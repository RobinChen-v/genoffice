//! M5.2b: `xl/styles.xml` editor for the incremental save path (style edits).
//!
//! Cell styles live in `cellXfs` as a flat table: every styled cell carries
//! `s="<index>"` and each xf references sub-parts by index (`fontId`,
//! `fillId`, `borderId`, `numFmtId`) plus optional `<alignment>`/`<protection>`
//! children. A style edit therefore:
//!   1. copies the cell's current xf,
//!   2. applies the renderer delta to its sub-parts (font / fill / border /
//!      number format / alignment / protection),
//!   3. dedups the result against existing parts — content-hash reuse, else
//!      append — and hands the new xf index back for the cell's `s` attribute,
//!   4. honors the renderer's semantics: `styleReset` returns the default xf
//!      (emitted as "no `s`" by the worksheet editor), `false` in the delta
//!      removes the attribute, `null` clears it.
//!
//! Only the save path uses this module; the reader (`visuals::read_styles`)
//! keeps working off the *written* parts, so both sides agree by
//! construction. Output rewrites only the containers we appended to
//! (`numFmts` / `fonts` / `fills` / `borders` / `cellXfs`) — everything else
//! in the original styles.xml streams through byte-for-byte.

use std::collections::HashSet;

use quick_xml::Reader;
use quick_xml::events::{BytesStart, BytesText, Event};
use roxmltree::Node;
use serde::{Deserialize, Serialize};

use crate::SidecarError;

/// Emits pre-encoded XML verbatim (from_escaped marks the payload as
/// already-encoded, so the writer copies it without re-escaping <>&).
macro_rules! raw {
    ($writer:expr, $text:expr) => {{
        $writer
            .write_event(Event::Text(BytesText::from_escaped($text.to_string())))?;
    }};
}

// ---------------------------------------------------------------------------
// Wire types (the renderer's workbookStyleEditSchema / editableBorderStyleSchema)
// ---------------------------------------------------------------------------

/// One OOXML border edge delta: `Some((style, color?))` sets the edge,
/// `None` clears it (the schema's `null`).
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleBorderEdge {
    pub style: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

const BORDER_STYLES: [&str; 13] = [
    "thin", "medium", "thick", "dashed", "dotted", "double", "hair", "dashDot",
    "dashDotDot", "mediumDashed", "mediumDashDot", "mediumDashDotDot", "slantDashDot",
];
const HORIZONTAL_ALIGNMENTS: [&str; 5] = ["left", "center", "right", "justify", "distributed"];
const VERTICAL_ALIGNMENTS: [&str; 3] = ["top", "center", "bottom"];

/// The renderer's `workbookStyleEditSchema`: only keys the user changed are
/// present. `Option<bool>` with `false` removes the attribute; the nested
/// `Option<Option<_>>` fields carry JSON `null` as "clear". Unknown keys are
/// rejected at deserialization — the host gate and this schema agree.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StyleDelta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    /// "single" | "double" — drives the `<u val>` when set (implies underline).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub underline_style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strikethrough: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f64>,
    /// `null` removes the explicit color (back to the theme default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_color: Option<Option<String>>,
    /// `null` clears the fill back to `patternType="none"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill_color: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub horizontal_alignment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vertical_alignment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wrap_text: Option<bool>,
    /// OOXML textRotation: 1-90 ccw, 91-180 cw (value-90), 255 stacked; 0 clears.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_rotation: Option<u32>,
    /// OOXML alignment indent steps; 0 clears.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indent: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protection_locked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protection_hidden: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border_top: Option<Option<StyleBorderEdge>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border_bottom: Option<Option<StyleBorderEdge>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border_left: Option<Option<StyleBorderEdge>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border_right: Option<Option<StyleBorderEdge>>,
}

impl StyleDelta {
    /// True when the delta object carries at least one key (a JSON `{}`
    /// deserializes as this struct with every field None).
    pub fn is_empty(&self) -> bool {
        self.bold.is_none()
            && self.italic.is_none()
            && self.underline.is_none()
            && self.underline_style.is_none()
            && self.strikethrough.is_none()
            && self.font_family.is_none()
            && self.font_size.is_none()
            && self.font_color.is_none()
            && self.fill_color.is_none()
            && self.horizontal_alignment.is_none()
            && self.vertical_alignment.is_none()
            && self.wrap_text.is_none()
            && self.text_rotation.is_none()
            && self.indent.is_none()
            && self.protection_locked.is_none()
            && self.protection_hidden.is_none()
            && self.number_format.is_none()
            && self.border_top.is_none()
            && self.border_bottom.is_none()
            && self.border_left.is_none()
            && self.border_right.is_none()
    }
}

// ---------------------------------------------------------------------------
// Canonical part model
// ---------------------------------------------------------------------------
// Every part (font/fill/border/xf) is parsed into a small tree whose
// attributes and children are canonicalized (sorted) so PartialEq doubles as
// the content-hash dedup the design calls for, and emission stays valid for
// appenders.

#[derive(Clone, Debug, Default, PartialEq)]
struct Part {
    tag: String,
    attrs: Vec<(String, String)>,
    children: Vec<Part>,
}

impl Part {
    fn new(tag: &str) -> Self {
        Self {
            tag: tag.to_owned(),
            attrs: Vec::new(),
            children: Vec::new(),
        }
    }

    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    fn has_attr(&self, name: &str, value: &str) -> bool {
        self.attrs.iter().any(|(key, val)| key == name && val == value)
    }

    fn set_attr(&mut self, name: &str, value: impl Into<String>) {
        let value = value.into();
        for slot in &mut self.attrs {
            if slot.0 == name {
                if slot.1 != value {
                    slot.1 = value;
                    self.attrs.sort();
                }
                return;
            }
        }
        self.attrs.push((name.to_owned(), value));
        self.attrs.sort();
    }

    fn remove_attr(&mut self, name: &str) -> bool {
        let before = self.attrs.len();
        self.attrs.retain(|(key, _)| key != name);
        before != self.attrs.len()
    }

    fn child(&self, tag: &str) -> Option<&Part> {
        self.children.iter().find(|child| child.tag == tag)
    }

