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
    /// `fixtures/contract/document-formats.json` names the same list for the
    /// frontend's copy, and tests on both sides keep them equal.
    pub const EXTENSIONS: &[&str] = &["pdf", "epub", "txt", "text", "log", "md", "markdown"];

    /// The extensions that register as this format, for the relink picker.
    /// Empty for [`Self::Md`], which no extension produces yet.
    pub fn extensions(self) -> &'static [&'static str] {
        match self {
            Self::Pdf => &["pdf"],
            Self::Epub => &["epub"],
            Self::Txt => &["txt", "text", "log", "md", "markdown"],
            Self::Md => &[],
        }
    }

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

    /// The format a file registers as. Markdown is read as plain text until the
    /// Markdown reader exists, so it registers as [`Self::Txt`] and its anchors
    /// are TXT byte ranges: see `docs/adr/0007-markdown-as-text.md`. Nothing
    /// produces [`Self::Md`] until then.
    pub fn from_extension(extension: &str) -> CoreResult<Self> {
        match extension.to_ascii_lowercase().as_str() {
            "pdf" => Ok(Self::Pdf),
            "epub" => Ok(Self::Epub),
            "txt" | "text" | "log" | "md" | "markdown" => Ok(Self::Txt),
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
    /// How far through the document `last_cursor_anchor` is, `0..1`, when the
    /// reader measured it.
    #[serde(default)]
    pub last_progress: Option<f64>,
    /// Set when the user removes the document from Recent / Continue reading;
    /// cleared back to `None` when the file is opened again.
    #[serde(default)]
    pub hidden_from_recent_at: Option<String>,
    /// Optional metadata title reported by the reader (EPUB `dc:title`,
    /// PDF `Info.Title`), keeping the filename stem in `title` untouched.
    #[serde(default)]
    pub display_title: Option<String>,
}

/// Saved reading position and progress for a document, used as the expected
/// and replacement state in [`crate::db::Database::replace_cursor_if`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CursorSnapshot {
    #[serde(default)]
    pub anchor: Option<AnchorLocation>,
    #[serde(default)]
    pub progress: Option<f64>,
}

impl CursorSnapshot {
    /// Structural equality between two cursor snapshots.
    ///
    /// Compares parsed anchors and `Option<f64>` progress values using
    /// standard finite float equality (so `-0.0 == 0.0` and `None == None`)
    /// rather than raw JSON strings or `f64::to_bits()`. Non-finite floats
    /// never compare equal.
    pub fn matches(&self, other: &Self) -> bool {
        let progress_matches = match (self.progress, other.progress) {
            (None, None) => true,
            (Some(a), Some(b)) => a.is_finite() && b.is_finite() && a == b,
            _ => false,
        };
        progress_matches && self.anchor == other.anchor
    }
}

/// Outcome of [`crate::db::Database::replace_cursor_if`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReplaceCursorResult {
    Replaced,
    Conflict { current: CursorSnapshot },
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

/// Persisted MindMap and Inspector pane state across application restarts (#119).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacePaneLayout {
    #[serde(default)]
    pub mind_map_open: bool,
    #[serde(default)]
    pub inspector_open: bool,
    /// Last non-zero MindMap width percentage (`35..=80`), if customized.
    #[serde(default)]
    pub mind_map_size: Option<f64>,
    /// Last non-zero Inspector width percentage (`20..=80`), if customized.
    #[serde(default)]
    pub inspector_size: Option<f64>,
}

impl WorkspacePaneLayout {
    pub const MIN_MIND_MAP_SIZE: f64 = 35.0;
    pub const MIN_INSPECTOR_SIZE: f64 = 20.0;
    pub const MAX_PANE_SIZE: f64 = 80.0;

    /// Drops non-finite or out-of-range widths so corrupt values cannot collapse the reader.
    pub fn sanitized(&self) -> Self {
        let clamp_size = |value: Option<f64>, min: f64| {
            value.filter(|v| v.is_finite() && (min..=Self::MAX_PANE_SIZE).contains(v))
        };
        Self {
            mind_map_open: self.mind_map_open,
            inspector_open: self.inspector_open,
            mind_map_size: clamp_size(self.mind_map_size, Self::MIN_MIND_MAP_SIZE),
            inspector_size: clamp_size(self.inspector_size, Self::MIN_INSPECTOR_SIZE),
        }
    }
}

