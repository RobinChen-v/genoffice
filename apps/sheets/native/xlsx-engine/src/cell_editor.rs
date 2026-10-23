//! Minimal worksheet XML editor for the M5 incremental save path.
//!
//! Scope (v1, "值优先" + M5.2b "样式编辑"): replaced/added cell **values**
//! (numbers, strings via inlineStr, formulas with a cached value, explicit
//! clears), plus **style** deltas (bold/font/fill/alignment/number format/
//! borders…, `styleReset`) merged through the styles.xml editor. Replaced
//! cells keep their original `s` attribute; a style edit writes the new
//! `s` returned by the styles editor; new cells take whatever `s` a delta
//! produces (none otherwise); `styleReset` drops `s` entirely (default xf).
//! Rich text, booleans and structural edits stay out of scope and are
//! rejected upstream by the host bridge.
//!
//! The editor streams the worksheet XML through quick-xml and rewrites only
//! the touched cells, keeping every other node as-is. Inserted XML fragments
//! are emitted as Raw events (byte-exact, no re-escaping). New cells:
//!   - into an existing row  -> appended at that row's end (before </row>)
//!   - into a missing row    -> a new <row r="N"> appended at </sheetData>
//!     end (Excel accepts out-of-order rows).

use std::collections::HashSet;

use quick_xml::Reader;
use quick_xml::events::{BytesStart, BytesText, Event};
use serde::{Deserialize, Serialize};

use crate::styles_editor::{StyleDelta, StylesEditor};
use crate::SidecarError;

/// One cell edit, 0-based row/column like every engine range.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellEdit {
    /// Engine sheet id (matches SheetMetadata.id — the id the renderer used
    /// for read_range), so the host can group edits per worksheet part.
    #[serde(default)]
    pub sheet_id: String,
    pub row: usize,
    pub column: usize,
    /// number | string | formula | boolean | rich | clear | style
    pub kind: String,
    /// For number/string/formula-cached: the rendered value text.
    #[serde(default)]
    pub value: Option<String>,
    /// For formula kind, the formula text (may start with '='); the engine
    /// stores it without the leading '='.
    #[serde(default)]
    pub formula: Option<String>,
    /// For rich kind: per-run styled text (inlineStr multi-<r>). `value` (if
    /// provided) holds the joined plain text for the shared string cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rich: Option<Vec<crate::types::RichRun>>,
    /// M5.2b: renderer style delta — merge into the cell's current xf before
    /// rewriting (the new `s` replaces the preserved one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<StyleDelta>,
    /// M5.2b: styleReset ("Clear Formats") — the cell's `s` drops to the
    /// default xf (no `s` attribute); a `style` delta rides on top of it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub style_reset: bool,
}

fn column_letter(mut column: usize) -> String {
    let mut out = String::new();
    loop {
        out.insert(0, (b'A' + (column % 26) as u8) as char);
        if column < 26 {
            break;
        }
        column = column / 26 - 1;
    }
    out
}

fn xml_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// One <r> of a rich-text inlineStr cell: <r><rPr>…flags/sz/color/rFont/vertAlign…</rPr><t xml:space="preserve">…</t></r>.
/// Bold/italic/underline/strike are emitted only when set (Excel's default is
/// absent = off), matching how shared-string rich runs serialize on read.
fn rich_run_xml(run: &crate::types::RichRun) -> String {
    let mut rpr = String::new();
    if run.bold { rpr.push_str("<b/>"); }
    if run.italic { rpr.push_str("<i/>"); }
    if run.underline { rpr.push_str("<u/>"); }
    if run.strikethrough { rpr.push_str("<strike/>"); }
    if let Some(vert) = &run.vert_align {
        rpr.push_str(&format!("<vertAlign val=\"{}\"/>", xml_escape(vert)));
    }
    if let Some(size) = run.size {
        rpr.push_str(&format!("<sz val=\"{size}\"/>"));
    }
    if let Some(color) = &run.color {
        // renderer 传 #RRGGBB；OOXML <color rgb> 需 8 位（Alpha+RRGGBB）
        let clean = color.trim_start_matches('#');
        let rgb = if clean.len() == 6 { format!("FF{clean}") } else { clean.to_string() };
        rpr.push_str(&format!("<color rgb=\"{}\"/>", xml_escape(&rgb)));
    }
    if let Some(family) = &run.family {
        rpr.push_str(&format!("<rFont val=\"{}\"/>", xml_escape(family)));
    }
    let text = xml_escape(&run.text);
    if rpr.is_empty() {
        format!("<r><t xml:space=\"preserve\">{text}</t></r>")
    } else {
        format!("<r><rPr>{rpr}</rPr><t xml:space=\"preserve\">{text}</t></r>")
    }
}

