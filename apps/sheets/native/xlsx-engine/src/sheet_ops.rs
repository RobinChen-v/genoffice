//! 工作簿级 sheet 操作：add/duplicate/remove-sheet、rename、set-sheet-hidden、reorder。
//!
//! 引擎的 sheet 身份是 `sheet-{sheetId 属性}`（workbook.xml 的数字字符串）。已存在
//! sheet 的 renderer id 即引擎 id；本批新增的 sheet 由 renderer 生成临时 id，
//! 通过 `SheetOp.sheet_id` 建立「临时 id → 引擎 id」映射（id_map），供同批
//! edits / sheetOrder 引用。
//!
//! 三个 workbook 级 part 随操作重写：
//!   - `xl/workbook.xml`：<sheets> 段重建（其余节点原样保留）；
//!   - `xl/_rels/workbook.xml.rels`：worksheet 关系增删（其余关系保留）；
//!   - `[Content_Types].xml`：worksheet Override 增删（其余保留）。
//! 新增/复制的 worksheet part 放入 additions，删除的放入 removals（归档层级）。

use super::*;
use quick_xml::events::BytesText;

/// renderer sheet op（save payload 的 sheetOps 项）。
#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetOp {
    /// add-sheet | duplicate-sheet | remove-sheet | rename-sheet | set-sheet-hidden | reorder-sheets
    pub kind: String,
    /// 目标 sheet 的 renderer id。已存在 sheet 即引擎 id（sheet-N）；本批新增是临时 id。
    #[serde(default)]
    pub sheet_id: Option<String>,
    /// add-sheet / duplicate-sheet 的新 sheet 名。
    #[serde(default)]
    pub name: Option<String>,
    /// duplicate-sheet 的源 sheet 的 renderer id。
    #[serde(default)]
    pub source_sheet_id: Option<String>,
    /// rename-sheet 的新名字。
    #[serde(default)]
    pub new_name: Option<String>,
    /// set-sheet-hidden 的目标隐藏状态。
    #[serde(default)]
    pub hidden: Option<bool>,
}

/// 单个最终 sheet 的声明身份。
#[derive(Clone, Debug)]
pub struct SheetPlanRow {
    pub engine_id: String,
    pub name: String,
    /// workbook.xml sheetId 属性（数字字符串）。
    pub sheet_id_attr: String,
    /// workbook.xml r:id（rIdN，匹配 rels）。
    pub r_id: String,
    /// 归档内 part 路径（xl/worksheets/sheetN.xml）。
    pub part_path: String,
    pub hidden: bool,
}

pub struct SheetPlanResult {
    pub workbook_xml: Vec<u8>,
    pub rels_xml: Vec<u8>,
    pub content_types_xml: Vec<u8>,
    /// 新增/复制的 worksheet part：路径 → 内容（尚未应用单元格 edits）。
    pub part_additions: Vec<(String, Vec<u8>)>,
    /// 删除的 worksheet part 路径。
    pub part_removals: Vec<String>,
    /// renderer 临时 sheet id → 引擎 id（已存在 sheet 是恒等映射）。
    pub id_map: HashMap<String, String>,
    /// 最终 sheet 列表（引擎 id 顺序）。
    pub rows: Vec<SheetPlanRow>,
}

const WORKSHEET_OVERRIDE: &str =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
const WORKSHEET_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";
const WORKBOOK_PATH: &str = "xl/workbook.xml";
const RELS_PATH: &str = "xl/_rels/workbook.xml.rels";
const CONTENT_TYPES_PATH: &str = "[Content_Types].xml";

/// 源文件的 sheet 声明快照。
struct SourceSheet {
    engine_id: String,
    name: String,
    sheet_id_attr: String,
    r_id: String,
    part_path: String,
    hidden: bool,
}

