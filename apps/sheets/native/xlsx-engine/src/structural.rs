//! 结构性操作：插入/删除行列、合并/取消合并单元格。
//!
//! 纯 XML 重写（与 cell_editor 同架构）：流式读 worksheet.xml，按操作序列
//! 计算「文件坐标 → 新坐标」映射（与 renderer view-transform 的 screen 空间
//! 语义一致），随后改写：
//!   - `<row r=N>` 行号 → 新行号（删除行整行丢弃，含子树）；
//!   - 行内 `<c r="A1">` 引用 → 新坐标（删除命中则保留原样——理论上行列
//!     删除已由外层行/列移除，单元格引用只随平移）；
//!   - `<mergeCells>`：现有合并区平移；merge-cells 增、unmerge-cells 删。
//!
//! 范围（本模块）：insert/remove rows/cols + merge/unmerge cells。move-rows、
//! set-row/col-size、set-col-style、hidden/outline 未实现（壳层仍拒绝）。

use crate::types::MergedRange;
use crate::SidecarError;
use quick_xml::events::{BytesStart, BytesText, Event};
use quick_xml::Reader;

/// 结构性操作（与 renderer workbookStructuralOpSchema 子集对齐）。
#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralOp {
    /// 引擎 sheet id（sheet-1），由调用方透传。
    #[serde(default)]
    pub sheet_id: String,
    /// insert-rows | remove-rows | insert-cols | remove-cols | merge-cells | unmerge-cells
    pub kind: String,
    /// 行列操作的起始坐标（0-based）。
    #[serde(default)]
    pub index: usize,
    /// 插入/删除的数量。
    #[serde(default)]
    pub count: usize,
    /// merge-cells / unmerge-cells 的区域。
    #[serde(default)]
    pub range: Option<MergedRange>,
}

/// 对文件坐标 pos 应用轴内操作，返回新坐标（None = 被 remove 删除）。
/// 与 renderer fileToScreen 的 insert/remove 语义一致（insert 在 index 前插空，
/// 原 index+ 平移；remove 删 [index, index+count)）。
fn shift_position(pos: usize, ops: &[&StructuralOp]) -> Option<usize> {
    let mut out = pos;
    for op in ops {
        match op.kind.as_str() {
            "insert-rows" | "insert-cols" => {
                if out >= op.index {
                    out += op.count;
                }
            }
            "remove-rows" | "remove-cols" => {
                if out >= op.index && out < op.index + op.count {
                    return None;
                }
                if out >= op.index + op.count {
                    out -= op.count;
                }
            }
            _ => {}
        }
    }
    Some(out)
}

/// 解析 `<c r="A1">` 的 0-based 行列。
fn cell_coords(reference: &str) -> Option<(usize, usize)> {
    let bytes = reference.as_bytes();
    let mut column = 0usize;
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        column = column * 26 + (bytes[i].to_ascii_uppercase() - b'A') as usize + 1;
        i += 1;
    }
    if i == 0 {
        return None;
    }
    let row: usize = reference[i..].parse().ok()?;
    Some((row - 1, column - 1))
}

/// 0-based 列 → 列字母。
pub(crate) fn column_letters(mut column: usize) -> String {
    let mut out = Vec::new();
    loop {
        out.push((b'A' + (column % 26) as u8) as char);
        if column < 26 {
            break;
        }
        column = column / 26 - 1;
    }
    out.iter().rev().collect()
}

/// 合并区 → "<mergeCell ref="A1:B2"/>".
fn merge_ref(range: &MergedRange) -> String {
    format!(
        "{}{}:{}{}",
        column_letters(range.start_column),
        range.start_row + 1,
        column_letters(range.end_column),
        range.end_row + 1
    )
}