    fn find_child_attr(&self, tag: &str, attr: &str, value: &str) -> bool {
        self.children.iter().any(|child| {
            child.tag == tag && child.attrs.iter().any(|(key, val)| key == attr && val == value)
        })
    }

    fn to_xml(&self) -> String {
        let mut out = String::new();
        out.push('<');
        out.push_str(&self.tag);
        for (key, value) in &self.attrs {
            out.push(' ');
            out.push_str(key);
            out.push_str("=\"");
            out.push_str(&escape_attr(value));
            out.push('"');
        }
        if self.children.is_empty() {
            out.push_str("/>");
        } else {
            out.push('>');
            for child in &self.children {
                out.push_str(&child.to_xml());
            }
            out.push_str("</");
            out.push_str(&self.tag);
            out.push('>');
        }
        out
    }
}

fn escape_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Canonical element order inside each part container, so dedup is robust to
/// producers that serialize the same content in a different child order.
fn child_rank(container_tag: &str, child_tag: &str) -> usize {
    let order: &[&str] = match container_tag {
        "font" => &[
            "b", "i", "strike", "condense", "extend", "outline", "shadow", "u",
            "vertAlign", "sz", "color", "rFont", "name", "family", "charset",
            "scheme",
        ],
        "patternFill" => &["fgColor", "bgColor"],
        "border" => &[
            "left", "right", "top", "bottom", "diagonal", "vertical", "horizontal", "start", "end",
        ],
        "xf" => &["alignment", "protection"],
        _ => &[],
    };
    order
        .iter()
        .position(|candidate| *candidate == child_tag)
        .unwrap_or(usize::MAX)
}

/// Recursively canonicalize `part` (attrs sorted by name, children by
/// (semantic rank, tag, serialized form)).
fn canonicalize(mut part: Part) -> Part {
    part.attrs.sort();
    for child in &mut part.children {
        *child = canonicalize(std::mem::take(child));
    }
    part.children.sort_by(|left, right| {
        (child_rank(&part.tag, &left.tag), &left.tag, left.to_xml())
            .cmp(&(child_rank(&part.tag, &right.tag), &right.tag, right.to_xml()))
    });
    part
}

fn part_from_node(node: Node<'_, '_>) -> Part {
    let mut part = Part::new(node.tag_name().name());
    for attribute in node.attributes() {
        // Drop namespace declarations; keep every real attribute (including
        // prefixed ones like x14ac:dyDescent) verbatim in the canonical form.
        if attribute.namespace() == Some(roxmltree::NS_XMLNS_URI) {
            continue;
        }
        part.attrs
            .push((attribute.name().to_owned(), attribute.value().to_owned()));
    }
    for child in node.children().filter(|child| child.is_element()) {
        part.children.push(part_from_node(child));
    }
    canonicalize(part)
}

/// Direct children of a container node as canonical parts (in doc order —
/// the file's index order — with every part canonicalized inside).
fn container_children(node: Node<'_, '_>) -> Vec<Part> {
    node.children()
        .filter(|child| child.is_element())
        .map(part_from_node)
        .collect()
}