/// Persisted reader tab session across application restarts.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSession {
    pub open_document_ids: Vec<String>,
    pub active_document_id: Option<String>,
    /// Immersive reading: chrome collapsed and the toolbar auto-hiding. Optional on
    /// the wire so a frontend that predates it still round-trips.
    #[serde(default)]
    pub immersive: bool,
    /// Persisted MindMap / Inspector visibility and widths. Optional on the wire so
    /// older payloads still round-trip.
    #[serde(default)]
    pub pane_layout: WorkspacePaneLayout,
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

/// How an annotation is drawn over its text. Excerpts are always highlights.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationStyle {
    #[default]
    Highlight,
    Underline,
}

impl AnnotationStyle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Highlight => "highlight",
            Self::Underline => "underline",
        }
    }

    /// Rows only hold what the column's CHECK allows; anything else reads as a
    /// highlight rather than failing the whole notebook load.
    pub fn from_column(value: &str) -> Self {
        match value {
            "underline" => Self::Underline,
            _ => Self::Highlight,
        }
    }
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
    #[serde(default)]
    pub style: AnnotationStyle,
    /// Optional human-readable location reported by the reader at creation time
    /// (for example `"Ch. 3 · p. 41"` or `"Line 6"`), keeping anchors opaque (#125).
    #[serde(default)]
    pub location_label: Option<String>,
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
    /// Optional on the wire so older callers keep creating highlights.
    #[serde(default)]
    pub style: AnnotationStyle,
    /// Optional human-readable location reported by the reader (#125).
    #[serde(default)]
    pub location_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnnotationPatch {
    pub note: Option<String>,
    pub color: Option<String>,
    /// `None` keeps the current style.
    #[serde(default)]
    pub style: Option<AnnotationStyle>,
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
    /// Optional human-readable location reported by the reader (#125).
    #[serde(default)]
    pub location_label: Option<String>,
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

/// An annotation brought back by Undo Delete, with the cards that cite it again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredAnnotation {
    pub annotation: Annotation,
    pub cards: Vec<NoteCard>,
}

/// Summary of a deleted card: its id, removed node(s), removed edges, and child
/// nodes whose `parent_node_id` was cleared to re-root them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedCard {
    pub card_id: String,
    pub node_ids: Vec<String>,
    pub edge_ids: Vec<String>,
    pub rerooted_child_node_ids: Vec<String>,
}

/// A card brought back by Undo Delete, with its node(s), connected edges, and
/// child nodes whose `parent_node_id` was re-attached to it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredCard {
    pub card: NoteCard,
    pub nodes: Vec<MindMapNode>,
    pub edges: Vec<MindMapEdge>,
    pub reparented_children: Vec<MindMapNode>,
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

/// Bounds applied to untrusted LAN-sync payloads during import (ADR 0008).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportLimits {
    pub max_title_chars: usize,
    pub max_bookmark_label_chars: usize,
    pub max_cfi_bytes: usize,
    pub max_href_bytes: usize,
    pub max_rects: usize,
    pub max_page_spans: usize,
    pub max_bookmarks_per_book: usize,
    pub max_catalog_books: usize,
}

impl Default for ImportLimits {
    fn default() -> Self {
        Self {
            max_title_chars: 512,
            max_bookmark_label_chars: 80,
            max_cfi_bytes: 4096,
            max_href_bytes: 1024,
            max_rects: 256,
            max_page_spans: 64,
            max_bookmarks_per_book: 10_000,
            max_catalog_books: 10_000,
        }
    }
}

/// A bookmark payload supplied to [`crate::db::Database::import_bookmarks`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBookmarkEntry {
    pub anchor: AnchorLocation,
    pub label: Option<String>,
    pub created_at: Option<String>,
}

/// Stable reason a bookmark entry was skipped during [`crate::db::Database::import_bookmarks`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BookmarkSkipReason {
    InvalidAnchor,
    FormatMismatch,
    AnchorLimitExceeded,
    BookmarkCapExceeded,
}

impl BookmarkSkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidAnchor => "invalid_anchor",
            Self::FormatMismatch => "format_mismatch",
            Self::AnchorLimitExceeded => "anchor_limit_exceeded",
            Self::BookmarkCapExceeded => "bookmark_cap_exceeded",
        }
    }
}