/// Builds the XML fragment for one edited cell. `style_attr` is the `s=".."`
/// fragment to write (empty → no `s` attribute), resolved by the caller from
/// the cell's current style state and the edit's delta.
fn cell_xml(edit: &CellEdit, style_attr: &str, reference: &str) -> String {
    let style = if style_attr.is_empty() {
        String::new()
    } else {
        format!(" {style_attr}")
    };
    match edit.kind.as_str() {
        "clear" => format!("<c r=\"{reference}\"{style}/>"),
        "style" => format!("<c r=\"{reference}\"{style}/>"),
        "string" => {
            let text = xml_escape(edit.value.as_deref().unwrap_or(""));
            format!(
                "<c r=\"{reference}\"{style} t=\"inlineStr\"><is><t xml:space=\"preserve\">{text}</t></is></c>"
            )
        }
        "formula" => {
            let raw = edit.formula.as_deref().unwrap_or("");
            let formula = xml_escape(raw.strip_prefix('=').unwrap_or(raw));
            let cached = xml_escape(edit.value.as_deref().unwrap_or("0"));
            format!("<c r=\"{reference}\"{style}><f>{formula}</f><v>{cached}</v></c>")
        }
        // ECMA-376 <c t="b">: value 1/true/TRUE = true, anything else false.
        // The renderer writes boolean cell edits (checkbox / TRUE-FALSE).
        "boolean" => {
            let raw = edit.value.as_deref().unwrap_or("").to_ascii_lowercase();
            let bit = if matches!(raw.as_str(), "1" | "true") { "1" } else { "0" };
            format!("<c r=\"{reference}\"{style} t=\"b\"><v>{bit}</v></c>")
        }
        // ECMA-376 inlineStr with multiple <r> runs — per-run rich text
        // (bold/italic/underline/strike/color/size/family/vertAlign).
        "rich" => {
            let runs = edit.rich.as_deref().unwrap_or(&[]);
            if runs.is_empty() {
                format!("<c r=\"{reference}\"{style} t=\"inlineStr\"><is><t xml:space=\"preserve\"></t></is></c>")
            } else {
                let body = runs.iter().map(rich_run_xml).collect::<String>();
                format!("<c r=\"{reference}\"{style} t=\"inlineStr\"><is>{body}</is></c>")
            }
        }
        _ => {
            let value = xml_escape(edit.value.as_deref().unwrap_or("0"));
            format!("<c r=\"{reference}\"{style}><v>{value}</v></c>")
        }
    }
}

/// The `s="N"` fragment (or "") for an edit on a cell whose current style
/// index is `current_s` (None for cells not present in the XML yet). Style
/// deltas go through the styles.xml editor, which returns the new xf index;
/// `styleReset` with no delta drops the attribute entirely (default xf).
fn style_attr_for(
    edit: &CellEdit,
    current_s: Option<usize>,
    styles: &mut StylesEditor,
) -> Result<String, SidecarError> {
    if edit.style.is_none() && !edit.style_reset {
        return Ok(current_s
            .map(|index| format!("s=\"{index}\""))
            .unwrap_or_default());
    }
    let base = if edit.style_reset { 0 } else { current_s.unwrap_or(0) };
    match styles.apply_style(base, edit.style.as_ref(), edit.style_reset)? {
        Some(index) => Ok(format!("s=\"{index}\"")),
        None => Ok(String::new()),
    }
}