/// 解析 workbook.xml 的 <sheet> 声明（与 read_sheet_declarations 同构，但保留
/// part 路径），r_id 通过 rels 解析成 part 路径（规范化）。
fn read_source_sheets(
    workbook_xml: &str,
    rels: &HashMap<String, String>,
) -> Result<Vec<SourceSheet>, SidecarError> {
    let mut reader = Reader::from_str(workbook_xml);
    let mut sheets = Vec::new();
    loop {
        match reader.read_event()? {
            Event::Start(element) | Event::Empty(element)
                if element.local_name().as_ref() == b"sheet" =>
            {
                let name = attribute_value(&reader, &element, b"name")?
                    .ok_or_else(|| SidecarError::Workbook("Sheet has no name.".into()))?;
                let sheet_id = attribute_value(&reader, &element, b"sheetId")?
                    .ok_or_else(|| SidecarError::Workbook("Sheet has no sheetId.".into()))?;
                let r_id = attribute_value(&reader, &element, b"id")?
                    .ok_or_else(|| SidecarError::Workbook("Sheet has no id.".into()))?;
                let hidden = matches!(
                    attribute_value(&reader, &element, b"state")?.as_deref(),
                    Some("hidden") | Some("veryHidden")
                );
                let target = rels
                    .get(&r_id)
                    .ok_or_else(|| {
                        SidecarError::Workbook(format!("Missing worksheet relation {r_id}."))
                    })?
                    .clone();
                let part_path = crate::workbook::normalize_worksheet_path(&target)?;
                sheets.push(SourceSheet {
                    engine_id: format!("sheet-{sheet_id}"),
                    name,
                    sheet_id_attr: sheet_id,
                    r_id,
                    part_path,
                    hidden,
                });
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(sheets)
}

/// 提取每个 <Relationship> 的三元组 (Id, Type, Target)。
fn read_relationship_rows(xml: &str) -> Result<Vec<(String, String, String)>, SidecarError> {
    let mut reader = Reader::from_str(xml);
    let mut rows = Vec::new();
    loop {
        match reader.read_event()? {
            Event::Start(element) | Event::Empty(element)
                if element.local_name().as_ref() == b"Relationship" =>
            {
                let id = attribute_value(&reader, &element, b"Id")?;
                let kind = attribute_value(&reader, &element, b"Type")?;
                let target = attribute_value(&reader, &element, b"Target")?;
                if let (Some(id), Some(kind), Some(target)) = (id, kind, target) {
                    rows.push((id, kind, target));
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(rows)
}

/// 提取 mounted 的 worksheet part 路径集（[Content_Types].xml 的 Override）。
fn read_ws_overrides(xml: &str) -> HashSet<String> {
    let mut reader = Reader::from_str(xml);
    let mut parts = HashSet::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(element) | Event::Empty(element))
                if element.local_name().as_ref() == b"Override" =>
            {
                let part = element
                    .attributes()
                    .with_checks(false)
                    .filter_map(|attr| attr.ok())
                    .find(|attr| attr.key.local_name().as_ref() == b"PartName")
                    .map(|attr| String::from_utf8_lossy(&attr.value).into_owned());
                let kind = element
                    .attributes()
                    .with_checks(false)
                    .filter_map(|attr| attr.ok())
                    .find(|attr| attr.key.local_name().as_ref() == b"ContentType")
                    .map(|attr| String::from_utf8_lossy(&attr.value).into_owned());
                if let (Some(part), Some(kind)) = (part, kind) {
                    if kind == WORKSHEET_OVERRIDE {
                        parts.insert(part.trim_start_matches('/').to_owned());
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    parts
}

fn escape_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 重建 workbook.xml 的 <sheets> 段；其余事件原样复制。源无 <sheets> 段时在
/// </workbook> 前补插（防御分支）。
fn rewrite_workbook_sheets(
    xml: &str,
    rows: &[SheetPlanRow],
) -> Result<Vec<u8>, SidecarError> {
    let has_sheets = xml.contains("<sheets");
    let mut reader = Reader::from_str(xml);
    let mut writer = quick_xml::Writer::new(Vec::<u8>::new());
    let mut in_sheets = false;
    let sheets_xml = || -> String {
        let mut out = String::from("<sheets>");
        for row in rows {
            let state = if row.hidden { r#" state="hidden""# } else { "" };
            out.push_str(&format!(
                r#"<sheet name="{}" sheetId="{}" r:id="{r_id}"{state}/>"#,
                escape_attr(&row.name),
                escape_attr(&row.sheet_id_attr),
                r_id = escape_attr(&row.r_id),
            ));
        }
        out.push_str("</sheets>");
        out
    };
    loop {
        let event = reader.read_event()?;
        match &event {
            Event::Eof => break,
            Event::Start(start) if start.local_name().as_ref() == b"sheets" => {
                in_sheets = true;
                writer
                    .write_event(Event::Text(BytesText::from_escaped(sheets_xml())))
                    .map_err(|error| SidecarError::Workbook(error.to_string()))?;
            }
            Event::End(end) if end.local_name().as_ref() == b"sheets" => {
                in_sheets = false;
                // 段被上面的 Text 整体写出，这里跳过原 </sheets>。
            }
            Event::End(end) if end.local_name().as_ref() == b"workbook" && !has_sheets => {
                // 防御：源文件无 <sheets> 段时在 </workbook> 前补插。
                writer
                    .write_event(Event::Text(BytesText::from_escaped(sheets_xml())))
                    .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                writer
                    .write_event(event.to_owned())
                    .map_err(|error| SidecarError::Workbook(error.to_string()))?;
            }
            _ => {
                if !in_sheets {
                    writer
                        .write_event(event.to_owned())
                        .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                }
            }
        }
    }
    Ok(writer.into_inner())
}

/// 重写 workbook.xml.rels：
///   - worksheet 关系：保留当且仅当 Id 属于最终 sheet 的 r_id 集；
///   - 其余类型关系原样保留；
///   - 在 `</Relationships>` 前追加新增 sheet 的关系。
fn rewrite_workbook_rels(
    xml: &str,
    final_r_ids: &HashSet<String>,
    add_relations: &[(String, String)],
) -> Result<Vec<u8>, SidecarError> {
    let mut reader = Reader::from_str(xml);
    let mut writer = quick_xml::Writer::new(Vec::<u8>::new());
    let mut pending: Vec<(String, String)> = add_relations.to_vec();
    loop {
        let event = reader.read_event()?;
        match &event {
            Event::Eof => break,
            Event::Start(start) if start.local_name().as_ref() == b"Relationship" => {
                let id = attribute_value(&reader, start, b"Id")?;
                let kind = attribute_value(&reader, start, b"Type")?;
                let is_worksheet = kind.as_deref() == Some(WORKSHEET_REL_TYPE);
                let keep = !is_worksheet
                    || id.as_deref().is_some_and(|id| final_r_ids.contains(id));
                if keep {
                    let mut out = BytesStart::new("Relationship");
                    for attr in start.attributes().with_checks(false) {
                        let attr = attr
                            .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                        out.push_attribute((attr.key.as_ref(), attr.value.as_ref()));
                    }
                    writer
                        .write_event(Event::Start(out))
                        .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                }
            }
            Event::Empty(start) if start.local_name().as_ref() == b"Relationship" => {
                let id = attribute_value(&reader, start, b"Id")?;
                let kind = attribute_value(&reader, start, b"Type")?;
                let is_worksheet = kind.as_deref() == Some(WORKSHEET_REL_TYPE);
                let keep = !is_worksheet
                    || id.as_deref().is_some_and(|id| final_r_ids.contains(id));
                if keep {
                    let mut out = BytesStart::new("Relationship");
                    for attr in start.attributes().with_checks(false) {
                        let attr = attr
                            .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                        out.push_attribute((attr.key.as_ref(), attr.value.as_ref()));
                    }
                    writer
                        .write_event(Event::Empty(out))
                        .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                }
            }
            Event::End(end) if end.local_name().as_ref() == b"Relationship" => {
                writer
                    .write_event(event.to_owned())
                    .map_err(|error| SidecarError::Workbook(error.to_string()))?;
            }
            Event::End(end) if end.local_name().as_ref() == b"Relationships" => {
                for (id, target) in &pending {
                    let line = format!(
                        r#"<Relationship Id="{id}" Type="{WORKSHEET_REL_TYPE}" Target="{target}"/>"#
                    );
                    writer
                        .write_event(Event::Text(BytesText::from_escaped(line)))
                        .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                }
                pending.clear();
                writer
                    .write_event(event.to_owned())
                    .map_err(|error| SidecarError::Workbook(error.to_string()))?;
            }
            _ => {
                writer
                    .write_event(event.to_owned())
                    .map_err(|error| SidecarError::Workbook(error.to_string()))?;
            }
        }
    }
    Ok(writer.into_inner())
}

/// 重写 [Content_Types].xml：删除已移除 part 的 worksheet Override，追加新增
/// part 的 Override；其余 Override 与 Default 原样保留。
fn rewrite_content_types(
    xml: &str,
    removed_parts: &HashSet<String>,
    added_parts: &[String],
) -> Result<Vec<u8>, SidecarError> {
    let mut reader = Reader::from_str(xml);
    let mut writer = quick_xml::Writer::new(Vec::<u8>::new());
    let mut pending: Vec<String> = added_parts.to_vec();
    loop {
        let event = reader.read_event()?;
        match &event {
            Event::Eof => break,
            Event::Start(start) if start.local_name().as_ref() == b"Override" => {
                let part = attribute_value(&reader, start, b"PartName")?;
                let kind = attribute_value(&reader, start, b"ContentType")?;
                let removed = kind.as_deref() == Some(WORKSHEET_OVERRIDE)
                    && part
                        .as_deref()
                        .is_some_and(|part| removed_parts.contains(part.trim_start_matches('/')));
                if !removed {
                    let mut out = BytesStart::new("Override");
                    for attr in start.attributes().with_checks(false) {
                        let attr = attr
                            .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                        out.push_attribute((attr.key.as_ref(), attr.value.as_ref()));
                    }
                    writer
                        .write_event(Event::Start(out))
                        .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                }
            }
            Event::Empty(start) if start.local_name().as_ref() == b"Override" => {
                let part = attribute_value(&reader, start, b"PartName")?;
                let kind = attribute_value(&reader, start, b"ContentType")?;
                let removed = kind.as_deref() == Some(WORKSHEET_OVERRIDE)
                    && part
                        .as_deref()
                        .is_some_and(|part| removed_parts.contains(part.trim_start_matches('/')));
                if !removed {
                    let mut out = BytesStart::new("Override");
                    for attr in start.attributes().with_checks(false) {
                        let attr = attr
                            .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                        out.push_attribute((attr.key.as_ref(), attr.value.as_ref()));
                    }
                    writer
                        .write_event(Event::Empty(out))
                        .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                }
            }
            Event::End(end) if end.local_name().as_ref() == b"Types" => {
                for part in &pending {
                    // part 已是 `/xl/worksheets/sheetN.xml` 形式（added_parts 存带
                    // 前导 / 的 PartName），这里直接拼接。
                    let line = format!(
                        r#"<Override PartName="{part}" ContentType="{WORKSHEET_OVERRIDE}"/>"#
                    );
                    writer
                        .write_event(Event::Text(BytesText::from_escaped(line)))
                        .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                }
                pending.clear();
                writer
                    .write_event(event.to_owned())
                    .map_err(|error| SidecarError::Workbook(error.to_string()))?;
            }
            _ => {
                writer
                    .write_event(event.to_owned())
                    .map_err(|error| SidecarError::Workbook(error.to_string()))?;
            }
        }
    }
    Ok(writer.into_inner())
}

fn sheet_number(path: &str) -> Option<usize> {
    let cleaned = path.trim_start_matches('/');
    let file = cleaned.strip_prefix("xl/worksheets/sheet")?;
    let file = file.strip_suffix(".xml")?;
    file.parse::<usize>().ok()
}

fn max_numeric_suffix<'a, I: Iterator<Item = &'a str>>(
    rows: &[SourceSheet],
    overrides: &HashSet<String>,
    rels_keys: I,
) -> (usize, usize, usize) {
    let mut max_part = 0usize;
    let mut max_sheet_id = 0usize;
    let mut max_r_id = 0usize;
    for row in rows {
        if let Some(n) = sheet_number(&row.part_path) {
            max_part = max_part.max(n);
        }
        if let Ok(n) = row.sheet_id_attr.parse::<usize>() {
            max_sheet_id = max_sheet_id.max(n);
        }
        if let Some(n) = row
            .r_id
            .strip_prefix("rId")
            .and_then(|v| v.parse::<usize>().ok())
        {
            max_r_id = max_r_id.max(n);
        }
    }
    for part in overrides {
        if let Some(n) = sheet_number(part) {
            max_part = max_part.max(n);
        }
    }
    // rId 命名空间是 rels 全局的：styles/theme/sharedStrings 等关系也占号，
    // 新分配不能与它们撞（否则 excel 打开即损坏）。
    for key in rels_keys {
        if let Some(n) = key.strip_prefix("rId").and_then(|v| v.parse::<usize>().ok()) {
            max_r_id = max_r_id.max(n);
        }
    }
    (max_part, max_sheet_id, max_r_id)
}

/// 新 sheet 的空白 part 内容（dim A1:CV200 = 200×100，与「新建空白表格」同款，
/// 不会触发渲染层大文件流式模式）。
pub fn blank_worksheet_xml() -> Vec<u8> {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:CV200"/><sheetData/></worksheet>"#
        .as_bytes()
        .to_vec()
}

/// 规划 sheet 操作，返回重写字节与 parts 增删集。
pub fn plan_sheet_ops(
    archive: &mut ZipArchive<File>,
    ops: &[SheetOp],
    sheet_order: &[String],
) -> Result<SheetPlanResult, SidecarError> {
    let workbook_xml = read_zip_string(archive, WORKBOOK_PATH)?;
    let rels_xml = read_zip_string(archive, RELS_PATH)?;
    let content_types_xml = read_zip_string(archive, CONTENT_TYPES_PATH)
        .map_err(|_| SidecarError::Workbook("Workbook missing [Content_Types].xml.".into()))?;
    let rels: HashMap<String, String> = read_relationship_rows(&rels_xml)?
        .into_iter()
        .map(|(id, _, target)| (id, target))
        .collect();
    let sources = read_source_sheets(&workbook_xml, &rels)?;
    let overrides = read_ws_overrides(&content_types_xml);
    let (max_part, max_sheet_id, max_r_id) =
        max_numeric_suffix(&sources, &overrides, rels.keys().map(String::as_str));

    let mut rows: Vec<SheetPlanRow> = sources
        .iter()
        .map(|sheet| SheetPlanRow {
            engine_id: sheet.engine_id.clone(),
            name: sheet.name.clone(),
            sheet_id_attr: sheet.sheet_id_attr.clone(),
            r_id: sheet.r_id.clone(),
            part_path: sheet.part_path.clone(),
            hidden: sheet.hidden,
        })
        .collect();
    let mut id_map: HashMap<String, String> = HashMap::new();
    for row in &rows {
        id_map.insert(row.engine_id.clone(), row.engine_id.clone());
    }
    let mut added_content: HashMap<String, Vec<u8>> = HashMap::new(); // part 路径 → 内容
    let mut added_parts: Vec<String> = Vec::new(); // /xl/worksheets/sheetN.xml 形式
    let mut removed_parts: HashSet<String> = HashSet::new();
    let mut next_sheet_id = max_sheet_id;
    let mut next_r_id = max_r_id;
    let mut next_part_index = max_part;

    for op in ops {
        match op.kind.as_str() {
            "add-sheet" => {
                let name = op.name.clone().ok_or_else(|| {
                    SidecarError::InvalidRequest("add-sheet needs a name.".into())
                })?;
                next_sheet_id += 1;
                next_r_id += 1;
                next_part_index += 1;
                let part_path = format!("xl/worksheets/sheet{next_part_index}.xml");
                let engine_id = format!("sheet-{next_sheet_id}");
                let content = blank_worksheet_xml();
                id_map.insert(
                    op.sheet_id.clone().unwrap_or_else(|| engine_id.clone()),
                    engine_id.clone(),
                );
                added_content.insert(part_path.clone(), content);
                added_parts.push(format!("/{part_path}"));
                rows.push(SheetPlanRow {
                    engine_id,
                    name,
                    sheet_id_attr: next_sheet_id.to_string(),
                    r_id: format!("rId{next_r_id}"),
                    part_path,
                    hidden: false,
                });
            }
            "duplicate-sheet" => {
                let name = op.name.clone().ok_or_else(|| {
                    SidecarError::InvalidRequest("duplicate-sheet needs a name.".into())
                })?;
                let source_id = op.source_sheet_id.clone().ok_or_else(|| {
                    SidecarError::InvalidRequest("duplicate-sheet needs sourceSheetId.".into())
                })?;
                let source_engine = id_map
                    .get(&source_id)
                    .cloned()
                    .unwrap_or_else(|| source_id.clone());
                let source_part = rows
                    .iter()
                    .find(|row| row.engine_id == source_engine)
                    .map(|row| row.part_path.clone())
                    .ok_or_else(|| {
                        SidecarError::InvalidRequest(format!(
                            "Unknown duplicate source {source_id}."
                        ))
                    })?;
                let content = if let Some(bytes) = added_content.get(&source_part) {
                    bytes.clone()
                } else {
                    let mut entry = crate::xml_util::zip_entry(archive, &source_part)
                        .map_err(|_| {
                            SidecarError::Workbook(format!(
                                "Workbook is missing {source_part}."
                            ))
                        })?;
                    let mut bytes = Vec::new();
                    use std::io::Read;
                    entry.read_to_end(&mut bytes)?;
                    bytes
                };
                next_sheet_id += 1;
                next_r_id += 1;
                next_part_index += 1;
                let part_path = format!("xl/worksheets/sheet{next_part_index}.xml");
                let engine_id = format!("sheet-{next_sheet_id}");
                id_map.insert(
                    op.sheet_id.clone().unwrap_or_else(|| engine_id.clone()),
                    engine_id.clone(),
                );
                added_content.insert(part_path.clone(), content);
                added_parts.push(format!("/{part_path}"));
                rows.push(SheetPlanRow {
                    engine_id,
                    name,
                    sheet_id_attr: next_sheet_id.to_string(),
                    r_id: format!("rId{next_r_id}"),
                    part_path,
                    hidden: false,
                });
            }
            "remove-sheet" => {
                let sheet = op.sheet_id.clone().ok_or_else(|| {
                    SidecarError::InvalidRequest("remove-sheet needs sheetId.".into())
                })?;
                let engine_id = id_map
                    .get(&sheet)
                    .cloned()
                    .unwrap_or_else(|| sheet.clone());
                let position = rows
                    .iter()
                    .position(|row| row.engine_id == engine_id)
                    .ok_or_else(|| {
                        SidecarError::InvalidRequest(format!("Unknown worksheet {sheet}."))
                    })?;
                let row = rows.remove(position);
                if added_content.contains_key(&row.part_path) {
                    added_content.remove(&row.part_path);
                    added_parts.retain(|part| part != &format!("/{}", row.part_path));
                } else {
                    removed_parts.insert(row.part_path.clone());
                }
            }
            "rename-sheet" => {
                let new_name = op.new_name.clone().ok_or_else(|| {
                    SidecarError::InvalidRequest("rename-sheet needs newName.".into())
                })?;
                let sheet = op.sheet_id.clone().ok_or_else(|| {
                    SidecarError::InvalidRequest("rename-sheet needs sheetId.".into())
                })?;
                let engine_id = id_map
                    .get(&sheet)
                    .cloned()
                    .unwrap_or_else(|| sheet.clone());
                let row = rows
                    .iter_mut()
                    .find(|row| row.engine_id == engine_id)
                    .ok_or_else(|| {
                        SidecarError::InvalidRequest(format!("Unknown worksheet {sheet}."))
                    })?;
                row.name = new_name;
            }
            "set-sheet-hidden" => {
                let hidden = op.hidden.ok_or_else(|| {
                    SidecarError::InvalidRequest("set-sheet-hidden needs hidden.".into())
                })?;
                let sheet = op.sheet_id.clone().ok_or_else(|| {
                    SidecarError::InvalidRequest("set-sheet-hidden needs sheetId.".into())
                })?;
                let engine_id = id_map
                    .get(&sheet)
                    .cloned()
                    .unwrap_or_else(|| sheet.clone());
                let row = rows
                    .iter_mut()
                    .find(|row| row.engine_id == engine_id)
                    .ok_or_else(|| {
                        SidecarError::InvalidRequest(format!("Unknown worksheet {sheet}."))
                    })?;
                row.hidden = hidden;
            }
            "reorder-sheets" => {
                // sheetOrder 数组在请求顶层；顺序逻辑统一在下方按 sheet_order 应用。
            }
            other => {
                return Err(SidecarError::InvalidRequest(format!(
                    "Unsupported sheet operation: {other}"
                )));
            }
        }
    }

    // 最终顺序：若请求带非空 sheetOrder（renderer 的 tab 全序），按它重排；
    // 否则保持处理后的行序。每个元素先按 id_map 归一到引擎 id。
    if !sheet_order.is_empty() {
        let mut ordered: Vec<SheetPlanRow> = Vec::with_capacity(rows.len());
        let mut seen: HashSet<String> = HashSet::new();
        for id in sheet_order {
            let engine_id = id_map.get(id).cloned().unwrap_or_else(|| id.clone());
            if !seen.insert(engine_id.clone()) {
                continue;
            }
            if let Some(row) = rows.iter().find(|row| row.engine_id == engine_id).cloned() {
                ordered.push(row);
            }
        }
        if ordered.len() < rows.len() {
            // 兜底：sheetOrder 未覆盖的 sheet（理论上不会出现）追加在尾部。
            for row in rows.iter().filter(|row| !seen.contains(&row.engine_id)) {
                ordered.push(row.clone());
            }
        }
        rows = ordered;
    }

    // 最终 r_id 集合（含新增），用于 rels 保留判断。
    let final_r_ids: HashSet<String> = rows.iter().map(|row| row.r_id.clone()).collect();
    let add_relations: Vec<(String, String)> = rows
        .iter()
        .filter(|row| !sources.iter().any(|sheet| sheet.r_id == row.r_id))
        .map(|row| {
            let target = row
                .part_path
                .strip_prefix("xl/")
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| row.part_path.clone());
            (row.r_id.clone(), target)
        })
        .collect();

    let new_workbook = rewrite_workbook_sheets(&workbook_xml, &rows)?;
    let new_rels = rewrite_workbook_rels(&rels_xml, &final_r_ids, &add_relations)?;
    let new_content_types = rewrite_content_types(&content_types_xml, &removed_parts, &added_parts)?;

    Ok(SheetPlanResult {
        workbook_xml: new_workbook,
        rels_xml: new_rels,
        content_types_xml: new_content_types,
        part_additions: added_content.into_iter().collect(),
        part_removals: removed_parts.into_iter().collect(),
        id_map,
        rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_fixture(entries: &[(&str, &str)]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.xlsx");
        let file = File::create(&path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, content) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
        (dir, path)
    }

    const WORKBOOK: &str = r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="0"/><sheets><sheet name="A" sheetId="1" r:id="rId1"/><sheet name="B" sheetId="2" r:id="rId2"/></sheets></workbook>"#;
    const RELS: &str = r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#;
    const CONTENT_TYPES: &str = r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>"#;

    fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        write_fixture(&[
            ("xl/workbook.xml", WORKBOOK),
            ("xl/_rels/workbook.xml.rels", RELS),
            ("[Content_Types].xml", CONTENT_TYPES),
            ("xl/worksheets/sheet1.xml", r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>"#),
            ("xl/worksheets/sheet2.xml", r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>2</v></c></row></sheetData></worksheet>"#),
        ])
    }

    fn run_op(
        ops: &[SheetOp],
        order: &[String],
    ) -> Result<SheetPlanResult, SidecarError> {
        let (_dir, path) = fixture();
        let file = File::open(&path).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        plan_sheet_ops(&mut archive, ops, order)
    }

    #[test]
    fn plan_add_and_rename_and_order() {
        let plan = run_op(
            &[
                SheetOp {
                    kind: "add-sheet".into(),
                    sheet_id: Some("tmp-9".into()),
                    name: Some("C".into()),
                    ..Default::default()
                },
                SheetOp {
                    kind: "rename-sheet".into(),
                    sheet_id: Some("sheet-1".into()),
                    new_name: Some("Alpha".into()),
                    ..Default::default()
                },
            ],
            &["sheet-2".into(), "tmp-9".into(), "sheet-1".into()],
        )
        .unwrap();
        assert_eq!(plan.rows.len(), 3);
        assert_eq!(plan.id_map.get("tmp-9").unwrap(), "sheet-3");
        assert_eq!(plan.rows[0].engine_id, "sheet-2");
        assert_eq!(plan.rows[2].name, "Alpha");
        let wb = String::from_utf8(plan.workbook_xml).unwrap();
        assert!(wb.contains(r#"<sheet name="Alpha" sheetId="1" r:id="rId1"/>"#));
        assert!(wb.contains(r#"<sheet name="C" sheetId="3" r:id="rId4"/>"#));
        assert!(wb.contains(r#"<workbookPr date1904="0"/>"#), "保留非 sheets 节点");
        // reorder 生效：sheet-2 在首个 <sheet>。
        let first = wb.find("r:id=\"rId2\"").unwrap();
        let second = wb.find("r:id=\"rId4\"").unwrap();
        let third = wb.find("r:id=\"rId1\"").unwrap();
        assert!(first < second && second < third);
        // rId 命名空间是 rels 全局的：styles 用掉了 rId3，新 sheet 必须用 rId4，
        // 否则 excel 打开即损坏。
        assert_eq!(plan.rows[1].r_id, "rId4");
        let rels = String::from_utf8(plan.rels_xml).unwrap();
        assert!(rels.contains(r#"Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml""#));
        assert!(rels.contains(r#"Target="styles.xml""#), "保留 styles 关系");
        let ct = String::from_utf8(plan.content_types_xml).unwrap();
        assert!(ct.contains(r#"PartName="/xl/worksheets/sheet3.xml""#));
        assert!(ct.contains(r#"PartName="/xl/styles.xml""#));
    }

    #[test]
    fn plan_remove_sheet_touches_all_three_parts() {
        let plan = run_op(
            &[SheetOp {
                kind: "remove-sheet".into(),
                sheet_id: Some("sheet-1".into()),
                ..Default::default()
            }],
            &[],
        )
        .unwrap();
        assert_eq!(plan.rows.len(), 1);
        assert_eq!(plan.rows[0].engine_id, "sheet-2");
        assert_eq!(plan.part_removals, vec!["xl/worksheets/sheet1.xml".to_owned()]);
        let wb = String::from_utf8(plan.workbook_xml).unwrap();
        assert!(!wb.contains(r#"sheetId="1""#));
        let rels = String::from_utf8(plan.rels_xml).unwrap();
        assert!(!rels.contains(r#"Id="rId1""#));
        assert!(rels.contains(r#"Id="rId2""#));
        let ct = String::from_utf8(plan.content_types_xml).unwrap();
        assert!(!ct.contains(r#"PartName="/xl/worksheets/sheet1.xml""#));
        assert!(ct.contains(r#"PartName="/xl/worksheets/sheet2.xml""#));
    }

    #[test]
    fn plan_duplicate_and_hidden() {
        let plan = run_op(
            &[
                SheetOp {
                    kind: "duplicate-sheet".into(),
                    sheet_id: Some("tmp-dup".into()),
                    name: Some("Copy of A".into()),
                    source_sheet_id: Some("sheet-1".into()),
                    ..Default::default()
                },
                SheetOp {
                    kind: "set-sheet-hidden".into(),
                    sheet_id: Some("sheet-2".into()),
                    hidden: Some(true),
                    ..Default::default()
                },
            ],
            &[],
        )
        .unwrap();
        assert_eq!(plan.rows.len(), 3);
        assert!(plan.rows[1].hidden, "B → hidden");
        let copy = plan
            .part_additions
            .iter()
            .find(|(path, _)| *path == "xl/worksheets/sheet3.xml")
            .expect("duplicate part added");
        let text = String::from_utf8(copy.1.clone()).unwrap();
        assert!(text.contains(r#"<v>1</v>"#), "复制了源内容");
        let wb = String::from_utf8(plan.workbook_xml).unwrap();
        assert!(wb.contains(r#"<sheet name="Copy of A" sheetId="3" r:id="rId4""#));
        assert!(wb.contains(r#"<sheet name="B" sheetId="2" r:id="rId2" state="hidden"/>"#));
    }
}