/// Diagnostic record for a single skipped entry in [`BookmarkImportReport`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedBookmark {
    /// Zero-based index of the entry in the input slice.
    pub index: usize,
    pub reason: BookmarkSkipReason,
}

/// Outcome of [`crate::db::Database::import_bookmarks`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkImportReport {
    pub inserted: usize,
    pub existing: usize,
    pub skipped: usize,
    pub skipped_entries: Vec<SkippedBookmark>,
    pub inserted_bookmarks: Vec<Bookmark>,
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

/// Text-column width, independent of page padding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReadingPageWidth {
    #[default]
    Standard,
    Wide,
    Full,
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
    /// The incoming page curls in around its leading edge, or around the spine of
    /// a two-page spread. Renamed from `flip`; stored rows still carry that name.
    #[serde(alias = "flip")]
    Curl,
    /// The incoming page rises from slightly behind the one it replaces.
    Stack,
}

/// How a continuous-scrolling reader animates an explicit page turn. Reduced
/// motion always turns instantly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScrollPageTransition {
    None,
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
    /// Older preference rows retain the standard 75-character measure.
    #[serde(default)]
    pub page_width: ReadingPageWidth,
    /// Justified text, hyphenated in the document's language.
    pub justify: bool,
    /// Dims images in the Dark theme.
    pub dim_images: bool,
    pub epub_reading_mode: EpubReadingMode,
    /// Also used by PDF single and two-page modes. Rows saved before it existed
    /// take the default, so it needs no migration. The wire enum stays strict:
    /// only `Database::get_reading_preferences` tolerates a mode it does not
    /// know, because only a stored row can have been written by a newer build.
    #[serde(default)]
    pub page_transition: PageTransition,
    /// Used by continuous-scrolling modes (`EPUB` `scroll`, `PDF` `continuous`,
    /// and `TXT`). When `None`, scrolling follows `page_transition` (`none`
    /// stays `none`; every other mode fades) so switching modes preserves both
    /// preferences independently.
    #[serde(default)]
    pub scroll_page_transition: Option<ScrollPageTransition>,
    /// Tints PDF page canvases to match the Dark or Sepia theme. Off by default,
    /// so a figure-heavy PDF is never inverted unexpectedly. The bitmap stays
    /// untouched: only the CSS filter on the canvas changes.
    #[serde(default)]
    pub tint_pdf_pages: bool,
    /// Whether focus mode also enters full screen. Rows saved before it existed
    /// take the default, so it needs no migration.
    #[serde(default)]
    pub focus_mode_full_screen: bool,
    /// Sensitivity level (`1..=5`, default `3`) for vertical wheel page turns in
    /// paginated modes. Higher values trigger with less wheel movement.
    #[serde(default = "default_wheel_sensitivity")]
    pub wheel_sensitivity: u8,
}

const fn default_wheel_sensitivity() -> u8 {
    ReadingPreferences::DEFAULT_WHEEL_SENSITIVITY
}

impl Default for ReadingPreferences {
    fn default() -> Self {
        Self {
            theme: ReadingTheme::Auto,
            font_family: ReadingFontFamily::Original,
            font_size: 100,
            line_spacing: 1.75,
            margins: ReadingMargins::Normal,
            page_width: ReadingPageWidth::Standard,
            justify: true,
            dim_images: false,
            epub_reading_mode: EpubReadingMode::Spread,
            page_transition: PageTransition::Slide,
            scroll_page_transition: None,
            tint_pdf_pages: false,
            focus_mode_full_screen: false,
            wheel_sensitivity: Self::DEFAULT_WHEEL_SENSITIVITY,
        }
    }
}

impl ReadingPreferences {
    pub const MIN_FONT_SIZE: u32 = 75;
    pub const MAX_FONT_SIZE: u32 = 200;
    pub const MIN_LINE_SPACING: f64 = 1.2;
    pub const MAX_LINE_SPACING: f64 = 2.4;
    pub const MIN_WHEEL_SENSITIVITY: u8 = 1;
    pub const MAX_WHEEL_SENSITIVITY: u8 = 5;
    pub const DEFAULT_WHEEL_SENSITIVITY: u8 = 3;

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
        if !(Self::MIN_WHEEL_SENSITIVITY..=Self::MAX_WHEEL_SENSITIVITY)
            .contains(&self.wheel_sensitivity)
        {
            return Err(CoreError::InvalidPreferences(format!(
                "wheelSensitivity must be between {} and {}",
                Self::MIN_WHEEL_SENSITIVITY,
                Self::MAX_WHEEL_SENSITIVITY
            )));
        }
        Ok(())
    }
}

