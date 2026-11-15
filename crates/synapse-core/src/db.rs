//! SQLite persistence: migrations and every query the app runs.

use std::path::{Path, PathBuf};

use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params};
use serde::de::DeserializeOwned;
use uuid::Uuid;

use crate::captures::{CaptureStore, decode_capture};
use crate::domain::{
    AnchorLocation, Annotation, AnnotationPatch, AnnotationStyle, Bookmark, CardPatch,
    CreateAnnotationInput, CreateBookmarkInput, CreateExcerptInput, CreatedExcerpt, Document,
    DocumentFormat, DocumentSourceState, DocumentSourceStatus, MindMapEdge, MindMapNode,
    NodeLayoutPatch, NoteCard, NotebookGraph, PageTransition, PdfDisplayMode, PdfLayout,
    PdfZoomMode, ReadingPreferences, RelinkDocumentResult, StudyNotebook, Viewport,
    WorkspaceSession,
};
use crate::fs_reader::{UTF8_LABEL, hash_file};
use crate::{CoreError, CoreResult};

/// Ordered and append-only: a migration's position is its schema version.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_init.sql"),
    include_str!("../migrations/0002_reading_preferences.sql"),
    include_str!("../migrations/0003_bookmarks.sql"),
    include_str!("../migrations/0004_independent_annotations.sql"),
    include_str!("../migrations/0005_workspace_session.sql"),
    include_str!("../migrations/0006_workspace_immersive.sql"),
    include_str!("../migrations/0007_reading_appearance.sql"),
    include_str!("../migrations/0008_annotation_style.sql"),
    include_str!("../migrations/0009_pdf_document_layout.sql"),
    include_str!("../migrations/0010_document_progress.sql"),
    include_str!("../migrations/0011_page_transition_curl.sql"),
];

const CARD_TITLE_MAX_CHARS: usize = 80;

/// Owns the single SQLite connection.
pub struct Database {
    conn: Connection,
    /// `None` only for a purely in-memory database, which has no data directory.
    captures: Option<CaptureStore>,
}

impl Database {
    /// Opens (or creates) the database at `path` and brings its schema up to date.
    /// Captures are stored next to the database file.
    pub fn open(path: &Path) -> CoreResult<Self> {
        let captures = path.parent().map(CaptureStore::new);
        Self::init(Connection::open(path)?, captures)
    }

    pub fn open_in_memory() -> CoreResult<Self> {
        Self::init(Connection::open_in_memory()?, None)
    }

    fn init(mut conn: Connection, captures: Option<CaptureStore>) -> CoreResult<Self> {
        // foreign_keys is per-connection and off by default in SQLite.
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate(&mut conn)?;
        Ok(Self { conn, captures })
    }

    pub fn captures_directory(&self) -> Option<PathBuf> {
        self.captures.as_ref().map(CaptureStore::directory)
    }

