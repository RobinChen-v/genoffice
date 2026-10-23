use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zip::ZipArchive;

pub mod archive;
mod cell_editor;
pub mod convert;
pub mod napi;
pub mod recalc;
mod richdata;
mod shared_formulas;
mod sheet_ops;
mod structural;
mod styles_editor;
mod visuals;

mod cell_images;
mod refs;
mod sparklines;
mod table_styles;
#[cfg(test)]
mod tests;
mod types;
mod workbook;
mod worksheet;
mod xml_util;

use cell_images::*;
use refs::*;
use sparklines::*;
use table_styles::*;
pub use types::*;
use workbook::*;
use worksheet::*;
use xml_util::*;
pub use cell_editor::CellEdit;
pub use structural::StructuralOp;
pub use styles_editor::{StyleBorderEdge, StyleDelta};
pub use sheet_ops::SheetOp;

pub use visuals::{CellStyle, MediaResult, ThemeFonts, VisualObject};
use visuals::{ColorContext, SheetVisualSource, SourceFormats};

const CHUNK_ROW_COUNT: usize = 256;
const MAX_RANGE_CELLS: usize = 100_000;
const RANGE_WAIT: Duration = Duration::from_millis(750);
/// Reads this far past the indexed row would only burn the full RANGE_WAIT;
/// answer immediately instead and let the caller poll.
const RANGE_WAIT_MAX_LAG_ROWS: usize = 16 * CHUNK_ROW_COUNT;
const MAX_FORMULA_CELLS: usize = 100_000;

#[derive(Debug, Default, Deserialize, Serialize)]
struct ChunkData {
    cells: Vec<CellRecord>,
    rows: Vec<RowProperty>,
}

#[derive(Debug)]
pub enum SidecarError {
    InvalidRequest(String),
    Io(String),
    Workbook(String),
}

impl std::fmt::Display for SidecarError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRequest(message) | Self::Io(message) | Self::Workbook(message) => {
                formatter.write_str(message)
            }
        }
    }
}

impl std::error::Error for SidecarError {}

impl From<std::io::Error> for SidecarError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

impl From<zip::result::ZipError> for SidecarError {
    fn from(error: zip::result::ZipError) -> Self {
        Self::Workbook(error.to_string())
    }
}

impl From<quick_xml::Error> for SidecarError {
    fn from(error: quick_xml::Error) -> Self {
        Self::Workbook(error.to_string())
    }
}

impl From<serde_json::Error> for SidecarError {
    fn from(error: serde_json::Error) -> Self {
        Self::Io(error.to_string())
    }
}

pub struct WorkbookSessions {
    sessions: HashMap<String, WorkbookSession>,
    /// Formula-engine cache for recalc_cells: holds the resident IronCalc
    /// model per workbook path so repeated recalcs skip the cold import.
    /// Keyed by canonical path (matching RecalcCache's own canonicalization),
    /// which the engine's `recalc::RecalcCache` manages.
    recalc_cache: std::sync::Mutex<crate::recalc::RecalcCache>,
}