/// Rebuilds the `<c>` start event with the `s` attribute replaced by
/// `style_attr` (empty removes it); every other attribute stays verbatim —
/// the style-only edit keeps the cell's content untouched.
fn cell_start_with_style(start: &BytesStart<'_>, style_attr: &str) -> BytesStart<'static> {
    let mut out = BytesStart::new("c");
    for attribute in start.attributes().with_checks(false) {
        let Ok(attribute) = attribute else { continue };
        if attribute.key.local_name().as_ref() != b"s" {
            out.push_attribute((attribute.key.as_ref(), attribute.value.as_ref()));
        }
    }
    if let Some(value) = style_attr.strip_prefix("s=\"") {
        if let Some(value) = value.strip_suffix('"') {
            out.push_attribute((b"s".as_ref(), value.as_bytes()));
        }
    }
    out
}

/// Emits pre-encoded XML verbatim: from_escaped marks the payload as
/// already-encoded, so the writer copies it without re-escaping <>&.
macro_rules! raw {
    ($writer:expr, $text:expr) => {{
        $writer
            .write_event(Event::Text(BytesText::from_escaped($text.to_string())))
            .map_err(|error| SidecarError::Workbook(error.to_string()))?;
    }};
}

/// Applies cell edits (values, clearing, style-only deltas) to a worksheet
/// XML part. `styles` is the shared styles.xml editor that resolves style
/// deltas into new xf indices and records the parts to append.
pub fn apply_sheet_edits(
    sheet_xml: &[u8],
    edits: &[CellEdit],
    styles: &mut StylesEditor,
) -> Result<Vec<u8>, SidecarError> {
    let mut reader = Reader::from_reader(sheet_xml);
    reader.config_mut().trim_text(false);
    let mut writer = quick_xml::Writer::new(Vec::<u8>::new());

    // edits handled so far (by index into `edits`).
    let mut consumed: HashSet<usize> = HashSet::new();
    let mut current_row: Option<usize> = None;

    loop {
        let event = reader.read_event().map_err(|error| SidecarError::Workbook(error.to_string()))?;
        match &event {
            Event::Eof => break,
            Event::Start(start) if start.local_name().as_ref() == b"row" => {
                // XML r= is 1-based; internal rows are 0-based like ranges.
                current_row = Some(row_index(start).unwrap_or(1).saturating_sub(1));
                writer.write_event(event.to_owned())?;
            }
            Event::Empty(start) if start.local_name().as_ref() == b"row" => {
                let row = row_index(start).unwrap_or(1).saturating_sub(1);
                current_row = Some(row);
                let attrs = row_attrs(start);
                let add: Vec<&CellEdit> = unremoved_for_row(edits, row, &consumed);
                if add.is_empty() {
                    writer.write_event(event.to_owned())?;
                } else {
                    let mut xml = format!("<row{attrs}>");
                    for edit in add {
                        consumed.insert(edit_index(edit, edits));
                        xml.push_str(&cell_xml(edit, &style_attr_for(edit, None, styles)?, &reference_for(edit)));
                    }
                    xml.push_str("</row>");
                    raw!(writer, xml);
                }
            }
            Event::Start(start) if start.local_name().as_ref() == b"c" => {
                if let Some((row, col)) = cell_address(start) {
                    if let Some(edit) = find_edit(edits, row, col, &consumed) {
                        consumed.insert(edit_index(edit, edits));
                        let current_s = style_index_of(start);
                        let reference = format!("{}{}", column_letter(col), row + 1);
                        if edit.kind == "style" {
                            // Style-only edit: keep the cell's content, swap
                            // its `s` attribute.
                            let style_attr = style_attr_for(edit, current_s, styles)?;
                            writer.write_event(Event::Start(cell_start_with_style(start, &style_attr)))?;
                            copy_children(&mut reader, &mut writer)?;
                            continue;
                        }
                        let style = style_attr_for(edit, current_s, styles)?;
                        raw!(writer, cell_xml(edit, &style, &reference));
                        skip_cell(&mut reader)?; // consume the old subtree
                        continue;
                    }
                }
                writer.write_event(event.to_owned())?;
            }
            Event::Empty(start) if start.local_name().as_ref() == b"c" => {
                if let Some((row, col)) = cell_address(start) {
                    if let Some(edit) = find_edit(edits, row, col, &consumed) {
                        consumed.insert(edit_index(edit, edits));
                        let current_s = style_index_of(start);
                        let reference = format!("{}{}", column_letter(col), row + 1);
                        if edit.kind == "style" {
                            let style_attr = style_attr_for(edit, current_s, styles)?;
                            let patched = cell_start_with_style(start, &style_attr);
                            writer.write_event(Event::Start(patched.clone()))?;
                            writer.write_event(Event::End(patched.to_end()))?;
                            continue;
                        }
                        let style = style_attr_for(edit, current_s, styles)?;
                        raw!(writer, cell_xml(edit, &style, &reference));
                        continue;
                    }
                }
                writer.write_event(event.to_owned())?;
            }
            Event::End(end) if end.local_name().as_ref() == b"row" => {
                if let Some(row) = current_row.take() {
                    let add: Vec<&CellEdit> = unremoved_for_row(edits, row, &consumed);
                    for edit in add {
                        consumed.insert(edit_index(edit, edits));
                        raw!(writer, cell_xml(edit, &style_attr_for(edit, None, styles)?, &reference_for(edit)));
                    }
                }
                writer.write_event(event.to_owned())?;
            }
            Event::Empty(start) if start.local_name().as_ref() == b"sheetData" => {
                // Self-closing <sheetData/> (empty workbooks, minimal
                // producers): treat it as open → new rows → close so edits
                // into a blank sheet still land.
                current_row = None;
                if !has_pending(edits, &consumed) {
                    writer.write_event(event.to_owned())?;
                } else {
                    writer.write_event(Event::Start(start.to_owned()))?;
                    emit_new_rows(&mut writer, edits, &mut consumed, styles)?;
                    writer.write_event(Event::End(start.to_end()))?;
                }
            }
            Event::End(end) if end.local_name().as_ref() == b"sheetData" => {
                current_row = None;
                // Rows that do not exist in the XML yet: emit collapsed new rows.
                emit_new_rows(&mut writer, edits, &mut consumed, styles)?;
                writer.write_event(event.to_owned())?;
            }
            _ => {
                writer.write_event(event.to_owned())?;
            }
        }
    }
    Ok(writer.into_inner())
}

/// True when any edit is still unconsumed (a new cell waiting for a row).
fn has_pending(edits: &[CellEdit], consumed: &HashSet<usize>) -> bool {
    edits
        .iter()
        .enumerate()
        .any(|(index, _)| !consumed.contains(&index))
}

/// Emits collapsed `<row r=N>` groups for every unconsumed edit (rows the
/// source XML never had), sorted by (row, column).
fn emit_new_rows(
    writer: &mut quick_xml::Writer<Vec<u8>>,
    edits: &[CellEdit],
    consumed: &mut HashSet<usize>,
    styles: &mut StylesEditor,
) -> Result<(), SidecarError> {
    let mut rest: Vec<&CellEdit> = unremoved(edits, consumed);
    rest.sort_by_key(|edit| (edit.row, edit.column));
    let mut last_row: Option<usize> = None;
    for edit in rest {
        consumed.insert(edit_index(edit, edits));
        if last_row != Some(edit.row) {
            if last_row.is_some() {
                raw!(writer, "</row>");
            }
            raw!(writer, format!("<row r=\"{}\">", edit.row + 1));
            last_row = Some(edit.row);
        }
        raw!(writer, cell_xml(edit, &style_attr_for(edit, None, styles)?, &reference_for(edit)));
    }
    if last_row.is_some() {
        raw!(writer, "</row>");
    }
    Ok(())
}

fn edit_index(edit: &CellEdit, edits: &[CellEdit]) -> usize {
    // `edits` is the same slice we receive; index identity via pointer is safe
    // because every candidate reference came from that slice.
    edits
        .iter()
        .position(|candidate| std::ptr::eq(candidate, edit))
        .unwrap_or(0)
}

fn find_edit<'a>(
    edits: &'a [CellEdit],
    row: usize,
    column: usize,
    consumed: &HashSet<usize>,
) -> Option<&'a CellEdit> {
    edits
        .iter()
        .enumerate()
        .find(|(index, edit)| edit.row == row && edit.column == column && !consumed.contains(index))
        .map(|(_, edit)| edit)
}