/// How a PDF lays out its pages.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PdfDisplayMode {
    #[default]
    Continuous,
    Single,
    TwoPage,
}

impl PdfDisplayMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Continuous => "continuous",
            Self::Single => "single",
            Self::TwoPage => "two-page",
        }
    }

    /// The column's CHECK admits only known modes; anything else reads as the
    /// default rather than failing the document's load.
    pub fn from_column(value: &str) -> Self {
        match value {
            "single" => Self::Single,
            "two-page" => Self::TwoPage,
            _ => Self::Continuous,
        }
    }
}

/// How a PDF page is sized. `Custom` uses `PdfLayout::scale`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PdfZoomMode {
    #[default]
    FitWidth,
    FitPage,
    ActualSize,
    Custom,
}

impl PdfZoomMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FitWidth => "fit-width",
            Self::FitPage => "fit-page",
            Self::ActualSize => "actual-size",
            Self::Custom => "custom",
        }
    }

    /// See `PdfDisplayMode::from_column`.
    pub fn from_column(value: &str) -> Self {
        match value {
            "fit-page" => Self::FitPage,
            "actual-size" => Self::ActualSize,
            "custom" => Self::Custom,
            _ => Self::FitWidth,
        }
    }
}

/// One PDF's page layout, stored and sent as a whole: `scale` only applies to the
/// custom zoom mode and `cover_page_alone` only to two pages, so a partial update
/// could produce a layout the reader never chose.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfLayout {
    pub display_mode: PdfDisplayMode,
    pub zoom_mode: PdfZoomMode,
    /// The custom zoom factor (`0.25..=4`), kept while another zoom mode is chosen
    /// so returning to custom zoom restores it.
    pub scale: f64,
    /// Clockwise view rotation in degrees: 0, 90, 180, or 270.
    pub rotation: u16,
    /// Two pages show page 1 alone, then 2-3, 4-5, so printed spreads face each other.
    pub cover_page_alone: bool,
}

impl Default for PdfLayout {
    fn default() -> Self {
        Self {
            display_mode: PdfDisplayMode::Continuous,
            zoom_mode: PdfZoomMode::FitWidth,
            scale: 1.0,
            rotation: 0,
            cover_page_alone: false,
        }
    }
}

impl PdfLayout {
    pub const MIN_SCALE: f64 = 0.25;
    pub const MAX_SCALE: f64 = 4.0;
    pub const ROTATIONS: [u16; 4] = [0, 90, 180, 270];

    pub fn validate(&self) -> CoreResult<()> {
        if !self.scale.is_finite() || !(Self::MIN_SCALE..=Self::MAX_SCALE).contains(&self.scale) {
            return Err(CoreError::InvalidLayout(format!(
                "scale must be between {} and {}",
                Self::MIN_SCALE,
                Self::MAX_SCALE
            )));
        }
        if !Self::ROTATIONS.contains(&self.rotation) {
            return Err(CoreError::InvalidLayout(
                "rotation must be 0, 90, 180, or 270".to_owned(),
            ));
        }
        Ok(())
    }

    /// The layout a PDF without one of its own starts from, after `self` was the
    /// last one saved. Display and zoom are habits that carry over. Rotation and the
    /// cover page describe one particular file, so they start fresh.
    pub fn inherited(&self) -> Self {
        Self {
            display_mode: self.display_mode,
            zoom_mode: self.zoom_mode,
            scale: self.scale,
            ..Self::default()
        }
    }
}

/// Returns `true` for C0 controls, DEL, C1 controls, and Unicode bidirectional
/// override/embedding/isolate formatting characters that must be stripped from
/// untrusted peer strings.
pub fn is_forbidden_control_char(ch: char) -> bool {
    matches!(
        ch,
        '\u{0000}'..='\u{001F}'
            | '\u{007F}'
            | '\u{0080}'..='\u{009F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2066}'..='\u{2069}'
    )
}

/// Strips forbidden control and bidi formatting characters from `text`.
pub fn strip_control_and_bidi(text: &str) -> String {
    text.chars()
        .filter(|&ch| !is_forbidden_control_char(ch))
        .collect()
}

