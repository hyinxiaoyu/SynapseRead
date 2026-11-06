//! Domain types crossing the IPC boundary.
//!
//! Serialized as camelCase. These mirror `apps/desktop/src/types/domain.ts`;
//! `fixtures/contract/anchors.json` is parsed by tests on both sides to keep
//! the two definitions from drifting.

use serde::{Deserialize, Serialize};

use crate::{CoreError, CoreResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentFormat {
    Pdf,
    Epub,
    Txt,
    Md,
}

impl DocumentFormat {
    /// Every file extension [`Self::from_extension`] accepts, for the file picker.
    pub const EXTENSIONS: &[&str] = &["pdf", "epub", "txt", "text", "log", "md", "markdown"];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Epub => "epub",
            Self::Txt => "txt",
            Self::Md => "md",
        }
    }

    pub fn parse(value: &str) -> CoreResult<Self> {
        match value {
            "pdf" => Ok(Self::Pdf),
            "epub" => Ok(Self::Epub),
            "txt" => Ok(Self::Txt),
            "md" => Ok(Self::Md),
            other => Err(CoreError::UnsupportedFormat(other.to_owned())),
        }
    }

    pub fn from_extension(extension: &str) -> CoreResult<Self> {
        match extension.to_ascii_lowercase().as_str() {
            "pdf" => Ok(Self::Pdf),
            "epub" => Ok(Self::Epub),
            "txt" | "text" | "log" => Ok(Self::Txt),
            "md" | "markdown" => Ok(Self::Md),
            other => Err(CoreError::UnsupportedFormat(other.to_owned())),
        }
    }
}

/// A rectangle in page space, each coordinate normalized to `0.0..=1.0` so it
/// survives any zoom level.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizedRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Normalized rectangles on a single PDF page, used when a highlight or excerpt
/// spans multiple pages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfPageSpan {
    pub page_index: u32,
    pub rects: Vec<NormalizedRect>,
}

/// Format-agnostic position inside a document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "format", rename_all = "lowercase")]
pub enum AnchorLocation {
    #[serde(rename_all = "camelCase")]
    Pdf {
        page_index: u32,
        rects: Vec<NormalizedRect>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        page_spans: Option<Vec<PdfPageSpan>>,
    },
    #[serde(rename_all = "camelCase")]
    Epub {
        cfi_range: String,
        chapter_href: String,
    },
    #[serde(rename_all = "camelCase")]
    Txt {
        start_byte_offset: u64,
        end_byte_offset: u64,
        line_index: u64,
    },
    /// Reserved for V1.1: no reader produces this anchor yet.
    #[serde(rename_all = "camelCase")]
    Md { ast_node_id: String, offset: u64 },
}

impl AnchorLocation {
    pub fn format(&self) -> DocumentFormat {
        match self {
            Self::Pdf { .. } => DocumentFormat::Pdf,
            Self::Epub { .. } => DocumentFormat::Epub,
            Self::Txt { .. } => DocumentFormat::Txt,
            Self::Md { .. } => DocumentFormat::Md,
        }
    }

    /// Rejects anchors that could never be resolved back to a source position.
    pub fn validate(&self) -> CoreResult<()> {
        let invalid = |message: &str| Err(CoreError::InvalidAnchor(message.to_owned()));
        let valid_rect = |r: &NormalizedRect| {
            let in_unit = |v: f64| (0.0..=1.0).contains(&v);
            in_unit(r.x)
                && in_unit(r.y)
                && r.width > 0.0
                && r.height > 0.0
                && in_unit(r.x + r.width)
                && in_unit(r.y + r.height)
        };
        match self {
            Self::Pdf {
                page_index,
                rects,
                page_spans,
            } => {
                if rects.is_empty() {
                    return invalid("a PDF anchor needs at least one rectangle");
                }
                if !rects.iter().all(valid_rect) {
                    return invalid("PDF rectangles must be non-empty and within the unit square");
                }
                if let Some(spans) = page_spans {
                    if spans.is_empty() {
                        return invalid("PDF pageSpans cannot be empty when present");
                    }
                    if spans[0].page_index != *page_index {
                        return invalid(
                            "the first PDF pageSpan must match the anchor's primary pageIndex",
                        );
                    }
                    for span in spans {
                        if span.rects.is_empty() || !span.rects.iter().all(valid_rect) {
                            return invalid(
                                "each PDF pageSpan must have valid rectangles within the unit square",
                            );
                        }
                    }
                    if spans
                        .windows(2)
                        .any(|pair| pair[0].page_index >= pair[1].page_index)
                    {
                        return invalid("PDF pageSpans must be ordered by ascending pageIndex");
                    }
                }
            }
            Self::Epub {
                cfi_range,
                chapter_href,
            } => {
                if cfi_range.is_empty() || chapter_href.is_empty() {
                    return invalid("an EPUB anchor needs a CFI range and a chapter href");
                }
            }
            Self::Txt {
                start_byte_offset,
                end_byte_offset,
                ..
            } => {
                if start_byte_offset >= end_byte_offset {
                    return invalid("a TXT anchor must cover at least one byte");
                }
            }
            Self::Md { ast_node_id, .. } => {
                if ast_node_id.is_empty() {
                    return invalid("a Markdown anchor needs an AST node id");
                }
            }
        }
        Ok(())
    }