    pub fn schema_version(&self) -> CoreResult<u32> {
        Ok(self
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))?)
    }

    // ---- Documents -------------------------------------------------------

    /// Registers the file at `path`, or returns the existing record when this
    /// content is already known. A known file found at a new path has its
    /// stored path updated, keeping its annotations attached.
    pub fn register_document(&self, path: &Path) -> CoreResult<Document> {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let format = DocumentFormat::from_extension(extension)?;
        let file_hash = hash_file(path)?;
        let file_path = path.to_string_lossy();
        let title = path
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_else(|| file_path.clone().into_owned());

        self.conn.execute(
            "INSERT INTO documents (id, title, file_path, file_hash, format, encoding, last_opened_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT (file_hash) DO UPDATE SET
                 file_path = excluded.file_path,
                 last_opened_at = excluded.last_opened_at",
            params![
                new_id(),
                title,
                file_path,
                file_hash,
                format.as_str(),
                UTF8_LABEL
            ],
        )?;
        Ok(self.conn.query_row(
            &format!("{DOCUMENT_SELECT} WHERE file_hash = ?1"),
            [&file_hash],
            map_document,
        )?)
    }

    pub fn touch_document_opened(&self, document_id: &str) -> CoreResult<Document> {
        let changed = self.conn.execute(
            "UPDATE documents SET last_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1",
            [document_id],
        )?;
        expect_changed(changed, "document", document_id)?;
        Ok(self.conn.query_row(
            &format!("{DOCUMENT_SELECT} WHERE id = ?1"),
            [document_id],
            map_document,
        )?)
    }

    pub fn list_documents(&self) -> CoreResult<Vec<Document>> {
        let mut statement = self
            .conn
            .prepare(&format!("{DOCUMENT_SELECT} ORDER BY created_at, id"))?;
        Ok(statement
            .query_map([], map_document)?
            .collect::<Result<_, _>>()?)
    }

    /// Where a registered document lives. This is the only way a document id
    /// becomes a path: callers outside core never choose what gets read.
    pub fn document_path(&self, document_id: &str) -> CoreResult<PathBuf> {
        let path: String = self
            .conn
            .query_row(
                "SELECT file_path FROM documents WHERE id = ?1",
                [document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| not_found("document", document_id))?;
        Ok(PathBuf::from(path))
    }

    /// Saves the reading position, and how far through the document it is as a
    /// fraction `0..1`. `None` clears the fraction: a percentage measured for an
    /// earlier position would be wrong for this one.
    pub fn update_document_cursor(
        &self,
        document_id: &str,
        anchor: &AnchorLocation,
        progress: Option<f64>,
    ) -> CoreResult<()> {
        anchor.validate()?;
        if let Some(progress) = progress
            && !(0.0..=1.0).contains(&progress)
        {
            return Err(CoreError::InvalidProgress(format!(
                "progress must be a fraction between 0 and 1, got {progress}"
            )));
        }
        let changed = self.conn.execute(
            "UPDATE documents SET last_cursor_anchor = ?2, last_progress = ?3 WHERE id = ?1",
            params![document_id, serde_json::to_string(anchor)?, progress],
        )?;
        expect_changed(changed, "document", document_id)
    }

    pub fn get_document(&self, document_id: &str) -> CoreResult<Document> {
        self.conn
            .query_row(
                &format!("{DOCUMENT_SELECT} WHERE id = ?1"),
                [document_id],
                map_document,
            )
            .optional()?
            .ok_or_else(|| not_found("document", document_id))
    }

    /// Checks whether a registered document's file is present and matches its
    /// recorded SHA-256 `file_hash`, without mutating the database.
    pub fn verify_document_source(&self, document_id: &str) -> CoreResult<DocumentSourceStatus> {
        let document = self.get_document(document_id)?;
        let path = Path::new(&document.file_path);
        let metadata = match std::fs::metadata(path) {
            Ok(meta) if meta.is_file() => meta,
            _ => {
                return Ok(DocumentSourceStatus {
                    document_id: document.id,
                    state: DocumentSourceState::Missing,
                    current_file_hash: None,
                    file_size_bytes: None,
                });
            }
        };
        let current_hash = hash_file(path)?;
        let state = if current_hash == document.file_hash {
            DocumentSourceState::Ok
        } else {
            DocumentSourceState::Changed
        };
        Ok(DocumentSourceStatus {
            document_id: document.id,
            state,
            current_file_hash: Some(current_hash),
            file_size_bytes: Some(metadata.len()),
        })
    }

    /// Explicitly relinks an existing document to `new_path`, updating its stored
    /// `file_path`, `file_hash`, and `title` while keeping all existing annotations,
    /// bookmarks, and MindMap cards attached.
    ///
    /// Rejects format changes and hash collisions with another registered document.
    /// When `file_hash` changes, `last_cursor_anchor` is cleared so stale offsets
    /// are never silently applied on reopen.
    pub fn relink_document(
        &self,
        document_id: &str,
        new_path: &Path,
    ) -> CoreResult<RelinkDocumentResult> {
        let existing = self.get_document(document_id)?;
        let extension = new_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let format = DocumentFormat::from_extension(extension)?;
        if format != existing.format {
            return Err(CoreError::UnsupportedFormat(format!(
                "cannot relink a {} document to a {} file",
                existing.format.as_str(),
                format.as_str()
            )));
        }

        let new_hash = hash_file(new_path)?;
        let duplicate_id: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM documents WHERE file_hash = ?1 AND id != ?2",
                params![new_hash, document_id],
                |row| row.get(0),
            )
            .optional()?;
        if duplicate_id.is_some() {
            return Err(CoreError::InvalidGraph(
                "that file is already registered as another document in your library".to_owned(),
            ));
        }

        let content_changed = new_hash != existing.file_hash;
        let file_path = new_path.to_string_lossy();
        let title = new_path
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_else(|| file_path.clone().into_owned());

        if content_changed {
            self.conn.execute(
                "UPDATE documents SET
                     title = ?2,
                     file_path = ?3,
                     file_hash = ?4,
                     last_cursor_anchor = NULL,
                     last_progress = NULL,
                     last_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id = ?1",
                params![document_id, title, file_path, new_hash],
            )?;
        } else {
            self.conn.execute(
                "UPDATE documents SET
                     title = ?2,
                     file_path = ?3,
                     last_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id = ?1",
                params![document_id, title, file_path],
            )?;
        }

        Ok(RelinkDocumentResult {
            document: self.get_document(document_id)?,
            content_changed,
            previous_file_hash: existing.file_hash,
        })
    }

    // ---- Notebooks -------------------------------------------------------

    pub fn create_notebook(&self, title: &str) -> CoreResult<StudyNotebook> {
        let id = new_id();
        self.conn.execute(
            "INSERT INTO study_notebooks (id, title) VALUES (?1, ?2)",
            params![id, title],
        )?;
        self.get_notebook(&id)
    }

    pub fn list_notebooks(&self) -> CoreResult<Vec<StudyNotebook>> {
        let mut statement = self
            .conn
            .prepare(&format!("{NOTEBOOK_SELECT} ORDER BY created_at, id"))?;
        Ok(statement
            .query_map([], map_notebook)?
            .collect::<Result<_, _>>()?)
    }

    pub fn save_notebook_viewport(&self, notebook_id: &str, viewport: &Viewport) -> CoreResult<()> {
        let changed = self.conn.execute(
            "UPDATE study_notebooks SET viewport_json = ?2 WHERE id = ?1",
            params![notebook_id, serde_json::to_string(viewport)?],
        )?;
        expect_changed(changed, "notebook", notebook_id)
    }

    fn get_notebook(&self, notebook_id: &str) -> CoreResult<StudyNotebook> {
        self.conn
            .query_row(
                &format!("{NOTEBOOK_SELECT} WHERE id = ?1"),
                [notebook_id],
                map_notebook,
            )
            .optional()?
            .ok_or_else(|| not_found("notebook", notebook_id))
    }

    /// Loads everything needed to render a notebook.
    pub fn load_notebook_graph(&self, notebook_id: &str) -> CoreResult<NotebookGraph> {
        let notebook = self.get_notebook(notebook_id)?;

        let mut statement = self.conn.prepare(&format!(
            "{ANNOTATION_SELECT} WHERE notebook_id = ?1 ORDER BY created_at, id"
        ))?;
        let annotations = statement
            .query_map([notebook_id], map_annotation)?
            .collect::<Result<Vec<_>, _>>()?;

        let mut statement = self.conn.prepare(&format!(
            "{CARD_SELECT} WHERE notebook_id = ?1 ORDER BY created_at, id"
        ))?;
        let cards = statement
            .query_map([notebook_id], map_card)?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .map(|card| self.with_annotation_ids(card))
            .collect::<CoreResult<Vec<_>>>()?;

        let mut statement = self.conn.prepare(&format!(
            "{NODE_SELECT} WHERE notebook_id = ?1 ORDER BY rowid"
        ))?;
        let nodes = statement
            .query_map([notebook_id], map_node)?
            .collect::<Result<Vec<_>, _>>()?;

        let mut statement = self.conn.prepare(&format!(
            "{EDGE_SELECT} WHERE notebook_id = ?1 ORDER BY rowid"
        ))?;
        let edges = statement
            .query_map([notebook_id], map_edge)?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(NotebookGraph {
            notebook,
            annotations,
            cards,
            nodes,
            edges,
        })
    }

    // ---- Excerpts --------------------------------------------------------

    /// The "Excerpt to MindMap" write: annotation, card, join row, node and
    /// optional parent edge commit atomically, so a failure leaves no orphans.
    /// A capture is written first, under the new annotation's id, and removed
    /// again if the transaction does not commit.
    pub fn create_excerpt(&mut self, input: &CreateExcerptInput) -> CoreResult<CreatedExcerpt> {
        input.anchor.validate()?;
        let has_text = input
            .excerpt_text
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty());
        if !has_text && input.excerpt_image_png.is_none() {
            return Err(CoreError::InvalidAnchor(
                "an excerpt needs text or a captured image".to_owned(),
            ));
        }
        let capture = input
            .excerpt_image_png
            .as_deref()
            .map(decode_capture)
            .transpose()?;

        let annotation_id = new_id();
        let image_path = match (&capture, &self.captures) {
            (Some(png), Some(store)) => Some(store.write(&annotation_id, png)?),
            (Some(_), None) => {
                return Err(CoreError::InvalidCapture(
                    "this database has no directory for captures".to_owned(),
                ));
            }
            (None, _) => None,
        };

        let result = self.insert_excerpt(input, &annotation_id, image_path.as_deref());
        if result.is_err()
            && let (Some(path), Some(store)) = (&image_path, &self.captures)
        {
            store.remove(path);
        }
        result
    }

    fn insert_excerpt(
        &mut self,
        input: &CreateExcerptInput,
        annotation_id: &str,
        image_path: Option<&str>,
    ) -> CoreResult<CreatedExcerpt> {
        let tx = self.conn.transaction()?;
        check_anchor_matches_document(&tx, &input.document_id, &input.anchor)?;
        if let Some(parent_id) = &input.parent_node_id {
            check_node_in_notebook(&tx, parent_id, &input.notebook_id)?;
        }

        let anchor_type = input.anchor.format().as_str();
        tx.execute(
            "INSERT INTO annotations (id, document_id, notebook_id, anchor_type,
                 anchor_payload_json, excerpt_text, excerpt_image_path, color)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                annotation_id,
                input.document_id,
                input.notebook_id,
                anchor_type,
                serde_json::to_string(&input.anchor)?,
                input.excerpt_text,
                image_path,
                input.color,
            ],
        )?;

        let card_id = new_id();
        tx.execute(
            "INSERT INTO note_cards (id, notebook_id, title) VALUES (?1, ?2, ?3)",
            params![
                card_id,
                input.notebook_id,
                card_title(input.excerpt_text.as_deref())
            ],
        )?;
        tx.execute(
            "INSERT INTO card_annotations (card_id, annotation_id) VALUES (?1, ?2)",
            params![card_id, annotation_id],
        )?;

        let node_id = new_id();
        tx.execute(
            "INSERT INTO mindmap_nodes (id, notebook_id, card_id, parent_node_id, pos_x, pos_y)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                node_id,
                input.notebook_id,
                card_id,
                input.parent_node_id,
                input.pos_x,
                input.pos_y
            ],
        )?;

        let edge = match &input.parent_node_id {
            Some(parent_id) => Some(insert_edge(
                &tx,
                &input.notebook_id,
                parent_id,
                &node_id,
                None,
            )?),
            None => None,
        };

        let annotation = tx.query_row(
            &format!("{ANNOTATION_SELECT} WHERE id = ?1"),
            [annotation_id],
            map_annotation,
        )?;
        let mut card = tx.query_row(
            &format!("{CARD_SELECT} WHERE id = ?1"),
            [&card_id],
            map_card,
        )?;
        card.annotation_ids = vec![annotation_id.to_owned()];
        let node = tx.query_row(
            &format!("{NODE_SELECT} WHERE id = ?1"),
            [&node_id],
            map_node,
        )?;

        tx.commit()?;
        Ok(CreatedExcerpt {
            annotation,
            card,
            node,
            edge,
        })
    }

    /// Creates an independent highlight or note inside `input.document_id`
    /// without generating a `NoteCard` or `MindMapNode`.
    pub fn create_annotation(&mut self, input: &CreateAnnotationInput) -> CoreResult<Annotation> {
        input.anchor.validate()?;
        if input.color.trim().is_empty() {
            return Err(CoreError::InvalidAnchor(
                "an annotation needs a highlight color".to_owned(),
            ));
        }
        let has_text = input
            .excerpt_text
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty());
        let has_note = input
            .note
            .as_deref()
            .is_some_and(|note| !note.trim().is_empty());
        if !has_text && input.excerpt_image_png.is_none() && !has_note {
            return Err(CoreError::InvalidAnchor(
                "an annotation needs selected text, a note, or a captured image".to_owned(),
            ));
        }
        let capture = input
            .excerpt_image_png
            .as_deref()
            .map(decode_capture)
            .transpose()?;

        let annotation_id = new_id();
        let image_path = match (&capture, &self.captures) {
            (Some(png), Some(store)) => Some(store.write(&annotation_id, png)?),
            (Some(_), None) => {
                return Err(CoreError::InvalidCapture(
                    "this database has no directory for captures".to_owned(),
                ));
            }
            (None, _) => None,
        };

        let result =
            self.insert_independent_annotation(input, &annotation_id, image_path.as_deref());
        if result.is_err()
            && let (Some(path), Some(store)) = (&image_path, &self.captures)
        {
            store.remove(path);
        }
        result
    }

    fn insert_independent_annotation(
        &mut self,
        input: &CreateAnnotationInput,
        annotation_id: &str,
        image_path: Option<&str>,
    ) -> CoreResult<Annotation> {
        let tx = self.conn.transaction()?;
        check_anchor_matches_document(&tx, &input.document_id, &input.anchor)?;
        check_notebook_exists(&tx, &input.notebook_id)?;

        let normalized_note = input
            .note
            .as_deref()
            .map(str::trim)
            .filter(|note| !note.is_empty());
        let anchor_type = input.anchor.format().as_str();
        tx.execute(
            "INSERT INTO annotations (id, document_id, notebook_id, anchor_type,
                 anchor_payload_json, excerpt_text, excerpt_image_path, note, color, style)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                annotation_id,
                input.document_id,
                input.notebook_id,
                anchor_type,
                serde_json::to_string(&input.anchor)?,
                input.excerpt_text,
                image_path,
                normalized_note,
                input.color.trim(),
                input.style.as_str(),
            ],
        )?;

        let annotation = tx.query_row(
            &format!("{ANNOTATION_SELECT} WHERE id = ?1"),
            [annotation_id],
            map_annotation,
        )?;
        tx.commit()?;
        Ok(annotation)
    }

    /// Updates an annotation's inline `note` and/or highlight `color`.
    /// When `patch.note` is `Some("")` or whitespace-only, `note` is cleared to `NULL`.
    pub fn update_annotation(
        &self,
        annotation_id: &str,
        patch: &AnnotationPatch,
    ) -> CoreResult<Annotation> {
        if let Some(color) = &patch.color
            && color.trim().is_empty()
        {
            return Err(CoreError::InvalidAnchor(
                "an annotation needs a highlight color".to_owned(),
            ));
        }
        let update_note = patch.note.is_some();
        let next_note = patch
            .note
            .as_deref()
            .map(str::trim)
            .filter(|note| !note.is_empty());
        let next_color = patch.color.as_deref().map(str::trim);
        let next_style = patch.style.map(AnnotationStyle::as_str);

        let changed = self.conn.execute(
            "UPDATE annotations SET
                 note = CASE WHEN ?2 THEN ?3 ELSE note END,
                 color = COALESCE(?4, color),
                 style = COALESCE(?5, style)
             WHERE id = ?1",
            params![
                annotation_id,
                update_note,
                next_note,
                next_color,
                next_style
            ],
        )?;
        expect_changed(changed, "annotation", annotation_id)?;
        Ok(self.conn.query_row(
            &format!("{ANNOTATION_SELECT} WHERE id = ?1"),
            [annotation_id],
            map_annotation,
        )?)
    }

    /// Deletes an annotation and removes its `card_annotations` links (via `ON DELETE CASCADE`).
    /// Shared `NoteCard`s and `MindMapNode`s remain intact with their titles, notes, and tags;
    /// their `annotation_ids` list simply no longer includes the deleted annotation.
    pub fn delete_annotation(&mut self, annotation_id: &str) -> CoreResult<()> {
        let image_path: Option<String> = self
            .conn
            .query_row(
                "SELECT excerpt_image_path FROM annotations WHERE id = ?1",
                [annotation_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| not_found("annotation", annotation_id))?;

        self.conn
            .execute("DELETE FROM annotations WHERE id = ?1", [annotation_id])?;
        if let (Some(path), Some(store)) = (image_path, &self.captures) {
            store.remove(&path);
        }
        Ok(())
    }

    /// Absolute path of an annotation's capture, or `None` if it has no image.
    pub fn capture_path(&self, annotation_id: &str) -> CoreResult<Option<PathBuf>> {
        let stored: Option<String> = self
            .conn
            .query_row(
                "SELECT excerpt_image_path FROM annotations WHERE id = ?1",
                [annotation_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| not_found("annotation", annotation_id))?;
        Ok(match (stored, &self.captures) {
            (Some(path), Some(store)) => Some(store.resolve(&path)),
            _ => None,
        })
    }

    // ---- Cards -----------------------------------------------------------

    pub fn update_card(&self, card_id: &str, patch: &CardPatch) -> CoreResult<NoteCard> {
        let tags_json = patch.tags.as_ref().map(serde_json::to_string).transpose()?;
        let changed = self.conn.execute(
            "UPDATE note_cards SET
                 title = COALESCE(?2, title),
                 markdown_notes = COALESCE(?3, markdown_notes),
                 tags_json = COALESCE(?4, tags_json)
             WHERE id = ?1",
            params![card_id, patch.title, patch.markdown_notes, tags_json],
        )?;
        expect_changed(changed, "card", card_id)?;
        let card =
            self.conn
                .query_row(&format!("{CARD_SELECT} WHERE id = ?1"), [card_id], map_card)?;
        self.with_annotation_ids(card)
    }

    fn with_annotation_ids(&self, mut card: NoteCard) -> CoreResult<NoteCard> {
        let mut statement = self.conn.prepare_cached(
            "SELECT ca.annotation_id FROM card_annotations ca
             JOIN annotations a ON a.id = ca.annotation_id
             WHERE ca.card_id = ?1 ORDER BY a.created_at, a.id",
        )?;
        card.annotation_ids = statement
            .query_map([&card.id], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        Ok(card)
    }

    // ---- Graph -----------------------------------------------------------

    pub fn update_node_layout(&self, node_id: &str, patch: &NodeLayoutPatch) -> CoreResult<()> {
        let changed = self.conn.execute(
            "UPDATE mindmap_nodes SET pos_x = ?2, pos_y = ?3, is_collapsed = ?4 WHERE id = ?1",
            params![node_id, patch.pos_x, patch.pos_y, patch.is_collapsed],
        )?;
        expect_changed(changed, "node", node_id)
    }

    pub fn create_edge(
        &mut self,
        notebook_id: &str,
        source_node_id: &str,
        target_node_id: &str,
        label: Option<&str>,
    ) -> CoreResult<MindMapEdge> {
        if source_node_id == target_node_id {
            return Err(CoreError::InvalidGraph(
                "a node cannot link to itself".to_owned(),
            ));
        }
        let tx = self.conn.transaction()?;
        check_node_in_notebook(&tx, source_node_id, notebook_id)?;
        check_node_in_notebook(&tx, target_node_id, notebook_id)?;
        let edge = insert_edge(&tx, notebook_id, source_node_id, target_node_id, label)?;
        tx.commit()?;
        Ok(edge)
    }

    pub fn delete_edge(&self, edge_id: &str) -> CoreResult<()> {
        let changed = self
            .conn
            .execute("DELETE FROM mindmap_edges WHERE id = ?1", [edge_id])?;
        expect_changed(changed, "edge", edge_id)
    }

    // ---- Reading Preferences ---------------------------------------------

    pub fn get_reading_preferences(&self) -> CoreResult<ReadingPreferences> {
        let stored: Option<serde_json::Value> = self
            .conn
            .query_row(
                "SELECT preferences_json FROM reading_preferences WHERE id = 1",
                [],
                |row| json_column(row, 0),
            )
            .optional()?;
        match stored {
            Some(stored) => Ok(reading_preferences_from_stored(stored)?),
            None => Ok(ReadingPreferences::default()),
        }
    }

    pub fn save_reading_preferences(
        &self,
        preferences: &ReadingPreferences,
    ) -> CoreResult<ReadingPreferences> {
        preferences.validate()?;
        let json = serde_json::to_string(preferences)?;
        self.conn.execute(
            "INSERT INTO reading_preferences (id, preferences_json, updated_at)
             VALUES (1, ?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT (id) DO UPDATE SET
                 preferences_json = excluded.preferences_json,
                 updated_at = excluded.updated_at",
            params![json],
        )?;
        self.get_reading_preferences()
    }

    // ---- PDF Layout --------------------------------------------------------

    /// The layout `document_id` was last read in. A PDF that has none starts from
    /// the most recently saved layout's display and zoom (see `PdfLayout::inherited`),
    /// or the default when no PDF has saved one yet.
    ///
    /// The layout a PDF starts from is stored on this first read. Otherwise an
    /// inherited layout would keep following whichever PDF changed last, and a PDF
    /// read without touching the toolbar would reopen in a layout it was never shown.
    pub fn get_pdf_layout(&self, document_id: &str) -> CoreResult<PdfLayout> {
        self.check_pdf_document(document_id)?;
        let own = self
            .conn
            .query_row(
                &format!("{PDF_LAYOUT_SELECT} WHERE document_id = ?1"),
                [document_id],
                map_pdf_layout,
            )
            .optional()?;
        if let Some(own) = own {
            return Ok(own);
        }
        // Saves replace their row, so the highest rowid is the latest save.
        let latest = self
            .conn
            .query_row(
                &format!("{PDF_LAYOUT_SELECT} ORDER BY rowid DESC LIMIT 1"),
                [],
                map_pdf_layout,
            )
            .optional()?;
        let layout = latest.map(|layout| layout.inherited()).unwrap_or_default();
        // The pinned row becomes the latest, which leaves inheritance unchanged: it
        // carries the same display and zoom as the row it was inherited from.
        self.insert_pdf_layout(document_id, &layout)?;
        Ok(layout)
    }

    /// Stores the whole layout for `document_id`, which becomes the one new PDFs
    /// inherit.
    pub fn save_pdf_layout(&self, document_id: &str, layout: &PdfLayout) -> CoreResult<PdfLayout> {
        layout.validate()?;
        self.check_pdf_document(document_id)?;
        self.insert_pdf_layout(document_id, layout)?;
        self.get_pdf_layout(document_id)
    }

    fn insert_pdf_layout(&self, document_id: &str, layout: &PdfLayout) -> CoreResult<()> {
        // REPLACE rather than an upsert: the new row's rowid orders it last.
        self.conn.execute(
            "INSERT OR REPLACE INTO pdf_document_layouts
                 (document_id, display_mode, zoom_mode, scale, rotation, cover_page_alone,
                  updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            params![
                document_id,
                layout.display_mode.as_str(),
                layout.zoom_mode.as_str(),
                layout.scale,
                layout.rotation,
                layout.cover_page_alone,
            ],
        )?;
        Ok(())
    }

    fn check_pdf_document(&self, document_id: &str) -> CoreResult<()> {
        let document = self.get_document(document_id)?;
        if document.format != DocumentFormat::Pdf {
            return Err(CoreError::InvalidLayout(format!(
                "{} is a {} document, not a PDF",
                document_id,
                document.format.as_str()
            )));
        }
        Ok(())
    }

    // ---- Bookmarks -------------------------------------------------------

    pub fn list_bookmarks(&self) -> CoreResult<Vec<Bookmark>> {
        let mut statement = self
            .conn
            .prepare(&format!("{BOOKMARK_SELECT} ORDER BY created_at, id"))?;
        Ok(statement
            .query_map([], map_bookmark)?
            .collect::<Result<_, _>>()?)
    }

    /// Creates a bookmark at `input.anchor`, or updates and returns the existing
    /// bookmark when `(document_id, location_key)` is already bookmarked.
    /// Does not create an annotation, card, or MindMap node.
    pub fn create_bookmark(&mut self, input: &CreateBookmarkInput) -> CoreResult<Bookmark> {
        input.anchor.validate()?;
        let tx = self.conn.transaction()?;
        check_anchor_matches_document(&tx, &input.document_id, &input.anchor)?;

        let label = input
            .label
            .as_deref()
            .and_then(|raw| raw.lines().map(str::trim).find(|line| !line.is_empty()))
            .map(truncate_label)
            .unwrap_or_else(|| input.anchor.default_bookmark_label());
        let location_key = input.anchor.location_key();
        let anchor_type = input.anchor.format().as_str();
        let anchor_json = serde_json::to_string(&input.anchor)?;

        tx.execute(
            "INSERT INTO bookmarks (id, document_id, anchor_type, anchor_payload_json,
                 location_key, label)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (document_id, location_key) DO UPDATE SET
                 anchor_payload_json = excluded.anchor_payload_json,
                 label = excluded.label",
            params![
                new_id(),
                input.document_id,
                anchor_type,
                anchor_json,
                location_key,
                label,
            ],
        )?;

        let bookmark = tx.query_row(
            &format!("{BOOKMARK_SELECT} WHERE document_id = ?1 AND location_key = ?2"),
            params![input.document_id, location_key],
            map_bookmark,
        )?;
        tx.commit()?;
        Ok(bookmark)
    }

    pub fn delete_bookmark(&self, bookmark_id: &str) -> CoreResult<()> {
        let changed = self
            .conn
            .execute("DELETE FROM bookmarks WHERE id = ?1", [bookmark_id])?;
        expect_changed(changed, "bookmark", bookmark_id)
    }

    // ---- Workspace Session -----------------------------------------------

    pub fn get_workspace_session(&self) -> CoreResult<WorkspaceSession> {
        let raw: Option<(Vec<String>, Option<String>, bool)> = self
            .conn
            .query_row(
                "SELECT open_document_ids, active_document_id, immersive
                 FROM workspace_session WHERE id = 1",
                [],
                |row| Ok((json_column(row, 0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((stored_ids, stored_active, immersive)) = raw else {
            return Ok(WorkspaceSession::default());
        };
        let mut open_document_ids = Vec::new();
        for id in stored_ids {
            if !open_document_ids.contains(&id) && self.document_exists(&id)? {
                open_document_ids.push(id);
            }
        }
        let active_document_id = stored_active
            .filter(|id| open_document_ids.contains(id))
            .or_else(|| open_document_ids.last().cloned());
        Ok(WorkspaceSession {
            open_document_ids,
            active_document_id,
            immersive,
        })
    }

    pub fn save_workspace_session(
        &self,
        session: &WorkspaceSession,
    ) -> CoreResult<WorkspaceSession> {
        let mut open_document_ids = Vec::new();
        for id in &session.open_document_ids {
            if !open_document_ids.contains(id) && self.document_exists(id)? {
                open_document_ids.push(id.clone());
            }
        }
        let active_document_id = session
            .active_document_id
            .as_ref()
            .filter(|id| open_document_ids.contains(id))
            .cloned()
            .or_else(|| open_document_ids.last().cloned());
        let open_json = serde_json::to_string(&open_document_ids)?;
        self.conn.execute(
            "INSERT INTO workspace_session
                 (id, open_document_ids, active_document_id, immersive, updated_at)
             VALUES (1, ?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT (id) DO UPDATE SET
                 open_document_ids = excluded.open_document_ids,
                 active_document_id = excluded.active_document_id,
                 immersive = excluded.immersive,
                 updated_at = excluded.updated_at",
            params![open_json, active_document_id, session.immersive],
        )?;
        self.get_workspace_session()
    }

    fn document_exists(&self, document_id: &str) -> CoreResult<bool> {
        let found: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM documents WHERE id = ?1",
                [document_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }
}

fn migrate(conn: &mut Connection) -> CoreResult<()> {
    let current: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    for (version, sql) in (1_u32..).zip(MIGRATIONS).skip(current as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
    }
    Ok(())
}

fn check_anchor_matches_document(
    tx: &Transaction<'_>,
    document_id: &str,
    anchor: &AnchorLocation,
) -> CoreResult<()> {
    let format: String = tx
        .query_row(
            "SELECT format FROM documents WHERE id = ?1",
            [document_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| not_found("document", document_id))?;
    if format != anchor.format().as_str() {
        return Err(CoreError::InvalidAnchor(format!(
            "{} anchor on a {format} document",
            anchor.format().as_str()
        )));
    }
    Ok(())
}

fn check_notebook_exists(tx: &Transaction<'_>, notebook_id: &str) -> CoreResult<()> {
    let exists: Option<String> = tx
        .query_row(
            "SELECT id FROM study_notebooks WHERE id = ?1",
            [notebook_id],
            |row| row.get(0),
        )
        .optional()?;
    exists
        .map(|_| ())
        .ok_or_else(|| not_found("notebook", notebook_id))
}

fn check_node_in_notebook(
    tx: &Transaction<'_>,
    node_id: &str,
    notebook_id: &str,
) -> CoreResult<()> {
    let owner: String = tx
        .query_row(
            "SELECT notebook_id FROM mindmap_nodes WHERE id = ?1",
            [node_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| not_found("node", node_id))?;
    if owner != notebook_id {
        return Err(CoreError::InvalidGraph(format!(
            "node {node_id} belongs to another notebook"
        )));
    }
    Ok(())
}

fn insert_edge(
    tx: &Transaction<'_>,
    notebook_id: &str,
    source_node_id: &str,
    target_node_id: &str,
    label: Option<&str>,
) -> CoreResult<MindMapEdge> {
    let id = new_id();
    tx.execute(
        "INSERT INTO mindmap_edges (id, notebook_id, source_node_id, target_node_id, label)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, notebook_id, source_node_id, target_node_id, label],
    )?;
    Ok(MindMapEdge {
        id,
        notebook_id: notebook_id.to_owned(),
        source_node_id: source_node_id.to_owned(),
        target_node_id: target_node_id.to_owned(),
        label: label.map(str::to_owned),
    })
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

fn not_found(entity: &'static str, id: &str) -> CoreError {
    CoreError::NotFound {
        entity,
        id: id.to_owned(),
    }
}

fn expect_changed(changed: usize, entity: &'static str, id: &str) -> CoreResult<()> {
    if changed == 0 {
        Err(not_found(entity, id))
    } else {
        Ok(())
    }
}

/// First line of the excerpt, shortened on a character boundary.
fn card_title(excerpt_text: Option<&str>) -> String {
    let first_line = excerpt_text
        .and_then(|text| text.lines().map(str::trim).find(|line| !line.is_empty()))
        .unwrap_or("Image excerpt");
    truncate_label(first_line)
}

fn truncate_label(text: &str) -> String {
    if text.chars().count() <= CARD_TITLE_MAX_CHARS {
        return text.to_owned();
    }
    let mut title: String = text.chars().take(CARD_TITLE_MAX_CHARS - 1).collect();
    title.push('…');
    title
}

// ---- Row mapping ---------------------------------------------------------

/// A malformed JSON column surfaces as a conversion failure on that column.
fn conversion_failure(
    index: usize,
    error: impl std::error::Error + Send + Sync + 'static,
) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(error))
}

/// Reads a stored preferences row, tolerating a page-turn mode this build lacks.
///
/// Only the read path is lenient. A newer build may have written a
/// `pageTransition` this one cannot parse, and rejecting it would fail the whole
/// load, so the key is dropped and `#[serde(default)]` supplies the default.
/// IPC input keeps strict enum validation, as the memory backend does, so a
/// garbage value from the frontend is still an error.
fn reading_preferences_from_stored(
    mut stored: serde_json::Value,
) -> CoreResult<ReadingPreferences> {
    if let Some(object) = stored.as_object_mut() {
        let unknown = object
            .get("pageTransition")
            .is_some_and(|mode| serde_json::from_value::<PageTransition>(mode.clone()).is_err());
        if unknown {
            object.remove("pageTransition");
        }
    }
    Ok(serde_json::from_value(stored)?)
}

fn json_column<T: DeserializeOwned>(row: &Row<'_>, index: usize) -> rusqlite::Result<T> {
    let raw: String = row.get(index)?;
    serde_json::from_str(&raw).map_err(|error| conversion_failure(index, error))
}

fn optional_json_column<T: DeserializeOwned>(
    row: &Row<'_>,
    index: usize,
) -> rusqlite::Result<Option<T>> {
    let raw: Option<String> = row.get(index)?;
    raw.map(|raw| serde_json::from_str(&raw))
        .transpose()
        .map_err(|error| conversion_failure(index, error))
}

const DOCUMENT_SELECT: &str = "SELECT id, title, file_path, file_hash, format, encoding,
    last_cursor_anchor, last_opened_at, created_at, last_progress FROM documents";

fn map_document(row: &Row<'_>) -> rusqlite::Result<Document> {
    let format: String = row.get(4)?;
    Ok(Document {
        id: row.get(0)?,
        title: row.get(1)?,
        file_path: row.get(2)?,
        file_hash: row.get(3)?,
        format: DocumentFormat::parse(&format).map_err(|error| conversion_failure(4, error))?,
        encoding: row.get(5)?,
        last_cursor_anchor: optional_json_column(row, 6)?,
        last_opened_at: row.get(7)?,
        created_at: row.get(8)?,
        last_progress: row.get(9)?,
    })
}

const NOTEBOOK_SELECT: &str = "SELECT id, title, viewport_json, created_at FROM study_notebooks";

fn map_notebook(row: &Row<'_>) -> rusqlite::Result<StudyNotebook> {
    Ok(StudyNotebook {
        id: row.get(0)?,
        title: row.get(1)?,
        viewport: optional_json_column(row, 2)?,
        created_at: row.get(3)?,
    })
}

const ANNOTATION_SELECT: &str = "SELECT id, document_id, notebook_id, anchor_payload_json,
    excerpt_text, excerpt_image_path, note, color, created_at, style FROM annotations";

fn map_annotation(row: &Row<'_>) -> rusqlite::Result<Annotation> {
    Ok(Annotation {
        id: row.get(0)?,
        document_id: row.get(1)?,
        notebook_id: row.get(2)?,
        anchor: json_column(row, 3)?,
        excerpt_text: row.get(4)?,
        excerpt_image_path: row.get(5)?,
        note: row.get(6)?,
        color: row.get(7)?,
        style: AnnotationStyle::from_column(&row.get::<_, String>(9)?),
        created_at: row.get(8)?,
    })
}

const PDF_LAYOUT_SELECT: &str = "SELECT display_mode, zoom_mode, scale, rotation,
    cover_page_alone FROM pdf_document_layouts";

fn map_pdf_layout(row: &Row<'_>) -> rusqlite::Result<PdfLayout> {
    Ok(PdfLayout {
        display_mode: PdfDisplayMode::from_column(&row.get::<_, String>(0)?),
        zoom_mode: PdfZoomMode::from_column(&row.get::<_, String>(1)?),
        scale: row.get(2)?,
        rotation: row.get(3)?,
        cover_page_alone: row.get(4)?,
    })
}

const CARD_SELECT: &str =
    "SELECT id, notebook_id, title, markdown_notes, tags_json, created_at FROM note_cards";

/// `annotation_ids` is left empty; callers fill it from the join table.
fn map_card(row: &Row<'_>) -> rusqlite::Result<NoteCard> {
    Ok(NoteCard {
        id: row.get(0)?,
        notebook_id: row.get(1)?,
        title: row.get(2)?,
        markdown_notes: row.get(3)?,
        tags: json_column(row, 4)?,
        annotation_ids: Vec::new(),
        created_at: row.get(5)?,
    })
}

const NODE_SELECT: &str = "SELECT id, notebook_id, card_id, parent_node_id, pos_x, pos_y,
    is_collapsed, style_json FROM mindmap_nodes";

fn map_node(row: &Row<'_>) -> rusqlite::Result<MindMapNode> {
    Ok(MindMapNode {
        id: row.get(0)?,
        notebook_id: row.get(1)?,
        card_id: row.get(2)?,
        parent_node_id: row.get(3)?,
        pos_x: row.get(4)?,
        pos_y: row.get(5)?,
        is_collapsed: row.get(6)?,
        style: optional_json_column(row, 7)?,
    })
}

const EDGE_SELECT: &str =
    "SELECT id, notebook_id, source_node_id, target_node_id, label FROM mindmap_edges";

fn map_edge(row: &Row<'_>) -> rusqlite::Result<MindMapEdge> {
    Ok(MindMapEdge {
        id: row.get(0)?,
        notebook_id: row.get(1)?,
        source_node_id: row.get(2)?,
        target_node_id: row.get(3)?,
        label: row.get(4)?,
    })
}

const BOOKMARK_SELECT: &str =
    "SELECT id, document_id, anchor_payload_json, label, created_at FROM bookmarks";

fn map_bookmark(row: &Row<'_>) -> rusqlite::Result<Bookmark> {
    Ok(Bookmark {
        id: row.get(0)?,
        document_id: row.get(1)?,
        anchor: json_column(row, 2)?,
        label: row.get(3)?,
        created_at: row.get(4)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::NormalizedRect;

    struct Fixture {
        db: Database,
        notebook_id: String,
        document_id: String,
        _dir: tempfile::TempDir,
    }

    fn fixture() -> Fixture {
        let db = Database::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.txt");
        std::fs::write(&path, "some content").unwrap();
        let document_id = db.register_document(&path).unwrap().id;
        let notebook_id = db.create_notebook("Study").unwrap().id;
        Fixture {
            db,
            notebook_id,
            document_id,
            _dir: dir,
        }
    }

    fn txt_anchor() -> AnchorLocation {
        AnchorLocation::Txt {
            start_byte_offset: 0,
            end_byte_offset: 4,
            line_index: 0,
        }
    }

    fn excerpt(f: &Fixture, parent_node_id: Option<String>) -> CreateExcerptInput {
        CreateExcerptInput {
            document_id: f.document_id.clone(),
            notebook_id: f.notebook_id.clone(),
            anchor: txt_anchor(),
            excerpt_text: Some("some".to_owned()),
            excerpt_image_png: None,
            color: "#fde047".to_owned(),
            parent_node_id,
            pos_x: 10.0,
            pos_y: 20.0,
        }
    }

    fn count(db: &Database, table: &str) -> i64 {
        db.conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    #[test]
    fn migration_creates_every_specified_table_and_column() {
        let db = Database::open_in_memory().unwrap();
        let expected: &[(&str, &[&str])] = &[
            (
                "documents",
                &[
                    "id",
                    "title",
                    "file_path",
                    "file_hash",
                    "format",
                    "encoding",
                    "last_cursor_anchor",
                    "created_at",
                    "last_opened_at",
                    "last_progress",
                ],
            ),
            (
                "study_notebooks",
                &["id", "title", "viewport_json", "created_at"],
            ),
            (
                "annotations",
                &[
                    "id",
                    "document_id",
                    "notebook_id",
                    "anchor_type",
                    "anchor_payload_json",
                    "excerpt_text",
                    "excerpt_image_path",
                    "color",
                    "created_at",
                    "note",
                    "style",
                ],
            ),
            (
                "note_cards",
                &[
                    "id",
                    "notebook_id",
                    "title",
                    "markdown_notes",
                    "tags_json",
                    "created_at",
                ],
            ),
            ("card_annotations", &["card_id", "annotation_id"]),
            (
                "mindmap_nodes",
                &[
                    "id",
                    "notebook_id",
                    "card_id",
                    "parent_node_id",
                    "pos_x",
                    "pos_y",
                    "is_collapsed",
                    "style_json",
                ],
            ),
            (
                "mindmap_edges",
                &[
                    "id",
                    "notebook_id",
                    "source_node_id",
                    "target_node_id",
                    "label",
                ],
            ),
            (
                "reading_preferences",
                &["id", "preferences_json", "updated_at"],
            ),
            (
                "bookmarks",
                &[
                    "id",
                    "document_id",
                    "anchor_type",
                    "anchor_payload_json",
                    "location_key",
                    "label",
                    "created_at",
                ],
            ),
            (
                "workspace_session",
                &[
                    "id",
                    "open_document_ids",
                    "active_document_id",
                    "updated_at",
                    "immersive",
                ],
            ),
            (
                "pdf_document_layouts",
                &[
                    "document_id",
                    "display_mode",
                    "zoom_mode",
                    "scale",
                    "rotation",
                    "cover_page_alone",
                    "updated_at",
                ],
            ),
        ];
        for (table, columns) in expected {
            let mut statement = db
                .conn
                .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
                .unwrap();
            let actual: Vec<String> = statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            assert_eq!(&actual, columns, "columns of {table}");
        }
    }

    #[test]
    fn migrations_are_idempotent_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.sqlite");
        let notebook_id = {
            let db = Database::open(&path).unwrap();
            assert_eq!(db.schema_version().unwrap() as usize, MIGRATIONS.len());
            db.create_notebook("Persisted").unwrap().id
        };
        let db = Database::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap() as usize, MIGRATIONS.len());
        assert_eq!(db.list_notebooks().unwrap()[0].id, notebook_id);
    }

    #[test]
    fn foreign_keys_are_enforced() {
        let db = Database::open_in_memory().unwrap();
        let result = db.conn.execute(
            "INSERT INTO note_cards (id, notebook_id, title) VALUES ('c', 'missing', 't')",
            [],
        );
        assert!(result.is_err());
    }

    #[test]
    fn registering_same_content_reuses_record_and_tracks_moves() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("a.txt");
        let second = dir.path().join("renamed.txt");
        std::fs::write(&first, "same bytes").unwrap();
        let db = Database::open_in_memory().unwrap();
        let original = db.register_document(&first).unwrap();

        std::fs::rename(&first, &second).unwrap();
        let moved = db.register_document(&second).unwrap();

        assert_eq!(moved.id, original.id);
        assert_eq!(moved.file_path, second.to_string_lossy());
        assert_eq!(moved.title, "a", "title is kept across moves");
        assert_eq!(db.list_documents().unwrap().len(), 1);
    }

    #[test]
    fn document_path_resolves_only_registered_documents() {
        let f = fixture();
        let path = f.db.document_path(&f.document_id).unwrap();
        assert_eq!(path, f._dir.path().join("book.txt"));
        assert!(matches!(
            f.db.document_path("/etc/passwd"),
            Err(CoreError::NotFound {
                entity: "document",
                ..
            })
        ));
    }

    #[test]
    fn registering_rejects_unknown_format() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sheet.xlsx");
        std::fs::write(&path, "x").unwrap();
        let db = Database::open_in_memory().unwrap();
        assert!(matches!(
            db.register_document(&path),
            Err(CoreError::UnsupportedFormat(_))
        ));
    }

    #[test]
    fn cursor_round_trips() {
        let f = fixture();
        f.db.update_document_cursor(&f.document_id, &txt_anchor(), None)
            .unwrap();
        let document = f.db.list_documents().unwrap().remove(0);
        assert_eq!(document.last_cursor_anchor, Some(txt_anchor()));
        assert_eq!(document.last_progress, None);
        assert!(matches!(
            f.db.update_document_cursor("missing", &txt_anchor(), None),
            Err(CoreError::NotFound { .. })
        ));
    }

    #[test]
    fn cursor_progress_is_validated_and_cleared_when_unknown() {
        let f = fixture();
        let progress = |db: &Database| db.get_document(&f.document_id).unwrap().last_progress;
        f.db.update_document_cursor(&f.document_id, &txt_anchor(), Some(0.25))
            .unwrap();
        assert_eq!(progress(&f.db), Some(0.25));

        for bad in [-0.01, 1.01, f64::NAN, f64::INFINITY] {
            let result =
                f.db.update_document_cursor(&f.document_id, &txt_anchor(), Some(bad));
            assert!(
                matches!(result, Err(CoreError::InvalidProgress(_))),
                "{bad} must be rejected"
            );
        }
        // A rejected write leaves the saved fraction alone.
        assert_eq!(progress(&f.db), Some(0.25));

        // A position the reader could not measure must not keep the old percentage.
        f.db.update_document_cursor(&f.document_id, &txt_anchor(), None)
            .unwrap();
        assert_eq!(progress(&f.db), None);

        // The schema enforces the same bounds.
        let result = f.db.conn.execute(
            "UPDATE documents SET last_progress = 2 WHERE id = ?1",
            [&f.document_id],
        );
        assert!(result.is_err());
    }

    #[test]
    fn viewport_round_trips() {
        let f = fixture();
        let viewport = Viewport {
            x: 1.5,
            y: -2.0,
            zoom: 0.75,
        };
        f.db.save_notebook_viewport(&f.notebook_id, &viewport)
            .unwrap();
        let graph = f.db.load_notebook_graph(&f.notebook_id).unwrap();
        assert_eq!(graph.notebook.viewport, Some(viewport));
    }

    #[test]
    fn create_excerpt_writes_all_rows_and_reloads_identically() {
        let mut f = fixture();
        let created = f.db.create_excerpt(&excerpt(&f, None)).unwrap();

        assert_eq!(created.card.title, "some");
        assert_eq!(
            created.card.annotation_ids,
            vec![created.annotation.id.clone()]
        );
        assert_eq!(created.node.card_id, created.card.id);
        assert!(created.edge.is_none());

        let graph = f.db.load_notebook_graph(&f.notebook_id).unwrap();
        assert_eq!(graph.annotations, [created.annotation]);
        assert_eq!(graph.cards, [created.card]);
        assert_eq!(graph.nodes, [created.node]);
        assert!(graph.edges.is_empty());
    }

    #[test]
    fn create_excerpt_with_parent_links_an_edge() {
        let mut f = fixture();
        let parent = f.db.create_excerpt(&excerpt(&f, None)).unwrap();
        let input = excerpt(&f, Some(parent.node.id.clone()));
        let child = f.db.create_excerpt(&input).unwrap();

        let edge = child.edge.unwrap();
        assert_eq!(edge.source_node_id, parent.node.id);
        assert_eq!(edge.target_node_id, child.node.id);
        assert_eq!(child.node.parent_node_id, Some(parent.node.id));
    }

    #[test]
    fn failed_excerpt_leaves_no_rows_behind() {
        let mut f = fixture();
        let input = excerpt(&f, Some("missing-parent".to_owned()));
        assert!(matches!(
            f.db.create_excerpt(&input),
            Err(CoreError::NotFound { entity: "node", .. })
        ));
        for table in [
            "annotations",
            "note_cards",
            "card_annotations",
            "mindmap_nodes",
        ] {
            assert_eq!(count(&f.db, table), 0, "{table}");
        }
    }

    #[test]
    fn excerpt_rolls_back_when_a_late_insert_fails() {
        let mut f = fixture();
        // Fail the node insert, after the annotation and card rows were written.
        f.db.conn
            .execute_batch(
                "CREATE TRIGGER fail_node BEFORE INSERT ON mindmap_nodes
                 BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
            )
            .unwrap();
        let input = excerpt(&f, None);
        assert!(matches!(
            f.db.create_excerpt(&input),
            Err(CoreError::Database(_))
        ));
        for table in ["annotations", "note_cards", "card_annotations"] {
            assert_eq!(count(&f.db, table), 0, "{table}");
        }
    }

    #[test]
    fn corrupt_json_columns_are_reported_not_panicked() {
        let mut f = fixture();
        f.db.create_excerpt(&excerpt(&f, None)).unwrap();
        f.db.conn
            .execute("UPDATE note_cards SET tags_json = 'not json'", [])
            .unwrap();
        assert!(matches!(
            f.db.load_notebook_graph(&f.notebook_id),
            Err(CoreError::Database(_))
        ));
    }

    #[test]
    fn excerpt_rejects_anchor_of_wrong_format() {
        let mut f = fixture();
        let mut input = excerpt(&f, None);
        input.anchor = AnchorLocation::Pdf {
            page_index: 0,
            rects: vec![NormalizedRect {
                x: 0.0,
                y: 0.0,
                width: 0.5,
                height: 0.5,
            }],
            page_spans: None,
        };
        assert!(matches!(
            f.db.create_excerpt(&input),
            Err(CoreError::InvalidAnchor(_))
        ));
    }

    #[test]
    fn excerpt_needs_text_or_image() {
        let mut f = fixture();
        let mut input = excerpt(&f, None);
        input.excerpt_text = Some("   ".to_owned());
        assert!(f.db.create_excerpt(&input).is_err());
    }

    /// A file-backed database, as the app uses, so captures have somewhere to go.
    struct OnDisk {
        db: Database,
        notebook_id: String,
        document_id: String,
        dir: tempfile::TempDir,
    }

    fn on_disk() -> OnDisk {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("app.sqlite3")).unwrap();
        let path = dir.path().join("book.pdf");
        std::fs::write(&path, "pdf").unwrap();
        OnDisk {
            document_id: db.register_document(&path).unwrap().id,
            notebook_id: db.create_notebook("Study").unwrap().id,
            db,
            dir,
        }
    }

    fn capture_input(f: &OnDisk, png: Option<&str>) -> CreateExcerptInput {
        CreateExcerptInput {
            document_id: f.document_id.clone(),
            notebook_id: f.notebook_id.clone(),
            anchor: AnchorLocation::Pdf {
                page_index: 0,
                rects: vec![NormalizedRect {
                    x: 0.1,
                    y: 0.1,
                    width: 0.5,
                    height: 0.5,
                }],
                page_spans: None,
            },
            excerpt_text: None,
            excerpt_image_png: png.map(str::to_owned),
            color: "#fde047".to_owned(),
            parent_node_id: None,
            pos_x: 0.0,
            pos_y: 0.0,
        }
    }

    /// A PNG signature in base64 is all core checks.
    const PNG_BASE64: &str = "iVBORw0KGgo=";

    fn capture_files(f: &OnDisk) -> usize {
        std::fs::read_dir(f.dir.path().join("captures")).map_or(0, Iterator::count)
    }

    #[test]
    fn a_capture_is_stored_under_its_annotation_id() {
        let mut f = on_disk();
        let created =
            f.db.create_excerpt(&capture_input(&f, Some(PNG_BASE64)))
                .unwrap();
        let id = &created.annotation.id;

        assert_eq!(
            created.annotation.excerpt_image_path.as_deref(),
            Some(format!("captures/{id}.png").as_str()),
            "stored relative, so the data directory can move"
        );
        assert_eq!(created.card.title, "Image excerpt");
        let path = f.db.capture_path(id).unwrap().unwrap();
        assert_eq!(
            path,
            f.dir.path().join("captures").join(format!("{id}.png"))
        );
        assert!(std::fs::read(path).unwrap().starts_with(b"\x89PNG"));
    }

    #[test]
    fn an_invalid_capture_writes_nothing() {
        let mut f = on_disk();
        let input = capture_input(&f, Some("R0lGODlh"));
        assert!(matches!(
            f.db.create_excerpt(&input),
            Err(CoreError::InvalidCapture(_))
        ));
        assert_eq!(capture_files(&f), 0);
        assert_eq!(count(&f.db, "annotations"), 0);
    }

    #[test]
    fn a_failed_transaction_removes_the_capture() {
        let mut f = on_disk();
        f.db.conn
            .execute_batch(
                "CREATE TRIGGER fail_node BEFORE INSERT ON mindmap_nodes
                 BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
            )
            .unwrap();
        let input = capture_input(&f, Some(PNG_BASE64));
        assert!(matches!(
            f.db.create_excerpt(&input),
            Err(CoreError::Database(_))
        ));
        assert_eq!(capture_files(&f), 0);
        assert_eq!(count(&f.db, "annotations"), 0);
    }

    #[test]
    fn a_rejected_anchor_writes_no_capture() {
        let mut f = on_disk();
        let mut input = capture_input(&f, Some(PNG_BASE64));
        input.document_id = "missing".to_owned();
        assert!(matches!(
            f.db.create_excerpt(&input),
            Err(CoreError::NotFound { .. })
        ));
        assert_eq!(capture_files(&f), 0);
    }

    #[test]
    fn capture_path_distinguishes_no_image_from_no_annotation() {
        let mut f = on_disk();
        let mut input = capture_input(&f, None);
        input.excerpt_text = Some("text only".to_owned());
        let created = f.db.create_excerpt(&input).unwrap();
        assert_eq!(f.db.capture_path(&created.annotation.id).unwrap(), None);
        assert!(matches!(
            f.db.capture_path("missing"),
            Err(CoreError::NotFound { .. })
        ));
    }

    #[test]
    fn an_in_memory_database_refuses_captures() {
        let mut f = fixture();
        let mut input = excerpt(&f, None);
        input.excerpt_image_png = Some(PNG_BASE64.to_owned());
        assert!(matches!(
            f.db.create_excerpt(&input),
            Err(CoreError::InvalidCapture(_))
        ));
    }

    #[test]
    fn long_titles_are_cut_on_character_boundaries() {
        let long = "汉".repeat(200);
        let title = card_title(Some(&long));
        assert_eq!(title.chars().count(), CARD_TITLE_MAX_CHARS);
        assert!(title.ends_with('…'));
        assert_eq!(card_title(Some("\n\n  second line \nx")), "second line");
    }

    #[test]
    fn card_patch_updates_only_given_fields() {
        let mut f = fixture();
        let created = f.db.create_excerpt(&excerpt(&f, None)).unwrap();
        let updated =
            f.db.update_card(
                &created.card.id,
                &CardPatch {
                    title: None,
                    markdown_notes: Some("**note**".to_owned()),
                    tags: Some(vec!["a".to_owned(), "b".to_owned()]),
                },
            )
            .unwrap();
        assert_eq!(updated.title, "some");
        assert_eq!(updated.markdown_notes, "**note**");
        assert_eq!(updated.tags, ["a", "b"]);
        assert_eq!(updated.annotation_ids, created.card.annotation_ids);
    }

    #[test]
    fn node_layout_persists() {
        let mut f = fixture();
        let created = f.db.create_excerpt(&excerpt(&f, None)).unwrap();
        f.db.update_node_layout(
            &created.node.id,
            &NodeLayoutPatch {
                pos_x: 5.0,
                pos_y: 6.0,
                is_collapsed: true,
            },
        )
        .unwrap();
        let node =
            f.db.load_notebook_graph(&f.notebook_id)
                .unwrap()
                .nodes
                .remove(0);
        assert_eq!(
            (node.pos_x, node.pos_y, node.is_collapsed),
            (5.0, 6.0, true)
        );
    }

    #[test]
    fn edges_reject_self_links_duplicates_and_foreign_nodes() {
        let mut f = fixture();
        let a = f.db.create_excerpt(&excerpt(&f, None)).unwrap().node.id;
        let b = f.db.create_excerpt(&excerpt(&f, None)).unwrap().node.id;
        let notebook = f.notebook_id.clone();

        assert!(matches!(
            f.db.create_edge(&notebook, &a, &a, None),
            Err(CoreError::InvalidGraph(_))
        ));
        let edge =
            f.db.create_edge(&notebook, &a, &b, Some("see also"))
                .unwrap();
        assert_eq!(edge.label.as_deref(), Some("see also"));
        assert!(f.db.create_edge(&notebook, &a, &b, None).is_err());

        let other = f.db.create_notebook("Other").unwrap().id;
        assert!(matches!(
            f.db.create_edge(&other, &a, &b, None),
            Err(CoreError::InvalidGraph(_))
        ));

        f.db.delete_edge(&edge.id).unwrap();
        assert!(matches!(
            f.db.delete_edge(&edge.id),
            Err(CoreError::NotFound { .. })
        ));
    }

    #[test]
    fn deleting_a_parent_promotes_children_and_drops_its_edges() {
        let mut f = fixture();
        let parent = f.db.create_excerpt(&excerpt(&f, None)).unwrap();
        let input = excerpt(&f, Some(parent.node.id.clone()));
        let child = f.db.create_excerpt(&input).unwrap();

        f.db.conn
            .execute("DELETE FROM mindmap_nodes WHERE id = ?1", [&parent.node.id])
            .unwrap();

        let graph = f.db.load_notebook_graph(&f.notebook_id).unwrap();
        assert_eq!(graph.nodes.len(), 1);
        assert_eq!(graph.nodes[0].id, child.node.id);
        assert_eq!(graph.nodes[0].parent_node_id, None);
        assert!(graph.edges.is_empty());
    }

    #[test]
    fn a_document_with_annotations_cannot_be_deleted() {
        let mut f = fixture();
        f.db.create_excerpt(&excerpt(&f, None)).unwrap();
        let result =
            f.db.conn
                .execute("DELETE FROM documents WHERE id = ?1", [&f.document_id]);
        assert!(result.is_err());
    }

    #[test]
    fn loading_a_missing_notebook_is_not_found() {
        let db = Database::open_in_memory().unwrap();
        assert!(matches!(
            db.load_notebook_graph("missing"),
            Err(CoreError::NotFound { .. })
        ));
    }

    #[test]
    fn reading_preferences_round_trip_and_validate() {
        let db = Database::open_in_memory().unwrap();
        let default_prefs = db.get_reading_preferences().unwrap();
        assert_eq!(default_prefs, ReadingPreferences::default());

        let updated = ReadingPreferences {
            theme: crate::domain::ReadingTheme::Sepia,
            font_family: crate::domain::ReadingFontFamily::NewYork,
            font_size: 125,
            line_spacing: 1.9,
            margins: crate::domain::ReadingMargins::Wide,
            page_width: crate::domain::ReadingPageWidth::Full,
            justify: false,
            dim_images: true,
            epub_reading_mode: crate::domain::EpubReadingMode::Scroll,
            page_transition: crate::domain::PageTransition::Fade,
            tint_pdf_pages: true,
            focus_mode_full_screen: true,
        };
        let saved = db.save_reading_preferences(&updated).unwrap();
        assert_eq!(saved, updated);
        assert_eq!(db.get_reading_preferences().unwrap(), updated);

        let mut invalid = updated;
        invalid.font_size = 300;
        assert!(matches!(
            db.save_reading_preferences(&invalid),
            Err(CoreError::InvalidPreferences(_))
        ));
    }

    #[test]
    fn stored_preferences_load_with_any_known_transition_and_without_the_field() {
        let db = Database::open_in_memory().unwrap();
        // Every mode a released build could have written, plus a row from
        // before the field existed (no `pageTransition` key at all).
        let cases = [
            (Some("none"), crate::domain::PageTransition::None),
            (Some("slide"), crate::domain::PageTransition::Slide),
            (Some("fade"), crate::domain::PageTransition::Fade),
            // The name this mode had before the rename, as an older build wrote it.
            (Some("flip"), crate::domain::PageTransition::Curl),
            (Some("curl"), crate::domain::PageTransition::Curl),
            (None, crate::domain::PageTransition::Slide),
        ];
        for (stored, expected) in cases {
            let mut row = serde_json::json!({
                "theme": "sepia",
                "fontFamily": "charter",
                "fontSize": 110,
                "lineSpacing": 1.4,
                "margins": "wide",
                "pageWidth": "full",
                "justify": false,
                "dimImages": true,
                "epubReadingMode": "paged",
            });
            if let Some(mode) = stored {
                row["pageTransition"] = serde_json::json!(mode);
            }
            db.conn
                .execute(
                    "INSERT INTO reading_preferences (id, preferences_json) VALUES (1, ?1)
                     ON CONFLICT (id) DO UPDATE SET preferences_json = excluded.preferences_json",
                    params![row.to_string()],
                )
                .unwrap();

            let prefs = db.get_reading_preferences().unwrap();
            assert_eq!(prefs.page_transition, expected, "stored {row}");
            assert_eq!(prefs.font_size, 110);
            // The row predates both appearance switches, which default to off.
            assert!(!prefs.tint_pdf_pages, "stored {row}");
            assert!(!prefs.focus_mode_full_screen, "stored {row}");
        }
    }

    #[test]
    fn page_transition_migration_renames_flip_to_curl() {
        let mut conn = Connection::open_in_memory().unwrap();
        // Bring the database to version 10, as the previous release left it.
        for (version, sql) in (1_u32..).zip(&MIGRATIONS[..10]) {
            conn.execute_batch(sql).unwrap();
            conn.pragma_update(None, "user_version", version).unwrap();
        }
        conn.execute(
            "INSERT INTO reading_preferences (id, preferences_json) VALUES (1, ?1)",
            params![
                r#"{"theme":"dark","fontFamily":"mono","fontSize":100,"lineSpacing":1.75,"margins":"normal","pageWidth":"standard","justify":true,"dimImages":false,"epubReadingMode":"spread","pageTransition":"flip"}"#
            ],
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        let db = Database {
            conn,
            captures: None,
        };

        assert_eq!(
            db.get_reading_preferences().unwrap().page_transition,
            crate::domain::PageTransition::Curl
        );
        // The row is canonical now, not merely readable under the alias.
        let stored: String = db
            .conn
            .query_row(
                "SELECT preferences_json FROM reading_preferences WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&stored).unwrap();
        assert_eq!(value["pageTransition"], serde_json::json!("curl"));
    }

    #[test]
    fn stored_preferences_keep_the_appearance_switches() {
        let db = Database::open_in_memory().unwrap();
        let stored = serde_json::json!({
            "theme": "dark",
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
            "focusModeFullScreen": true,
        });
        db.conn
            .execute(
                "INSERT INTO reading_preferences (id, preferences_json) VALUES (1, ?1)",
                params![stored.to_string()],
            )
            .unwrap();

        let prefs = db.get_reading_preferences().unwrap();
        assert!(prefs.tint_pdf_pages);
        assert!(prefs.focus_mode_full_screen);
    }

    #[test]
    fn an_unknown_stored_transition_falls_back_instead_of_failing_the_load() {
        let db = Database::open_in_memory().unwrap();
        // A newer build wrote a mode this one does not know.
        let stored = serde_json::json!({
            "theme": "dark",
            "fontFamily": "mono",
            "fontSize": 120,
            "lineSpacing": 1.9,
            "margins": "narrow",
            "pageWidth": "standard",
            "justify": true,
            "dimImages": false,
            "epubReadingMode": "spread",
            "pageTransition": "peel",
        });
        db.conn
            .execute(
                "INSERT INTO reading_preferences (id, preferences_json) VALUES (1, ?1)",
                params![stored.to_string()],
            )
            .unwrap();

        let prefs = db.get_reading_preferences().unwrap();
        assert_eq!(prefs.page_transition, crate::domain::PageTransition::Slide);
        // The rest of the row still loads; only the unknown field degrades.
        assert_eq!(prefs.theme, crate::domain::ReadingTheme::Dark);
        assert_eq!(prefs.font_size, 120);
    }

    #[test]
    fn page_width_persists_across_database_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("reading-width.sqlite");
        let preferences = ReadingPreferences {
            page_width: crate::domain::ReadingPageWidth::Full,
            ..ReadingPreferences::default()
        };
        {
            let db = Database::open(&path).unwrap();
            db.save_reading_preferences(&preferences).unwrap();
        }
        let reopened = Database::open(&path).unwrap();
        assert_eq!(reopened.get_reading_preferences().unwrap(), preferences);
    }

    #[test]
    fn appearance_migration_rewrites_stored_preferences() {
        use crate::domain::{EpubReadingMode, ReadingFontFamily, ReadingMargins, ReadingTheme};

        let cases = [
            (
                r#"{"theme":"sepia","fontFamily":"serif","fontSize":110,"lineSpacing":1.4,"readingWidth":"narrow","epubReadingMode":"paged"}"#,
                ReadingTheme::Sepia,
                ReadingFontFamily::Charter,
                ReadingMargins::Wide,
            ),
            (
                r#"{"theme":"light","fontFamily":"sans","fontSize":100,"lineSpacing":1.75,"readingWidth":"medium","epubReadingMode":"spread"}"#,
                ReadingTheme::Light,
                ReadingFontFamily::SfPro,
                ReadingMargins::Normal,
            ),
            (
                r#"{"theme":"dark","fontFamily":"mono","fontSize":100,"lineSpacing":1.75,"readingWidth":"full","epubReadingMode":"spread"}"#,
                ReadingTheme::Dark,
                ReadingFontFamily::Mono,
                ReadingMargins::Narrow,
            ),
        ];
        for (stored, theme, font_family, margins) in cases {
            let mut conn = Connection::open_in_memory().unwrap();
            // Bring the database to version 6, as a released build left it.
            for (version, sql) in (1_u32..).zip(&MIGRATIONS[..6]) {
                conn.execute_batch(sql).unwrap();
                conn.pragma_update(None, "user_version", version).unwrap();
            }
            conn.execute(
                "INSERT INTO reading_preferences (id, preferences_json) VALUES (1, ?1)",
                params![stored],
            )
            .unwrap();
            migrate(&mut conn).unwrap();
            let db = Database {
                conn,
                captures: None,
            };

            let prefs = db.get_reading_preferences().unwrap();
            assert_eq!(prefs.theme, theme);
            assert_eq!(prefs.font_family, font_family);
            assert_eq!(prefs.margins, margins);
            assert_eq!(prefs.page_width, crate::domain::ReadingPageWidth::Standard);
            assert!(prefs.justify);
            assert!(!prefs.dim_images);
            assert_eq!(prefs.page_transition, crate::domain::PageTransition::Slide);
            assert!(prefs.validate().is_ok());
            if theme == ReadingTheme::Sepia {
                assert_eq!(prefs.font_size, 110);
                assert_eq!(prefs.epub_reading_mode, EpubReadingMode::Paged);
            }
        }
    }

    #[test]
    fn new_installs_default_to_the_auto_theme_and_publisher_fonts() {
        let db = Database::open_in_memory().unwrap();
        let prefs = db.get_reading_preferences().unwrap();
        assert_eq!(prefs.theme, crate::domain::ReadingTheme::Auto);
        assert_eq!(
            prefs.font_family,
            crate::domain::ReadingFontFamily::Original
        );
    }

    fn register_pdf(db: &Database, dir: &Path, name: &str) -> String {
        let path = dir.join(name);
        // Registration hashes the bytes; distinct content keeps the documents apart.
        std::fs::write(&path, format!("%PDF-1.7 {name}")).unwrap();
        db.register_document(&path).unwrap().id
    }

    fn two_page_layout() -> PdfLayout {
        PdfLayout {
            display_mode: PdfDisplayMode::TwoPage,
            zoom_mode: PdfZoomMode::FitPage,
            scale: 1.5,
            rotation: 90,
            cover_page_alone: true,
        }
    }

    #[test]
    fn pdf_layout_round_trips_every_field_together() {
        let db = Database::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let pdf = register_pdf(&db, dir.path(), "book.pdf");
        assert_eq!(db.get_pdf_layout(&pdf).unwrap(), PdfLayout::default());

        let saved = db.save_pdf_layout(&pdf, &two_page_layout()).unwrap();
        assert_eq!(saved, two_page_layout());
        assert_eq!(db.get_pdf_layout(&pdf).unwrap(), two_page_layout());

        // A second save replaces the row rather than adding one.
        let custom = PdfLayout {
            zoom_mode: PdfZoomMode::Custom,
            scale: 2.25,
            ..two_page_layout()
        };
        db.save_pdf_layout(&pdf, &custom).unwrap();
        assert_eq!(db.get_pdf_layout(&pdf).unwrap(), custom);
        assert_eq!(count(&db, "pdf_document_layouts"), 1);
    }

    #[test]
    fn pdf_layout_rejects_invalid_values_and_non_pdf_documents() {
        let f = fixture();
        let pdf = register_pdf(&f.db, f._dir.path(), "book.pdf");
        for scale in [0.1, 4.5, f64::NAN, f64::INFINITY] {
            let layout = PdfLayout {
                scale,
                ..PdfLayout::default()
            };
            assert!(matches!(
                f.db.save_pdf_layout(&pdf, &layout),
                Err(CoreError::InvalidLayout(_))
            ));
        }
        let tilted = PdfLayout {
            rotation: 45,
            ..PdfLayout::default()
        };
        assert!(matches!(
            f.db.save_pdf_layout(&pdf, &tilted),
            Err(CoreError::InvalidLayout(_))
        ));
        // The fixture's document is a text file.
        assert!(matches!(
            f.db.get_pdf_layout(&f.document_id),
            Err(CoreError::InvalidLayout(_))
        ));
        assert!(matches!(
            f.db.save_pdf_layout(&f.document_id, &PdfLayout::default()),
            Err(CoreError::InvalidLayout(_))
        ));
        assert!(matches!(
            f.db.get_pdf_layout("missing"),
            Err(CoreError::NotFound { .. })
        ));
        assert!(matches!(
            f.db.save_pdf_layout("missing", &PdfLayout::default()),
            Err(CoreError::NotFound { .. })
        ));
        assert_eq!(count(&f.db, "pdf_document_layouts"), 0);
    }

    #[test]
    fn new_pdfs_inherit_the_last_saved_display_and_zoom_only() {
        let db = Database::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let first = register_pdf(&db, dir.path(), "first.pdf");
        let second = register_pdf(&db, dir.path(), "second.pdf");
        let fresh = register_pdf(&db, dir.path(), "fresh.pdf");

        db.save_pdf_layout(&first, &two_page_layout()).unwrap();
        let single = PdfLayout {
            display_mode: PdfDisplayMode::Single,
            zoom_mode: PdfZoomMode::Custom,
            scale: 0.75,
            rotation: 180,
            cover_page_alone: false,
        };
        db.save_pdf_layout(&second, &single).unwrap();
        // Rotation and the cover page describe one file; they do not carry over.
        let inherited = PdfLayout {
            display_mode: PdfDisplayMode::Single,
            zoom_mode: PdfZoomMode::Custom,
            scale: 0.75,
            rotation: 0,
            cover_page_alone: false,
        };
        assert_eq!(db.get_pdf_layout(&fresh).unwrap(), inherited);

        // Saving the first again, within the same millisecond, makes it the latest.
        // `fresh` has its layout now, so a PDF never read before shows the change.
        db.save_pdf_layout(&first, &two_page_layout()).unwrap();
        let later = register_pdf(&db, dir.path(), "later.pdf");
        assert_eq!(
            db.get_pdf_layout(&later).unwrap(),
            PdfLayout {
                display_mode: PdfDisplayMode::TwoPage,
                zoom_mode: PdfZoomMode::FitPage,
                scale: 1.5,
                ..PdfLayout::default()
            }
        );
        // Documents with their own layout keep it.
        assert_eq!(db.get_pdf_layout(&second).unwrap(), single);
    }

    #[test]
    fn inherited_layouts_are_pinned_on_first_read() {
        let db = Database::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let first = register_pdf(&db, dir.path(), "first.pdf");
        let second = register_pdf(&db, dir.path(), "second.pdf");
        let third = register_pdf(&db, dir.path(), "third.pdf");

        db.save_pdf_layout(&first, &two_page_layout()).unwrap();
        let inherited = two_page_layout().inherited();
        assert_eq!(db.get_pdf_layout(&second).unwrap(), inherited);
        assert_eq!(count(&db, "pdf_document_layouts"), 2);
        // Reading it again writes nothing new.
        assert_eq!(db.get_pdf_layout(&second).unwrap(), inherited);
        assert_eq!(count(&db, "pdf_document_layouts"), 2);

        // The first PDF changes; the second was left in Two Pages and stays there.
        let continuous = PdfLayout {
            display_mode: PdfDisplayMode::Continuous,
            ..two_page_layout()
        };
        db.save_pdf_layout(&first, &continuous).unwrap();
        assert_eq!(db.get_pdf_layout(&second).unwrap(), inherited);
        // A PDF opened after that inherits the change.
        assert_eq!(db.get_pdf_layout(&third).unwrap(), continuous.inherited());
    }

    #[test]
    fn pinning_an_inherited_layout_keeps_what_new_pdfs_inherit() {
        let db = Database::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let first = register_pdf(&db, dir.path(), "first.pdf");
        let second = register_pdf(&db, dir.path(), "second.pdf");
        let third = register_pdf(&db, dir.path(), "third.pdf");

        // With nothing saved, the first read pins the default.
        assert_eq!(db.get_pdf_layout(&first).unwrap(), PdfLayout::default());
        db.save_pdf_layout(&first, &two_page_layout()).unwrap();
        // The second's pinned row is now the latest, but it carries the same
        // display and zoom, so the third still inherits the first's choice.
        db.get_pdf_layout(&second).unwrap();
        assert_eq!(
            db.get_pdf_layout(&third).unwrap(),
            two_page_layout().inherited()
        );
    }

    #[test]
    fn pdf_layout_persists_across_reopen_and_goes_with_its_document() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("layout.sqlite");
        let pdf = {
            let db = Database::open(&db_path).unwrap();
            let pdf = register_pdf(&db, dir.path(), "book.pdf");
            db.save_pdf_layout(&pdf, &two_page_layout()).unwrap();
            pdf
        };
        let reopened = Database::open(&db_path).unwrap();
        assert_eq!(reopened.get_pdf_layout(&pdf).unwrap(), two_page_layout());

        reopened
            .conn
            .execute("DELETE FROM documents WHERE id = ?1", [&pdf])
            .unwrap();
        assert_eq!(count(&reopened, "pdf_document_layouts"), 0);
    }

    #[test]
    fn layout_migration_upgrades_a_version_8_database_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let conn = Connection::open_in_memory().unwrap();
        // Bring the database to version 8, as the previous release left it.
        for (version, sql) in (1_u32..).zip(&MIGRATIONS[..8]) {
            conn.execute_batch(sql).unwrap();
            conn.pragma_update(None, "user_version", version).unwrap();
        }
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        let db = Database {
            conn,
            captures: None,
        };
        // Registered as the version 8 schema stores it: today's registration
        // would select columns that schema does not have yet.
        let pdf = "pdf-at-version-8".to_owned();
        db.conn
            .execute(
                "INSERT INTO documents (id, title, file_path, file_hash, format)
                 VALUES (?1, 'book', ?2, 'hash-v8', 'pdf')",
                params![pdf, dir.path().join("book.pdf").to_string_lossy()],
            )
            .unwrap();
        let mut conn = db.conn;
        migrate(&mut conn).unwrap();
        let db = Database {
            conn,
            captures: None,
        };

        assert_eq!(db.schema_version().unwrap() as usize, MIGRATIONS.len());
        assert_eq!(db.list_documents().unwrap()[0].id, pdf);
        // Version 10 adds the reading fraction, unknown for rows that predate it.
        assert_eq!(db.list_documents().unwrap()[0].last_progress, None);
        assert_eq!(db.get_pdf_layout(&pdf).unwrap(), PdfLayout::default());
        db.save_pdf_layout(&pdf, &two_page_layout()).unwrap();
        assert_eq!(db.get_pdf_layout(&pdf).unwrap(), two_page_layout());

        // The schema enforces the same bounds as `PdfLayout::validate`.
        for (column, value) in [
            ("display_mode", "'spread'"),
            ("zoom_mode", "'fit-height'"),
            ("scale", "5"),
            ("rotation", "45"),
            ("cover_page_alone", "2"),
        ] {
            let result = db.conn.execute(
                &format!("UPDATE pdf_document_layouts SET {column} = {value}"),
                [],
            );
            assert!(result.is_err(), "{column} = {value} must be rejected");
        }
    }

    #[test]
    fn bookmarks_round_trip_deduplicate_and_do_not_create_cards_or_annotations() {
        let mut f = fixture();
        let created =
            f.db.create_bookmark(&CreateBookmarkInput {
                document_id: f.document_id.clone(),
                anchor: txt_anchor(),
                label: Some("  Line 1 · some content\nignored  ".to_owned()),
            })
            .unwrap();
        assert_eq!(created.document_id, f.document_id);
        assert_eq!(created.anchor, txt_anchor());
        assert_eq!(created.label, "Line 1 · some content");

        // Adding another bookmark at the same byte offset deduplicates in place.
        let same_location = AnchorLocation::Txt {
            start_byte_offset: 0,
            end_byte_offset: 8,
            line_index: 0,
        };
        let deduplicated =
            f.db.create_bookmark(&CreateBookmarkInput {
                document_id: f.document_id.clone(),
                anchor: same_location.clone(),
                label: None,
            })
            .unwrap();
        assert_eq!(deduplicated.id, created.id);
        assert_eq!(deduplicated.anchor, same_location);
        assert_eq!(deduplicated.label, "Line 1");
        assert_eq!(f.db.list_bookmarks().unwrap().len(), 1);

        // A second bookmark at a different byte offset creates a second entry.
        let second =
            f.db.create_bookmark(&CreateBookmarkInput {
                document_id: f.document_id.clone(),
                anchor: AnchorLocation::Txt {
                    start_byte_offset: 5,
                    end_byte_offset: 12,
                    line_index: 1,
                },
                label: Some("Chapter 2".to_owned()),
            })
            .unwrap();
        assert_ne!(second.id, created.id);
        assert_eq!(f.db.list_bookmarks().unwrap().len(), 2);

        // Bookmarks never create annotations, note cards, or MindMap nodes.
        for table in [
            "annotations",
            "note_cards",
            "card_annotations",
            "mindmap_nodes",
            "mindmap_edges",
        ] {
            assert_eq!(count(&f.db, table), 0, "{table}");
        }

        f.db.delete_bookmark(&created.id).unwrap();
        assert_eq!(f.db.list_bookmarks().unwrap(), vec![second]);
        assert!(matches!(
            f.db.delete_bookmark(&created.id),
            Err(CoreError::NotFound {
                entity: "bookmark",
                ..
            })
        ));
    }

    #[test]
    fn bookmarks_reject_wrong_format_invalid_anchors_and_missing_documents() {
        let mut f = fixture();
        assert!(matches!(
            f.db.create_bookmark(&CreateBookmarkInput {
                document_id: "missing".to_owned(),
                anchor: txt_anchor(),
                label: None,
            }),
            Err(CoreError::NotFound {
                entity: "document",
                ..
            })
        ));

        assert!(matches!(
            f.db.create_bookmark(&CreateBookmarkInput {
                document_id: f.document_id.clone(),
                anchor: AnchorLocation::Pdf {
                    page_index: 0,
                    rects: vec![NormalizedRect {
                        x: 0.0,
                        y: 0.0,
                        width: 1.0,
                        height: 0.1,
                    }],
                    page_spans: None,
                },
                label: None,
            }),
            Err(CoreError::InvalidAnchor(_))
        ));

        assert!(matches!(
            f.db.create_bookmark(&CreateBookmarkInput {
                document_id: f.document_id,
                anchor: AnchorLocation::Txt {
                    start_byte_offset: 4,
                    end_byte_offset: 4,
                    line_index: 0,
                },
                label: None,
            }),
            Err(CoreError::InvalidAnchor(_))
        ));
    }

    #[test]
    fn bookmarks_persist_across_database_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("app.sqlite3");
        let book_path = dir.path().join("book.pdf");
        std::fs::write(&book_path, "pdf").unwrap();

        let saved = {
            let mut db = Database::open(&db_path).unwrap();
            let doc = db.register_document(&book_path).unwrap();
            db.create_bookmark(&CreateBookmarkInput {
                document_id: doc.id,
                anchor: AnchorLocation::Pdf {
                    page_index: 2,
                    rects: vec![NormalizedRect {
                        x: 0.0,
                        y: 0.25,
                        width: 1.0,
                        height: 0.001,
                    }],
                    page_spans: None,
                },
                label: Some("Page 3".to_owned()),
            })
            .unwrap()
        };

        let reopened = Database::open(&db_path).unwrap();
        assert_eq!(reopened.list_bookmarks().unwrap(), vec![saved]);
    }

    #[test]
    fn independent_annotations_crud_and_shared_card_deletion_semantics() {
        let mut f = fixture();
        // 1. Create an independent highlight with a note (no card or MindMap node created).
        let standalone =
            f.db.create_annotation(&CreateAnnotationInput {
                document_id: f.document_id.clone(),
                notebook_id: f.notebook_id.clone(),
                anchor: txt_anchor(),
                excerpt_text: Some("some".to_owned()),
                excerpt_image_png: None,
                note: Some("  standalone note  ".to_owned()),
                color: "#fde047".to_owned(),
                style: AnnotationStyle::Highlight,
            })
            .unwrap();
        assert_eq!(standalone.note.as_deref(), Some("standalone note"));
        assert_eq!(standalone.color, "#fde047");
        assert_eq!(count(&f.db, "annotations"), 1);
        assert_eq!(count(&f.db, "note_cards"), 0);
        assert_eq!(count(&f.db, "mindmap_nodes"), 0);

        // 2. Edit note and color, then clear note with whitespace.
        let edited =
            f.db.update_annotation(
                &standalone.id,
                &AnnotationPatch {
                    note: Some("updated note".to_owned()),
                    color: Some("#86efac".to_owned()),
                    style: Some(AnnotationStyle::Underline),
                },
            )
            .unwrap();
        assert_eq!(edited.note.as_deref(), Some("updated note"));
        assert_eq!(edited.color, "#86efac");
        assert_eq!(edited.style, AnnotationStyle::Underline);

        let cleared =
            f.db.update_annotation(
                &standalone.id,
                &AnnotationPatch {
                    note: Some("   ".to_owned()),
                    color: None,
                    style: None,
                },
            )
            .unwrap();
        assert_eq!(cleared.note, None);
        assert_eq!(cleared.color, "#86efac");
        assert_eq!(cleared.style, AnnotationStyle::Underline);

        // 3. Create an excerpt linked to a card and MindMap node, then delete the annotation.
        // Shared card and node must remain intact, while `card.annotation_ids` drops the deleted id.
        let created_excerpt = f.db.create_excerpt(&excerpt(&f, None)).unwrap();
        let graph_before = f.db.load_notebook_graph(&f.notebook_id).unwrap();
        assert_eq!(graph_before.annotations.len(), 2);
        assert_eq!(graph_before.cards.len(), 1);
        assert_eq!(
            graph_before.cards[0].annotation_ids,
            vec![created_excerpt.annotation.id.clone()]
        );

        f.db.delete_annotation(&created_excerpt.annotation.id)
            .unwrap();
        let graph_after = f.db.load_notebook_graph(&f.notebook_id).unwrap();
        assert_eq!(graph_after.annotations, vec![cleared]);
        assert_eq!(graph_after.cards.len(), 1);
        assert_eq!(graph_after.cards[0].id, created_excerpt.card.id);
        assert!(graph_after.cards[0].annotation_ids.is_empty());
        assert_eq!(graph_after.nodes.len(), 1);
    }

    #[test]
    fn workspace_session_and_recent_document_timestamps_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("session.sqlite");
        let first_file = dir.path().join("first.txt");
        let second_file = dir.path().join("second.txt");
        std::fs::write(&first_file, "first").unwrap();
        std::fs::write(&second_file, "second").unwrap();

        let (first_id, second_id) = {
            let db = Database::open(&db_path).unwrap();
            assert_eq!(
                db.get_workspace_session().unwrap(),
                WorkspaceSession::default()
            );

            let first = db.register_document(&first_file).unwrap();
            let second = db.register_document(&second_file).unwrap();
            assert!(first.last_opened_at.is_some());
            assert!(second.last_opened_at.is_some());

            // Saving deduplicates, drops unknown document ids, and normalizes active_document_id.
            let saved = db
                .save_workspace_session(&WorkspaceSession {
                    open_document_ids: vec![
                        first.id.clone(),
                        "missing-doc".to_owned(),
                        second.id.clone(),
                        first.id.clone(),
                    ],
                    active_document_id: Some("missing-doc".to_owned()),
                    immersive: true,
                })
                .unwrap();
            assert_eq!(
                saved,
                WorkspaceSession {
                    open_document_ids: vec![first.id.clone(), second.id.clone()],
                    active_document_id: Some(second.id.clone()),
                    immersive: true,
                }
            );

            let touched = db.touch_document_opened(&first.id).unwrap();
            assert!(touched.last_opened_at.is_some());
            (first.id, second.id)
        };

        let reopened = Database::open(&db_path).unwrap();
        assert_eq!(
            reopened.get_workspace_session().unwrap(),
            WorkspaceSession {
                open_document_ids: vec![first_id, second_id.clone()],
                active_document_id: Some(second_id),
                immersive: true,
            }
        );
    }

    #[test]
    fn verify_and_relink_document_source_handles_missing_moved_and_changed_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(&dir.path().join("recovery.sqlite")).unwrap();
        let original = dir.path().join("paper-v1.txt");
        std::fs::write(&original, "original version content").unwrap();

        let doc = db.register_document(&original).unwrap();
        db.update_document_cursor(&doc.id, &txt_anchor(), Some(0.5))
            .unwrap();
        let notebook = db.create_notebook("Notes").unwrap();
        let annotation = db
            .create_annotation(&CreateAnnotationInput {
                document_id: doc.id.clone(),
                notebook_id: notebook.id.clone(),
                anchor: txt_anchor(),
                excerpt_text: Some("original".to_owned()),
                excerpt_image_png: None,
                note: Some("preserved note".to_owned()),
                color: "#fde047".to_owned(),
                style: AnnotationStyle::default(),
            })
            .unwrap();

        // 1. Source is intact (`Ok`).
        let status = db.verify_document_source(&doc.id).unwrap();
        assert_eq!(status.state, DocumentSourceState::Ok);
        assert_eq!(
            status.current_file_hash.as_deref(),
            Some(doc.file_hash.as_str())
        );
        assert_eq!(status.file_size_bytes, Some(24));

        // 2. Source moved to a new path (`Missing` at original path, then relinked with identical content).
        let moved = dir.path().join("paper-moved.txt");
        std::fs::rename(&original, &moved).unwrap();
        let missing_status = db.verify_document_source(&doc.id).unwrap();
        assert_eq!(missing_status.state, DocumentSourceState::Missing);
        assert_eq!(missing_status.current_file_hash, None);

        let moved_relink = db.relink_document(&doc.id, &moved).unwrap();
        assert!(!moved_relink.content_changed);
        assert_eq!(moved_relink.document.file_hash, doc.file_hash);
        assert_eq!(moved_relink.document.title, "paper-moved");
        assert_eq!(moved_relink.document.last_cursor_anchor, Some(txt_anchor()));
        assert_eq!(moved_relink.document.last_progress, Some(0.5));

        // 3. In-place modification (`Changed`), then explicit relink to a revised edition.
        std::fs::write(&moved, "revised edition with different bytes").unwrap();
        let changed_status = db.verify_document_source(&doc.id).unwrap();
        assert_eq!(changed_status.state, DocumentSourceState::Changed);
        assert_ne!(
            changed_status.current_file_hash.as_deref(),
            Some(doc.file_hash.as_str())
        );

        let revised_relink = db.relink_document(&doc.id, &moved).unwrap();
        assert!(revised_relink.content_changed);
        assert_eq!(revised_relink.previous_file_hash, doc.file_hash);
        // Stale cursor anchor is cleared when content hash changes, while notes/annotations are preserved.
        assert_eq!(revised_relink.document.last_cursor_anchor, None);
        assert_eq!(revised_relink.document.last_progress, None);
        let graph = db.load_notebook_graph(&notebook.id).unwrap();
        assert_eq!(graph.annotations, vec![annotation]);

        // 4. Rejects format mismatch and duplicate document hash collision.
        let wrong_format = dir.path().join("other.pdf");
        std::fs::write(&wrong_format, "pdf bytes").unwrap();
        assert!(matches!(
            db.relink_document(&doc.id, &wrong_format),
            Err(CoreError::UnsupportedFormat(_))
        ));

        let other_txt = dir.path().join("other.txt");
        std::fs::write(&other_txt, "distinct other document").unwrap();
        let _other_doc = db.register_document(&other_txt).unwrap();
        assert!(matches!(
            db.relink_document(&doc.id, &other_txt),
            Err(CoreError::InvalidGraph(_))
        ));
    }
}