/// Extracts the first non-empty trimmed line after stripping forbidden control
/// and bidi formatting characters.
pub fn sanitize_single_line(raw: &str) -> Option<String> {
    raw.lines().find_map(|line| {
        let cleaned = strip_control_and_bidi(line);
        let trimmed = cleaned.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_owned())
        }
    })
}

/// Truncates `text` to at most `max_chars` Unicode scalar values, appending an
/// ellipsis when shortened.
pub fn truncate_chars(text: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    if text.chars().count() <= max_chars {
        return text.to_owned();
    }
    if max_chars == 1 {
        return "…".to_owned();
    }
    let mut shortened: String = text.chars().take(max_chars - 1).collect();
    shortened.push('…');
    shortened
}

/// Sanitizes a book title received from a peer (first non-empty trimmed line,
/// controls/bidi stripped, capped to `limits.max_title_chars`), falling back to
/// `"Untitled"` when nothing remains.
pub fn sanitize_import_title(raw: &str, limits: &ImportLimits) -> String {
    sanitize_single_line(raw)
        .map(|line| truncate_chars(&line, limits.max_title_chars))
        .unwrap_or_else(|| "Untitled".to_owned())
}

/// Sanitizes a bookmark label received from a peer using the same rules as
/// `Database::import_bookmarks` (first non-empty trimmed line, controls/bidi
/// stripped, falling back to the anchor's default label or `"Bookmark"`, and
/// capped to `limits.max_bookmark_label_chars`).
pub fn sanitize_bookmark_label(
    raw: Option<&str>,
    anchor: &AnchorLocation,
    limits: &ImportLimits,
) -> String {
    let candidate = raw
        .and_then(sanitize_single_line)
        .or_else(|| sanitize_single_line(&anchor.default_bookmark_label()))
        .unwrap_or_else(|| "Bookmark".to_owned());
    truncate_chars(&candidate, limits.max_bookmark_label_chars)
}

/// Outcome of importing a verified document file into the local database.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", content = "document", rename_all = "camelCase")]
pub enum ImportDocumentResult {
    /// A new document record was inserted.
    Created(Document),
    /// An existing record whose source file was missing had its `file_path` repaired.
    Repaired(Document),
    /// An existing record already points to an on-disk file and was left untouched.
    AlreadyPresent(Document),
}

impl ImportDocumentResult {
    pub fn document(&self) -> &Document {
        match self {
            Self::Created(doc) | Self::Repaired(doc) | Self::AlreadyPresent(doc) => doc,
        }
    }

    pub fn into_document(self) -> Document {
        match self {
            Self::Created(doc) | Self::Repaired(doc) | Self::AlreadyPresent(doc) => doc,
        }
    }
}

/// Privacy-filtered catalog metadata for LAN sync export.
/// Intentionally omits `file_path` and `last_opened_at` (ADR 0008, T-14).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCatalogBook {
    pub document_id: String,
    pub file_hash: String,
    pub title: String,
    pub format: DocumentFormat,
    pub extension: String,
    pub has_position: bool,
    pub bookmark_count: u64,
}

/// Saved reading position for LAN sync export.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPosition {
    pub anchor: AnchorLocation,
    pub progress: Option<f64>,
}