impl WorkbookSessions {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            recalc_cache: std::sync::Mutex::new(crate::recalc::RecalcCache::default()),
        }
    }

    pub fn open(&mut self, path: &Path) -> Result<WorkbookMetadata, SidecarError> {
        self.open_with_locale(path, "zh", None)
    }

    pub fn open_with_locale(
        &mut self,
        path: &Path,
        locale: &str,
        short_date_format: Option<&str>,
    ) -> Result<WorkbookMetadata, SidecarError> {
        let canonical_path = path.canonicalize()?;
        let file = File::open(&canonical_path)?;
        let mut archive = ZipArchive::new(file)?;
        archive::validate_entries(&mut archive)?;
        let entry_count = archive.len();
        let mut color_context = visuals::read_theme_palette(&mut archive)?;
        visuals::read_indexed_palette(&mut archive, &mut color_context)?;
        let theme_colors = color_context.palette_hex();
        let theme_fonts = visuals::read_theme_fonts(&mut archive)?;
        let shared_strings = Arc::new(read_shared_strings(&mut archive, &color_context)?);
        let (declarations, workbook_protection, active_tab, date_1904) =
            read_sheet_declarations(&mut archive)?;
        let relationships = read_workbook_relationships(&mut archive)?;
        let (styles, dxf_styles, normal_font_name) = visuals::read_styles(
            &mut archive,
            &color_context,
            theme_fonts.as_ref(),
            locale,
            short_date_format,
        )?;
        let custom_table_styles = read_custom_table_styles(&mut archive, &dxf_styles);
        let rich_value_images = richdata::read_rich_value_images(&mut archive);
        let mut cell_image_count = 0usize;
        let mut sheets = Vec::with_capacity(declarations.len());
        let mut runtimes = Vec::with_capacity(declarations.len());
        let mut visual_sources = Vec::with_capacity(declarations.len());
        let mut sheet_names = Vec::with_capacity(declarations.len());

        for declaration in declarations {
            let target = relationships
                .get(&declaration.relationship_id)
                .ok_or_else(|| {
                    SidecarError::Workbook(format!(
                        "Missing worksheet relationship {}.",
                        declaration.relationship_id
                    ))
                })?;
            let worksheet_path = normalize_worksheet_path(target)?;
            let source_xml_bytes = zip_entry(&mut archive, &worksheet_path)?.size();
            let dimensions = read_sheet_dimensions(&mut archive, &worksheet_path, &color_context)?;
            let tables = read_sheet_tables(
                &mut archive,
                &worksheet_path,
                &color_context,
                &custom_table_styles,
            )?;
            let comments = visuals::read_comments(&mut archive, &worksheet_path)?
                .into_iter()
                .filter_map(|(reference, author, text)| {
                    let anchor = reference.split(':').next().unwrap_or(&reference);
                    let (row, column) = parse_address(&anchor.replace('$', "")).ok()?;
                    Some(CommentInfo {
                        row,
                        column,
                        author,
                        text,
                    })
                })
                .collect();
            let sparklines = read_sheet_sparklines(&mut archive, &worksheet_path)?;
            let cell_images = read_sheet_cell_images(
                &mut archive,
                &worksheet_path,
                &rich_value_images,
                &mut cell_image_count,
            )?;
            let pivot_infos = visuals::read_pivot_tables(&mut archive, &worksheet_path)?;
            let pivot_ranges = pivot_infos
                .iter()
                .filter_map(|info| parse_range_reference(&info.output_ref))
                .collect();
            let pivot_tables = pivot_infos
                .into_iter()
                .map(|info| {
                    let mut palette =
                        pivot_style_palette(info.style_name.as_deref(), &color_context);
                    if !info.show_row_stripes {
                        palette.stripe_fill = None;
                        palette.second_row_stripe_fill = None;
                    }
                    if !info.show_col_stripes {
                        palette.column_stripe_fill = None;
                        palette.second_column_stripe_fill = None;
                    }
                    PivotTableInfo {
                        palette,
                        styled: info
                            .style_name
                            .as_deref()
                            .is_some_and(|name| !name.is_empty()),
                        path: info.path,
                        cache_path: info.cache_path,
                        output_ref: info.output_ref,
                        first_data_row: info.first_data_row,
                        first_data_col: info.first_data_col,
                        row_grand_totals: info.row_grand_totals,
                        row_kinds: info.row_kinds,
                    }
                })
                .collect();
            let id = format!("sheet-{}", declaration.sheet_id);
            // A table may extend past the last written cell (a header-only
            // sheet whose table spans empty data rows); its banding and
            // frame still render there, so the grid must reach it.
            let (mut row_count, mut column_count) = (dimensions.row_count, dimensions.column_count);
            for table in &tables {
                row_count = row_count.max(table.range.end_row + 1);
                column_count = column_count.max(table.range.end_column + 1);
            }
            sheet_names.push((declaration.name.clone(), worksheet_path.clone()));
            sheets.push(SheetMetadata {
                id: id.clone(),
                name: declaration.name,
                row_count,
                column_count,
                source_xml_bytes,
                column_widths: dimensions.column_widths,
                default_row_height: dimensions.default_row_height,
                default_row_height_fixed: dimensions.default_row_height_fixed,
                default_column_width: dimensions.default_column_width,
                base_column_width: dimensions.base_column_width,
                freeze: dimensions.freeze,
                hidden: declaration.hidden,
                tab_color: dimensions.tab_color,
                show_grid_lines: dimensions.show_grid_lines,
                show_formulas: dimensions.show_formulas,
                show_row_col_headers: dimensions.show_row_col_headers,
                right_to_left: dimensions.right_to_left,
                zoom_scale: dimensions.zoom_scale,
                tables,
                comments,
                pivot_ranges,
                pivot_tables,
                sparklines,
                print_area: None,
                print_titles: None,
                has_scoped_defined_names: false,
                cell_images,
            });
            visual_sources.push(SheetVisualSource {
                sheet_id: id,
                worksheet_path: worksheet_path.clone(),
            });
            runtimes.push(SheetRuntime::new(worksheet_path));
        }
        if sheets.is_empty() {
            return Err(SidecarError::Workbook(
                "Workbook contains no readable worksheets.".into(),
            ));
        }
        // Value-less cells are kept when their xf paints something visible
        // (fill/border) or differs from the default xf in number format,
        // font or alignment — formatting a user's future input inherits (#169).
        let default_style = styles.first().cloned().unwrap_or_default();
        let styled_xfs: Arc<Vec<bool>> = Arc::new(
            styles
                .iter()
                .map(|style| style.styles_blank_cell(&default_style))
                .collect(),
        );
        let mut source_formats = SourceFormats::new(sheet_names, &styles);
        let visual_objects = visuals::read_visual_objects(
            &mut archive,
            &visual_sources,
            &color_context,
            &mut source_formats,
        )?;
        let (defined_names, print_names, scoped_sheets) = read_defined_names(&mut archive)?;
        for (sheet_index, sheet) in sheets.iter_mut().enumerate() {
            if let Some(names) = print_names.get(&sheet_index) {
                sheet.print_area = names.area.clone();
                sheet.print_titles = names.titles.clone();
            }
            sheet.has_scoped_defined_names = scoped_sheets.contains(&sheet_index);
        }

        let session_id = Uuid::new_v4().to_string();
        let cache_directory = std::env::temp_dir().join(format!("genspark-ai-excel-{session_id}"));
        fs::create_dir(&cache_directory)?;
        let name = canonical_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("workbook.xlsx")
            .to_owned();
        self.sessions.insert(
            session_id.clone(),
            WorkbookSession {
                path: canonical_path,
                sheets: sheets.clone(),
                runtimes,
                shared_strings,
                styled_xfs,
                color_context: Arc::new(color_context),
                visuals: visual_objects.clone(),
                cache_directory,
                cancelled: Arc::new(AtomicBool::new(false)),
            },
        );
        Ok(WorkbookMetadata {
            session_id,
            name,
            entry_count,
            sheets,
            active_tab,
            styles,
            dxf_styles,
            visuals: visual_objects,
            defined_names,
            theme_colors,
            theme_fonts,
            normal_font_name,
            workbook_protection,
            date1904: date_1904,
            short_date_format: short_date_format.map(ToOwned::to_owned),
        })
    }

    pub fn read_range(
        &mut self,
        session_id: &str,
        sheet_id: &str,
        range: &CellRange,
    ) -> Result<RangeResult, SidecarError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| SidecarError::InvalidRequest("Unknown workbook session.".into()))?;
        let sheet_index = session
            .sheets
            .iter()
            .position(|sheet| sheet.id == sheet_id)
            .ok_or_else(|| SidecarError::InvalidRequest("Unknown worksheet.".into()))?;
        range.validate(&session.sheets[sheet_index])?;
        session.ensure_parser(sheet_index)?;
        session.read_range(sheet_index, range)
    }

    pub fn read_formula_cells(
        &mut self,
        session_id: &str,
        sheet_id: &str,
    ) -> Result<FormulaCellsResult, SidecarError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| SidecarError::InvalidRequest("Unknown workbook session.".into()))?;
        let sheet_index = session
            .sheets
            .iter()
            .position(|sheet| sheet.id == sheet_id)
            .ok_or_else(|| SidecarError::InvalidRequest("Unknown worksheet.".into()))?;
        session.ensure_parser(sheet_index)?;
        session.read_formula_cells(sheet_index)
    }

    /// M5 incremental save: applies cell edits (values + M5.2b style deltas)
    /// to the session's snapshot, writes a new snapshot file and reopens the
    /// new file — mirroring the desktop session-swap semantics (the returned
    /// metadata has a fresh sessionId the host swaps in; the renderer
    /// reopens from it). Style deltas append to `xl/styles.xml`
    /// (materialized when the workbook had none).
    ///
    /// Session lifetime: the swap is **not atomic** on purpose. The new
    /// session is opened first and the old one closed only afterwards — and
    /// only when `close_old` is set. The Harmony shell passes
    /// `close_old: false` (`save_cells_keep_old`) and closes the old session
    /// itself after the write-back to the user's URI succeeds; a canceled
    /// Save-As or a failed write-back then leaves the original session live,
    /// so the renderer's retry keeps working instead of hitting "Unknown
    /// workbook session" on an already-closed id.
    pub fn save_cells(
        &mut self,
        session_id: &str,
        target_path: &Path,
        edits: &[CellEdit],
    ) -> Result<WorkbookMetadata, SidecarError> {
        self.save_cells_impl(session_id, target_path, edits, &[], true)
    }

    /// `save_cells` variant that leaves the source session open — the caller
    /// closes it once the downstream write-back succeeded (see above).
    pub fn save_cells_keep_old(
        &mut self,
        session_id: &str,
        target_path: &Path,
        edits: &[CellEdit],
    ) -> Result<WorkbookMetadata, SidecarError> {
        self.save_cells_impl(session_id, target_path, edits, &[], false)
    }

    /// 保存：单元格编辑 + 结构性操作（插删行列/合并）同批落盘。结构性操作
    /// 先应用（平移行列），再按平移后的坐标应用单元格编辑。
    pub fn save_cells_with_structural(
        &mut self,
        session_id: &str,
        target_path: &Path,
        edits: &[CellEdit],
        structural_ops: &[StructuralOp],
        keep_old: bool,
    ) -> Result<WorkbookMetadata, SidecarError> {
        self.save_cells_impl(session_id, target_path, edits, structural_ops, !keep_old)
    }

    /// 多 sheet 操作保存：直接操作 workbook 级 part（workbook.xml / rels /
    /// [Content_Types].xml）+ 受影响的 worksheet part 增删，再回到既有的
    /// 重开流程。sheetOps 一次性应用（add/duplicate/remove/rename/hidden/
    /// reorder），随后单元格 edits / structuralOps 落到最终生效的 sheet。
    pub fn save_cells_with_sheet_ops(
        &mut self,
        session_id: &str,
        target_path: &Path,
        edits: &[CellEdit],
        structural_ops: &[StructuralOp],
        sheet_ops: &[SheetOp],
        sheet_order: &[String],
        keep_old: bool,
    ) -> Result<WorkbookMetadata, SidecarError> {
        use crate::archive::{EntryContent, save_archive};
        use crate::cell_editor::apply_sheet_edits;
        use crate::sheet_ops::plan_sheet_ops;
        use crate::structural::apply_structural_ops;
        use crate::styles_editor::StylesEditor;

        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| SidecarError::InvalidRequest("Unknown workbook session.".into()))?;
        let source_path = session.path.clone();
        drop(session);

        if edits.is_empty() && structural_ops.is_empty() && sheet_ops.is_empty() {
            return Err(SidecarError::InvalidRequest(
                "save needs at least one edit, structural op or sheet op.".into(),
            ));
        }

        // 先规划 sheet 操作：需要读源包的三个 workbook 级 part。
        let plan = {
            let mut archive = ZipArchive::new(File::open(&source_path)?)?;
            plan_sheet_ops(&mut archive, sheet_ops, sheet_order)?
        };

        let styles_editor = {
            let mut styles_archive = ZipArchive::new(File::open(&source_path)?)?;
            let styles_xml =
                crate::visuals::read_optional_xml(&mut styles_archive, "xl/styles.xml")?;
            StylesEditor::new(styles_xml.as_deref(), "zh")
        };
        let mut styles_editor = styles_editor;

        let mut replacement_files: Vec<std::path::PathBuf> = Vec::new();
        let mut replacements: Vec<EntryContent> = Vec::new();
        let mut additions: Vec<EntryContent> = Vec::new();
        let mut removals: Vec<String> = plan.part_removals.clone();

        let mut write_replace = |name: &str, bytes: &[u8], replacements: &mut Vec<EntryContent>, replacement_files: &mut Vec<PathBuf>, session_id: &str, key: &str| -> Result<(), SidecarError> {
            let temp = std::env::temp_dir().join(format!("xlsx-{}-{}-{}.xml", session_id, key, replacement_files.len()));
            fs::write(&temp, bytes)?;
            replacement_files.push(temp.clone());
            replacements.push(EntryContent {
                name: name.to_owned(),
                content_path: temp,
            });
            Ok(())
        };

        // workbook 级三个 part 全量重写（replacements）。
        write_replace(
            "xl/workbook.xml",
            &plan.workbook_xml,
            &mut replacements,
            &mut replacement_files,
            session_id,
            "sheet-wb",
        )?;
        write_replace(
            "xl/_rels/workbook.xml.rels",
            &plan.rels_xml,
            &mut replacements,
            &mut replacement_files,
            session_id,
            "sheet-rels",
        )?;
        write_replace(
            "[Content_Types].xml",
            &plan.content_types_xml,
            &mut replacements,
            &mut replacement_files,
            session_id,
            "sheet-ct",
        )?;

        // 新增/复制的 worksheet part → additions（先写原始内容，下面的单元格
        // 编辑循环里若命中再改写）。
        for (path, bytes) in &plan.part_additions {
            let temp = std::env::temp_dir().join(format!(
                "xlsx-{}-{}-{}.xml",
                session_id,
                path.replace(['/', '.'], "_"),
                replacement_files.len()
            ));
            fs::write(&temp, bytes)?;
            replacement_files.push(temp.clone());
            let entry = EntryContent {
                name: path.clone(),
                content_path: temp,
            };
            additions.push(entry);
        }

        // 单元格编辑与结构性操作：按「引擎 id 归一化后的 sheet 行」分派。
        // plan.rows 含最终 sheet（已有 + 新增）；edits/structuralOps 的 sheet_id
        // 可能是 renderer 临时 id → 经 plan.id_map 归一。
        let resolve = |id: &str| -> String {
            plan.id_map
                .get(id)
                .cloned()
                .unwrap_or_else(|| id.to_owned())
        };
        for row in &plan.rows {
            let sheet_edits: Vec<CellEdit> = edits
                .iter()
                .filter(|edit| resolve(&edit.sheet_id) == row.engine_id)
                .cloned()
                .collect();
            let sheet_ops: Vec<StructuralOp> = structural_ops
                .iter()
                .filter(|op| resolve(&op.sheet_id) == row.engine_id)
                .cloned()
                .collect();
            if sheet_edits.is_empty() && sheet_ops.is_empty() {
                continue;
            }
            let is_new = plan
                .part_additions
                .iter()
                .any(|(path, _)| *path == row.part_path);
            let mut xml: Vec<u8> = if is_new {
                plan.part_additions
                    .iter()
                    .find(|(path, _)| *path == row.part_path)
                    .map(|(_, bytes)| bytes.clone())
                    .unwrap_or_else(|| crate::sheet_ops::blank_worksheet_xml())
            } else {
                let mut archive = ZipArchive::new(File::open(&source_path)?)?;
                let mut entry =
                    crate::xml_util::zip_entry(&mut archive, &row.part_path).map_err(|_| {
                        SidecarError::Workbook(format!(
                            "Workbook is missing {}.",
                            row.part_path
                        ))
                    })?;
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes)?;
                bytes
            };
            if !sheet_ops.is_empty() {
                xml = apply_structural_ops(&xml, &sheet_ops)?;
            }
            if !sheet_edits.is_empty() {
                xml = apply_sheet_edits(&xml, &sheet_edits, &mut styles_editor)?;
            }
            let temp = std::env::temp_dir().join(format!(
                "xlsx-{}-{}-{}.xml",
                session_id,
                row.part_path.replace(['/', '.'], "_"),
                replacement_files.len()
            ));
            fs::write(&temp, &xml)?;
            replacement_files.push(temp.clone());
            if is_new {
                // 已在 additions 中放入原始内容：替换为该已编辑版本。
                if let Some(entry) = additions.iter_mut().find(|entry| entry.name == row.part_path) {
                    entry.content_path = temp.clone();
                }
            } else {
                replacements.push(EntryContent {
                    name: row.part_path.clone(),
                    content_path: temp,
                });
            }
        }

        if styles_editor.is_modified() {
            let styles_bytes = styles_editor.render()?;
            let temp =
                std::env::temp_dir().join(format!("xlsx-styles-{session_id}.xml"));
            fs::write(&temp, &styles_bytes)?;
            replacement_files.push(temp.clone());
            let entry = EntryContent {
                name: "xl/styles.xml".to_owned(),
                content_path: temp,
            };
            if styles_editor.had_source() {
                replacements.push(entry);
            } else {
                additions.push(entry);
            }
        }

        if source_path == target_path {
            return Err(SidecarError::InvalidRequest(
                "Save target must differ from the source snapshot.".into(),
            ));
        }
        let _ = fs::remove_file(target_path);
        let result = save_archive(&source_path, target_path, &replacements, &removals, &additions);
        for temp in &replacement_files {
            let _ = fs::remove_file(temp);
        }
        result?;

        let reopened = self.open_with_locale(target_path, "zh", None)?;
        if !keep_old {
            let _ = self.close(session_id);
        }
        Ok(reopened)
    }

    fn save_cells_impl(
        &mut self,
        session_id: &str,
        target_path: &Path,
        edits: &[CellEdit],
        structural_ops: &[StructuralOp],
        close_old: bool,
    ) -> Result<WorkbookMetadata, SidecarError> {
        use crate::archive::{EntryContent, save_archive};
        use crate::cell_editor::apply_sheet_edits;
        use crate::structural::apply_structural_ops;
        use crate::styles_editor::StylesEditor;

        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| SidecarError::InvalidRequest("Unknown workbook session.".into()))?;
        let source_path = session.path.clone();
        // sheet id -> zip entry path for every sheet (worksheet_path is the
        // part path the indexer resolved, relative to the archive root).
        let mut part_paths: Vec<(String, String)> = Vec::new();
        for (sheet, runtime) in session.sheets.iter().zip(session.runtimes.iter()) {
            part_paths.push((sheet.id.clone(), runtime.worksheet_path.clone()));
        }
        drop(session);

        if edits.is_empty() && structural_ops.is_empty() {
            return Err(SidecarError::InvalidRequest(
                "save_cells needs at least one edit.".into(),
            ));
        }

        // M5.2b: styles.xml drive for style deltas — parsed once from the
        // source snapshot, mutated across sheets, flushed back into the
        // package when anything changed (or materialized when absent).
        let styles_editor = {
            let mut styles_archive = ZipArchive::new(File::open(&source_path)?)?;
            let styles_xml =
                crate::visuals::read_optional_xml(&mut styles_archive, "xl/styles.xml")?;
            StylesEditor::new(styles_xml.as_deref(), "zh")
        };
        let mut styles_editor = styles_editor;

        let mut replacement_files: Vec<std::path::PathBuf> = Vec::new();
        let mut replacements: Vec<EntryContent> = Vec::new();
        let mut additions: Vec<EntryContent> = Vec::new();
        let result = (|| -> Result<(), SidecarError> {
            for (sheet_id, part_path) in part_paths {
                let sheet_edits: Vec<CellEdit> = edits
                    .iter()
                    .filter(|edit| edit.sheet_id == sheet_id)
                    .cloned()
                    .collect();
                let sheet_ops: Vec<StructuralOp> = structural_ops
                    .iter()
                    .filter(|op| op.sheet_id == sheet_id)
                    .cloned()
                    .collect();
                if sheet_edits.is_empty() && sheet_ops.is_empty() {
                    continue;
                }
                let mut archive = ZipArchive::new(File::open(&source_path)?)?;
                let mut entry = crate::xml_util::zip_entry(&mut archive, &part_path).map_err(|_| {
                    SidecarError::Workbook(format!("Workbook is missing {part_path}."))
                })?;
                let mut xml = Vec::new();
                use std::io::Read;
                entry.read_to_end(&mut xml)?;
                // 结构性操作先行：行列平移/合并后，单元格编辑落在平移后的坐标。
                let mut updated = if sheet_ops.is_empty() {
                    xml.clone()
                } else {
                    apply_structural_ops(&xml, &sheet_ops)?
                };
                if !sheet_edits.is_empty() {
                    updated = apply_sheet_edits(&updated, &sheet_edits, &mut styles_editor)?;
                }
                let temp = std::env::temp_dir().join(format!(
                    "xlsx-cell-{}-{}.xml",
                    session_id,
                    replacement_files.len()
                ));
                fs::write(&temp, updated)?;
                replacement_files.push(temp.clone());
                replacements.push(EntryContent {
                    name: part_path,
                    content_path: temp,
                });
            }
            if styles_editor.is_modified() {
                let styles_bytes = styles_editor.render()?;
                let temp = std::env::temp_dir().join(format!("xlsx-styles-{session_id}.xml"));
                fs::write(&temp, &styles_bytes)?;
                replacement_files.push(temp.clone());
                let entry = EntryContent {
                    name: "xl/styles.xml".to_owned(),
                    content_path: temp,
                };
                if styles_editor.had_source() {
                    replacements.push(entry);
                } else {
                    additions.push(entry);
                }
            }
            if replacements.is_empty() && additions.is_empty() {
                return Err(SidecarError::InvalidRequest(
                    "No worksheet matched the given sheet ids.".into(),
                ));
            }
            // Repeated saves reuse the same target path; archive::save_archive
            // refuses source==target only, an existing target is fine — but
            // must not collide with the source itself (identical fast-path).
            if source_path == target_path {
                return Err(SidecarError::InvalidRequest(
                    "Save target must differ from the source snapshot.".into(),
                ));
            }
            let _ = fs::remove_file(target_path);
            save_archive(&source_path, target_path, &replacements, &[], &additions)?;
            Ok(())
        })();
        for temp in &replacement_files {
            let _ = fs::remove_file(temp);
        }
        result?;

        // Open the new snapshot FIRST. The old session keeps its (untouched)
        // working snapshot, so a failed reopen leaves the renderer's current
        // session fully usable for a retry instead of orphaning it.
        let reopened = self.open_with_locale(target_path, "zh", None)?;
        if close_old {
            // Best-effort: the swap already succeeded; a close failure must
            // not throw away the save result (the session would leak until
            // process exit, which the host's own close-on-unmount covers).
            // Locale note: not part of session state; the bridge always opens
            // with 'zh' (DesktopBridge.xlsOpenJson passes the same), and date
            // formats come from the file itself on reopen.
            let _ = self.close(session_id);
        }
        Ok(reopened)
    }

    pub fn close(&mut self, session_id: &str) -> Result<(), SidecarError> {
        let session = self
            .sessions
            .remove(session_id)
            .ok_or_else(|| SidecarError::InvalidRequest("Unknown workbook session.".into()))?;
        session.close()
    }

    /// Shell "新建空白表格": materializes a real (empty) xlsx at `path` and
    /// opens it as a normal session — the blank sheet then edits and saves
    /// through the exact same `save_cells` path as opened files.
    pub fn create_blank(&mut self, path: &Path, sheet_name: &str) -> Result<WorkbookMetadata, SidecarError> {
        crate::convert::create_empty_workbook(path, sheet_name)?;
        // Locale mirrors the bridge convention (open always 'zh'); date
        // formats come from the file itself.
        self.open_with_locale(path, "zh", None)
    }

    /// Recalculate formula cells after an edit set, returning the new display
    /// values for the requested read ranges. Reuses the resident IronCalc
    /// model cache (keyed by the session's canonical snapshot path) so repeat
    /// recalcs skip the cold import. Mirrors the standalone ELF's
    /// `RecalcCells{path, edits, reads}` semantics with a sessionId instead
    /// of a raw path.
    pub fn recalc_cells(
        &self,
        session_id: &str,
        edits: &[crate::recalc::RecalcEdit],
        reads: &[crate::recalc::RecalcRead],
    ) -> Result<crate::recalc::RecalcResult, SidecarError> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| SidecarError::InvalidRequest("Unknown workbook session.".into()))?;
        // renderer 的 sheetId 是引擎元数据 id（sheet-1）；IronCalc 按 worksheet
        // 名字（Sheet1）匹配 —— 先把 id 映射回 name。
        let name_of = |id: &str| -> Result<String, SidecarError> {
            session
                .sheets
                .iter()
                .find(|sheet| sheet.id == id)
                .map(|sheet| sheet.name.clone())
                .ok_or_else(|| SidecarError::InvalidRequest(format!("Unknown sheet: {id}")))
        };
        let edits: Vec<crate::recalc::RecalcEdit> = edits
            .iter()
            .map(|edit| {
                let sheet = name_of(&edit.sheet)?;
                Ok(crate::recalc::RecalcEdit {
                    sheet,
                    row: edit.row,
                    column: edit.column,
                    input: edit.input.clone(),
                })
            })
            .collect::<Result<Vec<_>, SidecarError>>()?;
        let reads: Vec<crate::recalc::RecalcRead> = reads
            .iter()
            .map(|read| {
                let sheet = name_of(&read.sheet)?;
                Ok(crate::recalc::RecalcRead { sheet, range: read.range.clone() })
            })
            .collect::<Result<Vec<_>, SidecarError>>()?;
        let path = session.path.clone();
        drop(session);
        let mut cache = self
            .recalc_cache
            .lock()
            .map_err(|_| SidecarError::Io("Recalc cache lock was poisoned.".into()))?;
        crate::recalc::recalc_cells(&mut cache, &path, &edits, &reads)
    }

    /// The workbook file behind a session, for cross-subsystem cleanup
    /// (the recalc cache keys resident models by path).
    pub fn session_path(&self, session_id: &str) -> Option<PathBuf> {
        self.sessions
            .get(session_id)
            .map(|session| session.path.clone())
    }

    pub fn read_media(
        &self,
        session_id: &str,
        visual_id: &str,
    ) -> Result<MediaResult, SidecarError> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| SidecarError::InvalidRequest("Unknown workbook session.".into()))?;
        let media_path = session
            .visuals
            .iter()
            .find(|visual| visual.id == visual_id)
            .and_then(|visual| {
                visual
                    .media_path
                    .as_deref()
                    .or(visual.fill_media_path.as_deref())
            })
            .or_else(|| {
                session
                    .sheets
                    .iter()
                    .flat_map(|sheet| sheet.cell_images.iter())
                    .find(|image| image.id == visual_id)
                    .map(|image| image.media_path.as_str())
            })
            .map(str::to_owned)
            .or_else(|| session.header_footer_picture_path(visual_id))
            .ok_or_else(|| SidecarError::InvalidRequest("Unknown workbook image.".into()))?;
        let file = File::open(&session.path)?;
        let mut archive = ZipArchive::new(file)?;
        visuals::read_media(&mut archive, &media_path)
    }
}