fn unremoved_for_row<'a>(
    edits: &'a [CellEdit],
    row: usize,
    consumed: &HashSet<usize>,
) -> Vec<&'a CellEdit> {
    edits
        .iter()
        .enumerate()
        .filter(|(index, edit)| edit.row == row && !consumed.contains(index))
        .map(|(_, edit)| edit)
        .collect()
}

fn unremoved<'a>(edits: &'a [CellEdit], consumed: &HashSet<usize>) -> Vec<&'a CellEdit> {
    edits
        .iter()
        .enumerate()
        .filter(|(index, _)| !consumed.contains(index))
        .map(|(_, edit)| edit)
        .collect()
}

fn reference_for(edit: &CellEdit) -> String {
    format!("{}{}", column_letter(edit.column), edit.row + 1)
}

fn row_attrs(start: &BytesStart<'_>) -> String {
    let mut out = String::new();
    for attr in start.attributes().flatten() {
        if attr.key.as_ref() != b"r" {
            out.push(' ');
            out.push_str(&String::from_utf8_lossy(attr.key.as_ref()));
            out.push_str("=\"");
            out.push_str(&xml_escape(&String::from_utf8_lossy(&attr.value)));
            out.push('"');
        }
    }
    out
}

fn row_index(start: &BytesStart<'_>) -> Option<usize> {
    start
        .attributes()
        .flatten()
        .find(|attr| attr.key.as_ref() == b"r")
        .and_then(|attr| String::from_utf8_lossy(&attr.value).parse::<usize>().ok())
}