/// Privacy-filtered bookmark entry for LAN sync export.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBookmark {
    pub anchor: AnchorLocation,
    pub label: String,
    pub created_at: String,
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

        let mut nan_spacing = prefs.clone();
        nan_spacing.line_spacing = f64::NAN;
        assert!(matches!(
            nan_spacing.validate(),
            Err(CoreError::InvalidPreferences(_))
        ));

        for invalid in [0_u8, 6_u8] {
            let mut bad_sensitivity = prefs.clone();
            bad_sensitivity.wheel_sensitivity = invalid;
            assert!(matches!(
                bad_sensitivity.validate(),
                Err(CoreError::InvalidPreferences(_))
            ));
        }
        for valid in
            ReadingPreferences::MIN_WHEEL_SENSITIVITY..=ReadingPreferences::MAX_WHEEL_SENSITIVITY
        {
            let mut valid_sensitivity = prefs.clone();
            valid_sensitivity.wheel_sensitivity = valid;
            assert!(valid_sensitivity.validate().is_ok());
        }
    }

    #[test]
    fn pdf_layout_uses_the_wire_names_the_frontend_sends() {
        let layout = PdfLayout {
            display_mode: PdfDisplayMode::TwoPage,
            zoom_mode: PdfZoomMode::ActualSize,
            scale: 1.25,
            rotation: 270,
            cover_page_alone: true,
        };
        let wire = serde_json::json!({
            "displayMode": "two-page",
            "zoomMode": "actual-size",
            "scale": 1.25,
            "rotation": 270,
            "coverPageAlone": true,
        });
        assert_eq!(serde_json::to_value(&layout).unwrap(), wire);
        assert_eq!(
            serde_json::from_value::<PdfLayout>(wire.clone()).unwrap(),
            layout
        );
        for mode in [
            PdfDisplayMode::Continuous,
            PdfDisplayMode::Single,
            PdfDisplayMode::TwoPage,
        ] {
            assert_eq!(PdfDisplayMode::from_column(mode.as_str()), mode);
        }
        for mode in [
            PdfZoomMode::FitWidth,
            PdfZoomMode::FitPage,
            PdfZoomMode::ActualSize,
            PdfZoomMode::Custom,
        ] {
            assert_eq!(PdfZoomMode::from_column(mode.as_str()), mode);
        }

        // The layout is sent whole: a missing or extra field is an error.
        let mut partial = wire.clone();
        partial.as_object_mut().unwrap().remove("coverPageAlone");
        assert!(serde_json::from_value::<PdfLayout>(partial).is_err());
        let mut extra = wire;
        extra["pageLabels"] = serde_json::json!(true);
        assert!(serde_json::from_value::<PdfLayout>(extra).is_err());
    }

    #[test]
    fn page_transition_round_trips_every_mode_and_rejects_an_unknown_one() {
        for (mode, wire) in [
            (PageTransition::None, "none"),
            (PageTransition::Slide, "slide"),
            (PageTransition::Fade, "fade"),
            (PageTransition::Curl, "curl"),
            (PageTransition::Stack, "stack"),
        ] {
            assert_eq!(serde_json::to_value(mode).unwrap(), serde_json::json!(wire));
            assert_eq!(
                serde_json::from_value::<PageTransition>(serde_json::json!(wire)).unwrap(),
                mode
            );
        }

        // `flip` is the name this mode had before it became `curl`. A stored row
        // written by an older build still carries it, and must keep loading.
        assert_eq!(
            serde_json::from_value::<PageTransition>(serde_json::json!("flip")).unwrap(),
            PageTransition::Curl
        );
        // What this build writes is the new name, so a rewrite is a no-op.
        assert_eq!(
            serde_json::to_value(PageTransition::Curl).unwrap(),
            serde_json::json!("curl")
        );

        // The wire enum is what `save_reading_preferences` takes, so it stays
        // strict: a mode this build does not know is a rejected argument, not a
        // silently stored default. Only the read path is lenient.
        let sent = serde_json::json!({
            "theme": "sepia",
            "fontFamily": "new-york",
            "fontSize": 110,
            "lineSpacing": 1.4,
            "margins": "wide",
            "pageWidth": "full",
            "justify": false,
            "dimImages": true,
            "epubReadingMode": "paged",
            "pageTransition": "peel",
        });
        assert!(serde_json::from_value::<ReadingPreferences>(sent).is_err());
    }

    #[test]
    fn reading_preferences_without_a_page_transition_take_the_default() {
        let stored = serde_json::json!({
            "theme": "light",
            "fontFamily": "original",
            "fontSize": 100,
            "lineSpacing": 1.75,
            "margins": "normal",
            "justify": true,
            "dimImages": false,
            "epubReadingMode": "spread",
        });
        let prefs: ReadingPreferences = serde_json::from_value(stored).unwrap();
        assert_eq!(prefs.page_transition, PageTransition::Slide);
        assert_eq!(prefs.scroll_page_transition, None);
        // The same row predates the appearance switches and wheel sensitivity.
        assert!(!prefs.tint_pdf_pages);
        assert!(!prefs.focus_mode_full_screen);
        assert_eq!(prefs.wheel_sensitivity, 3);
    }

    #[test]
    fn scroll_page_transition_round_trips_and_rejects_paginated_only_modes() {
        for (mode, wire) in [
            (ScrollPageTransition::None, "none"),
            (ScrollPageTransition::Fade, "fade"),
        ] {
            assert_eq!(serde_json::to_value(mode).unwrap(), serde_json::json!(wire));
            assert_eq!(
                serde_json::from_value::<ScrollPageTransition>(serde_json::json!(wire)).unwrap(),
                mode
            );
        }

        let default_wire = serde_json::to_value(ReadingPreferences::default()).unwrap();
        assert_eq!(
            default_wire["scrollPageTransition"],
            serde_json::Value::Null
        );

        for value in [
            serde_json::Value::Null,
            serde_json::json!("none"),
            serde_json::json!("fade"),
        ] {
            let mut sent = default_wire.clone();
            sent["scrollPageTransition"] = value.clone();
            let parsed: ReadingPreferences = serde_json::from_value(sent).unwrap();
            assert_eq!(
                serde_json::to_value(parsed.scroll_page_transition).unwrap(),
                value
            );
        }

        for invalid in ["slide", "curl", "stack", "peel"] {
            let mut sent = default_wire.clone();
            sent["scrollPageTransition"] = serde_json::json!(invalid);
            assert!(
                serde_json::from_value::<ReadingPreferences>(sent).is_err(),
                "expected {invalid} to be rejected for scrollPageTransition"
            );
        }
    }

    #[test]
    fn reading_preferences_appearance_switches_round_trip_over_the_wire() {
        let prefs = ReadingPreferences {
            theme: ReadingTheme::Dark,
            tint_pdf_pages: true,
            focus_mode_full_screen: true,
            wheel_sensitivity: 5,
            ..ReadingPreferences::default()
        };
        let wire = serde_json::to_value(&prefs).unwrap();
        assert_eq!(wire["tintPdfPages"], true);
        assert_eq!(wire["focusModeFullScreen"], true);
        assert_eq!(wire["wheelSensitivity"], 5);

        let sent = serde_json::json!({
            "theme": "sepia",
            "fontFamily": "original",
            "fontSize": 100,
            "lineSpacing": 1.75,
            "margins": "normal",
            "pageWidth": "standard",
            "justify": true,
            "dimImages": false,
            "epubReadingMode": "spread",
            "pageTransition": "slide",
            "tintPdfPages": true,
            "focusModeFullScreen": false,
            "wheelSensitivity": 2,
        });
        let parsed: ReadingPreferences = serde_json::from_value(sent).unwrap();
        assert!(parsed.tint_pdf_pages);
        assert!(!parsed.focus_mode_full_screen);
        assert_eq!(parsed.wheel_sensitivity, 2);
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
            DocumentFormat::from_extension("MarkDown").unwrap(),
            DocumentFormat::Txt
        );
        assert!(DocumentFormat::from_extension("docx").is_err());
    }

    #[test]
    fn every_picker_extension_is_a_known_format() {
        for extension in DocumentFormat::EXTENSIONS {
            DocumentFormat::from_extension(extension).unwrap();
        }
    }

    /// Issue #99: `Md` has no reader, so a picked or dropped file must never
    /// register as it, or it opens as a tab with nothing to read.
    #[test]
    fn markdown_registers_as_readable_text() {
        for extension in ["md", "markdown", "MD"] {
            assert_eq!(
                DocumentFormat::from_extension(extension).unwrap(),
                DocumentFormat::Txt
            );
        }
        for extension in DocumentFormat::EXTENSIONS {
            assert_ne!(
                DocumentFormat::from_extension(extension).unwrap(),
                DocumentFormat::Md
            );
        }
    }

    #[test]
    fn per_format_extensions_partition_the_picker_list() {
        let formats = [
            DocumentFormat::Pdf,
            DocumentFormat::Epub,
            DocumentFormat::Txt,
            DocumentFormat::Md,
        ];
        let mut all: Vec<&str> = Vec::new();
        for format in formats {
            for extension in format.extensions() {
                assert_eq!(DocumentFormat::from_extension(extension).unwrap(), format);
                all.push(extension);
            }
        }
        all.sort_unstable();
        let mut picker = DocumentFormat::EXTENSIONS.to_vec();
        picker.sort_unstable();
        assert_eq!(all, picker);
    }

    #[derive(Deserialize)]
    struct FormatContract {
        formats: Vec<FormatContractEntry>,
    }

    #[derive(Deserialize)]
    struct FormatContractEntry {
        label: String,
        format: DocumentFormat,
        extensions: Vec<String>,
    }

    /// The frontend builds the drop overlay and empty-state copy from this file,
    /// so the formats it names are exactly the ones the picker offers.
    #[test]
    fn document_format_contract_matches_the_picker() {
        let contract: FormatContract = serde_json::from_str(include_str!(
            "../../../fixtures/contract/document-formats.json"
        ))
        .unwrap();
        let mut listed = Vec::new();
        for entry in &contract.formats {
            assert!(!entry.label.is_empty());
            assert!(
                !entry.extensions.is_empty(),
                "{} lists no extension",
                entry.label
            );
            for extension in &entry.extensions {
                assert_eq!(
                    DocumentFormat::from_extension(extension).unwrap(),
                    entry.format,
                    "{extension}"
                );
                listed.push(extension.as_str());
            }
        }
        assert_eq!(listed, DocumentFormat::EXTENSIONS);
    }

    #[test]
    fn cursor_snapshot_matches_structurally_and_treats_signed_zero_as_equal() {
        let empty = CursorSnapshot::default();
        assert!(empty.matches(&CursorSnapshot {
            anchor: None,
            progress: None,
        }));

        let anchor = AnchorLocation::Txt {
            start_byte_offset: 10,
            end_byte_offset: 20,
            line_index: 1,
        };
        let pos_zero = CursorSnapshot {
            anchor: Some(anchor.clone()),
            progress: Some(0.0),
        };
        let neg_zero = CursorSnapshot {
            anchor: Some(anchor.clone()),
            progress: Some(-0.0),
        };
        assert!(pos_zero.matches(&neg_zero));
        assert!(neg_zero.matches(&pos_zero));

        let no_progress = CursorSnapshot {
            anchor: Some(anchor.clone()),
            progress: None,
        };
        assert!(!pos_zero.matches(&no_progress));
        assert!(!no_progress.matches(&pos_zero));

        let nan = CursorSnapshot {
            anchor: Some(anchor.clone()),
            progress: Some(f64::NAN),
        };
        assert!(!nan.matches(&nan));

        let inf = CursorSnapshot {
            anchor: Some(anchor),
            progress: Some(f64::INFINITY),
        };
        assert!(!inf.matches(&inf));
    }

    #[test]
    fn import_limits_and_sanitizers_strip_controls_bidi_and_enforce_caps() {
        let limits = ImportLimits::default();
        assert_eq!(limits.max_title_chars, 512);
        assert_eq!(limits.max_bookmark_label_chars, 80);
        assert_eq!(limits.max_cfi_bytes, 4096);
        assert_eq!(limits.max_href_bytes, 1024);
        assert_eq!(limits.max_rects, 256);
        assert_eq!(limits.max_page_spans, 64);
        assert_eq!(limits.max_bookmarks_per_book, 10_000);
        assert_eq!(limits.max_catalog_books, 10_000);

        let anchor = AnchorLocation::Txt {
            start_byte_offset: 0,
            end_byte_offset: 10,
            line_index: 4,
        };

        // Strips C0, DEL, C1, bidi overrides (U+202A..=U+202E), and bidi isolates (U+2066..=U+2069)
        let hostile = "  \u{0000}Hello\u{0007}\u{001F}\u{007F}\u{0080}\u{009F} \u{202E}World\u{202C}\u{2066}!\u{2069}  \nSecond line";
        assert_eq!(sanitize_import_title(hostile, &limits), "Hello World!");
        assert_eq!(
            sanitize_bookmark_label(Some(hostile), &anchor, &limits),
            "Hello World!"
        );

        // Empty or control-only inputs fall back cleanly
        let only_controls = "\u{0000}\u{001B}\u{202E}\u{2066}   \t\n";
        assert_eq!(sanitize_import_title(only_controls, &limits), "Untitled");
        assert_eq!(
            sanitize_bookmark_label(Some(only_controls), &anchor, &limits),
            "Line 5"
        );

        // Character caps apply on Unicode scalar boundaries with ellipsis
        let long_title = "书".repeat(600);
        let sanitized_title = sanitize_import_title(&long_title, &limits);
        assert_eq!(sanitized_title.chars().count(), 512);
        assert!(sanitized_title.ends_with('…'));

        let long_label = "章".repeat(120);
        let sanitized_label = sanitize_bookmark_label(Some(&long_label), &anchor, &limits);
        assert_eq!(sanitized_label.chars().count(), 80);
        assert!(sanitized_label.ends_with('…'));
    }
}