impl Default for WorkbookSessions {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for WorkbookSessions {
    fn drop(&mut self) {
        for (_, session) in self.sessions.drain() {
            let _ = session.close();
        }
    }
}

struct WorkbookSession {
    path: PathBuf,
    sheets: Vec<SheetMetadata>,
    runtimes: Vec<SheetRuntime>,
    shared_strings: Arc<Vec<SharedString>>,
    styled_xfs: Arc<Vec<bool>>,
    color_context: Arc<ColorContext>,
    visuals: Vec<VisualObject>,
    cache_directory: PathBuf,
    cancelled: Arc<AtomicBool>,
}

impl WorkbookSession {
    /// Media path behind a header/footer picture id (`&G` slots live on the
    /// indexed sheet state, so only completed sheets can resolve one).
    fn header_footer_picture_path(&self, picture_id: &str) -> Option<String> {
        self.runtimes.iter().find_map(|runtime| {
            let (lock, _) = &*runtime.state;
            let index = lock.lock().ok()?;
            index
                .page_setup
                .as_ref()?
                .header_footer_pictures
                .iter()
                .find(|picture| picture.id == picture_id)
                .map(|picture| picture.media_path.clone())
        })
    }

    fn ensure_parser(&mut self, sheet_index: usize) -> Result<(), SidecarError> {
        let runtime = &mut self.runtimes[sheet_index];
        if runtime.handle.is_some() {
            return Ok(());
        }
        let path = self.path.clone();
        let worksheet_path = runtime.worksheet_path.clone();
        let declared_row_count = self.sheets[sheet_index].row_count;
        let cache_directory = self.cache_directory.clone();
        let state = Arc::clone(&runtime.state);
        let shared_strings = Arc::clone(&self.shared_strings);
        let styled_xfs = Arc::clone(&self.styled_xfs);
        let color_context = Arc::clone(&self.color_context);
        // The capped overlay list is the single source of truth: only cells
        // that actually got a picture record lose their cached error.
        let rich_image_cells: Arc<HashSet<(usize, usize)>> = Arc::new(
            self.sheets[sheet_index]
                .cell_images
                .iter()
                .map(|image| (image.row, image.column))
                .collect(),
        );
        let cancelled = Arc::clone(&self.cancelled);
        let handle = thread::Builder::new()
            .name(format!("xlsx-index-{sheet_index}"))
            .spawn(move || {
                let result = index_worksheet(
                    &path,
                    &worksheet_path,
                    sheet_index,
                    declared_row_count,
                    &cache_directory,
                    &shared_strings,
                    &styled_xfs,
                    &color_context,
                    &rich_image_cells,
                    &state,
                    &cancelled,
                );
                let (lock, condition) = &*state;
                if let Ok(mut index) = lock.lock() {
                    match result {
                        Ok(()) => index.complete = true,
                        Err(error) => index.error = Some(error.to_string()),
                    }
                    condition.notify_all();
                }
            })?;
        runtime.handle = Some(handle);
        Ok(())
    }