/// Parses `<c r="A1" ...>` into (row, col), 0-based.
fn cell_address(start: &BytesStart<'_>) -> Option<(usize, usize)> {
    start
        .attributes()
        .flatten()
        .find(|attr| attr.key.as_ref() == b"r")
        .and_then(|attr| parse_cell_address(&String::from_utf8_lossy(&attr.value)))
}

/// The cell's current `s` (xf index) as an integer, None without the attribute.
fn style_index_of(start: &BytesStart<'_>) -> Option<usize> {
    start
        .attributes()
        .flatten()
        .find(|attr| attr.key.as_ref() == b"s")
        .and_then(|attr| String::from_utf8_lossy(&attr.value).parse::<usize>().ok())
}

fn parse_cell_address(reference: &str) -> Option<(usize, usize)> {
    let reference = reference.trim();
    if reference.is_empty() {
        return None;
    }
    let split = reference
        .find(|ch: char| ch.is_ascii_digit())
        .unwrap_or(reference.len());
    let letters = &reference[..split];
    let digits = &reference[split..];
    if letters.is_empty() || digits.is_empty() {
        return None;
    }
    let mut column = 0usize;
    for ch in letters.chars() {
        let code = ch.to_ascii_uppercase() as usize;
        if !(b'A' as usize..=b'Z' as usize).contains(&code) {
            return None;
        }
        column = column * 26 + (code - b'A' as usize + 1);
    }
    let row = digits.parse::<usize>().ok()?;
    if row == 0 {
        return None;
    }
    Some((row - 1, column - 1))
}

fn skip_cell(reader: &mut Reader<&[u8]>) -> Result<(), SidecarError> {
    let mut depth = 1usize;
    loop {
        let event = reader
            .read_event()
            .map_err(|error| SidecarError::Workbook(error.to_string()))?;
        match event {
            Event::Eof => return Ok(()),
            Event::Start(_) => depth += 1,
            Event::End(_) => {
                depth -= 1;
                if depth == 0 {
                    return Ok(());
                }
            }
            _ => {}
        }
    }
}