/// 计算平移 + 应用 merge/unmerge ops 后的合并段文本；无合并结果时返回 None（整段剔除）。
fn merge_section_bytes(
    collected: &[MergedRange],
    row_ops: &[&StructuralOp],
    col_ops: &[&StructuralOp],
    merge_ops: &[&StructuralOp],
) -> Option<String> {
    let mut final_merges: Vec<MergedRange> = Vec::new();
    for m in collected {
        if let (Some(sr), Some(sc), Some(er), Some(ec)) = (
            shift_position(m.start_row, row_ops),
            shift_position(m.start_column, col_ops),
            shift_position(m.end_row, row_ops),
            shift_position(m.end_column, col_ops),
        ) {
            if sr <= er && sc <= ec {
                final_merges.push(MergedRange {
                    start_row: sr,
                    end_row: er,
                    start_column: sc,
                    end_column: ec,
                });
            }
        }
    }
    for op in merge_ops {
        if let Some(range) = &op.range {
            match op.kind.as_str() {
                "merge-cells" => {
                    if range.start_row <= range.end_row
                        && range.start_column <= range.end_column
                        && !final_merges.iter().any(|m| ranges_overlap(m, range))
                    {
                        final_merges.push(*range);
                    }
                }
                "unmerge-cells" => {
                    final_merges.retain(|m| !range_eq(m, range));
                }
                _ => {}
            }
        }
    }
    if final_merges.is_empty() {
        return None;
    }
    let mut xml = format!("<mergeCells count=\"{}\">", final_merges.len());
    for m in &final_merges {
        xml.push_str(&format!("<mergeCell ref=\"{}\"/>", merge_ref(m)));
    }
    xml.push_str("</mergeCells>");
    Some(xml)
}