    fn read_range(
        &self,
        sheet_index: usize,
        range: &CellRange,
    ) -> Result<RangeResult, SidecarError> {
        let runtime = &self.runtimes[sheet_index];
        let (lock, condition) = &*runtime.state;
        let index = lock
            .lock()
            .map_err(|_| SidecarError::Io("Worksheet index lock was poisoned.".into()))?;
        let far_ahead = index.error.is_none()
            && !index.complete
            && index
                .indexed_through_row
                .map_or(range.start_row, |row| range.start_row.saturating_sub(row))
                >= RANGE_WAIT_MAX_LAG_ROWS;
        let index = if far_ahead {
            index
        } else {
            condition
                .wait_timeout_while(index, RANGE_WAIT, |current| {
                    // 行数据按进度放行太早：merges/hyperlinks 等尾部元数据
                    // 只在整表解析完成后写入 index，因此必须等 complete。
                    current.error.is_none() && !current.complete
                })
                .map_err(|_| SidecarError::Io("Worksheet index wait failed.".into()))?
                .0
        };
        if let Some(error) = &index.error {
            return Err(SidecarError::Workbook(error.clone()));
        }
        let indexed_through_row = index.indexed_through_row;
        let indexing_complete = index.complete;
        let merges = index
            .merges
            .iter()
            .filter(|merge| {
                merge.start_row <= range.end_row
                    && merge.end_row >= range.start_row
                    && merge.start_column <= range.end_column
                    && merge.end_column >= range.start_column
            })
            .copied()
            .collect::<Vec<_>>();
        let hyperlinks = index
            .hyperlinks
            .iter()
            .filter(|link| {
                link.row >= range.start_row
                    && link.row <= range.end_row
                    && link.column >= range.start_column
                    && link.column <= range.end_column
            })
            .cloned()
            .collect::<Vec<_>>();
        let conditional_rules = if indexing_complete {
            index.conditional_rules.clone()
        } else {
            Vec::new()
        };
        let auto_filter = if indexing_complete {
            index.auto_filter
        } else {
            None
        };
        let auto_filter_columns = if indexing_complete {
            index.auto_filter_columns.clone()
        } else {
            Vec::new()
        };
        let data_validations = if indexing_complete {
            index.data_validations.clone()
        } else {
            Vec::new()
        };
        let sheet_protection = if indexing_complete {
            index.sheet_protection
        } else {
            None
        };
        let row_breaks = if indexing_complete {
            index.row_breaks.clone()
        } else {
            Vec::new()
        };
        let col_breaks = if indexing_complete {
            index.col_breaks.clone()
        } else {
            Vec::new()
        };
        let protected_ranges = if indexing_complete {
            index.protected_ranges.clone()
        } else {
            Vec::new()
        };
        let page_setup = if indexing_complete {
            index.page_setup.clone()
        } else {
            None
        };
        let first_chunk = range.start_row / CHUNK_ROW_COUNT;
        let last_available_row = indexed_through_row
            .map(|row| row.min(range.end_row))
            .unwrap_or(0);
        let last_chunk = last_available_row / CHUNK_ROW_COUNT;
        let paths = if indexed_through_row.is_none() || last_available_row < range.start_row {
            Vec::new()
        } else {
            (first_chunk..=last_chunk)
                .filter_map(|chunk| index.chunk_files.get(&chunk).cloned())
                .collect::<Vec<_>>()
        };
        drop(index);

        let mut cells = Vec::new();
        let mut rows = Vec::new();
        for path in paths {
            let file = File::open(path)?;
            let chunk: ChunkData = serde_json::from_reader(BufReader::new(file))?;
            cells.extend(chunk.cells.into_iter().filter(|cell| {
                cell.row >= range.start_row
                    && cell.row <= range.end_row
                    && cell.column >= range.start_column
                    && cell.column <= range.end_column
            }));
            rows.extend(
                chunk
                    .rows
                    .into_iter()
                    .filter(|row| row.row >= range.start_row && row.row <= range.end_row),
            );
        }
        Ok(RangeResult {
            cells,
            rows,
            merges,
            hyperlinks,
            conditional_rules,
            auto_filter,
            auto_filter_columns,
            data_validations,
            sheet_protection,
            row_breaks,
            col_breaks,
            protected_ranges,
            page_setup,
            indexed_through_row,
            indexing_complete,
        })
    }