fn part_from_str(xml: &str) -> Part {
    part_from_node(
        roxmltree::Document::parse(xml)
            .expect("static fixture xml")
            .root_element(),
    )
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

const CUSTOM_NUM_FMT_BASE: u32 = 164;

/// Containers we can append parts into, in their OOXML document order.
const CONTAINERS: [&str; 5] = ["numFmts", "fonts", "fills", "borders", "cellXfs"];

pub(crate) struct StylesEditor {
    /// Original styles.xml (None when the workbook has no styles part).
    source: Option<String>,
    /// Parsed parts; indices are the file's fontId/fillId/borderId/s.
    fonts: Vec<Part>,
    fills: Vec<Part>,
    borders: Vec<Part>,
    /// Custom + file-declared number formats (id, formatCode).
    num_fmts: Vec<(u32, String)>,
    /// cellXfs in file order.
    xfs: Vec<Part>,
    /// Original length of each list: additions are everything past it.
    orig_fonts: usize,
    orig_fills: usize,
    orig_borders: usize,
    orig_num_fmts: usize,
    orig_xfs: usize,
    /// Locale for builtin-number-format resolution on save (mirrors the
    /// reopen locale — the bridge always opens with 'zh').
    locale: String,
    modified: bool,
}

impl StylesEditor {
    /// Parses `xl/styles.xml`. An absent (or unparseable) part yields an
    /// editor over the default single-style workbook, which materializes a
    /// fresh styles.xml on save.
    pub(crate) fn new(source: Option<&str>, locale: &str) -> Self {
        let mut editor = Self {
            source: source.map(ToOwned::to_owned),
            fonts: vec![Part::new("font")],
            fills: vec![
                part_from_str("<fill><patternFill patternType=\"none\"/></fill>"),
                part_from_str("<fill><patternFill patternType=\"gray125\"/></fill>"),
            ],
            borders: vec![Part::new("border")],
            num_fmts: Vec::new(),
            xfs: vec![default_xf()],
            orig_fonts: 0,
            orig_fills: 0,
            orig_borders: 0,
            orig_num_fmts: 0,
            orig_xfs: 0,
            locale: locale.to_owned(),
            modified: false,
        };
        let Some(xml) = source else {
            editor.orig_fonts = 1;
            editor.orig_fills = 2;
            editor.orig_borders = 1;
            editor.orig_xfs = 1;
            return editor;
        };
        let Ok(document) = crate::visuals::parse_document(xml, "styles.xml") else {
            // A styles.xml that fails to parse is treated as absent — the save
            // writes a fresh minimal part instead of refusing the whole save.
            editor.source = None;
            editor.orig_fonts = 1;
            editor.orig_fills = 2;
            editor.orig_borders = 1;
            editor.orig_xfs = 1;
            return editor;
        };

        let find = |tag: &str| document.descendants().find(|node| node.has_tag_name(tag));
        if let Some(node) = find("fonts") {
            let parsed = container_children(node);
            if !parsed.is_empty() {
                editor.fonts = parsed;
            }
        }
        if let Some(node) = find("fills") {
            let parsed = container_children(node);
            if !parsed.is_empty() {
                editor.fills = parsed;
            }
        }
        if let Some(node) = find("borders") {
            let parsed = container_children(node);
            if !parsed.is_empty() {
                editor.borders = parsed;
            }
        }
        if let Some(node) = find("numFmts") {
            for part in container_children(node) {
                if let (Some(id), Some(code)) = (part.attr("numFmtId"), part.attr("formatCode")) {
                    if let Ok(id) = id.parse::<u32>() {
                        editor.num_fmts.push((id, code.to_owned()));
                    }
                }
            }
        }
        if let Some(node) = find("cellXfs") {
            let parsed = container_children(node);
            if !parsed.is_empty() {
                editor.xfs = parsed;
            }
        }
        editor.orig_fonts = editor.fonts.len();
        editor.orig_fills = editor.fills.len();
        editor.orig_borders = editor.borders.len();
        editor.orig_num_fmts = editor.num_fmts.len();
        editor.orig_xfs = editor.xfs.len();
        editor
    }

    pub(crate) fn is_modified(&self) -> bool {
        self.modified
    }

    /// True when the original workbook had a styles part (drives replace vs.
    /// add in the archive writer).
    pub(crate) fn had_source(&self) -> bool {
        self.source.is_some()
    }

    /// Applies a style delta to the xf at `base` (the cell's current `s`).
    /// Returns the new xf index, or None when the cell ends up on the default
    /// xf (styleReset with no delta → the worksheet editor emits no `s`).
    pub(crate) fn apply_style(
        &mut self,
        base: usize,
        delta: Option<&StyleDelta>,
        reset: bool,
    ) -> Result<Option<usize>, SidecarError> {
        let Some(delta) = delta.filter(|delta| !delta.is_empty()) else {
            return Ok(if reset { None } else { Some(base) });
        };
        validate_delta(delta)?;
        let base_part = self.xfs.get(base).cloned().unwrap_or_else(default_xf);
        let merged = self.merge(base_part, delta);
        if merged == self.xfs.get(base).cloned().unwrap_or_else(default_xf) {
            // The delta changed nothing: keep the original index — or drop to
            // the default xf when the user asked for a reset.
            return Ok(if reset { None } else { Some(base) });
        }
        if let Some(existing) = self.xfs.iter().position(|candidate| *candidate == merged) {
            return Ok(Some(existing));
        }
        let index = self.xfs.len();
        self.xfs.push(merged);
        self.modified = true;
        Ok(Some(index))
    }

    /// Copies `xf`, applies the delta to its sub-parts, and canonicalizes it.
    fn merge(&mut self, mut xf: Part, delta: &StyleDelta) -> Part {
        if has_font_delta(delta) {
            let font_id = self.index_of(&xf, "fontId");
            let font = self
                .fonts
                .get(font_id)
                .cloned()
                .unwrap_or_else(|| Part::new("font"));
            let (font, changed) = apply_font_delta(font, delta);
            if changed {
                let new_id = self.dedup_or_append_font(font);
                if new_id != font_id {
                    xf.set_attr("fontId", new_id.to_string());
                    xf.set_attr("applyFont", "1");
                }
            }
        }
        if let Some(color) = &delta.fill_color {
            let fill_id = self.index_of(&xf, "fillId");
            let fill = self
                .fills
                .get(fill_id)
                .cloned()
                .unwrap_or_else(|| Part::new("fill"));
            let (fill, changed) = apply_fill_delta(fill, color);
            if changed {
                let new_id = self.dedup_or_append_fill(fill);
                if new_id != fill_id {
                    xf.set_attr("fillId", new_id.to_string());
                    xf.set_attr("applyFill", "1");
                }
            }
        }
        if has_border_delta(delta) {
            let border_id = self.index_of(&xf, "borderId");
            let border = self
                .borders
                .get(border_id)
                .cloned()
                .unwrap_or_else(|| Part::new("border"));
            let (border, changed) = apply_border_delta(border, delta);
            if changed {
                let new_id = self.dedup_or_append_border(border);
                if new_id != border_id {
                    xf.set_attr("borderId", new_id.to_string());
                    xf.set_attr("applyBorder", "1");
                }
            }
        }
        if let Some(code) = &delta.number_format {
            let current: u32 = self.index_of(&xf, "numFmtId") as u32;
            let (new_id, changed) = self.resolve_num_fmt(&xf, code);
            if changed && new_id != current {
                xf.set_attr("numFmtId", new_id.to_string());
                xf.set_attr("applyNumberFormat", "1");
            }
        }
        if has_alignment_delta(delta) {
            let base = xf.child("alignment").cloned();
            let (changed, merged) = merge_alignment(base, delta);
            if changed {
                xf.children.retain(|child| child.tag != "alignment");
                if let Some(alignment) = merged {
                    xf.children.push(alignment);
                }
                xf.set_attr("applyAlignment", "1");
            }
        }
        if delta.protection_locked.is_some() || delta.protection_hidden.is_some() {
            let base = xf.child("protection").cloned();
            let (changed, merged) = merge_protection(base, delta);
            if changed {
                xf.children.retain(|child| child.tag != "protection");
                if let Some(protection) = merged {
                    xf.children.push(protection);
                }
                xf.set_attr("applyProtection", "1");
            }
        }
        canonicalize(xf)
    }

    fn index_of(&self, xf: &Part, name: &str) -> usize {
        xf.attr(name)
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0)
    }

    fn dedup_or_append_font(&mut self, font: Part) -> usize {
        if let Some(index) = self.fonts.iter().position(|candidate| *candidate == font) {
            return index;
        }
        self.fonts.push(font);
        self.modified = true;
        self.fonts.len() - 1
    }

    fn dedup_or_append_fill(&mut self, fill: Part) -> usize {
        if let Some(index) = self.fills.iter().position(|candidate| *candidate == fill) {
            return index;
        }
        self.fills.push(fill);
        self.modified = true;
        self.fills.len() - 1
    }

    fn dedup_or_append_border(&mut self, border: Part) -> usize {
        if let Some(index) = self.borders.iter().position(|candidate| *candidate == border) {
            return index;
        }
        self.borders.push(border);
        self.modified = true;
        self.borders.len() - 1
    }

    /// Resolves a number-format code to a numFmtId: unchanged when it equals
    /// the xf's current code, builtin id when the code is a builtin pattern,
    /// the matching custom id, or a freshly appended custom id (≥164).
    fn resolve_num_fmt(&mut self, xf: &Part, code: &str) -> (u32, bool) {
        let current: u32 = self.index_of(xf, "numFmtId") as u32;
        if self.effective_num_fmt(current).as_deref() == Some(code) {
            return (current, false);
        }
        if let Some(id) = self.builtin_id_for_code(code) {
            return (id, true);
        }
        if let Some((id, _)) = self.num_fmts.iter().find(|(_, existing)| existing == code) {
            return (*id, true);
        }
        let id = self
            .num_fmts
            .iter()
            .map(|(id, _)| *id)
            .filter(|id| *id >= CUSTOM_NUM_FMT_BASE)
            .max()
            .unwrap_or(CUSTOM_NUM_FMT_BASE - 1)
            + 1;
        self.num_fmts.push((id, code.to_owned()));
        self.modified = true;
        (id, true)
    }

    fn effective_num_fmt(&self, id: u32) -> Option<String> {
        if let Some((_, code)) = self.num_fmts.iter().find(|(existing, _)| *existing == id) {
            return Some(code.clone());
        }
        crate::visuals::builtin_number_format(id, &self.locale).map(ToOwned::to_owned)
    }

    fn builtin_id_for_code(&self, code: &str) -> Option<u32> {
        (0..=81).find(|id| {
            crate::visuals::builtin_number_format(*id, "en") == Some(code)
                || crate::visuals::builtin_number_format(*id, &self.locale) == Some(code)
        })
    }

    // -- rendering -----------------------------------------------------------

    /// Serializes the editor back to `xl/styles.xml` bytes: original parts
    /// verbatim, additions injected into their containers (with patched
    /// `count` attributes), missing containers materialized, and a fresh
    /// minimal document when the workbook had no styles part.
    pub(crate) fn render(&self) -> Result<Vec<u8>, SidecarError> {
        let Some(source) = &self.source else {
            return Ok(self.render_fresh().into_bytes());
        };
        let additions = self.container_additions();
        if additions.is_empty() {
            return Ok(source.as_bytes().to_vec());
        }

        let mut reader = Reader::from_str(source);
        reader.config_mut().trim_text(false);
        let mut writer = quick_xml::Writer::new(Vec::<u8>::new());
        // Containers that appeared in the source document (Start or Empty).
        let mut seen: HashSet<&'static str> = HashSet::new();

        loop {
            let event = reader
                .read_event()
                .map_err(|error| SidecarError::Workbook(error.to_string()))?;
            match &event {
                Event::Eof => break,
                Event::Start(start) => {
                    let container = container_of(start.local_name().as_ref());
                    if is_container(container) && additions.fragment(container).is_some() {
                        seen.insert(container);
                        let patched = patch_count(start, additions.count_for(container, self));
                        writer.write_event(Event::Start(patched))?;
                    } else {
                        writer.write_event(event.to_owned())?;
                    }
                }
                Event::Empty(empty) => {
                    let container = container_of(empty.local_name().as_ref());
                    if is_container(container) && additions.fragment(container).is_some() {
                        seen.insert(container);
                        let patched = patch_count(empty, additions.count_for(container, self));
                        writer.write_event(Event::Start(patched.clone()))?;
                        raw!(&mut writer, additions.fragment(container).unwrap());
                        writer.write_event(Event::End(patched.to_end()))?;
                    } else {
                        writer.write_event(event.to_owned())?;
                    }
                }
                Event::End(end) => {
                    let container = container_of(end.local_name().as_ref());
                    if is_container(container) {
                        if let Some(fragment) = additions.fragment(container) {
                            raw!(&mut writer, fragment);
                        }
                    }
                    // Containers with additions that never appeared in the
                    // source: materialize them right before the root closes so
                    // the output stays a single well-formed document (index
                    // order per OOXML); everything else is byte-identical.
                    if end.local_name().as_ref() == b"styleSheet" {
                        let mut synthetic = String::new();
                        for container in CONTAINERS {
                            if additions.fragment(container).is_some() && !seen.contains(container) {
                                let fragment = additions.fragment(container).unwrap();
                                let count = additions.count_for(container, self);
                                synthetic.push_str(&format!(
                                    "<{container} count=\"{count}\">{fragment}</{container}>"
                                ));
                            }
                        }
                        if !synthetic.is_empty() {
                            raw!(&mut writer, synthetic);
                        }
                    }
                    writer.write_event(event.to_owned())?;
                }
                _ => {
                    writer.write_event(event.to_owned())?;
                }
            }
        }
        Ok(writer.into_inner())
    }

    /// Minimal but valid styles.xml with the accumulated parts — used when
    /// the source workbook had no styles part at all.
    fn render_fresh(&self) -> String {
        let fonts_xml: String = self.fonts.iter().map(Part::to_xml).collect();
        let fills_xml: String = self.fills.iter().map(Part::to_xml).collect();
        let borders_xml: String = self.borders.iter().map(Part::to_xml).collect();
        let cell_xfs_xml: String = self.xfs.iter().map(Part::to_xml).collect();
        let num_fmts_xml: String = self
            .num_fmts
            .iter()
            .map(|(id, code)| {
                format!("<numFmt numFmtId=\"{id}\" formatCode=\"{}\"/>", escape_attr(code))
            })
            .collect();
        let num_fmts = if num_fmts_xml.is_empty() {
            String::new()
        } else {
            format!("<numFmts count=\"{}\">{num_fmts_xml}</numFmts>", self.num_fmts.len())
        };
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
             <styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">\
             {num_fmts}\
             <fonts count=\"{}\">{fonts_xml}</fonts>\
             <fills count=\"{}\">{fills_xml}</fills>\
             <borders count=\"{}\">{borders_xml}</borders>\
             <cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>\
             <cellXfs count=\"{}\">{cell_xfs_xml}</cellXfs>\
             </styleSheet>",
            self.fonts.len(),
            self.fills.len(),
            self.borders.len(),
            self.xfs.len(),
        )
    }

    fn container_additions(&self) -> ContainerAdditions {
        let parts: fn(&[Part]) -> Option<String> = |items| {
            if items.is_empty() {
                None
            } else {
                Some(items.iter().map(Part::to_xml).collect())
            }
        };
        ContainerAdditions {
            num_fmts: (!self.num_fmts[self.orig_num_fmts..].is_empty()).then(|| {
                self.num_fmts[self.orig_num_fmts..]
                    .iter()
                    .map(|(id, code)| {
                        format!("<numFmt numFmtId=\"{id}\" formatCode=\"{}\"/>", escape_attr(code))
                    })
                    .collect()
            }),
            fonts: parts(&self.fonts[self.orig_fonts..]),
            fills: parts(&self.fills[self.orig_fills..]),
            borders: parts(&self.borders[self.orig_borders..]),
            cell_xfs: parts(&self.xfs[self.orig_xfs..]),
        }
    }
}

