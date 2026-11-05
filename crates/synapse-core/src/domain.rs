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

/// Format-agnostic position inside a document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "format", rename_all = "lowercase")]
pub enum AnchorLocation {
    #[serde(rename_all = "camelCase")]
    Pdf {
        page_index: u32,
        rects: Vec<NormalizedRect>,
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
        match self {
            Self::Pdf { rects, .. } => {
                if rects.is_empty() {
                    return invalid("a PDF anchor needs at least one rectangle");
                }
                let in_unit = |v: f64| (0.0..=1.0).contains(&v);
                let all_valid = rects.iter().all(|r| {
                    in_unit(r.x)
                        && in_unit(r.y)
                        && r.width > 0.0
                        && r.height > 0.0
                        && in_unit(r.x + r.width)
                        && in_unit(r.y + r.height)
                });
                if !all_valid {
                    return invalid("PDF rectangles must be non-empty and within the unit square");
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
    pub created_at: String,
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
    pub color: String,
    pub created_at: String,
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
    pub excerpt_image_path: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contract_fixture_parses_and_validates() {
        let fixture = include_str!("../../../fixtures/contract/anchors.json");
        let anchors: Vec<AnchorLocation> = serde_json::from_str(fixture).unwrap();
        assert_eq!(anchors.len(), 5);
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
        };
        assert!(anchor.validate().is_err());
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
}