/// Copies the children of the current cell element (including its closing
/// `</c>`) verbatim — the style-only edit path replaces the `<c>` start but
/// keeps the cell's content untouched.
fn copy_children(
    reader: &mut Reader<&[u8]>,
    writer: &mut quick_xml::Writer<Vec<u8>>,
) -> Result<(), SidecarError> {
    let mut depth = 1usize;
    loop {
        let event = reader
            .read_event()
            .map_err(|error| SidecarError::Workbook(error.to_string()))?;
        match &event {
            Event::Eof => return Ok(()),
            Event::Start(_) => {
                depth += 1;
                writer.write_event(event.to_owned())?;
            }
            Event::End(_) => {
                depth -= 1;
                writer.write_event(event.to_owned())?;
                if depth == 0 {
                    return Ok(());
                }
            }
            _ => {
                writer.write_event(event.to_owned())?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn styles() -> StylesEditor {
        StylesEditor::new(
            Some(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>"#,
            ),
            "zh",
        )
    }

    fn edits() -> Vec<CellEdit> {
        vec![
            CellEdit { sheet_id: "s1".into(), row: 0, column: 0, kind: "number".into(), value: Some("42".into()), ..Default::default() },
            CellEdit { sheet_id: "s1".into(), row: 1, column: 0, kind: "string".into(), value: Some("hi".into()), ..Default::default() },
            CellEdit { sheet_id: "s1".into(), row: 0, column: 1, kind: "formula".into(), value: Some("84".into()), formula: Some("=42*2".into()), ..Default::default() },
            CellEdit { sheet_id: "s1".into(), row: 2, column: 5, kind: "number".into(), value: Some("7".into()), ..Default::default() },
        ]
    }

    #[test]
    fn parses_cell_references() {
        assert_eq!(parse_cell_address("A1"), Some((0, 0)));
        assert_eq!(parse_cell_address("Z1"), Some((0, 25)));
        assert_eq!(parse_cell_address("AA2"), Some((1, 26)));
        assert_eq!(parse_cell_address("C10"), Some((9, 2)));
        assert_eq!(parse_cell_address("A0"), None);
    }

    #[test]
    fn rewrites_existing_and_appends_into_rows() {
        let xml = br#"<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row></sheetData></worksheet>"#;
        let out = apply_sheet_edits(xml, &edits(), &mut styles()).expect("edit ok");
        let text = String::from_utf8(out).expect("utf8");
        // Row 1: replaced A1 + appended B1 formula.
        assert!(text.contains(r#"<c r="A1"><v>42</v></c>"#), "{text}");
        assert!(text.contains(r#"<c r="B1"><f>42*2</f><v>84</v></c>"#), "{text}");
        assert!(text.contains(r#"</row><c r=""#) || text.contains(r#"<c r="B1"><f>42*2</f><v>84</v></c></row>"#), "{text}");
        // Row 2: appended A2 inline string.
        assert!(text.contains(r#"<c r="A2" t="inlineStr"><is><t xml:space="preserve">hi</t></is></c>"#), "{text}");
        // Missing row 3 created at sheetData end.
        assert!(text.contains(r#"<row r="3"><c r="F3"><v>7</v></c></row>"#), "{text}");
    }

    #[test]
    fn preserves_style_on_replaced_cell() {
        let xml = br#"<worksheet><sheetData><row r="1"><c r="A1" s="3"><v>1</v></c></row></sheetData></worksheet>"#;
        let out = apply_sheet_edits(xml, &[CellEdit { sheet_id: "s1".into(), row: 0, column: 0, kind: "number".into(), value: Some("9".into()), ..Default::default() }], &mut styles()).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains(r#"<c r="A1" s="3"><v>9</v></c>"#), "{text}");
    }

    #[test]
    fn clear_drops_contents_keeps_style() {
        let xml = br#"<worksheet><sheetData><row r="1"><c r="A1" s="2"><v>1</v></c></row></sheetData></worksheet>"#;
        let out = apply_sheet_edits(xml, &[CellEdit { sheet_id: "s1".into(), row: 0, column: 0, kind: "clear".into(), ..Default::default() }], &mut styles()).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains(r#"<c r="A1" s="2"/>"#), "{text}");
    }

    #[test]
    fn new_cell_into_existing_row_append_has_valid_xml() {
        let xml = br#"<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>"#;
        let edits = vec![CellEdit { sheet_id: "s1".into(), row: 0, column: 2, kind: "number".into(), value: Some("5".into()), ..Default::default() }];
        let out = apply_sheet_edits(xml, &edits, &mut styles()).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains(r#"<c r="C1"><v>5</v></c>"#), "{text}");
        // Row stays single: one <row r="1"> start/end pair.
        assert_eq!(text.matches(r#"<row r="1">"#).count(), 1, "{text}");
        assert_eq!(text.matches("</row>").count(), 1, "{text}");
    }

    #[test]
    fn style_only_edit_keeps_content_and_swaps_s() {
        let xml = br#"<worksheet><sheetData><row r="1"><c r="A1" s="0" t="s"><v>5</v></c></row></sheetData></worksheet>"#;
        let edits = vec![CellEdit {
            sheet_id: "s1".into(), row: 0, column: 0, kind: "style".into(),
            style: Some(crate::styles_editor::StyleDelta { bold: Some(true), ..Default::default() }),
            ..Default::default()
        }];
        let out = apply_sheet_edits(xml, &edits, &mut styles()).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains(r#"<c r="A1" t="s" s="1"><v>5</v></c>"#), "{text}");
    }

    #[test]
    fn style_reset_drops_the_s_attribute() {
        let xml = br#"<worksheet><sheetData><row r="1"><c r="A1" s="2" t="s"><v>5</v></c></row></sheetData></worksheet>"#;
        let edits = vec![CellEdit { sheet_id: "s1".into(), row: 0, column: 0, kind: "style".into(), style_reset: true, ..Default::default() }];
        let out = apply_sheet_edits(xml, &edits, &mut styles()).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains(r#"<c r="A1" t="s"><v>5</v></c>"#), "{text}");
        assert!(!text.contains(" s="), "{text}");
    }

    #[test]
    fn new_cell_with_style_attaches_s() {
        let xml = br#"<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>"#;
        let edits = vec![CellEdit {
            sheet_id: "s1".into(), row: 0, column: 2, kind: "number".into(), value: Some("5".into()),
            style: Some(crate::styles_editor::StyleDelta { fill_color: Some(Some("#FFFF00".into())), ..Default::default() }),
            ..Default::default()
        }];
        let out = apply_sheet_edits(xml, &edits, &mut styles()).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains(r#"<c r="C1" s="1"><v>5</v></c>"#), "{text}");
    }

    #[test]
    fn value_edit_with_style_writes_new_s_and_value() {
        let xml = br#"<worksheet><sheetData><row r="1"><c r="A1" s="0"><v>1</v></c></row></sheetData></worksheet>"#;
        let edits = vec![CellEdit {
            sheet_id: "s1".into(), row: 0, column: 0, kind: "string".into(), value: Some("styled".into()),
            style: Some(crate::styles_editor::StyleDelta { italic: Some(true), ..Default::default() }),
            ..Default::default()
        }];
        let out = apply_sheet_edits(xml, &edits, &mut styles()).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains(r#"<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">styled</t></is></c>"#), "{text}");
    }

    #[test]
    fn boolean_edit_writes_t_b_and_normalizes_value() {
        let xml = br#"<worksheet><sheetData><row r="1"><c r="A1"><v>0</v></c></row></sheetData></worksheet>"#;
        // TRUE / true / 1 → 1；其余 → 0
        for (raw, expect) in [("TRUE", "1"), ("true", "1"), ("1", "1"), ("FALSE", "0"), ("fAlSe", "0"), ("0", "0"), ("yes", "0")] {
            let edits = vec![CellEdit { sheet_id: "s1".into(), row: 0, column: 0, kind: "boolean".into(), value: Some(raw.into()), ..Default::default() }];
            let out = apply_sheet_edits(xml, &edits, &mut styles()).unwrap();
            let text = String::from_utf8(out).unwrap();
            assert!(text.contains(&format!(r#"<c r="A1" t="b"><v>{expect}</v></c>"#)), "raw={raw} expect={expect}: {text}");
        }
    }

    #[test]
    fn boolean_roundtrip_reads_back_as_boolean_value() {
        use crate::types::CellValue;
        use crate::WorkbookSessions;
        use std::path::Path;

        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("src.xlsx");
        let target = dir.path().join("saved.xlsx");
        let mut model = ironcalc::base::Model::new_empty("fixture", "en", "UTC", "en").unwrap();
        model.set_user_input(0, 1, 1, "10".to_string()).unwrap();
        model.evaluate();
        ironcalc::export::save_to_xlsx(&model, source.to_str().unwrap()).unwrap();

        let mut sessions = WorkbookSessions::new();
        let opened = sessions.open(Path::new(&source)).expect("open");
        let sheet_id = opened.sheets[0].id.clone();
        let edits = vec![CellEdit { sheet_id: sheet_id.clone(), row: 0, column: 0, kind: "boolean".into(), value: Some("TRUE".into()), ..Default::default() }];
        let saved = sessions.save_cells(&opened.session_id, &target, &edits).unwrap();
        let range = crate::CellRange { start_row: 0, end_row: 0, start_column: 0, end_column: 0 };
        let result = sessions.read_range(&saved.session_id, &sheet_id, &range).unwrap();
        let cell = result.cells.iter().find(|c| c.row == 0 && c.column == 0).expect("cell");
        assert!(matches!(cell.value, Some(CellValue::Boolean(true))), "{:?}", cell.value);
    }

    #[test]
    fn rich_edit_writes_inline_str_multi_run() {
        use crate::types::RichRun;
        let xml = br#"<worksheet><sheetData><row r="1"><c r="A1"><v>0</v></c></row></sheetData></worksheet>"#;
        let edits = vec![CellEdit {
            sheet_id: "s1".into(), row: 0, column: 0, kind: "rich".into(),
            rich: Some(vec![
                RichRun { text: "bold".into(), bold: true, italic: false, underline: false, strikethrough: false, color: Some("#FF0000".into()), size: Some(14.0), family: Some("Arial".into()), vert_align: None },
                RichRun { text: "plain".into(), bold: false, italic: false, underline: false, strikethrough: false, color: None, size: None, family: None, vert_align: Some("superscript".into()) },
            ]),
            ..Default::default()
        }];
        let out = apply_sheet_edits(xml, &edits, &mut styles()).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains(r#"t="inlineStr""#), "{text}");
        assert!(text.contains(r#"<r><rPr><b/><sz val="14"/><color rgb="FFFF0000"/><rFont val="Arial"/></rPr><t xml:space="preserve">bold</t></r>"#), "{text}");
        assert!(text.contains(r#"<r><rPr><vertAlign val="superscript"/></rPr><t xml:space="preserve">plain</t></r>"#), "{text}");
    }

    #[test]
    fn rich_roundtrip_reads_back_runs() {
        use crate::types::CellValue;
        use crate::WorkbookSessions;
        use std::path::Path;

        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("src.xlsx");
        let target = dir.path().join("saved.xlsx");
        let mut model = ironcalc::base::Model::new_empty("fixture", "en", "UTC", "en").unwrap();
        model.set_user_input(0, 1, 1, "10".to_string()).unwrap();
        model.evaluate();
        ironcalc::export::save_to_xlsx(&model, source.to_str().unwrap()).unwrap();

        let mut sessions = WorkbookSessions::new();
        let opened = sessions.open(Path::new(&source)).expect("open");
        let sheet_id = opened.sheets[0].id.clone();
        let edits = vec![CellEdit {
            sheet_id: sheet_id.clone(), row: 0, column: 0, kind: "rich".into(),
            rich: Some(vec![
                crate::types::RichRun { text: "rich".into(), bold: true, italic: false, underline: false, strikethrough: false, color: None, size: None, family: None, vert_align: None },
            ]),
            ..Default::default()
        }];
        let saved = sessions.save_cells(&opened.session_id, &target, &edits).unwrap();
        let range = crate::CellRange { start_row: 0, end_row: 0, start_column: 0, end_column: 0 };
        let result = sessions.read_range(&saved.session_id, &sheet_id, &range).unwrap();
        let cell = result.cells.iter().find(|c| c.row == 0 && c.column == 0).expect("cell");
        // 读取侧：rich run 解析为 String（值）+ runs 保留在 CellRecord.rich
        assert!(matches!(&cell.value, Some(CellValue::String(s)) if s == "rich"), "{:?}", cell.value);
        let runs = cell.rich.as_ref().expect("rich runs");
        assert_eq!(runs.len(), 1);
        assert!(runs[0].bold, "{runs:?}");
        assert_eq!(runs[0].text, "rich");
    }

    /// End-to-end through WorkbookSessions: open a real xlsx, save cell edits
    /// into a new snapshot, reopen, and read the edited cells back.
    #[test]
    fn save_cells_roundtrip_through_sessions() {
        use crate::WorkbookSessions;
        use ironcalc::base::Model;
        use ironcalc::export::save_to_xlsx;
        use std::path::Path;

        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("src.xlsx");
        let target = dir.path().join("saved.xlsx");
        let mut model = Model::new_empty("fixture", "en", "UTC", "en").unwrap();
        model.set_user_input(0, 1, 1, "10".to_string()).unwrap();
        model.evaluate();
        save_to_xlsx(&model, source.to_str().unwrap()).unwrap();

        let mut sessions = WorkbookSessions::new();
        let opened = sessions.open(Path::new(&source)).expect("open");
        let sheet_id = opened.sheets[0].id.clone();

        let edits = vec![
            CellEdit { sheet_id: sheet_id.clone(), row: 0, column: 0, kind: "number".into(), value: Some("42".into()), ..Default::default() },
            CellEdit { sheet_id: sheet_id.clone(), row: 1, column: 0, kind: "string".into(), value: Some("hi".into()), ..Default::default() },
            CellEdit { sheet_id: sheet_id.clone(), row: 0, column: 1, kind: "formula".into(), value: Some("84".into()), formula: Some("=42*2".into()), ..Default::default() },
        ];
        let reopened = sessions
            .save_cells(&opened.session_id, Path::new(&target), &edits)
            .expect("save_cells");
        assert_ne!(reopened.session_id, opened.session_id, "session swaps on save");

        let range = crate::CellRange { start_row: 0, end_row: 1, start_column: 0, end_column: 1 };
        let result = sessions
            .read_range(&reopened.session_id, &sheet_id, &range)
            .expect("read edited cells");
        let cells = result.cells;
        assert_eq!(cells.len(), 3, "A1 value + B1 formula + A2 string: {cells:?}");
        assert!(cells.iter().any(|cell| cell.column == 0 && cell.row == 0
            && matches!(cell.value, Some(crate::CellValue::Number(v)) if v == 42.0)), "{cells:?}");
        assert!(cells.iter().any(|cell| cell.column == 0 && cell.row == 1
            && matches!(cell.value, Some(crate::CellValue::String(ref s)) if s == "hi")), "{cells:?}");
        assert!(cells.iter().any(|cell| cell.column == 1 && cell.row == 0
            && matches!(cell.value, Some(crate::CellValue::Number(v)) if v == 84.0)), "{cells:?}");
        // The original A1=10 must be gone.
        assert!(!cells.iter().any(|cell| matches!(cell.value, Some(crate::CellValue::Number(v)) if v == 10.0)), "{cells:?}");
    }
}