struct ContainerAdditions {
    num_fmts: Option<String>,
    fonts: Option<String>,
    fills: Option<String>,
    borders: Option<String>,
    cell_xfs: Option<String>,
}

impl ContainerAdditions {
    fn fragment(&self, container: &'static str) -> Option<&str> {
        match container {
            "numFmts" => self.num_fmts.as_deref(),
            "fonts" => self.fonts.as_deref(),
            "fills" => self.fills.as_deref(),
            "borders" => self.borders.as_deref(),
            "cellXfs" => self.cell_xfs.as_deref(),
            _ => None,
        }
    }

    fn is_empty(&self) -> bool {
        self.fragment("numFmts").is_none()
            && self.fragment("fonts").is_none()
            && self.fragment("fills").is_none()
            && self.fragment("borders").is_none()
            && self.fragment("cellXfs").is_none()
    }

    fn count_for(&self, container: &'static str, editor: &StylesEditor) -> usize {
        match container {
            "numFmts" => editor.num_fmts.len(),
            "fonts" => editor.fonts.len(),
            "fills" => editor.fills.len(),
            "borders" => editor.borders.len(),
            "cellXfs" => editor.xfs.len(),
            _ => 0,
        }
    }
}

fn container_of(name: &[u8]) -> &'static str {
    match name {
        b"numFmts" => "numFmts",
        b"fonts" => "fonts",
        b"fills" => "fills",
        b"borders" => "borders",
        b"cellXfs" => "cellXfs",
        _ => "",
    }
}