    /// Canonical key identifying a bookmarkable reading location within a document.
    pub fn location_key(&self) -> String {
        match self {
            Self::Pdf { page_index, .. } => format!("pdf:{page_index}"),
            Self::Epub {
                cfi_range,
                chapter_href,
            } => format!("epub:{chapter_href}:{cfi_range}"),
            Self::Txt {
                start_byte_offset, ..
            } => format!("txt:{start_byte_offset}"),
            Self::Md {
                ast_node_id,
                offset,
            } => format!("md:{ast_node_id}:{offset}"),
        }
    }

    /// Fallback human-readable label when a bookmark is created without one.
    pub fn default_bookmark_label(&self) -> String {
        match self {
            Self::Pdf { page_index, .. } => format!("Page {}", page_index + 1),
            Self::Epub { chapter_href, .. } => chapter_href.clone(),
            Self::Txt { line_index, .. } => format!("Line {}", line_index + 1),
            Self::Md { ast_node_id, .. } => ast_node_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: String,
    pub title: String,
    pub file_path: String,
    pub file_hash: String,
    pub format: DocumentFormat,
    pub encoding: String,
    pub last_cursor_anchor: Option<AnchorLocation>,
    #[serde(default)]
    pub last_opened_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentSourceState {
    Ok,
    Missing,
    Changed,
}

/// On-disk verification status of a registered document's source file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentSourceStatus {
    pub document_id: String,
    pub state: DocumentSourceState,
    pub current_file_hash: Option<String>,
    pub file_size_bytes: Option<u64>,
}

/// Result of explicitly relinking a document to a replacement file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelinkDocumentResult {
    pub document: Document,
    pub content_changed: bool,
    pub previous_file_hash: String,
}

/// Persisted reader tab session across application restarts.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSession {
    pub open_document_ids: Vec<String>,
    pub active_document_id: Option<String>,
    /// Immersive reading: chrome collapsed and the toolbar auto-hiding. Optional on
    /// the wire so a frontend that predates it still round-trips.
    #[serde(default)]
    pub immersive: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyNotebook {
    pub id: String,
    pub title: String,
    pub viewport: Option<Viewport>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    pub document_id: String,
    pub notebook_id: String,
    pub anchor: AnchorLocation,
    pub excerpt_text: Option<String>,
    pub excerpt_image_path: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    pub color: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateAnnotationInput {
    pub document_id: String,
    pub notebook_id: String,
    pub anchor: AnchorLocation,
    pub excerpt_text: Option<String>,
    /// A base64 PNG for an area capture. Core chooses where it is stored.
    pub excerpt_image_png: Option<String>,
    pub note: Option<String>,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnnotationPatch {
    pub note: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteCard {
    pub id: String,
    pub notebook_id: String,
    pub title: String,
    pub markdown_notes: String,
    pub tags: Vec<String>,
    /// Ordered by excerpt creation time; more than one after a merge.
    pub annotation_ids: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MindMapNode {
    pub id: String,
    pub notebook_id: String,
    pub card_id: String,
    pub parent_node_id: Option<String>,
    pub pos_x: f64,
    pub pos_y: f64,
    pub is_collapsed: bool,
    pub style: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MindMapEdge {
    pub id: String,
    pub notebook_id: String,
    pub source_node_id: String,
    pub target_node_id: String,
    pub label: Option<String>,
}

/// Everything the workspace needs to render one notebook.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookGraph {
    pub notebook: StudyNotebook,
    pub annotations: Vec<Annotation>,
    pub cards: Vec<NoteCard>,
    pub nodes: Vec<MindMapNode>,
    pub edges: Vec<MindMapEdge>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateExcerptInput {
    pub document_id: String,
    pub notebook_id: String,
    pub anchor: AnchorLocation,
    pub excerpt_text: Option<String>,
    /// A base64 PNG. Core chooses where it goes: the webview never supplies a
    /// path, so this cannot be used to point an annotation at an arbitrary file.
    pub excerpt_image_png: Option<String>,
    pub color: String,
    pub parent_node_id: Option<String>,
    pub pos_x: f64,
    pub pos_y: f64,
}

/// The rows created by one "Excerpt to MindMap" action.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedExcerpt {
    pub annotation: Annotation,
    pub card: NoteCard,
    pub node: MindMapNode,
    /// The parent link is represented as an edge so the canvas renders it uniformly.
    pub edge: Option<MindMapEdge>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardPatch {
    pub title: Option<String>,
    pub markdown_notes: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeLayoutPatch {
    pub pos_x: f64,
    pub pos_y: f64,
    pub is_collapsed: bool,
}

/// Independent reading bookmark inside a document (no card or annotation).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub document_id: String,
    pub anchor: AnchorLocation,
    pub label: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateBookmarkInput {
    pub document_id: String,
    pub anchor: AnchorLocation,
    pub label: Option<String>,
}

/// The page palette. `Auto` follows the system's light or dark appearance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReadingTheme {
    Auto,
    Light,
    Sepia,
    Dark,
}

/// A reading face. `Original` keeps the publisher's fonts (EPUB) or the default
/// serif (TXT); the frontend maps every other face to a stack with fallbacks for
/// platforms that lack it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReadingFontFamily {
    Original,
    Charter,
    Iowan,
    Palatino,
    Athelas,
    NewYork,
    Seravek,
    SfPro,
    Mono,
}

/// Page padding around the text column. The column itself is capped by the
/// reading measure, not by this setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReadingMargins {
    Narrow,
    Normal,
    Wide,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EpubReadingMode {
    Spread,
    Paged,
    Scroll,
}

/// How a paged reader animates a page turn. Reduced motion always turns instantly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PageTransition {
    None,
    #[default]
    Slide,
    Fade,
}

/// User-configurable appearance and layout preferences for EPUB and TXT readers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadingPreferences {
    pub theme: ReadingTheme,
    pub font_family: ReadingFontFamily,
    /// Font size percentage (`75..=200`).
    pub font_size: u32,
    /// Line height multiplier (`1.2..=2.4`).
    pub line_spacing: f64,
    pub margins: ReadingMargins,
    /// Justified text, hyphenated in the document's language.
    pub justify: bool,
    /// Dims images in the Dark theme.
    pub dim_images: bool,
    pub epub_reading_mode: EpubReadingMode,
    /// Also used by PDF single and two-page modes. Rows saved before it existed
    /// take the default, so it needs no migration.
    #[serde(default)]
    pub page_transition: PageTransition,
}

impl Default for ReadingPreferences {
    fn default() -> Self {
        Self {
            theme: ReadingTheme::Auto,
            font_family: ReadingFontFamily::Original,
            font_size: 100,
            line_spacing: 1.75,
            margins: ReadingMargins::Normal,
            justify: true,
            dim_images: false,
            epub_reading_mode: EpubReadingMode::Spread,
            page_transition: PageTransition::Slide,
        }
    }
}

impl ReadingPreferences {
    pub const MIN_FONT_SIZE: u32 = 75;
    pub const MAX_FONT_SIZE: u32 = 200;
    pub const MIN_LINE_SPACING: f64 = 1.2;
    pub const MAX_LINE_SPACING: f64 = 2.4;

    pub fn validate(&self) -> CoreResult<()> {
        if !(Self::MIN_FONT_SIZE..=Self::MAX_FONT_SIZE).contains(&self.font_size) {
            return Err(CoreError::InvalidPreferences(format!(
                "fontSize must be between {} and {}",
                Self::MIN_FONT_SIZE,
                Self::MAX_FONT_SIZE
            )));
        }
        if !self.line_spacing.is_finite()
            || !(Self::MIN_LINE_SPACING..=Self::MAX_LINE_SPACING).contains(&self.line_spacing)
        {
            return Err(CoreError::InvalidPreferences(format!(
                "lineSpacing must be between {:.1} and {:.1}",
                Self::MIN_LINE_SPACING,
                Self::MAX_LINE_SPACING
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_preferences_defaults_and_validates() {
        let prefs = ReadingPreferences::default();
        assert!(prefs.validate().is_ok());

        let mut bad_size = prefs.clone();
        bad_size.font_size = 50;
        assert!(matches!(
            bad_size.validate(),
            Err(CoreError::InvalidPreferences(_))
        ));

        let mut bad_spacing = prefs.clone();
        bad_spacing.line_spacing = 3.0;
        assert!(matches!(
            bad_spacing.validate(),
            Err(CoreError::InvalidPreferences(_))
        ));

        let mut nan_spacing = prefs;
        nan_spacing.line_spacing = f64::NAN;
        assert!(matches!(
            nan_spacing.validate(),
            Err(CoreError::InvalidPreferences(_))
        ));
    }

    #[test]
    fn contract_fixture_parses_and_validates() {
        let fixture = include_str!("../../../fixtures/contract/anchors.json");
        let anchors: Vec<AnchorLocation> = serde_json::from_str(fixture).unwrap();
        assert_eq!(anchors.len(), 6);
        for anchor in &anchors {
            anchor.validate().unwrap();
        }
    }

    #[test]
    fn contract_fixture_round_trips_exactly() {
        let fixture = include_str!("../../../fixtures/contract/anchors.json");
        let original: serde_json::Value = serde_json::from_str(fixture).unwrap();
        let anchors: Vec<AnchorLocation> = serde_json::from_value(original.clone()).unwrap();
        assert_eq!(serde_json::to_value(anchors).unwrap(), original);
    }

    fn pdf_with_rect(x: f64, y: f64, width: f64, height: f64) -> AnchorLocation {
        AnchorLocation::Pdf {
            page_index: 0,
            rects: vec![NormalizedRect {
                x,
                y,
                width,
                height,
            }],
            page_spans: None,
        }
    }

    #[test]
    fn rejects_rectangles_outside_the_page() {
        assert!(pdf_with_rect(0.9, 0.0, 0.2, 0.1).validate().is_err());
        assert!(pdf_with_rect(-0.1, 0.0, 0.2, 0.1).validate().is_err());
        assert!(pdf_with_rect(0.0, 0.0, 0.0, 0.1).validate().is_err());
        assert!(pdf_with_rect(f64::NAN, 0.0, 0.1, 0.1).validate().is_err());
        assert!(pdf_with_rect(0.0, 0.0, 1.0, 1.0).validate().is_ok());
    }

    #[test]
    fn rejects_pdf_anchor_without_rectangles() {
        let anchor = AnchorLocation::Pdf {
            page_index: 0,
            rects: vec![],
            page_spans: None,
        };
        assert!(anchor.validate().is_err());
    }

    #[test]
    fn validates_cross_page_pdf_spans_and_backward_compatibility() {
        // Legacy single-page PDF anchor without pageSpans still parses and round-trips without pageSpans.
        let legacy_json = serde_json::json!({
            "format": "pdf",
            "pageIndex": 2,
            "rects": [{ "x": 0.1, "y": 0.2, "width": 0.5, "height": 0.05 }]
        });
        let legacy: AnchorLocation = serde_json::from_value(legacy_json.clone()).unwrap();
        legacy.validate().unwrap();
        assert_eq!(serde_json::to_value(&legacy).unwrap(), legacy_json);

        // Valid cross-page PDF anchor.
        let valid_rect = NormalizedRect {
            x: 0.1,
            y: 0.2,
            width: 0.5,
            height: 0.05,
        };
        let cross_page = AnchorLocation::Pdf {
            page_index: 1,
            rects: vec![valid_rect],
            page_spans: Some(vec![
                PdfPageSpan {
                    page_index: 1,
                    rects: vec![valid_rect],
                },
                PdfPageSpan {
                    page_index: 2,
                    rects: vec![valid_rect],
                },
            ]),
        };
        cross_page.validate().unwrap();

        // Empty page_spans rejected.
        let empty_spans = AnchorLocation::Pdf {
            page_index: 1,
            rects: vec![valid_rect],
            page_spans: Some(vec![]),
        };
        assert!(empty_spans.validate().is_err());

        // Mismatched first page_index rejected.
        let mismatched = AnchorLocation::Pdf {
            page_index: 1,
            rects: vec![valid_rect],
            page_spans: Some(vec![PdfPageSpan {
                page_index: 2,
                rects: vec![valid_rect],
            }]),
        };
        assert!(mismatched.validate().is_err());

        // Unordered page_spans rejected.
        let unordered = AnchorLocation::Pdf {
            page_index: 2,
            rects: vec![valid_rect],
            page_spans: Some(vec![
                PdfPageSpan {
                    page_index: 2,
                    rects: vec![valid_rect],
                },
                PdfPageSpan {
                    page_index: 1,
                    rects: vec![valid_rect],
                },
            ]),
        };
        assert!(unordered.validate().is_err());
    }

    #[test]
    fn rejects_empty_txt_range() {
        let anchor = AnchorLocation::Txt {
            start_byte_offset: 5,
            end_byte_offset: 5,
            line_index: 0,
        };
        assert!(anchor.validate().is_err());
    }

    #[test]
    fn maps_extensions_case_insensitively() {
        assert_eq!(
            DocumentFormat::from_extension("PDF").unwrap(),
            DocumentFormat::Pdf
        );
        assert_eq!(
            DocumentFormat::from_extension("markdown").unwrap(),
            DocumentFormat::Md
        );
        assert!(DocumentFormat::from_extension("docx").is_err());
    }

    #[test]
    fn every_picker_extension_is_a_known_format() {
        for extension in DocumentFormat::EXTENSIONS {
            DocumentFormat::from_extension(extension).unwrap();
        }
    }
}