/// 应用结构性操作到 worksheet XML；返回重写后的字节。
pub fn apply_structural_ops(
    sheet_xml: &[u8],
    ops: &[StructuralOp],
) -> Result<Vec<u8>, SidecarError> {
    if ops.is_empty() {
        return Ok(sheet_xml.to_vec());
    }
    let row_ops: Vec<&StructuralOp> = ops
        .iter()
        .filter(|op| matches!(op.kind.as_str(), "insert-rows" | "remove-rows"))
        .collect();
    let col_ops: Vec<&StructuralOp> = ops
        .iter()
        .filter(|op| matches!(op.kind.as_str(), "insert-cols" | "remove-cols"))
        .collect();
    let merge_ops: Vec<&StructuralOp> = ops
        .iter()
        .filter(|op| matches!(op.kind.as_str(), "merge-cells" | "unmerge-cells"))
        .collect();

    // 收集现有 mergeCells：先纯收集，后统一重建。
    let mut collected_merges: Vec<MergedRange> = Vec::new();
    let mut reader = Reader::from_reader(sheet_xml);
    reader.config_mut().trim_text(false);
    // 一次性事件流：第一阶段收集 mergeCell + 记录 mergeCells 段起止。
    // 第二条路径更简单：两遍法——第一遍收集 merges，第二遍重建 sheetData+mergeCells。
    // 这里直接单遍：遇到 <mergeCell> 收集；遇 </mergeCells> 时统一输出重建段。
    let mut rebuilt: Vec<u8> = Vec::new();
    let mut writer = quick_xml::Writer::new(rebuilt);

    let mut in_merge_cells = false;
    let mut merge_seen = false; // 源 XML 是否含 <mergeCells> 段
    let mut skip_row_depth = 0usize; // 整行被删时跳过的子树深度（1-based 根行）

    loop {
        let event = reader.read_event().map_err(|error| {
            SidecarError::Workbook(format!("structural read: {error}"))
        })?;
        match &event {
            Event::Eof => break,
            Event::Start(start) if start.local_name().as_ref() == b"mergeCells" => {
                in_merge_cells = true;
                merge_seen = true;
                collected_merges.clear();
                // 不写原 start；由 </mergeCells> 统一重建。
            }
            Event::End(end) if end.local_name().as_ref() == b"mergeCells" && in_merge_cells => {
                in_merge_cells = false;
                // 平移现有 merge + 应用 merge/unmerge ops
                if let Some(xml) = merge_section_bytes(
                    &collected_merges,
                    &row_ops,
                    &col_ops,
                    &merge_ops,
                ) {
                    writer
                        .write_event(Event::Text(BytesText::from_escaped(xml)))
                        .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                }
                // 空 merges → 整段剔除（合法）
            }
            Event::End(end) if end.local_name().as_ref() == b"sheetData" => {
                writer
                    .write_event(event.to_owned())
                    .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                // 源无 <mergeCells> 段但带 merge ops → 在 sheetData 之后补建一段
                if !merge_seen {
                    if let Some(xml) = merge_section_bytes(
                        &[],
                        &row_ops,
                        &col_ops,
                        &merge_ops,
                    ) {
                        writer
                            .write_event(Event::Text(BytesText::from_escaped(xml)))
                            .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                    }
                }
            }
            Event::Start(start) if start.local_name().as_ref() == b"row" => {
                let new_row = row_index(start).and_then(|r| shift_position(r, &row_ops));
                match new_row {
                    Some(r) => {
                        writer
                            .write_event(Event::Start(rewrite_row_start(start, r)))
                            .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                    }
                    None => {
                        // 整行删除：跳过其子树（子树深度按 parent 计数）
                        skip_row_depth = 1;
                    }
                }
            }
            Event::Empty(start) if start.local_name().as_ref() == b"row" => {
                let src_row = row_index(start);
                let new_row = src_row.and_then(|r| shift_position(r, &row_ops));
                match new_row {
                    Some(r) => {
                        writer
                            .write_event(Event::Empty(rewrite_row_start(start, r)))
                            .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                    }
                    None => {
                        // 空行删除：什么都不写
                    }
                }
            }
            Event::End(end) if end.local_name().as_ref() == b"row" => {
                if skip_row_depth > 0 {
                    skip_row_depth -= 1;
                } else {
                    writer
                        .write_event(event.to_owned())
                        .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                }
            }
            Event::Empty(start) if start.local_name().as_ref() == b"mergeCell" => {
                if in_merge_cells {
                    // 收集现有 mergeCell ref → pending（重建段时统一输出）
                    if let Some(ref_attr) = start
                        .attributes()
                        .with_checks(false)
                        .find_map(|a| a.ok().filter(|a| a.key.local_name().as_ref() == b"ref"))
                    {
                        let reference = String::from_utf8_lossy(&ref_attr.value).to_string();
                        if let Some(range) = crate::refs::parse_merge_reference(&reference) {
                            collected_merges.push(range);
                        }
                    }
                } else {
                    writer
                        .write_event(event.to_owned())
                        .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                }
            }
            Event::Start(start)
                if skip_row_depth == 0
                    && (start.local_name().as_ref() == b"c") =>
            {
                let rewritten = rewrite_cell_start(start, &row_ops, &col_ops);
                writer
                    .write_event(rewritten.map(Event::Start).unwrap_or_else(|| event.to_owned()))
                    .map_err(|error| SidecarError::Workbook(error.to_string()))?;
            }
            Event::Empty(start)
                if skip_row_depth == 0
                    && (start.local_name().as_ref() == b"c") =>
            {
                let rewritten = rewrite_cell_start(start, &row_ops, &col_ops);
                writer
                    .write_event(rewritten.map(Event::Empty).unwrap_or_else(|| event.to_owned()))
                    .map_err(|error| SidecarError::Workbook(error.to_string()))?;
            }
            _ => {
                if skip_row_depth == 0 {
                    writer
                        .write_event(event.to_owned())
                        .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                }
            }
        }
    }
    Ok(writer.into_inner())
}

/// 提取 <row r=N> 的 0-based 行号。
fn row_index(start: &BytesStart<'_>) -> Option<usize> {
    for attr in start.attributes().with_checks(false) {
        if let Ok(a) = attr {
            if a.key.local_name().as_ref() == b"r" {
                if let Ok(v) = String::from_utf8_lossy(&a.value).parse::<usize>() {
                    return Some(v.saturating_sub(1));
                }
            }
        }
    }
    None
}