fn is_container(name: &'static str) -> bool {
    !name.is_empty()
}

/// Rebuilds a container start event with an updated `count` attribute
/// (additions change the element counts).
fn patch_count(start: &BytesStart<'_>, count: usize) -> BytesStart<'static> {
    let name = String::from_utf8_lossy(start.local_name().as_ref()).into_owned();
    let mut out = BytesStart::new(name);
    for attribute in start.attributes().with_checks(false) {
        let Ok(attribute) = attribute else { continue };
        if attribute.key.as_ref() != b"count" {
            out.push_attribute((attribute.key.as_ref(), attribute.value.as_ref()));
        }
    }
    out.push_attribute((b"count".as_ref(), count.to_string().as_bytes()));
    out
}

fn default_xf() -> Part {
    let mut xf = Part::new("xf");
    xf.set_attr("numFmtId", "0");
    xf.set_attr("fontId", "0");
    xf.set_attr("fillId", "0");
    xf.set_attr("borderId", "0");
    xf.set_attr("xfId", "0");
    xf
}

// ---------------------------------------------------------------------------
// Delta application helpers (each returns the new part + whether it changed)
// ---------------------------------------------------------------------------

fn has_font_delta(delta: &StyleDelta) -> bool {
    delta.bold.is_some()
        || delta.italic.is_some()
        || delta.underline.is_some()
        || delta.underline_style.is_some()
        || delta.strikethrough.is_some()
        || delta.font_family.is_some()
        || delta.font_size.is_some()
        || delta.font_color.is_some()
}

fn has_border_delta(delta: &StyleDelta) -> bool {
    delta.border_top.is_some()
        || delta.border_bottom.is_some()
        || delta.border_left.is_some()
        || delta.border_right.is_some()
}

fn has_alignment_delta(delta: &StyleDelta) -> bool {
    delta.horizontal_alignment.is_some()
        || delta.vertical_alignment.is_some()
        || delta.wrap_text.is_some()
        || delta.text_rotation.is_some()
        || delta.indent.is_some()
}

/// Engine-boundary validation of delta values (the host gate validates keys;
/// this rejects out-of-domain values before they land in the file).
fn validate_delta(delta: &StyleDelta) -> Result<(), SidecarError> {
    for edge in [
        &delta.border_top,
        &delta.border_bottom,
        &delta.border_left,
        &delta.border_right,
    ] {
        if let Some(Some(edge)) = edge {
            if !BORDER_STYLES.contains(&edge.style.as_str()) {
                return Err(SidecarError::InvalidRequest(format!(
                    "Unsupported border style '{}'.",
                    edge.style
                )));
            }
        }
    }
    if let Some(value) = &delta.horizontal_alignment {
        if !HORIZONTAL_ALIGNMENTS.contains(&value.as_str()) {
            return Err(SidecarError::InvalidRequest(format!(
                "Unsupported horizontal alignment '{}'.",
                value
            )));
        }
    }
    if let Some(value) = &delta.vertical_alignment {
        if !VERTICAL_ALIGNMENTS.contains(&value.as_str()) {
            return Err(SidecarError::InvalidRequest(format!(
                "Unsupported vertical alignment '{}'.",
                value
            )));
        }
    }
    if let Some(value) = &delta.underline_style {
        if !matches!(value.as_str(), "single" | "double") {
            return Err(SidecarError::InvalidRequest(format!(
                "Unsupported underline style '{}'.",
                value
            )));
        }
    }
    for color in delta.font_color.iter().chain(delta.fill_color.iter()).flatten() {
        if !is_hex_color(color) {
            return Err(SidecarError::InvalidRequest(format!(
                "Unsupported color '{}' (expected #RRGGBB).",
                color
            )));
        }
    }
    if let Some(size) = delta.font_size {
        if !(size.is_finite() && size > 0.0 && size <= 409.0) {
            return Err(SidecarError::InvalidRequest(format!(
                "Unsupported font size {size}."
            )));
        }
    }
    if let Some(code) = &delta.number_format {
        if code.trim().is_empty() {
            return Err(SidecarError::InvalidRequest(
                "Number format must not be empty.".into(),
            ));
        }
    }
    Ok(())
}

fn is_hex_color(value: &str) -> bool {
    let hex = value.strip_prefix('#');
    hex.is_some_and(|hex| hex.len() == 6 && hex.chars().all(|ch| ch.is_ascii_hexdigit()))
}

enum UnderlineAction {
    Nothing,
    Remove,
    Set(String),
}

fn apply_font_delta(mut font: Part, delta: &StyleDelta) -> (Part, bool) {
    let mut changed = false;
    if let Some(value) = delta.bold {
        changed |= set_bool_child(&mut font, "b", value);
    }
    if let Some(value) = delta.italic {
        changed |= set_bool_child(&mut font, "i", value);
    }
    if let Some(value) = delta.strikethrough {
        changed |= set_bool_child(&mut font, "strike", value);
    }
    if delta.underline.is_some() || delta.underline_style.is_some() {
        let action = match (&delta.underline, &delta.underline_style) {
            (Some(false), _) => UnderlineAction::Remove,
            (Some(true), Some(style)) | (None, Some(style)) => {
                UnderlineAction::Set(style.clone())
            }
            (Some(true), None) => UnderlineAction::Set("single".into()),
            (None, None) => UnderlineAction::Nothing,
        };
        match action {
            UnderlineAction::Nothing => {}
            UnderlineAction::Remove => changed |= remove_child(&mut font, "u"),
            UnderlineAction::Set(style) => {
                let mut underline = Part::new("u");
                if style != "single" {
                    underline.set_attr("val", &style);
                }
                changed |= replace_child(&mut font, underline);
            }
        }
    }
    if let Some(size) = delta.font_size {
        let value = format_f64(size);
        if !font.find_child_attr("sz", "val", &value) {
            set_val_child(&mut font, "sz", value);
            changed = true;
        }
    }
    if let Some(family) = &delta.font_family {
        if !font.find_child_attr("name", "val", family) {
            set_val_child(&mut font, "name", family.clone());
            changed = true;
        }
    }
    if let Some(color) = &delta.font_color {
        match color {
            Some(hex) => changed |= replace_child(&mut font, color_part(hex)),
            None => changed |= remove_child(&mut font, "color"),
        }
    }
    (canonicalize(font), changed)
}

/// `Some(true)` ensures the plain `<tag/>`; `Some(false)` removes it.
fn set_bool_child(part: &mut Part, tag: &str, value: bool) -> bool {
    let target = Part::new(tag);
    match part.children.iter().find(|child| child.tag == tag) {
        Some(current) => {
            if *current == target {
                false
            } else {
                replace_child(part, target)
            }
        }
        None => {
            if value {
                part.children.push(target);
                true
            } else {
                false
            }
        }
    }
}

fn replace_child(part: &mut Part, target: Part) -> bool {
    let tag = target.tag.clone();
    if part.children.iter().any(|child| child.tag == tag && *child == target) {
        return false;
    }
    part.children.retain(|child| child.tag != tag);
    part.children.push(target);
    true
}

fn remove_child(part: &mut Part, tag: &str) -> bool {
    let before = part.children.len();
    part.children.retain(|child| child.tag != tag);
    before != part.children.len()
}

fn set_val_child(part: &mut Part, tag: &str, value: String) {
    part.children.retain(|child| child.tag != tag);
    let mut child = Part::new(tag);
    child.set_attr("val", value);
    part.children.push(child);
}

fn color_part(hex: &str) -> Part {
    let mut color = Part::new("color");
    color.set_attr("rgb", to_argb(hex));
    color
}

/// `#RRGGBB` → `FFRRGGBB` (OOXML argb, full alpha).
fn to_argb(hex: &str) -> String {
    let hex = hex.trim_start_matches('#');
    if hex.len() == 6 {
        format!("FF{hex}").to_uppercase()
    } else {
        hex.to_uppercase()
    }
}

fn format_f64(value: f64) -> String {
    if (value - value.round()).abs() < f64::EPSILON {
        format!("{}", value.round() as i64)
    } else {
        format!("{value}")
    }
}

fn apply_fill_delta(_fill: Part, color: &Option<String>) -> (Part, bool) {
    let mut pattern = Part::new("patternFill");
    match color {
        Some(hex) => {
            pattern.set_attr("patternType", "solid");
            let mut foreground = Part::new("fgColor");
            foreground.set_attr("rgb", to_argb(hex));
            pattern.children.push(foreground);
        }
        None => {
            pattern.set_attr("patternType", "none");
        }
    }
    let mut fill = Part::new("fill");
    fill.children.push(pattern);
    (canonicalize(fill), true)
}

fn apply_border_delta(mut border: Part, delta: &StyleDelta) -> (Part, bool) {
    let mut changed = false;
    for (tag, edge) in [
        ("top", &delta.border_top),
        ("bottom", &delta.border_bottom),
        ("left", &delta.border_left),
        ("right", &delta.border_right),
    ] {
        let Some(option) = edge else { continue };
        let target = match option {
            Some(edge) => {
                let mut element = Part::new(tag);
                element.set_attr("style", &edge.style);
                if let Some(color) = &edge.color {
                    element.children.push(color_part(color));
                }
                element
            }
            None => Part::new(tag), // cleared edge = empty element
        };
        changed |= replace_edge(&mut border, target);
    }
    (canonicalize(border), changed)
}

fn replace_edge(border: &mut Part, target: Part) -> bool {
    let tag = target.tag.clone();
    if border.children.iter().any(|child| child.tag == tag && *child == target) {
        return false;
    }
    border.children.retain(|child| child.tag != tag);
    let rank = child_rank("border", &tag);
    let position = border
        .children
        .iter()
        .position(|child| child_rank("border", &child.tag) > rank)
        .unwrap_or(border.children.len());
    border.children.insert(position, target);
    true
}

fn merge_alignment(base: Option<Part>, delta: &StyleDelta) -> (bool, Option<Part>) {
    let mut changed = false;
    let mut alignment = base.unwrap_or_else(|| Part::new("alignment"));
    if let Some(value) = &delta.horizontal_alignment {
        if !alignment.has_attr("horizontal", value) {
            alignment.set_attr("horizontal", value);
            changed = true;
        }
    }
    if let Some(value) = &delta.vertical_alignment {
        if !alignment.has_attr("vertical", value) {
            alignment.set_attr("vertical", value);
            changed = true;
        }
    }
    match delta.wrap_text {
        Some(true) => {
            if !alignment.has_attr("wrapText", "1") {
                alignment.set_attr("wrapText", "1");
                changed = true;
            }
        }
        Some(false) => changed |= alignment.remove_attr("wrapText"),
        None => {}
    }
    if let Some(rotation) = delta.text_rotation {
        if rotation == 0 {
            changed |= alignment.remove_attr("textRotation");
        } else if !alignment.has_attr("textRotation", &rotation.to_string()) {
            alignment.set_attr("textRotation", rotation.to_string());
            changed = true;
        }
    }
    if let Some(indent) = delta.indent {
        if indent == 0 {
            changed |= alignment.remove_attr("indent");
        } else if !alignment.has_attr("indent", &indent.to_string()) {
            alignment.set_attr("indent", indent.to_string());
            changed = true;
        }
    }
    if changed && alignment.attrs.is_empty() {
        return (true, None);
    }
    (changed, Some(alignment))
}

fn merge_protection(base: Option<Part>, delta: &StyleDelta) -> (bool, Option<Part>) {
    let mut changed = false;
    let mut protection = base.unwrap_or_else(|| Part::new("protection"));
    if let Some(locked) = delta.protection_locked {
        let value = if locked { "1" } else { "0" };
        if !protection.has_attr("locked", value) {
            protection.set_attr("locked", value);
            changed = true;
        }
    }
    if let Some(hidden) = delta.protection_hidden {
        let value = if hidden { "1" } else { "0" };
        if !protection.has_attr("hidden", value) {
            protection.set_attr("hidden", value);
            changed = true;
        }
    }
    if changed && protection.attrs.is_empty() {
        return (true, None);
    }
    (changed, Some(protection))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn delta(bold: bool) -> StyleDelta {
        StyleDelta {
            bold: Some(bold),
            ..StyleDelta::default()
        }
    }

    const MINIMAL_STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>"#;

    #[test]
    fn bold_delta_appends_font_and_xf() {
        let mut editor = StylesEditor::new(Some(MINIMAL_STYLES), "zh");
        let new_xf = editor.apply_style(0, Some(&delta(true)), false).unwrap().unwrap();
        assert_eq!(new_xf, 1, "one appended xf");
        let xml = String::from_utf8(editor.render().unwrap()).unwrap();
        assert!(xml.contains("<font><b/><sz val=\"11\"/><color theme=\"1\"/><name val=\"Calibri\"/><family val=\"2\"/><scheme val=\"minor\"/></font>"), "{xml}");
        assert!(xml.contains("fontId=\"1\""), "{xml}");
        assert!(xml.contains("applyFont=\"1\""), "{xml}");
        assert!(xml.contains("<fonts count=\"2\">"), "{xml}");
        assert!(xml.contains("<cellXfs count=\"2\">"), "{xml}");
    }

    #[test]
    fn identical_deltas_dedup_to_one_xf() {
        let mut editor = StylesEditor::new(Some(MINIMAL_STYLES), "zh");
        let first = editor.apply_style(0, Some(&delta(true)), false).unwrap().unwrap();
        let second = editor.apply_style(0, Some(&delta(true)), false).unwrap().unwrap();
        assert_eq!(first, second);
        let xml = String::from_utf8(editor.render().unwrap()).unwrap();
        assert_eq!(xml.matches("<font><b/>").count(), 1, "{xml}");
        assert_eq!(xml.matches("applyFont=\"1\"").count(), 1, "{xml}");
    }

    #[test]
    fn fill_color_delta_appends_solid_fill() {
        let mut editor = StylesEditor::new(Some(MINIMAL_STYLES), "zh");
        let new_xf = editor
            .apply_style(
                0,
                Some(&StyleDelta {
                    fill_color: Some(Some("#FFFF00".into())),
                    ..StyleDelta::default()
                }),
                false,
            )
            .unwrap()
            .unwrap();
        let xml = String::from_utf8(editor.render().unwrap()).unwrap();
        assert!(xml.contains("<fill><patternFill patternType=\"solid\"><fgColor rgb=\"FFFFFF00\"/></patternFill></fill>"), "{xml}");
        assert!(xml.contains("fillId=\"2\""), "{xml}");
        assert!(xml.contains("applyFill=\"1\""), "{xml}");
        assert_eq!(new_xf, 1);
    }

    #[test]
    fn clear_fill_delta_resets_to_none_pattern() {
        let mut editor = StylesEditor::new(Some(MINIMAL_STYLES), "zh");
        let _ = editor.apply_style(0, Some(&StyleDelta { fill_color: Some(Some("#FF0000".into())), ..Default::default() }), false).unwrap().unwrap();
        let cleared = editor.apply_style(1, Some(&StyleDelta { fill_color: Some(None), ..Default::default() }), false).unwrap().unwrap();
        assert_eq!(cleared, 2, "a new xf for the cleared cell");
        let xml = String::from_utf8(editor.render().unwrap()).unwrap();
        // Clear dedups to the original patternType="none" fill (id 0) — nothing appended.
        assert!(xml.contains("<fills count=\"3\">"), "{xml}");
        assert!(xml.contains("<fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill><fill><patternFill patternType=\"solid\"><fgColor rgb=\"FFFF0000\"/></patternFill></fill>"), "{xml}");
        assert!(xml.contains("<xf applyFill=\"1\" borderId=\"0\" fillId=\"0\" fontId=\"0\" numFmtId=\"0\" xfId=\"0\"/>"), "{xml}");
        assert_eq!(xml.matches("<fill>").count(), 3, "{xml}");
    }

    #[test]
    fn border_delta_appends_border_and_edge() {
        let mut editor = StylesEditor::new(Some(MINIMAL_STYLES), "zh");
        let _ = editor
            .apply_style(
                0,
                Some(&StyleDelta {
                    border_top: Some(Some(StyleBorderEdge { style: "thin".into(), color: Some("#000000".into()) })),
                    ..StyleDelta::default()
                }),
                false,
            )
            .unwrap()
            .unwrap();
        let xml = String::from_utf8(editor.render().unwrap()).unwrap();
        assert!(xml.contains("<border><left/><right/><top style=\"thin\"><color rgb=\"FF000000\"/></top><bottom/><diagonal/></border>"), "{xml}");
        assert!(xml.contains("borderId=\"1\""), "{xml}");
        assert!(xml.contains("applyBorder=\"1\""), "{xml}");
    }

    #[test]
    fn remove_border_edge_clears_it() {
        let styled = r#"<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font/></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thick"/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/></cellXfs>
</styleSheet>"#;
        let mut editor = StylesEditor::new(Some(styled), "zh");
        let _ = editor
            .apply_style(
                1,
                Some(&StyleDelta { border_top: Some(None), ..StyleDelta::default() }),
                false,
            )
            .unwrap()
            .unwrap();
        let xml = String::from_utf8(editor.render().unwrap()).unwrap();
        assert!(xml.contains("<border><left/><right/><top/><bottom/><diagonal/></border>"), "{xml}");
    }

    #[test]
    fn number_format_reuses_builtin_id() {
        let mut editor = StylesEditor::new(Some(MINIMAL_STYLES), "zh");
        let _ = editor
            .apply_style(0, Some(&StyleDelta { number_format: Some("0.00%".into()), ..StyleDelta::default() }), false)
            .unwrap()
            .unwrap();
        let xml = String::from_utf8(editor.render().unwrap()).unwrap();
        assert!(xml.contains("numFmtId=\"10\""), "{xml}");
        assert!(xml.contains("applyNumberFormat=\"1\""), "{xml}");
        // "0.00%" is builtin id 10 — no custom numFmt entry appended.
        assert!(!xml.contains("<numFmts"), "{xml}");
    }

    #[test]
    fn custom_number_format_appends_numfmt_entry() {
        let mut editor = StylesEditor::new(Some(MINIMAL_STYLES), "zh");
        let _ = editor
            .apply_style(
                0,
                Some(&StyleDelta { number_format: Some("0.0000".into()), ..StyleDelta::default() }),
                false,
            )
            .unwrap()
            .unwrap();
        let xml = String::from_utf8(editor.render().unwrap()).unwrap();
        assert!(xml.contains("<numFmts count=\"1\"><numFmt numFmtId=\"164\" formatCode=\"0.0000\"/></numFmts>"), "{xml}");
        assert!(xml.contains("numFmtId=\"164\""), "{xml}");
    }

    #[test]
    fn alignment_and_protection_merge_into_xf() {
        let mut editor = StylesEditor::new(Some(MINIMAL_STYLES), "zh");
        let _ = editor
            .apply_style(
                0,
                Some(&StyleDelta {
                    horizontal_alignment: Some("center".into()),
                    vertical_alignment: Some("top".into()),
                    wrap_text: Some(true),
                    indent: Some(2),
                    protection_locked: Some(false),
                    ..StyleDelta::default()
                }),
                false,
            )
            .unwrap()
            .unwrap();
        let xml = String::from_utf8(editor.render().unwrap()).unwrap();
        assert!(xml.contains("<alignment horizontal=\"center\" indent=\"2\" vertical=\"top\" wrapText=\"1\"/>"), "{xml}");
        assert!(xml.contains("<protection locked=\"0\"/>"), "{xml}");
        assert!(xml.contains("applyAlignment=\"1\""), "{xml}");
        assert!(xml.contains("applyProtection=\"1\""), "{xml}");
    }

    #[test]
    fn style_reset_without_delta_returns_none() {
        let mut editor = StylesEditor::new(Some(MINIMAL_STYLES), "zh");
        assert_eq!(editor.apply_style(0, None, true).unwrap(), None);
        assert!(!editor.is_modified());
    }

    #[test]
    fn style_on_missing_styles_part_writes_fresh_document() {
        let mut editor = StylesEditor::new(None, "zh");
        let index = editor.apply_style(0, Some(&delta(true)), false).unwrap().unwrap();
        assert_eq!(index, 1);
        let xml = String::from_utf8(editor.render().unwrap()).unwrap();
        assert!(xml.starts_with("<?xml"), "{xml}");
        assert!(xml.contains("<styleSheet"), "{xml}");
        assert!(xml.contains("<font><b/></font>"), "{xml}");
        assert!(xml.contains("fontId=\"1\""), "{xml}");
        assert!(xml.contains("applyFont=\"1\""), "{xml}");
    }

    #[test]
    fn missing_container_is_materialized_inside_the_root() {
        // Degenerate source without a <fonts> container: the appended font
        // must produce a well-formed styles.xml with <fonts> inside the root.
        let degraded = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>"#;
        let mut editor = StylesEditor::new(Some(degraded), "zh");
        let index = editor.apply_style(0, Some(&delta(true)), false).unwrap().unwrap();
        assert_eq!(index, 1);
        let xml = String::from_utf8(editor.render().unwrap()).unwrap();
        // Well-formed and the fonts container sits before the root close.
        let document = roxmltree::Document::parse(&xml).expect("well-formed");
        let root = document.root_element();
        let fonts = root
            .children()
            .find(|node| node.has_tag_name("fonts"))
            .expect("fonts container materialized");
        assert!(fonts.has_attribute("count"), "{xml}");
        assert!(
            xml.rfind("<fonts").unwrap() < xml.rfind("</styleSheet>").unwrap(),
            "fonts must precede </styleSheet>: {xml}"
        );
        assert!(xml.contains("<font><b/></font>"), "{xml}");
    }

    #[test]
    fn invalid_border_style_is_rejected() {
        let mut editor = StylesEditor::new(Some(MINIMAL_STYLES), "zh");
        let error = editor
            .apply_style(
                0,
                Some(&StyleDelta {
                    border_top: Some(Some(StyleBorderEdge { style: "fancy".into(), color: None })),
                    ..StyleDelta::default()
                }),
                false,
            )
            .unwrap_err();
        assert!(error.to_string().contains("border style"), "{error}");
    }

    #[test]
    fn unknown_delta_key_is_rejected_at_deserialization() {
        let value: Result<StyleDelta, _> = serde_json::from_str(r#"{"bold":true,"nope":1}"#);
        assert!(value.is_err());
    }
}