    /// All formula cells indexed so far; the closure analyzer polls until
    /// `indexing_complete`. Capped — a sheet over the cap sets `truncated`.
    fn read_formula_cells(&self, sheet_index: usize) -> Result<FormulaCellsResult, SidecarError> {
        let runtime = &self.runtimes[sheet_index];
        let (lock, _) = &*runtime.state;
        let index = lock
            .lock()
            .map_err(|_| SidecarError::Io("Worksheet index lock was poisoned.".into()))?;
        if let Some(error) = &index.error {
            return Err(SidecarError::Workbook(error.clone()));
        }
        Ok(FormulaCellsResult {
            cells: index.formula_cells.clone(),
            indexing_complete: index.complete,
            truncated: index.formula_truncated,
        })
    }

    fn close(mut self) -> Result<(), SidecarError> {
        self.cancelled.store(true, Ordering::Release);
        for runtime in &self.runtimes {
            let (_, condition) = &*runtime.state;
            condition.notify_all();
        }
        for runtime in &mut self.runtimes {
            if let Some(handle) = runtime.handle.take() {
                let _ = handle.join();
            }
        }
        if self.cache_directory.exists() {
            fs::remove_dir_all(&self.cache_directory)?;
        }
        Ok(())
    }
}

struct SheetRuntime {
    worksheet_path: String,
    state: Arc<(Mutex<SheetIndex>, Condvar)>,
    handle: Option<JoinHandle<()>>,
}

impl SheetRuntime {
    fn new(worksheet_path: String) -> Self {
        Self {
            worksheet_path,
            state: Arc::new((Mutex::new(SheetIndex::default()), Condvar::new())),
            handle: None,
        }
    }
}

#[derive(Default)]
struct SheetIndex {
    indexed_through_row: Option<usize>,
    complete: bool,
    error: Option<String>,
    chunk_files: HashMap<usize, PathBuf>,
    merges: Vec<MergedRange>,
    hyperlinks: Vec<HyperlinkRecord>,
    conditional_rules: Vec<ConditionalRule>,
    auto_filter: Option<MergedRange>,
    auto_filter_columns: Vec<FilterColumnCriteria>,
    data_validations: Vec<DataValidationRule>,
    sheet_protection: Option<SheetProtectionInfo>,
    row_breaks: Vec<usize>,
    col_breaks: Vec<usize>,
    protected_ranges: Vec<ProtectedRangeInfo>,
    page_setup: Option<PagePrintInfo>,
    /// Formula cells collected while indexing, capped at MAX_FORMULA_CELLS.
    formula_cells: Vec<CellRecord>,
    formula_truncated: bool,
}

#[derive(Debug)]
struct SheetDeclaration {
    name: String,
    sheet_id: String,
    relationship_id: String,
    hidden: bool,
}