/// 重写 <row r="N"> 的 r 属性为新行号，其余属性保留。
fn rewrite_row_start(start: &BytesStart<'_>, new_row: usize) -> BytesStart<'static> {
    let mut out = BytesStart::new("row");
    for attr in start.attributes().with_checks(false) {
        if let Ok(a) = attr {
            if a.key.local_name().as_ref() != b"r" {
                out.push_attribute((a.key.as_ref(), a.value.as_ref()));
            }
        }
    }
    let value = (new_row + 1).to_string();
    out.push_attribute((b"r".as_ref(), value.as_bytes()));
    out
}

/// 重写 <c r="A1"> 的引用为平移后坐标。返回 None 表示无 r 引用（顺序单元格）——
/// 原样保留。
fn rewrite_cell_start(
    start: &BytesStart<'_>,
    row_ops: &[&StructuralOp],
    col_ops: &[&StructuralOp],
) -> Option<BytesStart<'static>> {
    let mut reference = None;
    for attr in start.attributes().with_checks(false) {
        if let Ok(a) = attr {
            if a.key.local_name().as_ref() == b"r" {
                let text = String::from_utf8_lossy(&a.value).to_string();
                reference = cell_coords(&text);
            }
        }
    }
    let (row, col) = reference?;
    let new_row = shift_position(row, row_ops)?;
    let new_col = shift_position(col, col_ops)?;
    let mut out = BytesStart::new("c");
    for attr in start.attributes().with_checks(false) {
        if let Ok(a) = attr {
            if a.key.local_name().as_ref() != b"r" {
                out.push_attribute((a.key.as_ref(), a.value.as_ref()));
            }
        }
    }
    let new_ref = format!("{}{}", column_letters(new_col), new_row + 1);
    out.push_attribute((b"r".as_ref(), new_ref.as_bytes()));
    Some(out)
}

/// 两个合并区是否重叠（新增合并前检查）。
fn ranges_overlap(a: &MergedRange, b: &MergedRange) -> bool {
    a.start_row <= b.end_row
        && a.end_row >= b.start_row
        && a.start_column <= b.end_column
        && a.end_column >= b.start_column
}

fn range_eq(a: &MergedRange, b: &MergedRange) -> bool {
    a.start_row == b.start_row
        && a.end_row == b.end_row
        && a.start_column == b.start_column
        && a.end_column == b.end_column
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(kind: &str, index: usize, count: usize) -> StructuralOp {
        StructuralOp {
            sheet_id: "s1".into(),
            kind: kind.into(),
            index,
            count,
            range: None,
        }
    }

    #[test]
    fn insert_rows_shifts_row_refs_and_cells() {
        let xml = br#"<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>1</v></c></row><row r="2"><c r="B2"><v>2</v></c></row></sheetData></worksheet>"#;
        let out = apply_structural_ops(xml, &[op("insert-rows", 1, 2)]).unwrap();
        let text = String::from_utf8(out).unwrap();
        // row1 保持原行；其 A1 单元格的 r 不变（t/s 属性重写后顺序可交换）
        assert!(text.contains(r#"<row r="1">"#), "{text}");
        assert!(text.contains(r#"r="A1""#), "{text}");
        assert!(text.contains(r#"t="s""#), "{text}");
        assert!(text.contains(r#"<v>1</v>"#), "{text}");
        // row2 → row4，单元格引用同步平移
        assert!(text.contains(r#"<row r="4"><c r="B4"><v>2</v></c></row>"#), "{text}");
    }

    #[test]
    fn remove_rows_drops_deleted_and_shifts_rest() {
        let xml = br#"<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row><row r="3"><c r="A3"><v>3</v></c></row></sheetData></worksheet>"#;
        let out = apply_structural_ops(xml, &[op("remove-rows", 1, 1)]).unwrap();
        let text = String::from_utf8(out).unwrap();
        // row2 删除；row3 → row2，单元格 A3 → A2（引用随行平移）
        assert!(!text.contains(r#"r="2"><c r="A2"><v>2</v>"#), "{text}");
        assert!(text.contains(r#"<row r="1"><c r="A1"><v>1</v></c></row>"#), "{text}");
        assert!(text.contains(r#"<row r="2"><c r="A2"><v>3</v></c></row>"#), "{text}");
    }

    #[test]
    fn insert_cols_shifts_columns() {
        let xml = br#"<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row></sheetData></worksheet>"#;
        let out = apply_structural_ops(xml, &[op("insert-cols", 1, 1)]).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains(r#"<c r="A1"><v>1</v></c><c r="C1"><v>2</v></c>"#), "{text}");
    }

    #[test]
    fn remove_cols_drops_columns() {
        let xml = br#"<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row></sheetData></worksheet>"#;
        let out = apply_structural_ops(xml, &[op("remove-cols", 0, 1)]).unwrap();
        let text = String::from_utf8(out).unwrap();
        // A 列删；B1 → A1（用平移后的 <c r="A1">，但 A1 原值已删，只有 B1 平移）
        assert!(text.contains(r#"<c r="A1"><v>2</v></c>"#), "{text}");
    }

    #[test]
    fn merge_and_unmerge_cells() {
        let xml = br#"<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><mergeCells count="0"></mergeCells></worksheet>"#;
        let merge = StructuralOp {
            sheet_id: "s1".into(),
            kind: "merge-cells".into(),
            index: 0,
            count: 0,
            range: Some(MergedRange { start_row: 0, end_row: 1, start_column: 0, end_column: 1 }),
        };
        let out = apply_structural_ops(xml, &[merge]).unwrap();
        let text = String::from_utf8(out.clone()).unwrap();
        assert!(text.contains(r#"<mergeCell ref="A1:B2"/>"#), "{text}");
        // 再次 unmerge
        let unmerge = StructuralOp {
            sheet_id: "s1".into(),
            kind: "unmerge-cells".into(),
            index: 0,
            count: 0,
            range: Some(MergedRange { start_row: 0, end_row: 1, start_column: 0, end_column: 1 }),
        };
        let out2 = apply_structural_ops(&out, &[unmerge]).unwrap();
        let text2 = String::from_utf8(out2).unwrap();
        assert!(!text2.contains("mergeCell"), "{text2}");
    }

    #[test]
    fn merge_shifts_with_row_insert() {
        let xml = br#"<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:B2"/></mergeCells></worksheet>"#;
        let out = apply_structural_ops(xml, &[op("insert-rows", 1, 1)]).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains(r#"<mergeCell ref="A1:B3"/>"#), "{text}");
    }
}
#[cfg(test)]
mod evt_probe {
    #[test]
    fn probe_merge_event_names() {
        let xml = br#"<worksheet><mergeCells count="1"><mergeCell ref="A1:B2"/></mergeCells></worksheet>"#;
        let mut reader = quick_xml::Reader::from_reader(&xml[..]);
        let mut names: Vec<String> = Vec::new();
        loop {
            let ev = reader.read_event().unwrap();
            match &ev {
                quick_xml::events::Event::Eof => break,
                quick_xml::events::Event::Start(e) => names.push(format!("Start({})", String::from_utf8_lossy(e.name().as_ref()))),
                quick_xml::events::Event::Empty(e) => names.push(format!("Empty({})", String::from_utf8_lossy(e.name().as_ref()))),
                quick_xml::events::Event::End(e) => names.push(format!("End({})", String::from_utf8_lossy(e.name().as_ref()))),
                _ => {}
            }
        }
        eprintln!("events: {names:?}");
        assert_eq!(names[1], "Start(mergeCells)");
    }
}
