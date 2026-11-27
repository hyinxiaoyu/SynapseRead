//! SQLite persistence: migrations and every query the app runs.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::captures::{CaptureStore, decode_capture};
use crate::domain::{
    AnchorLocation, Annotation, AnnotationPatch, AnnotationStyle, Bookmark, BookmarkImportReport,
    BookmarkSkipReason, CardPatch, CreateAnnotationInput, CreateBookmarkInput, CreateExcerptInput,
    CreatedExcerpt, CursorSnapshot, DeletedCard, Document, DocumentFormat, DocumentSourceState,
    DocumentSourceStatus, ExportBookmark, ExportCatalogBook, ExportPosition, ImportBookmarkEntry,
    ImportDocumentResult, ImportLimits, MindMapEdge, MindMapNode, NodeLayoutPatch, NoteCard,
    NotebookGraph, PageTransition, PdfDisplayMode, PdfLayout, PdfZoomMode, ReadingPreferences,
    RelinkDocumentResult, ReplaceCursorResult, RestoredAnnotation, RestoredCard,
    ScrollPageTransition, SkippedBookmark, StudyNotebook, Viewport, WorkspacePaneLayout,
    WorkspaceSession, sanitize_import_title, sanitize_single_line, truncate_chars,
};
use crate::fs_reader::{UTF8_LABEL, hash_file};
use crate::library::{
    ManagedLibrary, PublishSharedLease, validate_extension, validate_file_hash,
    validated_extension_for_export,
};
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
    include_str!("../migrations/0012_annotation_soft_delete.sql"),
    include_str!("../migrations/0013_markdown_as_text.sql"),
    include_str!("../migrations/0014_workspace_pane_layout.sql"),
    include_str!("../migrations/0015_card_undo_snapshots.sql"),
    include_str!("../migrations/0016_document_hidden_from_recent.sql"),
    include_str!("../migrations/0017_document_display_title.sql"),
    include_str!("../migrations/0018_annotation_location_label.sql"),
];

const CARD_TITLE_MAX_CHARS: usize = 80;
const LOCATION_LABEL_MAX_CHARS: usize = 160;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeletedCardSnapshot {
    card: NoteCard,
    /// Raw `card_annotations` links (including soft-deleted annotations) so
    /// restoring a card and then undoing a highlight deletion still re-links them.
    raw_annotation_ids: Vec<String>,
    nodes: Vec<MindMapNode>,
    edges: Vec<MindMapEdge>,
    /// `(child_node_id, former_parent_node_id)` pairs re-rooted when this card was deleted.
    child_parent_links: Vec<(String, String)>,
}

/// Owns the single SQLite connection.
pub struct Database {
    conn: Connection,
    /// `None` only for a purely in-memory database, which has no data directory.
    captures: Option<CaptureStore>,
    /// `None` only for a purely in-memory database, which has no data directory.
    library: Option<ManagedLibrary>,
    /// Whether this connection acquired the exclusive sole-connection lock on open.
    sole_connection_on_open: bool,
    /// Shared advisory lock held while this connection is alive so a concurrent
    /// `Database::open` does not purge pending Undo rows, captures, or staged files under it.
    _session_lock: Option<std::fs::File>,
}

fn acquire_session_lock(path: &Path) -> CoreResult<(std::fs::File, bool)> {
    let mut lock_os = path.as_os_str().to_os_string();
    lock_os.push(".session.lock");
    let lock_path = PathBuf::from(lock_os);
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)?;
    match file.try_lock() {
        Ok(()) => Ok((file, true)),
        Err(std::fs::TryLockError::WouldBlock) => {
            file.lock_shared()?;
            Ok((file, false))
        }
        Err(std::fs::TryLockError::Error(err)) => Err(err.into()),
    }
}

impl Database {
    /// Opens (or creates) the database at `path` and brings its schema up to date.
    /// Captures and the managed library live next to the database file.
    pub fn open(path: &Path) -> CoreResult<Self> {
        let captures = path.parent().map(CaptureStore::new);
        let library = path.parent().map(ManagedLibrary::new);
        let conn = Connection::open(path)?;
        let (session_lock, is_sole_connection) = acquire_session_lock(path)?;
        let database = Self::init(
            conn,
            captures,
            library,
            Some(session_lock),
            is_sole_connection,
        )?;
        if is_sole_connection && let Some(lock) = &database._session_lock {
            lock.unlock()?;
            lock.lock_shared()?;
        }
        Ok(database)
    }

    pub fn open_in_memory() -> CoreResult<Self> {
        Self::init(Connection::open_in_memory()?, None, None, None, true)
    }

    fn init(
        mut conn: Connection,
        captures: Option<CaptureStore>,
        library: Option<ManagedLibrary>,
        session_lock: Option<std::fs::File>,
        is_sole_connection: bool,
    ) -> CoreResult<Self> {
        // foreign_keys is per-connection and off by default in SQLite.
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate(&mut conn)?;
        let mut database = Self {
            conn,
            captures,
            library,
            sole_connection_on_open: is_sole_connection,
            _session_lock: session_lock,
        };
        if is_sole_connection {
            database.purge_deleted_annotations()?;
            database.purge_deleted_card_snapshots()?;
            database.reconcile_managed_library()?;
        }
        Ok(database)
    }

    pub fn captures_directory(&self) -> Option<PathBuf> {
        self.captures.as_ref().map(CaptureStore::directory)
    }

    pub fn managed_library(&self) -> Option<&ManagedLibrary> {
        self.library.as_ref()
    }

    pub fn is_sole_connection(&self) -> bool {
        self.sole_connection_on_open
    }

    fn reconcile_managed_library(&self) -> CoreResult<()> {
        let Some(library) = &self.library else {
            return Ok(());
        };
        let mut statement = self.conn.prepare("SELECT file_path FROM documents")?;
        let referenced_paths: Vec<PathBuf> = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .map(|res| res.map(PathBuf::from))
            .collect::<Result<_, _>>()?;
        let _ = library.reconcile(&referenced_paths)?;
        Ok(())
    }

    pub fn schema_version(&self) -> CoreResult<u32> {
        Ok(self
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))?)
    }

    // ---- Documents -------------------------------------------------------

    fn acquire_publish_shared_lock(&self) -> CoreResult<Option<PublishSharedLease>> {
        self.library
            .as_ref()
            .map(ManagedLibrary::acquire_publish_shared_lock)
            .transpose()
    }

    /// Registers the file at `path`, or returns the existing record when this
    /// content is already known. A known file found at a new path has its
    /// stored path updated, keeping its annotations attached.
    pub fn register_document(&self, path: &Path) -> CoreResult<Document> {
        let file_hash = hash_document_for_registration(path)?;
        let _publish_lease = self.acquire_publish_shared_lock()?;
        ensure_existing_regular_file(path)?;
        upsert_document_with_hash(&self.conn, path, &file_hash)
    }

    /// Commits a document registration inside a transaction using a `file_hash`
    /// computed outside the database lock, rechecking the file format and file
    /// existence under the managed-library coordination lock before writing.
    pub fn register_document_with_hash(
        &mut self,
        path: &Path,
        file_hash: &str,
    ) -> CoreResult<Document> {
        let _publish_lease = self.acquire_publish_shared_lock()?;
        ensure_existing_regular_file(path)?;
        let tx = self.conn.transaction()?;
        let document = upsert_document_with_hash(&tx, path, file_hash)?;
        tx.commit()?;
        Ok(document)
    }

    pub fn touch_document_opened(&self, document_id: &str) -> CoreResult<Document> {
        let changed = self.conn.execute(
            "UPDATE documents
             SET last_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 hidden_from_recent_at = NULL
             WHERE id = ?1",
            [document_id],
        )?;
        expect_changed(changed, "document", document_id)?;
        get_document_in_conn(&self.conn, document_id)
    }

    /// Hides a document from the Recent / Continue reading lists without
    /// modifying its annotations, cards, bookmarks, or reading cursor.
    /// Opening or relinking the document clears the flag again.
    pub fn hide_document_from_recent(&self, document_id: &str) -> CoreResult<Document> {
        let changed = self.conn.execute(
            "UPDATE documents
             SET hidden_from_recent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1",
            [document_id],
        )?;
        expect_changed(changed, "document", document_id)?;
        get_document_in_conn(&self.conn, document_id)
    }

    /// Stores or clears a sanitized single-line metadata display title only for
    /// the file the reader loaded (`id` + `expected_file_hash`), preserving the
    /// file-stem `title`. Returns `Ok(None)` when the document's `file_hash`
    /// has changed (for example after a content-changing relink).
    pub fn set_document_display_title(
        &self,
        document_id: &str,
        display_title: Option<&str>,
        expected_file_hash: &str,
    ) -> CoreResult<Option<Document>> {
        let normalized = display_title
            .and_then(sanitize_single_line)
            .map(|title| truncate_chars(&title, ImportLimits::default().max_title_chars));
        let changed = self.conn.execute(
            "UPDATE documents SET display_title = ?2 WHERE id = ?1 AND file_hash = ?3",
            params![document_id, normalized, expected_file_hash],
        )?;
        if changed == 0 {
            if self.document_exists(document_id)? {
                return Ok(None);
            }
            return Err(not_found("document", document_id));
        }
        Ok(Some(get_document_in_conn(&self.conn, document_id)?))
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

    /// Atomically replaces a document's saved reading position and progress if
    /// and only if the currently persisted values match `expected` structurally.
    ///
    /// Returns [`ReplaceCursorResult::Conflict`] with the loaded state without
    /// modifying the row when another write has already changed either field.
    pub fn replace_cursor_if(
        &mut self,
        document_id: &str,
        expected: &CursorSnapshot,
        next: &CursorSnapshot,
    ) -> CoreResult<ReplaceCursorResult> {
        self.replace_cursor_if_inner(document_id, None, None, expected, next)
    }

    /// Like [`Self::replace_cursor_if`], but additionally verifies inside the
    /// same SQLite transaction that the target document's `file_hash` still
    /// matches `expected_file_hash` (returning [`CoreError::LanHashMismatch`]
    /// if the document was relinked to another file).
    pub fn replace_cursor_if_for_hash(
        &mut self,
        document_id: &str,
        expected_file_hash: &str,
        expected: &CursorSnapshot,
        next: &CursorSnapshot,
    ) -> CoreResult<ReplaceCursorResult> {
        self.replace_cursor_if_inner(document_id, Some(expected_file_hash), None, expected, next)
    }

    /// Like [`Self::replace_cursor_if_for_hash`], additionally verifying inside
    /// the same SQLite transaction that `documents.file_path` still matches the
    /// exact verified `expected_file_path`.
    pub fn replace_cursor_if_for_target(
        &mut self,
        document_id: &str,
        expected_file_hash: &str,
        expected_file_path: &str,
        expected: &CursorSnapshot,
        next: &CursorSnapshot,
    ) -> CoreResult<ReplaceCursorResult> {
        self.replace_cursor_if_inner(
            document_id,
            Some(expected_file_hash),
            Some(expected_file_path),
            expected,
            next,
        )
    }

    fn replace_cursor_if_inner(
        &mut self,
        document_id: &str,
        expected_file_hash: Option<&str>,
        expected_file_path: Option<&str>,
        expected: &CursorSnapshot,
        next: &CursorSnapshot,
    ) -> CoreResult<ReplaceCursorResult> {
        let tx = self.conn.transaction()?;
        let (file_hash, file_path, current): (String, String, CursorSnapshot) = tx
            .query_row(
                "SELECT file_hash, file_path, last_cursor_anchor, last_progress FROM documents WHERE id = ?1",
                [document_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        CursorSnapshot {
                            anchor: optional_json_column(row, 2)?,
                            progress: row.get(3)?,
                        },
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| not_found("document", document_id))?;

        if let Some(required_hash) = expected_file_hash
            && file_hash != required_hash
        {
            return Err(CoreError::LanHashMismatch(
                "target document file hash changed before cursor update".into(),
            ));
        }
        if let Some(required_path) = expected_file_path
            && file_path != required_path
        {
            return Err(CoreError::LanHashMismatch(
                "target document file path changed before cursor update".into(),
            ));
        }

        if !current.matches(expected) {
            return Ok(ReplaceCursorResult::Conflict { current });
        }

        if let Some(anchor) = &next.anchor {
            anchor.validate()?;
            check_anchor_matches_document(&tx, document_id, anchor, None)?;
        }
        if let Some(progress) = next.progress
            && (!progress.is_finite() || !(0.0..=1.0).contains(&progress))
        {
            return Err(CoreError::InvalidProgress(format!(
                "progress must be a fraction between 0 and 1, got {progress}"
            )));
        }

        let anchor_json = next
            .anchor
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let changed = tx.execute(
            "UPDATE documents SET last_cursor_anchor = ?2, last_progress = ?3 WHERE id = ?1",
            params![document_id, anchor_json, next.progress],
        )?;
        expect_changed(changed, "document", document_id)?;
        tx.commit()?;
        Ok(ReplaceCursorResult::Replaced)
    }

    pub fn get_document(&self, document_id: &str) -> CoreResult<Document> {
        get_document_in_conn(&self.conn, document_id)
    }

    /// Checks whether a registered document's file is present and matches its
    /// recorded SHA-256 `file_hash`, without mutating the database.
    pub fn verify_document_source(&self, document_id: &str) -> CoreResult<DocumentSourceStatus> {
        let document = self.get_document(document_id)?;
        verify_document_file(&document)
    }

    /// Explicitly relinks an existing document to `new_path`, updating its stored
    /// `file_path`, `file_hash`, and `title` while keeping all existing annotations,
    /// bookmarks, and MindMap cards attached.
    ///
    /// Rejects format changes and hash collisions with another registered document.
    /// When `file_hash` changes, `last_cursor_anchor`, `last_progress`, `display_title`,
    /// and existing annotations' `location_label` (including soft-deleted rows) are
    /// cleared atomically so stale positions are never attributed to the new edition.
    pub fn relink_document(
        &mut self,
        document_id: &str,
        new_path: &Path,
    ) -> CoreResult<RelinkDocumentResult> {
        let existing = self.get_document(document_id)?;
        let new_hash = hash_document_for_relink(existing.format, new_path)?;
        let _publish_lease = self.acquire_publish_shared_lock()?;
        ensure_existing_regular_file(new_path)?;
        let tx = self.conn.transaction()?;
        let result = relink_document_in_conn(&tx, document_id, new_path, &new_hash)?;
        tx.commit()?;
        Ok(result)
    }

    /// Commits a document relink inside a transaction using a `new_hash` computed
    /// outside the database lock, rechecking the existing document, format
    /// compatibility, file existence, and `file_hash` uniqueness under the
    /// coordination lock before writing.
    pub fn relink_document_with_hash(
        &mut self,
        document_id: &str,
        new_path: &Path,
        new_hash: &str,
    ) -> CoreResult<RelinkDocumentResult> {
        let _publish_lease = self.acquire_publish_shared_lock()?;
        ensure_existing_regular_file(new_path)?;
        let tx = self.conn.transaction()?;
        let result = relink_document_in_conn(&tx, document_id, new_path, new_hash)?;
        tx.commit()?;
        Ok(result)
    }

    // ---- LAN Sync Import / Export ----------------------------------------

    /// Imports a verified document file published into the managed library
    /// without touching `last_opened_at` or clobbering healthy local records
    /// (ADR 0008, LS-06).
    ///
    /// - On insert: uses the sanitized peer `title` (never the SHA-256 filename
    ///   stem) and sets `last_opened_at = NULL`.
    /// - On hash match: repairs `file_path` only when the existing record's file
    ///   is missing on disk (rechecked under the transaction, preserving title,
    ///   format, cursor, bookmarks, annotations, and cards); leaves existing
    ///   on-disk records untouched (`AlreadyPresent`).
    /// - Resolves `file_hash UNIQUE` races cleanly to `AlreadyPresent`.
    pub fn import_document(
        &mut self,
        path: &Path,
        file_hash: &str,
        title: &str,
        format: DocumentFormat,
    ) -> CoreResult<ImportDocumentResult> {
        validate_file_hash(file_hash)?;
        let ext = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let _ = validate_extension(format, ext)?;
        let sanitized_title = sanitize_import_title(title, &ImportLimits::default());

        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let result = import_document_in_conn(&tx, path, file_hash, &sanitized_title, format)?;
        tx.commit()?;
        Ok(result)
    }

    /// Reads privacy-filtered catalog metadata for a LAN sync session snapshot.
    /// Never returns `file_path` or `last_opened_at` (ADR 0008, T-14).
    pub fn export_catalog_books(&self) -> CoreResult<Vec<ExportCatalogBook>> {
        let mut statement = self.conn.prepare(
            "SELECT d.id, d.file_hash, d.title, d.format, d.file_path,
                    d.last_cursor_anchor IS NOT NULL,
                    (SELECT COUNT(*) FROM bookmarks b WHERE b.document_id = d.id)
             FROM documents d
             ORDER BY d.created_at, d.id",
        )?;
        let rows = statement
            .query_map([], |row| {
                let document_id: String = row.get(0)?;
                let file_hash: String = row.get(1)?;
                let title: String = row.get(2)?;
                let raw_format: String = row.get(3)?;
                let file_path: String = row.get(4)?;
                let has_position: bool = row.get(5)?;
                let bookmark_count: i64 = row.get(6)?;
                let format =
                    DocumentFormat::parse(&raw_format).map_err(|err| conversion_failure(3, err))?;
                let extension = validated_extension_for_export(format, Path::new(&file_path));
                Ok(ExportCatalogBook {
                    document_id,
                    file_hash,
                    title,
                    format,
                    extension,
                    has_position,
                    bookmark_count: u64::try_from(bookmark_count).unwrap_or(0),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Reads a document's saved reading position for LAN sync export.
    /// Never returns `file_path` or `last_opened_at` (ADR 0008, T-14).
    pub fn export_document_position(
        &self,
        document_id: &str,
    ) -> CoreResult<Option<ExportPosition>> {
        let row: Option<(Option<String>, Option<f64>)> = self
            .conn
            .query_row(
                "SELECT last_cursor_anchor, last_progress FROM documents WHERE id = ?1",
                [document_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((anchor_json, progress)) = row else {
            return Err(not_found("document", document_id));
        };
        let Some(anchor_json) = anchor_json else {
            return Ok(None);
        };
        let anchor: AnchorLocation = serde_json::from_str(&anchor_json)?;
        Ok(Some(ExportPosition { anchor, progress }))
    }

    /// Reads a document's bookmarks for LAN sync export.
    /// Never returns `file_path`, `last_opened_at`, or internal row IDs (ADR 0008, T-14).
    pub fn export_document_bookmarks(&self, document_id: &str) -> CoreResult<Vec<ExportBookmark>> {
        if !self.document_exists(document_id)? {
            return Err(not_found("document", document_id));
        }
        let mut statement = self.conn.prepare(
            "SELECT anchor_payload_json, label, created_at
             FROM bookmarks
             WHERE document_id = ?1
             ORDER BY created_at, id",
        )?;
        let rows = statement
            .query_map([document_id], |row| {
                Ok(ExportBookmark {
                    anchor: json_column(row, 0)?,
                    label: row.get(1)?,
                    created_at: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
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
            "{ANNOTATION_SELECT} WHERE notebook_id = ?1 AND deleted_at IS NULL ORDER BY created_at, id"
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
        check_anchor_matches_document(
            &tx,
            &input.document_id,
            &input.anchor,
            input.expected_file_hash.as_deref(),
        )?;
        if let Some(parent_id) = &input.parent_node_id {
            check_node_in_notebook(&tx, parent_id, &input.notebook_id)?;
        }

        let anchor_type = input.anchor.format().as_str();
        let location_label = normalize_location_label(input.location_label.as_deref());
        tx.execute(
            "INSERT INTO annotations (id, document_id, notebook_id, anchor_type,
                 anchor_payload_json, excerpt_text, excerpt_image_path, color, location_label)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                annotation_id,
                input.document_id,
                input.notebook_id,
                anchor_type,
                serde_json::to_string(&input.anchor)?,
                input.excerpt_text,
                image_path,
                input.color,
                location_label,
            ],
        )?;

        let card_id = new_id();
        tx.execute(
            "INSERT INTO note_cards (id, notebook_id, title) VALUES (?1, ?2, ?3)",
            params![
                card_id,
                input.notebook_id,
                card_title(input.excerpt_text.as_deref(), location_label.as_deref())
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
        check_anchor_matches_document(
            &tx,
            &input.document_id,
            &input.anchor,
            input.expected_file_hash.as_deref(),
        )?;
        check_notebook_exists(&tx, &input.notebook_id)?;

        let normalized_note = input
            .note
            .as_deref()
            .map(str::trim)
            .filter(|note| !note.is_empty());
        let location_label = normalize_location_label(input.location_label.as_deref());
        let anchor_type = input.anchor.format().as_str();
        tx.execute(
            "INSERT INTO annotations (id, document_id, notebook_id, anchor_type,
                 anchor_payload_json, excerpt_text, excerpt_image_path, note, color, style,
                 location_label)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
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
                location_label,
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
             WHERE id = ?1 AND deleted_at IS NULL",
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

    /// Deletes an annotation as the reader sees it. The row, its `card_annotations`
    /// links, and its capture stay until the next launch, so `restore_annotation`
    /// can undo this exactly; meanwhile every read skips it, and its cards no
    /// longer list it. Cards and nodes are never deleted with it.
    pub fn delete_annotation(&mut self, annotation_id: &str) -> CoreResult<()> {
        let changed = self.conn.execute(
            "UPDATE annotations SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1 AND deleted_at IS NULL",
            [annotation_id],
        )?;
        expect_changed(changed, "annotation", annotation_id)
    }

    /// Undoes `delete_annotation`: the annotation returns with its id, capture, and
    /// card links, and the cards are returned as they now read.
    pub fn restore_annotation(&mut self, annotation_id: &str) -> CoreResult<RestoredAnnotation> {
        let tx = self.conn.transaction()?;
        let changed = tx.execute(
            "UPDATE annotations SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL",
            [annotation_id],
        )?;
        expect_changed(changed, "deleted annotation", annotation_id)?;
        let annotation = tx.query_row(
            &format!("{ANNOTATION_SELECT} WHERE id = ?1"),
            [annotation_id],
            map_annotation,
        )?;
        let card_ids = {
            let mut statement = tx.prepare(
                "SELECT card_id FROM card_annotations WHERE annotation_id = ?1 ORDER BY card_id",
            )?;
            statement
                .query_map([annotation_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        tx.commit()?;

        let cards = card_ids
            .iter()
            .map(|card_id| {
                let card = self.conn.query_row(
                    &format!("{CARD_SELECT} WHERE id = ?1"),
                    [card_id],
                    map_card,
                )?;
                self.with_annotation_ids(card)
            })
            .collect::<CoreResult<Vec<_>>>()?;
        Ok(RestoredAnnotation { annotation, cards })
    }

    /// Removes annotations deleted in an earlier session, with their links and
    /// captures. Files go only after the rows commit, so a failure never leaves a
    /// row pointing at a missing capture.
    fn purge_deleted_annotations(&mut self) -> CoreResult<()> {
        let tx = self.conn.transaction()?;
        let image_paths = {
            let mut statement = tx.prepare(
                "SELECT excerpt_image_path FROM annotations
                 WHERE deleted_at IS NOT NULL AND excerpt_image_path IS NOT NULL",
            )?;
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        tx.execute("DELETE FROM annotations WHERE deleted_at IS NOT NULL", [])?;
        tx.commit()?;
        if let Some(store) = &self.captures {
            for path in &image_paths {
                store.remove(path);
            }
        }
        Ok(())
    }

    /// Absolute path of an annotation's capture, or `None` if it has no image.
    pub fn capture_path(&self, annotation_id: &str) -> CoreResult<Option<PathBuf>> {
        let stored: Option<String> = self
            .conn
            .query_row(
                "SELECT excerpt_image_path FROM annotations
                 WHERE id = ?1 AND deleted_at IS NULL",
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
             WHERE ca.card_id = ?1 AND a.deleted_at IS NULL ORDER BY a.created_at, a.id",
        )?;
        card.annotation_ids = statement
            .query_map([&card.id], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        Ok(card)
    }

    /// Removes a card, its MindMap node(s), its `card_annotations` links, and all
    /// edges touching those nodes in one transaction. Child nodes are re-rooted
    /// (`parent_node_id = NULL`), never deleted, and source highlights stay in the
    /// reader. An ephemeral snapshot is saved for session Undo (`restore_card`).
    pub fn delete_card(&mut self, card_id: &str) -> CoreResult<DeletedCard> {
        let tx = self.conn.transaction()?;
        let card = tx
            .query_row(&format!("{CARD_SELECT} WHERE id = ?1"), [card_id], map_card)
            .optional()?
            .ok_or_else(|| not_found("card", card_id))?;

        let raw_annotation_ids = {
            let mut stmt = tx.prepare(
                "SELECT annotation_id FROM card_annotations
                 WHERE card_id = ?1 ORDER BY annotation_id",
            )?;
            stmt.query_map([card_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };

        let nodes = {
            let mut stmt = tx.prepare(&format!("{NODE_SELECT} WHERE card_id = ?1 ORDER BY id"))?;
            stmt.query_map([card_id], map_node)?
                .collect::<Result<Vec<_>, _>>()?
        };
        let node_ids: Vec<String> = nodes.iter().map(|node| node.id.clone()).collect();
        let node_id_set: HashSet<&str> = node_ids.iter().map(String::as_str).collect();

        let mut child_parent_links = Vec::new();
        let mut rerooted_child_node_ids = Vec::new();
        for node_id in &node_ids {
            let mut stmt =
                tx.prepare("SELECT id FROM mindmap_nodes WHERE parent_node_id = ?1 ORDER BY id")?;
            let children = stmt
                .query_map([node_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            for child_id in children {
                if !node_id_set.contains(child_id.as_str()) {
                    rerooted_child_node_ids.push(child_id.clone());
                }
                child_parent_links.push((child_id, node_id.clone()));
            }
        }
        rerooted_child_node_ids.sort();
        rerooted_child_node_ids.dedup();

        let mut edges = Vec::new();
        let mut seen_edges = HashSet::new();
        for node_id in &node_ids {
            let mut stmt = tx.prepare(&format!(
                "{EDGE_SELECT} WHERE source_node_id = ?1 OR target_node_id = ?1 ORDER BY id"
            ))?;
            let connected = stmt
                .query_map([node_id], map_edge)?
                .collect::<Result<Vec<_>, _>>()?;
            for edge in connected {
                if seen_edges.insert(edge.id.clone()) {
                    edges.push(edge);
                }
            }
        }
        edges.sort_by(|a, b| a.id.cmp(&b.id));
        let edge_ids: Vec<String> = edges.iter().map(|edge| edge.id.clone()).collect();

        let snapshot = DeletedCardSnapshot {
            card,
            raw_annotation_ids,
            nodes,
            edges,
            child_parent_links,
        };
        let snapshot_json = serde_json::to_string(&snapshot)?;
        tx.execute(
            "INSERT OR REPLACE INTO deleted_card_snapshots (card_id, snapshot_json)
             VALUES (?1, ?2)",
            params![card_id, snapshot_json],
        )?;

        // Cascades `card_annotations`, `mindmap_nodes`, and `mindmap_edges`, and sets
        // `parent_node_id = NULL` on child nodes atomically inside this transaction.
        let changed = tx.execute("DELETE FROM note_cards WHERE id = ?1", [card_id])?;
        expect_changed(changed, "card", card_id)?;
        tx.commit()?;

        Ok(DeletedCard {
            card_id: card_id.to_owned(),
            node_ids,
            edge_ids,
            rerooted_child_node_ids,
        })
    }

    /// Undoes `delete_card` within the same session: restores the card, its notes,
    /// tags, surviving annotation links, node(s) with position and parent, surviving
    /// edges, and re-attaches re-rooted child nodes.
    pub fn restore_card(&mut self, card_id: &str) -> CoreResult<RestoredCard> {
        let tx = self.conn.transaction()?;
        let snapshot: DeletedCardSnapshot = tx
            .query_row(
                "SELECT snapshot_json FROM deleted_card_snapshots WHERE card_id = ?1",
                [card_id],
                |row| json_column(row, 0),
            )
            .optional()?
            .ok_or_else(|| not_found("deleted card", card_id))?;

        check_notebook_exists(&tx, &snapshot.card.notebook_id)?;

        let tags_json = serde_json::to_string(&snapshot.card.tags)?;
        tx.execute(
            "INSERT INTO note_cards (id, notebook_id, title, markdown_notes, tags_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                snapshot.card.id,
                snapshot.card.notebook_id,
                snapshot.card.title,
                snapshot.card.markdown_notes,
                tags_json,
                snapshot.card.created_at,
            ],
        )?;

        for annotation_id in &snapshot.raw_annotation_ids {
            let exists: Option<String> = tx
                .query_row(
                    "SELECT id FROM annotations WHERE id = ?1",
                    [annotation_id],
                    |row| row.get(0),
                )
                .optional()?;
            if exists.is_some() {
                tx.execute(
                    "INSERT OR IGNORE INTO card_annotations (card_id, annotation_id)
                     VALUES (?1, ?2)",
                    params![snapshot.card.id, annotation_id],
                )?;
            }
        }

        // Insert nodes with NULL parent first so multi-node parent references resolve
        // regardless of order, then restore parent links that still exist.
        for node in &snapshot.nodes {
            let style_json = node.style.as_ref().map(serde_json::to_string).transpose()?;
            tx.execute(
                "INSERT INTO mindmap_nodes
                     (id, notebook_id, card_id, parent_node_id, pos_x, pos_y, is_collapsed, style_json)
                 VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7)",
                params![
                    node.id,
                    node.notebook_id,
                    node.card_id,
                    node.pos_x,
                    node.pos_y,
                    node.is_collapsed,
                    style_json,
                ],
            )?;
        }
        for node in &snapshot.nodes {
            if let Some(parent_id) = &node.parent_node_id {
                let parent_exists: Option<String> = tx
                    .query_row(
                        "SELECT id FROM mindmap_nodes WHERE id = ?1",
                        [parent_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if parent_exists.is_some() {
                    tx.execute(
                        "UPDATE mindmap_nodes SET parent_node_id = ?2 WHERE id = ?1",
                        params![node.id, parent_id],
                    )?;
                }
            }
        }

        let mut reparented_children = Vec::new();
        for (child_id, parent_id) in &snapshot.child_parent_links {
            let changed = tx.execute(
                "UPDATE mindmap_nodes SET parent_node_id = ?2
                 WHERE id = ?1 AND parent_node_id IS NULL",
                params![child_id, parent_id],
            )?;
            if changed > 0 {
                let child = tx.query_row(
                    &format!("{NODE_SELECT} WHERE id = ?1"),
                    [child_id],
                    map_node,
                )?;
                reparented_children.push(child);
            }
        }

        let mut edges = Vec::new();
        for edge in &snapshot.edges {
            let endpoints_exist: i64 = tx.query_row(
                "SELECT COUNT(*) FROM mindmap_nodes WHERE id IN (?1, ?2)",
                params![edge.source_node_id, edge.target_node_id],
                |row| row.get(0),
            )?;
            if endpoints_exist == 2 {
                let inserted = tx.execute(
                    "INSERT OR IGNORE INTO mindmap_edges
                         (id, notebook_id, source_node_id, target_node_id, label)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        edge.id,
                        edge.notebook_id,
                        edge.source_node_id,
                        edge.target_node_id,
                        edge.label,
                    ],
                )?;
                if inserted > 0 {
                    edges.push(edge.clone());
                }
            }
        }

        tx.execute(
            "DELETE FROM deleted_card_snapshots WHERE card_id = ?1",
            [card_id],
        )?;

        let restored_nodes = {
            let mut stmt = tx.prepare(&format!("{NODE_SELECT} WHERE card_id = ?1 ORDER BY id"))?;
            stmt.query_map([card_id], map_node)?
                .collect::<Result<Vec<_>, _>>()?
        };
        let raw_card =
            tx.query_row(&format!("{CARD_SELECT} WHERE id = ?1"), [card_id], map_card)?;
        tx.commit()?;

        let card = self.with_annotation_ids(raw_card)?;
        Ok(RestoredCard {
            card,
            nodes: restored_nodes,
            edges,
            reparented_children,
        })
    }

    fn purge_deleted_card_snapshots(&mut self) -> CoreResult<()> {
        self.conn
            .execute("DELETE FROM deleted_card_snapshots", [])?;
        Ok(())
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
        check_anchor_matches_document(&tx, &input.document_id, &input.anchor, None)?;

        let label = normalize_bookmark_label(
            input.label.as_deref(),
            &input.anchor,
            ImportLimits::default().max_bookmark_label_chars,
        );
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

    /// Insert-only bookmark import for LAN book sync (ADR 0008).
    ///
    /// Runs in a single SQLite transaction, validates each entry individually
    /// (skipping invalid, wrong-format, oversized, or over-cap entries without
    /// aborting valid entries), and leaves existing `(document_id, location_key)`
    /// rows untouched via `ON CONFLICT DO NOTHING`.
    pub fn import_bookmarks(
        &mut self,
        document_id: &str,
        entries: &[ImportBookmarkEntry],
        limits: &ImportLimits,
    ) -> CoreResult<BookmarkImportReport> {
        self.import_bookmarks_inner(document_id, None, None, entries, limits)
    }

    /// Like [`Self::import_bookmarks`], but additionally verifies inside the
    /// same SQLite transaction that the target document's `file_hash` still
    /// matches `expected_file_hash` (returning [`CoreError::LanHashMismatch`]
    /// if the document was relinked to another file).
    pub fn import_bookmarks_for_hash(
        &mut self,
        document_id: &str,
        expected_file_hash: &str,
        entries: &[ImportBookmarkEntry],
        limits: &ImportLimits,
    ) -> CoreResult<BookmarkImportReport> {
        self.import_bookmarks_inner(document_id, Some(expected_file_hash), None, entries, limits)
    }

    /// Like [`Self::import_bookmarks_for_hash`], additionally verifying inside
    /// the same SQLite transaction that `documents.file_path` still matches the
    /// exact verified `expected_file_path`.
    pub fn import_bookmarks_for_target(
        &mut self,
        document_id: &str,
        expected_file_hash: &str,
        expected_file_path: &str,
        entries: &[ImportBookmarkEntry],
        limits: &ImportLimits,
    ) -> CoreResult<BookmarkImportReport> {
        self.import_bookmarks_inner(
            document_id,
            Some(expected_file_hash),
            Some(expected_file_path),
            entries,
            limits,
        )
    }

    fn import_bookmarks_inner(
        &mut self,
        document_id: &str,
        expected_file_hash: Option<&str>,
        expected_file_path: Option<&str>,
        entries: &[ImportBookmarkEntry],
        limits: &ImportLimits,
    ) -> CoreResult<BookmarkImportReport> {
        let tx = self.conn.transaction()?;
        let (doc_format, file_hash, file_path): (String, String, String) = tx
            .query_row(
                "SELECT format, file_hash, file_path FROM documents WHERE id = ?1",
                [document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| not_found("document", document_id))?;

        if let Some(required_hash) = expected_file_hash
            && file_hash != required_hash
        {
            return Err(CoreError::LanHashMismatch(
                "target document file hash changed before bookmark import".into(),
            ));
        }
        if let Some(required_path) = expected_file_path
            && file_path != required_path
        {
            return Err(CoreError::LanHashMismatch(
                "target document file path changed before bookmark import".into(),
            ));
        }

        let count_i64: i64 = tx.query_row(
            "SELECT COUNT(*) FROM bookmarks WHERE document_id = ?1",
            [document_id],
            |row| row.get(0),
        )?;
        let mut current_count = usize::try_from(count_i64).unwrap_or(0);

        let mut fallback_now: Option<String> = None;
        let mut inserted = 0usize;
        let mut existing = 0usize;
        let mut skipped_entries = Vec::new();
        let mut inserted_bookmarks = Vec::new();

        {
            let mut exists_stmt =
                tx.prepare("SELECT 1 FROM bookmarks WHERE document_id = ?1 AND location_key = ?2")?;
            let mut insert_stmt = tx.prepare(
                "INSERT INTO bookmarks (id, document_id, anchor_type, anchor_payload_json,
                     location_key, label, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT (document_id, location_key) DO NOTHING",
            )?;

            for (index, entry) in entries.iter().enumerate() {
                if entry.anchor.validate().is_err() {
                    skipped_entries.push(SkippedBookmark {
                        index,
                        reason: BookmarkSkipReason::InvalidAnchor,
                    });
                    continue;
                }
                if doc_format != entry.anchor.format().as_str() {
                    skipped_entries.push(SkippedBookmark {
                        index,
                        reason: BookmarkSkipReason::FormatMismatch,
                    });
                    continue;
                }
                if !check_anchor_limits(&entry.anchor, limits) {
                    skipped_entries.push(SkippedBookmark {
                        index,
                        reason: BookmarkSkipReason::AnchorLimitExceeded,
                    });
                    continue;
                }

                let location_key = entry.anchor.location_key();
                if current_count >= limits.max_bookmarks_per_book {
                    let already_exists = exists_stmt
                        .query_row(params![document_id, location_key], |_| Ok(()))
                        .optional()?
                        .is_some();
                    if already_exists {
                        existing += 1;
                    } else {
                        skipped_entries.push(SkippedBookmark {
                            index,
                            reason: BookmarkSkipReason::BookmarkCapExceeded,
                        });
                    }
                    continue;
                }

                let label = normalize_bookmark_label(
                    entry.label.as_deref(),
                    &entry.anchor,
                    limits.max_bookmark_label_chars,
                );
                let created_at = match entry.created_at.as_deref() {
                    Some(ts) if is_valid_iso8601_utc(ts) => ts.to_owned(),
                    _ => {
                        if let Some(ref ts) = fallback_now {
                            ts.clone()
                        } else {
                            let ts: String = tx.query_row(
                                "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
                                [],
                                |row| row.get(0),
                            )?;
                            fallback_now = Some(ts.clone());
                            ts
                        }
                    }
                };
                let id = new_id();
                let anchor_type = entry.anchor.format().as_str();
                let anchor_json = serde_json::to_string(&entry.anchor)?;

                let changed = insert_stmt.execute(params![
                    id,
                    document_id,
                    anchor_type,
                    anchor_json,
                    location_key,
                    label,
                    created_at,
                ])?;
                if changed == 0 {
                    existing += 1;
                } else {
                    current_count += 1;
                    inserted += 1;
                    inserted_bookmarks.push(Bookmark {
                        id,
                        document_id: document_id.to_owned(),
                        anchor: entry.anchor.clone(),
                        label,
                        created_at,
                    });
                }
            }
        }

        tx.commit()?;
        Ok(BookmarkImportReport {
            inserted,
            existing,
            skipped: skipped_entries.len(),
            skipped_entries,
            inserted_bookmarks,
        })
    }

    pub fn delete_bookmark(&self, bookmark_id: &str) -> CoreResult<()> {
        let changed = self
            .conn
            .execute("DELETE FROM bookmarks WHERE id = ?1", [bookmark_id])?;
        expect_changed(changed, "bookmark", bookmark_id)
    }

    // ---- Workspace Session -----------------------------------------------

    pub fn get_workspace_session(&self) -> CoreResult<WorkspaceSession> {
        struct RawSession {
            open_document_ids: Vec<String>,
            active_document_id: Option<String>,
            immersive: bool,
            mind_map_open: bool,
            inspector_open: bool,
            mind_map_size: Option<f64>,
            inspector_size: Option<f64>,
        }
        let raw = self
            .conn
            .query_row(
                "SELECT open_document_ids, active_document_id, immersive,
                        mind_map_open, inspector_open, mind_map_size, inspector_size
                 FROM workspace_session WHERE id = 1",
                [],
                |row| {
                    Ok(RawSession {
                        open_document_ids: json_column(row, 0)?,
                        active_document_id: row.get(1)?,
                        immersive: row.get(2)?,
                        mind_map_open: row.get(3)?,
                        inspector_open: row.get(4)?,
                        mind_map_size: row.get(5)?,
                        inspector_size: row.get(6)?,
                    })
                },
            )
            .optional()?;
        let Some(raw) = raw else {
            return Ok(WorkspaceSession::default());
        };
        let mut open_document_ids = Vec::new();
        for id in raw.open_document_ids {
            if !open_document_ids.contains(&id) && self.document_exists(&id)? {
                open_document_ids.push(id);
            }
        }
        let active_document_id = raw
            .active_document_id
            .filter(|id| open_document_ids.contains(id))
            .or_else(|| open_document_ids.last().cloned());
        let pane_layout = WorkspacePaneLayout {
            mind_map_open: raw.mind_map_open,
            inspector_open: raw.inspector_open,
            mind_map_size: raw.mind_map_size,
            inspector_size: raw.inspector_size,
        }
        .sanitized();
        Ok(WorkspaceSession {
            open_document_ids,
            active_document_id,
            immersive: raw.immersive,
            pane_layout,
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
        let pane_layout = session.pane_layout.sanitized();
        self.conn.execute(
            "INSERT INTO workspace_session
                 (id, open_document_ids, active_document_id, immersive,
                  mind_map_open, inspector_open, mind_map_size, inspector_size, updated_at)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT (id) DO UPDATE SET
                 open_document_ids = excluded.open_document_ids,
                 active_document_id = excluded.active_document_id,
                 immersive = excluded.immersive,
                 mind_map_open = excluded.mind_map_open,
                 inspector_open = excluded.inspector_open,
                 mind_map_size = excluded.mind_map_size,
                 inspector_size = excluded.inspector_size,
                 updated_at = excluded.updated_at",
            params![
                open_json,
                active_document_id,
                session.immersive,
                pane_layout.mind_map_open,
                pane_layout.inspector_open,
                pane_layout.mind_map_size,
                pane_layout.inspector_size,
            ],
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

/// Validates `path`'s extension and hashes its bytes without touching the
/// database, so callers can run file I/O outside any database lock.
pub fn hash_document_for_registration(path: &Path) -> CoreResult<String> {
    let _format = document_format_for_path(path)?;
    hash_file(path)
}

/// Validates that `new_path` matches `expected_format` and hashes its bytes
/// without touching the database, so callers can run file I/O outside any
/// database lock.
pub fn hash_document_for_relink(
    expected_format: DocumentFormat,
    new_path: &Path,
) -> CoreResult<String> {
    validate_relink_format(expected_format, new_path)?;
    hash_file(new_path)
}

/// Checks whether `document`'s file on disk is present and matches its recorded
/// SHA-256 `file_hash`, without touching the database.
pub fn verify_document_file(document: &Document) -> CoreResult<DocumentSourceStatus> {
    verify_document_file_with_hasher(document, hash_file)
}

/// Same as [`verify_document_file`] with an injectable file hasher for tests.
pub fn verify_document_file_with_hasher<F>(
    document: &Document,
    hasher: F,
) -> CoreResult<DocumentSourceStatus>
where
    F: FnOnce(&Path) -> CoreResult<String>,
{
    let path = Path::new(&document.file_path);
    let metadata = match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => meta,
        _ => {
            return Ok(DocumentSourceStatus {
                document_id: document.id.clone(),
                state: DocumentSourceState::Missing,
                current_file_hash: None,
                file_size_bytes: None,
            });
        }
    };
    let current_hash = hasher(path)?;
    let state = if current_hash == document.file_hash {
        DocumentSourceState::Ok
    } else {
        DocumentSourceState::Changed
    };
    Ok(DocumentSourceStatus {
        document_id: document.id.clone(),
        state,
        current_file_hash: Some(current_hash),
        file_size_bytes: Some(metadata.len()),
    })
}

fn document_format_for_path(path: &Path) -> CoreResult<DocumentFormat> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    DocumentFormat::from_extension(extension)
}

fn validate_relink_format(
    expected_format: DocumentFormat,
    new_path: &Path,
) -> CoreResult<DocumentFormat> {
    let format = document_format_for_path(new_path)?;
    if format != expected_format {
        return Err(CoreError::UnsupportedFormat(format!(
            "cannot relink a {} document to a {} file",
            expected_format.as_str(),
            format.as_str()
        )));
    }
    Ok(format)
}

fn get_document_in_conn(conn: &Connection, document_id: &str) -> CoreResult<Document> {
    conn.query_row(
        &format!("{DOCUMENT_SELECT} WHERE id = ?1"),
        [document_id],
        map_document,
    )
    .optional()?
    .ok_or_else(|| not_found("document", document_id))
}

fn upsert_document_with_hash(
    conn: &Connection,
    path: &Path,
    file_hash: &str,
) -> CoreResult<Document> {
    let format = document_format_for_path(path)?;
    let file_path = path.to_string_lossy();
    let title = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| file_path.clone().into_owned());

    conn.execute(
        "INSERT INTO documents (id, title, file_path, file_hash, format, encoding, last_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (file_hash) DO UPDATE SET
             file_path = excluded.file_path,
             last_opened_at = excluded.last_opened_at,
             hidden_from_recent_at = NULL",
        params![
            new_id(),
            title,
            file_path,
            file_hash,
            format.as_str(),
            UTF8_LABEL
        ],
    )?;
    Ok(conn.query_row(
        &format!("{DOCUMENT_SELECT} WHERE file_hash = ?1"),
        [file_hash],
        map_document,
    )?)
}

fn is_existing_regular_file(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file())
}

fn ensure_existing_regular_file(path: &Path) -> CoreResult<()> {
    let meta = std::fs::metadata(path).map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            CoreError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("document file is missing: {}", path.display()),
            ))
        } else {
            CoreError::Io(err)
        }
    })?;
    if !meta.is_file() {
        return Err(CoreError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("document path is not a regular file: {}", path.display()),
        )));
    }
    Ok(())
}

fn ensure_valid_import_target_file(path: &Path) -> CoreResult<()> {
    let meta = std::fs::symlink_metadata(path).map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            CoreError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("published import target is missing: {}", path.display()),
            ))
        } else {
            CoreError::Io(err)
        }
    })?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(CoreError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "published import target must be a regular file: {}",
                path.display()
            ),
        )));
    }
    Ok(())
}

fn import_document_in_conn(
    conn: &Connection,
    path: &Path,
    file_hash: &str,
    sanitized_title: &str,
    format: DocumentFormat,
) -> CoreResult<ImportDocumentResult> {
    if let Some(existing) = conn
        .query_row(
            &format!("{DOCUMENT_SELECT} WHERE file_hash = ?1"),
            [file_hash],
            map_document,
        )
        .optional()?
    {
        if !is_existing_regular_file(Path::new(&existing.file_path)) {
            ensure_valid_import_target_file(path)?;
            // Preserve the missing record's validated extension (critical for
            // `.md`/`.markdown` under `format: "txt"`, `R2-01` / `R3-08`):
            // refuse to repair a missing record with a mismatched extension.
            let existing_ext = Path::new(&existing.file_path)
                .extension()
                .and_then(|ext| ext.to_str())
                .and_then(|ext| validate_extension(existing.format, ext).ok());
            let incoming_ext = path
                .extension()
                .and_then(|ext| ext.to_str())
                .and_then(|ext| validate_extension(format, ext).ok());
            if let Some(required_ext) = existing_ext
                && incoming_ext.as_deref() != Some(required_ext.as_str())
            {
                return Err(CoreError::UnsupportedFormat(format!(
                    "cannot repair missing .{required_ext} document with mismatched extension"
                )));
            }
            let file_path = path.to_string_lossy();
            conn.execute(
                "UPDATE documents SET file_path = ?2 WHERE id = ?1",
                params![existing.id, file_path],
            )?;
            let repaired = get_document_in_conn(conn, &existing.id)?;
            return Ok(ImportDocumentResult::Repaired(repaired));
        }
        return Ok(ImportDocumentResult::AlreadyPresent(existing));
    }

    ensure_valid_import_target_file(path)?;
    insert_imported_document_row(conn, path, file_hash, sanitized_title, format)
}

fn insert_imported_document_row(
    conn: &Connection,
    path: &Path,
    file_hash: &str,
    sanitized_title: &str,
    format: DocumentFormat,
) -> CoreResult<ImportDocumentResult> {
    let id = new_id();
    let file_path = path.to_string_lossy();
    let insert = conn.execute(
        "INSERT INTO documents (id, title, file_path, file_hash, format, encoding, last_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)",
        params![
            id,
            sanitized_title,
            file_path,
            file_hash,
            format.as_str(),
            UTF8_LABEL,
        ],
    );
    match insert {
        Ok(_) => {
            let created = get_document_in_conn(conn, &id)?;
            Ok(ImportDocumentResult::Created(created))
        }
        Err(rusqlite::Error::SqliteFailure(err, _))
            if err.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
        {
            let existing = conn.query_row(
                &format!("{DOCUMENT_SELECT} WHERE file_hash = ?1"),
                [file_hash],
                map_document,
            )?;
            Ok(ImportDocumentResult::AlreadyPresent(existing))
        }
        Err(err) => Err(err.into()),
    }
}

fn relink_document_in_conn(
    tx: &Transaction<'_>,
    document_id: &str,
    new_path: &Path,
    new_hash: &str,
) -> CoreResult<RelinkDocumentResult> {
    let existing = get_document_in_conn(tx, document_id)?;
    let _format = validate_relink_format(existing.format, new_path)?;

    let duplicate_id: Option<String> = tx
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
        tx.execute(
            "UPDATE documents SET
                 title = ?2,
                 file_path = ?3,
                 file_hash = ?4,
                 last_cursor_anchor = NULL,
                 last_progress = NULL,
                 last_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 hidden_from_recent_at = NULL,
                 display_title = NULL
             WHERE id = ?1",
            params![document_id, title, file_path, new_hash],
        )?;
        // Old chapter/page/line labels no longer describe the revised file, including
        // soft-deleted annotations that can still be restored via Undo (#125).
        tx.execute(
            "UPDATE annotations SET location_label = NULL WHERE document_id = ?1",
            params![document_id],
        )?;
    } else {
        tx.execute(
            "UPDATE documents SET
                 title = ?2,
                 file_path = ?3,
                 last_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 hidden_from_recent_at = NULL
             WHERE id = ?1",
            params![document_id, title, file_path],
        )?;
    }

    Ok(RelinkDocumentResult {
        document: get_document_in_conn(tx, document_id)?,
        content_changed,
        previous_file_hash: existing.file_hash,
    })
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
    expected_file_hash: Option<&str>,
) -> CoreResult<()> {
    let (format, current_hash): (String, String) = tx
        .query_row(
            "SELECT format, file_hash FROM documents WHERE id = ?1",
            [document_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| not_found("document", document_id))?;
    if format != anchor.format().as_str() {
        return Err(CoreError::InvalidAnchor(format!(
            "{} anchor on a {format} document",
            anchor.format().as_str()
        )));
    }
    if let Some(expected) = expected_file_hash
        && expected != current_hash
    {
        return Err(CoreError::InvalidAnchor(
            "the document changed since this selection was made".to_owned(),
        ));
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
/// Captures without text use `"Figure · <location>"` when a location label is known (#125).
fn card_title(excerpt_text: Option<&str>, location_label: Option<&str>) -> String {
    if let Some(first_line) =
        excerpt_text.and_then(|text| text.lines().map(str::trim).find(|line| !line.is_empty()))
    {
        return truncate_label(first_line);
    }
    match location_label {
        Some(label) => truncate_label(&format!("Figure · {label}")),
        None => "Image excerpt".to_owned(),
    }
}

fn normalize_location_label(raw: Option<&str>) -> Option<String> {
    raw.and_then(sanitize_single_line)
        .map(|label| truncate_chars(&label, LOCATION_LABEL_MAX_CHARS))
}

fn truncate_label(text: &str) -> String {
    truncate_chars(text, CARD_TITLE_MAX_CHARS)
}

fn normalize_bookmark_label(
    raw: Option<&str>,
    anchor: &AnchorLocation,
    max_chars: usize,
) -> String {
    let candidate = raw
        .and_then(sanitize_single_line)
        .or_else(|| sanitize_single_line(&anchor.default_bookmark_label()))
        .unwrap_or_else(|| "Bookmark".to_owned());
    truncate_chars(&candidate, max_chars)
}

fn check_anchor_limits(anchor: &AnchorLocation, limits: &ImportLimits) -> bool {
    match anchor {
        AnchorLocation::Pdf {
            rects, page_spans, ..
        } => {
            if rects.len() > limits.max_rects {
                return false;
            }
            if let Some(spans) = page_spans {
                if spans.len() > limits.max_page_spans {
                    return false;
                }
                if spans.iter().any(|span| span.rects.len() > limits.max_rects) {
                    return false;
                }
            }
            true
        }
        AnchorLocation::Epub {
            cfi_range,
            chapter_href,
        } => cfi_range.len() <= limits.max_cfi_bytes && chapter_href.len() <= limits.max_href_bytes,
        AnchorLocation::Txt { .. } | AnchorLocation::Md { .. } => true,
    }
}

/// Validates an ISO-8601 UTC timestamp such as `2026-11-21T02:55:34Z` or
/// `2026-11-21T02:55:34.123Z` (1 to 9 fractional digits).
fn is_valid_iso8601_utc(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20 || *bytes.last().unwrap_or(&0) != b'Z' {
        return false;
    }
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return false;
    }

    let parse_digits = |slice: &[u8]| -> Option<u32> {
        let mut acc: u32 = 0;
        for &b in slice {
            if !b.is_ascii_digit() {
                return None;
            }
            acc = acc * 10 + u32::from(b - b'0');
        }
        Some(acc)
    };

    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        parse_digits(&bytes[0..4]),
        parse_digits(&bytes[5..7]),
        parse_digits(&bytes[8..10]),
        parse_digits(&bytes[11..13]),
        parse_digits(&bytes[14..16]),
        parse_digits(&bytes[17..19]),
    ) else {
        return false;
    };

    if year == 0 || !(1..=12).contains(&month) {
        return false;
    }
    let is_leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap => 29,
        2 => 28,
        _ => return false,
    };
    if !(1..=max_day).contains(&day) || hour > 23 || minute > 59 || second > 59 {
        return false;
    }

    let frac = &bytes[19..bytes.len() - 1];
    if frac.is_empty() {
        return true;
    }
    if frac[0] != b'.' {
        return false;
    }
    let digits = &frac[1..];
    (1..=9).contains(&digits.len()) && digits.iter().all(u8::is_ascii_digit)
}

// ---- Row mapping ---------------------------------------------------------

/// A malformed JSON column surfaces as a conversion failure on that column.
fn conversion_failure(
    index: usize,
    error: impl std::error::Error + Send + Sync + 'static,
) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(error))
}

/// Drops `key` from `object` when its stored JSON fails to deserialize as `T`.
fn drop_invalid_preference_field<T: DeserializeOwned>(
    object: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
) {
    let invalid = object
        .get(key)
        .is_some_and(|value| serde_json::from_value::<T>(value.clone()).is_err());
    if invalid {
        object.remove(key);
    }
}

/// Reads a stored preferences row, tolerating a page-turn mode this build lacks.
///
/// Only the read path is lenient. A newer build may have written a
/// `pageTransition` or `scrollPageTransition` this one cannot parse, and
/// rejecting it would fail the whole load, so the key is dropped and
/// `#[serde(default)]` supplies the default. IPC input keeps strict enum
/// validation, as the memory backend does, so a garbage value from the frontend
/// is still an error.
fn reading_preferences_from_stored(
    mut stored: serde_json::Value,
) -> CoreResult<ReadingPreferences> {
    if let Some(object) = stored.as_object_mut() {
        drop_invalid_preference_field::<PageTransition>(object, "pageTransition");
        drop_invalid_preference_field::<Option<ScrollPageTransition>>(
            object,
            "scrollPageTransition",
        );
        if object.get("wheelSensitivity").is_some_and(|value| {
            !matches!(
                serde_json::from_value::<u8>(value.clone()),
                Ok(level)
                    if (ReadingPreferences::MIN_WHEEL_SENSITIVITY
                        ..=ReadingPreferences::MAX_WHEEL_SENSITIVITY)
                        .contains(&level)
            )
        }) {
            object.remove("wheelSensitivity");
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
    last_cursor_anchor, last_opened_at, created_at, last_progress, hidden_from_recent_at,
    display_title FROM documents";

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
        hidden_from_recent_at: row.get(10)?,
        display_title: row.get(11)?,
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
    excerpt_text, excerpt_image_path, note, color, created_at, style, location_label FROM annotations";

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
        location_label: row.get(10)?,
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
            location_label: None,
            expected_file_hash: None,
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
                    "hidden_from_recent_at",
                    "display_title",
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
                    "deleted_at",
                    "location_label",
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
                    "mind_map_open",
                    "inspector_open",
                    "mind_map_size",
                    "inspector_size",
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
            (
                "deleted_card_snapshots",
                &["card_id", "snapshot_json", "deleted_at"],
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
        // Declined before anything is written, so it never reaches Recent documents.
        assert!(db.list_documents().unwrap().is_empty());
    }

    /// Issue #99: the picker and the drop overlay offer Markdown, so it must open
    /// as something readable, with excerpts anchored like any other text file.
    #[test]
    fn registering_markdown_creates_a_readable_text_document() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open_in_memory().unwrap();
        let notebook_id = db.create_notebook("Study").unwrap().id;
        for name in ["README.md", "notes.MARKDOWN"] {
            let path = dir.path().join(name);
            std::fs::write(&path, format!("# {name}\n\nSome *notes*.\n")).unwrap();
            let document = db.register_document(&path).unwrap();
            assert_eq!(document.format, DocumentFormat::Txt, "{name}");

            let annotation = |anchor| CreateAnnotationInput {
                document_id: document.id.clone(),
                notebook_id: notebook_id.clone(),
                anchor,
                excerpt_text: Some("Some".to_owned()),
                excerpt_image_png: None,
                note: None,
                color: "#fde047".to_owned(),
                style: AnnotationStyle::Highlight,
                location_label: None,
                expected_file_hash: None,
            };
            db.create_annotation(&annotation(txt_anchor())).unwrap();
            assert!(matches!(
                db.create_annotation(&annotation(AnchorLocation::Md {
                    ast_node_id: "paragraph-1".to_owned(),
                    offset: 0,
                })),
                Err(CoreError::InvalidAnchor(_))
            ));
        }
        assert_eq!(db.list_documents().unwrap().len(), 2);
    }

    #[test]
    fn markdown_document_relinks_to_another_text_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open_in_memory().unwrap();
        let original = dir.path().join("notes.md");
        std::fs::write(&original, "# Notes\n").unwrap();
        let document = db.register_document(&original).unwrap();
        let moved = dir.path().join("notes.markdown");
        std::fs::rename(&original, &moved).unwrap();
        let relinked = db.relink_document(&document.id, &moved).unwrap();
        assert_eq!(relinked.document.format, DocumentFormat::Txt);
        assert!(DocumentFormat::Txt.extensions().contains(&"markdown"));
    }

    #[test]
    fn markdown_migration_makes_readerless_documents_text() {
        let mut conn = Connection::open_in_memory().unwrap();
        // Bring the database to version 12, as the previous release left it.
        for (version, sql) in (1_u32..).zip(&MIGRATIONS[..12]) {
            conn.execute_batch(sql).unwrap();
            conn.pragma_update(None, "user_version", version).unwrap();
        }
        conn.execute_batch(
            r#"
            INSERT INTO documents (id, title, file_path, file_hash, format, last_cursor_anchor, last_progress)
            VALUES
                ('plain', 'README', '/notes/README.md', 'h1', 'md',
                 '{"format":"md","astNodeId":"heading-1","offset":0}', 0.5),
                ('anchored', 'Old', '/notes/old.md', 'h2', 'md', NULL, NULL),
                ('book', 'Book', '/books/book.txt', 'h3', 'txt',
                 '{"format":"txt","startByteOffset":0,"endByteOffset":4,"lineIndex":0}', 0.25);
            INSERT INTO study_notebooks (id, title) VALUES ('nb', 'Study');
            INSERT INTO annotations (id, document_id, notebook_id, anchor_type, anchor_payload_json, color)
            VALUES ('a1', 'anchored', 'nb', 'md',
                    '{"format":"md","astNodeId":"paragraph-1","offset":0}', '#fde047');
            "#,
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        let db = Database {
            conn,
            captures: None,
            library: None,
            sole_connection_on_open: true,
            _session_lock: None,
        };

        let plain = db.get_document("plain").unwrap();
        assert_eq!(plain.format, DocumentFormat::Txt);
        assert_eq!(plain.last_cursor_anchor, None);
        assert_eq!(plain.last_progress, None);
        // Converting it would orphan an anchor only a Markdown reader understands.
        assert_eq!(
            db.get_document("anchored").unwrap().format,
            DocumentFormat::Md
        );
        let book = db.get_document("book").unwrap();
        assert_eq!(book.format, DocumentFormat::Txt);
        assert_eq!(book.last_cursor_anchor, Some(txt_anchor()));
        assert_eq!(book.last_progress, Some(0.25));
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
    fn replace_cursor_if_updates_when_expected_matches_including_unset_and_signed_zero() {
        let mut f = fixture();
        let initial_anchor = txt_anchor();
        let next_anchor = AnchorLocation::Txt {
            start_byte_offset: 5,
            end_byte_offset: 12,
            line_index: 1,
        };

        // T-29: matching unset (None/None) cursor updates anchor and progress together.
        let result =
            f.db.replace_cursor_if(
                &f.document_id,
                &CursorSnapshot {
                    anchor: None,
                    progress: None,
                },
                &CursorSnapshot {
                    anchor: Some(initial_anchor.clone()),
                    progress: Some(0.0),
                },
            )
            .unwrap();
        assert_eq!(result, ReplaceCursorResult::Replaced);
        let doc = f.db.get_document(&f.document_id).unwrap();
        assert_eq!(doc.last_cursor_anchor, Some(initial_anchor.clone()));
        assert_eq!(doc.last_progress, Some(0.0));

        // Structural equality treats -0.0 == 0.0 (never raw f64::to_bits()).
        let result =
            f.db.replace_cursor_if(
                &f.document_id,
                &CursorSnapshot {
                    anchor: Some(initial_anchor.clone()),
                    progress: Some(-0.0),
                },
                &CursorSnapshot {
                    anchor: Some(next_anchor.clone()),
                    progress: Some(0.75),
                },
            )
            .unwrap();
        assert_eq!(result, ReplaceCursorResult::Replaced);
        let doc = f.db.get_document(&f.document_id).unwrap();
        assert_eq!(doc.last_cursor_anchor, Some(next_anchor.clone()));
        assert_eq!(doc.last_progress, Some(0.75));

        // Structural equality ignores raw JSON key ordering and whitespace.
        f.db.conn
            .execute(
                "UPDATE documents SET last_cursor_anchor = ?2 WHERE id = ?1",
                params![
                    &f.document_id,
                    r#"{ "lineIndex" : 1, "endByteOffset": 12, "startByteOffset": 5, "format": "txt" }"#,
                ],
            )
            .unwrap();
        let result =
            f.db.replace_cursor_if(
                &f.document_id,
                &CursorSnapshot {
                    anchor: Some(next_anchor),
                    progress: Some(0.75),
                },
                &CursorSnapshot {
                    anchor: None,
                    progress: None,
                },
            )
            .unwrap();
        assert_eq!(result, ReplaceCursorResult::Replaced);
        let doc = f.db.get_document(&f.document_id).unwrap();
        assert_eq!(doc.last_cursor_anchor, None);
        assert_eq!(doc.last_progress, None);
    }

    #[test]
    fn replace_cursor_if_detects_anchor_only_and_progress_only_conflicts() {
        let mut f = fixture();
        let anchor_a = txt_anchor();
        let anchor_b = AnchorLocation::Txt {
            start_byte_offset: 5,
            end_byte_offset: 10,
            line_index: 1,
        };
        let anchor_c = AnchorLocation::Txt {
            start_byte_offset: 6,
            end_byte_offset: 12,
            line_index: 2,
        };

        f.db.update_document_cursor(&f.document_id, &anchor_a, Some(0.25))
            .unwrap();

        // T-30: anchor changed alone -> Conflict with current, row untouched.
        let conflict =
            f.db.replace_cursor_if(
                &f.document_id,
                &CursorSnapshot {
                    anchor: Some(anchor_b.clone()),
                    progress: Some(0.25),
                },
                &CursorSnapshot {
                    anchor: Some(anchor_c.clone()),
                    progress: Some(0.9),
                },
            )
            .unwrap();
        assert_eq!(
            conflict,
            ReplaceCursorResult::Conflict {
                current: CursorSnapshot {
                    anchor: Some(anchor_a.clone()),
                    progress: Some(0.25),
                }
            }
        );

        // T-30: progress changed alone (different value) -> Conflict with current, row untouched.
        let conflict =
            f.db.replace_cursor_if(
                &f.document_id,
                &CursorSnapshot {
                    anchor: Some(anchor_a.clone()),
                    progress: Some(0.5),
                },
                &CursorSnapshot {
                    anchor: Some(anchor_c.clone()),
                    progress: Some(0.9),
                },
            )
            .unwrap();
        assert_eq!(
            conflict,
            ReplaceCursorResult::Conflict {
                current: CursorSnapshot {
                    anchor: Some(anchor_a.clone()),
                    progress: Some(0.25),
                }
            }
        );

        // T-30: progress changed alone (None vs Some) -> Conflict with current, row untouched.
        let conflict =
            f.db.replace_cursor_if(
                &f.document_id,
                &CursorSnapshot {
                    anchor: Some(anchor_a.clone()),
                    progress: None,
                },
                &CursorSnapshot {
                    anchor: Some(anchor_c),
                    progress: Some(0.9),
                },
            )
            .unwrap();
        assert_eq!(
            conflict,
            ReplaceCursorResult::Conflict {
                current: CursorSnapshot {
                    anchor: Some(anchor_a.clone()),
                    progress: Some(0.25),
                }
            }
        );

        let doc = f.db.get_document(&f.document_id).unwrap();
        assert_eq!(doc.last_cursor_anchor, Some(anchor_a));
        assert_eq!(doc.last_progress, Some(0.25));
    }

    #[test]
    fn replace_cursor_if_validates_format_anchor_progress_and_document() {
        let mut f = fixture();
        let epub_path = f._dir.path().join("book.epub");
        std::fs::write(&epub_path, "fake epub bytes").unwrap();
        let epub_doc = f.db.register_document(&epub_path).unwrap();

        let empty = CursorSnapshot::default();
        let pdf_anchor = AnchorLocation::Pdf {
            page_index: 0,
            rects: vec![crate::domain::NormalizedRect {
                x: 0.1,
                y: 0.1,
                width: 0.5,
                height: 0.1,
            }],
            page_spans: None,
        };

        // T-33: format mismatch (PDF anchor on EPUB) -> invalid_anchor.
        let err =
            f.db.replace_cursor_if(
                &epub_doc.id,
                &empty,
                &CursorSnapshot {
                    anchor: Some(pdf_anchor),
                    progress: Some(0.4),
                },
            )
            .unwrap_err();
        assert!(matches!(err, CoreError::InvalidAnchor(_)));
        assert_eq!(err.code(), "invalid_anchor");

        // T-33: structurally invalid anchor -> invalid_anchor.
        let err =
            f.db.replace_cursor_if(
                &f.document_id,
                &empty,
                &CursorSnapshot {
                    anchor: Some(AnchorLocation::Txt {
                        start_byte_offset: 10,
                        end_byte_offset: 10,
                        line_index: 0,
                    }),
                    progress: Some(0.4),
                },
            )
            .unwrap_err();
        assert!(matches!(err, CoreError::InvalidAnchor(_)));
        assert_eq!(err.code(), "invalid_anchor");

        // T-33: non-finite or out-of-range progress -> invalid_progress.
        for bad in [-0.01, 1.01, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let err =
                f.db.replace_cursor_if(
                    &f.document_id,
                    &empty,
                    &CursorSnapshot {
                        anchor: Some(txt_anchor()),
                        progress: Some(bad),
                    },
                )
                .unwrap_err();
            assert!(
                matches!(err, CoreError::InvalidProgress(_)),
                "{bad} must be rejected with InvalidProgress"
            );
            assert_eq!(err.code(), "invalid_progress");
        }

        // Rejected writes must leave both rows untouched.
        let epub_after = f.db.get_document(&epub_doc.id).unwrap();
        assert_eq!(epub_after.last_cursor_anchor, None);
        assert_eq!(epub_after.last_progress, None);
        let txt_after = f.db.get_document(&f.document_id).unwrap();
        assert_eq!(txt_after.last_cursor_anchor, None);
        assert_eq!(txt_after.last_progress, None);

        // T-33: unknown document -> not_found.
        let err =
            f.db.replace_cursor_if(
                "missing-doc",
                &empty,
                &CursorSnapshot {
                    anchor: Some(txt_anchor()),
                    progress: Some(0.2),
                },
            )
            .unwrap_err();
        assert!(matches!(err, CoreError::NotFound { .. }));
        assert_eq!(err.code(), "not_found");
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
            location_label: None,
            expected_file_hash: None,
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

    /// Undo Delete must restore exactly what was deleted (#97).
    #[test]
    fn a_deleted_capture_excerpt_restores_with_its_id_card_link_and_image() {
        let mut f = on_disk();
        let created =
            f.db.create_excerpt(&capture_input(&f, Some(PNG_BASE64)))
                .unwrap();
        let id = created.annotation.id.clone();
        let path = f.db.capture_path(&id).unwrap().unwrap();

        f.db.delete_annotation(&id).unwrap();
        let graph = f.db.load_notebook_graph(&f.notebook_id).unwrap();
        assert!(graph.annotations.is_empty());
        assert_eq!(graph.cards.len(), 1, "the card is never deleted with it");
        assert!(graph.cards[0].annotation_ids.is_empty());
        assert_eq!(graph.nodes.len(), 1);
        assert!(path.exists(), "the capture is kept for Undo");

        let restored = f.db.restore_annotation(&id).unwrap();
        assert_eq!(restored.annotation, created.annotation);
        assert_eq!(restored.cards, vec![created.card.clone()]);
        assert_eq!(f.db.capture_path(&id).unwrap(), Some(path.clone()));
        assert!(std::fs::read(&path).unwrap().starts_with(b"\x89PNG"));

        let graph = f.db.load_notebook_graph(&f.notebook_id).unwrap();
        assert_eq!(graph.annotations, vec![created.annotation]);
        assert_eq!(graph.cards, vec![created.card]);
    }

    #[test]
    fn a_deleted_annotation_is_gone_to_every_read_until_restored() {
        let mut f = on_disk();
        let created =
            f.db.create_excerpt(&capture_input(&f, Some(PNG_BASE64)))
                .unwrap();
        let id = created.annotation.id.clone();
        let not_found = |result: CoreResult<_>| matches!(result, Err(CoreError::NotFound { .. }));

        assert!(not_found(f.db.restore_annotation(&id).map(|_| ())));
        f.db.delete_annotation(&id).unwrap();
        assert!(not_found(f.db.delete_annotation(&id)));
        assert!(not_found(f.db.capture_path(&id).map(|_| ())));
        let patch = AnnotationPatch {
            note: Some("late".to_owned()),
            color: None,
            style: None,
        };
        assert!(not_found(f.db.update_annotation(&id, &patch).map(|_| ())));
        let card =
            f.db.update_card(
                &created.card.id,
                &CardPatch {
                    title: Some("Renamed".to_owned()),
                    markdown_notes: None,
                    tags: None,
                },
            )
            .unwrap();
        assert!(card.annotation_ids.is_empty());

        f.db.restore_annotation(&id).unwrap();
        assert!(not_found(f.db.restore_annotation(&id).map(|_| ())));
        assert_eq!(
            f.db.update_annotation(&id, &patch).unwrap().note.as_deref(),
            Some("late")
        );
    }

    /// Undo history is in memory, so a delete becomes final on the next launch.
    #[test]
    fn reopening_purges_deleted_annotations_their_links_and_captures() {
        let mut f = on_disk();
        let deleted =
            f.db.create_excerpt(&capture_input(&f, Some(PNG_BASE64)))
                .unwrap();
        let kept =
            f.db.create_excerpt(&capture_input(&f, Some(PNG_BASE64)))
                .unwrap();
        f.db.delete_annotation(&deleted.annotation.id).unwrap();
        assert_eq!(capture_files(&f), 2);

        // Close the first session before relaunching so the session lock is released.
        f.db = Database::open_in_memory().unwrap();
        let db = Database::open(&f.dir.path().join("app.sqlite3")).unwrap();
        assert_eq!(count(&db, "annotations"), 1);
        assert_eq!(count(&db, "card_annotations"), 1);
        assert_eq!(count(&db, "note_cards"), 2, "cards outlive their source");
        assert_eq!(capture_files(&f), 1);
        assert!(
            db.capture_path(&kept.annotation.id)
                .unwrap()
                .unwrap()
                .exists()
        );
        f.db = db;
        assert!(matches!(
            f.db.restore_annotation(&deleted.annotation.id),
            Err(CoreError::NotFound { .. })
        ));
    }

    #[test]
    fn opening_a_second_connection_while_live_keeps_pending_undo_and_captures() {
        let mut f = on_disk();
        let deleted =
            f.db.create_excerpt(&capture_input(&f, Some(PNG_BASE64)))
                .unwrap();
        f.db.delete_annotation(&deleted.annotation.id).unwrap();
        assert_eq!(capture_files(&f), 1);

        let second = Database::open(&f.dir.path().join("app.sqlite3")).unwrap();
        assert_eq!(count(&second, "annotations"), 1);
        assert_eq!(capture_files(&f), 1);

        let restored = f.db.restore_annotation(&deleted.annotation.id).unwrap();
        assert_eq!(restored.annotation, deleted.annotation);
        assert_eq!(restored.cards, vec![deleted.card]);
        assert!(
            f.db.capture_path(&deleted.annotation.id)
                .unwrap()
                .unwrap()
                .exists()
        );
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
        let title = card_title(Some(&long), None);
        assert_eq!(title.chars().count(), CARD_TITLE_MAX_CHARS);
        assert!(title.ends_with('…'));
        assert_eq!(
            card_title(Some("\n\n  second line \nx"), None),
            "second line"
        );
        assert_eq!(card_title(None, Some("p. 12")), "Figure · p. 12");
        assert_eq!(card_title(None, None), "Image excerpt");
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
            scroll_page_transition: Some(crate::domain::ScrollPageTransition::None),
            tint_pdf_pages: true,
            focus_mode_full_screen: true,
            wheel_sensitivity: 4,
        };
        let saved = db.save_reading_preferences(&updated).unwrap();
        assert_eq!(saved, updated);
        assert_eq!(db.get_reading_preferences().unwrap(), updated);

        let mut invalid = updated.clone();
        invalid.font_size = 300;
        assert!(matches!(
            db.save_reading_preferences(&invalid),
            Err(CoreError::InvalidPreferences(_))
        ));

        for invalid_sensitivity in [0_u8, 6_u8] {
            let mut bad = updated.clone();
            bad.wheel_sensitivity = invalid_sensitivity;
            assert!(matches!(
                db.save_reading_preferences(&bad),
                Err(CoreError::InvalidPreferences(_))
            ));
        }
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
            assert_eq!(prefs.scroll_page_transition, None, "stored {row}");
            assert_eq!(prefs.font_size, 110);
            // The row predates both appearance switches and wheel sensitivity.
            assert!(!prefs.tint_pdf_pages, "stored {row}");
            assert!(!prefs.focus_mode_full_screen, "stored {row}");
            assert_eq!(
                prefs.wheel_sensitivity,
                ReadingPreferences::DEFAULT_WHEEL_SENSITIVITY,
                "stored {row}"
            );
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
            library: None,
            sole_connection_on_open: true,
            _session_lock: None,
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
    fn stored_scroll_page_transition_loads_valid_values_and_tolerates_unknown_ones() {
        let db = Database::open_in_memory().unwrap();
        let cases = [
            (serde_json::Value::Null, None),
            (
                serde_json::json!("none"),
                Some(crate::domain::ScrollPageTransition::None),
            ),
            (
                serde_json::json!("fade"),
                Some(crate::domain::ScrollPageTransition::Fade),
            ),
            // A newer build (or unknown mode) degrades cleanly to `None`.
            (serde_json::json!("glide"), None),
        ];
        for (stored_value, expected) in cases {
            let stored = serde_json::json!({
                "theme": "dark",
                "fontFamily": "mono",
                "fontSize": 120,
                "lineSpacing": 1.9,
                "margins": "narrow",
                "pageWidth": "standard",
                "justify": true,
                "dimImages": false,
                "epubReadingMode": "scroll",
                "pageTransition": "curl",
                "scrollPageTransition": stored_value,
            });
            db.conn
                .execute(
                    "INSERT INTO reading_preferences (id, preferences_json) VALUES (1, ?1)
                     ON CONFLICT (id) DO UPDATE SET preferences_json = excluded.preferences_json",
                    params![stored.to_string()],
                )
                .unwrap();

            let prefs = db.get_reading_preferences().unwrap();
            assert_eq!(prefs.scroll_page_transition, expected, "stored {stored}");
            assert_eq!(prefs.page_transition, crate::domain::PageTransition::Curl);
            assert_eq!(prefs.theme, crate::domain::ReadingTheme::Dark);
        }
    }

    #[test]
    fn page_width_and_wheel_sensitivity_persist_across_database_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("reading-width.sqlite");
        let preferences = ReadingPreferences {
            page_width: crate::domain::ReadingPageWidth::Full,
            wheel_sensitivity: 5,
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
    fn stored_wheel_sensitivity_out_of_range_or_unknown_degrades_to_default() {
        let db = Database::open_in_memory().unwrap();
        for bad_value in [
            serde_json::json!(0),
            serde_json::json!(9),
            serde_json::json!(-1),
            serde_json::json!("fast"),
            serde_json::Value::Null,
        ] {
            let stored = serde_json::json!({
                "theme": "light",
                "fontFamily": "original",
                "fontSize": 100,
                "lineSpacing": 1.75,
                "margins": "normal",
                "pageWidth": "standard",
                "justify": true,
                "dimImages": false,
                "epubReadingMode": "spread",
                "pageTransition": "slide",
                "wheelSensitivity": bad_value,
            });
            db.conn
                .execute(
                    "INSERT INTO reading_preferences (id, preferences_json) VALUES (1, ?1)
                     ON CONFLICT (id) DO UPDATE SET preferences_json = excluded.preferences_json",
                    params![stored.to_string()],
                )
                .unwrap();

            let prefs = db.get_reading_preferences().unwrap();
            assert_eq!(
                prefs.wheel_sensitivity,
                ReadingPreferences::DEFAULT_WHEEL_SENSITIVITY,
                "stored {stored}"
            );
            assert_eq!(prefs.theme, crate::domain::ReadingTheme::Light);
        }
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
                library: None,
                sole_connection_on_open: true,
                _session_lock: None,
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
            library: None,
            sole_connection_on_open: true,
            _session_lock: None,
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
            library: None,
            sole_connection_on_open: true,
            _session_lock: None,
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

    /// T-35 & T-36: Insert-only import preserves existing `(document_id, location_key)`
    /// rows byte-identically, and re-importing the same payload inserts 0 rows.
    #[test]
    fn import_bookmarks_is_insert_only_and_idempotent_on_reimport() {
        let mut f = fixture();
        let existing_anchor = AnchorLocation::Txt {
            start_byte_offset: 0,
            end_byte_offset: 5,
            line_index: 0,
        };
        let existing_row =
            f.db.create_bookmark(&CreateBookmarkInput {
                document_id: f.document_id.clone(),
                anchor: existing_anchor.clone(),
                label: Some("Original receiver label".to_owned()),
            })
            .unwrap();

        let raw_before: (String, String, String, String) = f
            .db
            .conn
            .query_row(
                "SELECT id, label, anchor_payload_json, created_at FROM bookmarks WHERE id = ?1",
                [&existing_row.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();

        // Colliding location_key with different end_byte_offset, label, and created_at,
        // plus two new entries (and an in-batch duplicate of the second new entry).
        let payload = vec![
            ImportBookmarkEntry {
                anchor: AnchorLocation::Txt {
                    start_byte_offset: 0,
                    end_byte_offset: 12,
                    line_index: 0,
                },
                label: Some("Sender overwrite attempt".to_owned()),
                created_at: Some("2025-01-02T03:04:05.678Z".to_owned()),
            },
            ImportBookmarkEntry {
                anchor: AnchorLocation::Txt {
                    start_byte_offset: 10,
                    end_byte_offset: 20,
                    line_index: 1,
                },
                label: Some("Chapter 2".to_owned()),
                created_at: Some("2025-02-03T04:05:06Z".to_owned()),
            },
            ImportBookmarkEntry {
                anchor: AnchorLocation::Txt {
                    start_byte_offset: 10,
                    end_byte_offset: 25,
                    line_index: 1,
                },
                label: Some("Duplicate in same batch".to_owned()),
                created_at: Some("2025-02-04T00:00:00Z".to_owned()),
            },
        ];

        let report =
            f.db.import_bookmarks(&f.document_id, &payload, &ImportLimits::default())
                .unwrap();
        assert_eq!(report.inserted, 1);
        assert_eq!(report.existing, 2);
        assert_eq!(report.skipped, 0);
        assert!(report.skipped_entries.is_empty());
        assert_eq!(report.inserted_bookmarks.len(), 1);
        assert_ne!(report.inserted_bookmarks[0].id, existing_row.id);
        assert_eq!(report.inserted_bookmarks[0].label, "Chapter 2");
        assert_eq!(
            report.inserted_bookmarks[0].created_at,
            "2025-02-03T04:05:06Z"
        );

        // T-36: Existing row is byte-identical after import.
        let raw_after: (String, String, String, String) = f
            .db
            .conn
            .query_row(
                "SELECT id, label, anchor_payload_json, created_at FROM bookmarks WHERE id = ?1",
                [&existing_row.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(raw_before, raw_after);

        // T-35: Re-importing the exact same payload inserts 0 rows and classifies all as existing.
        let second =
            f.db.import_bookmarks(&f.document_id, &payload, &ImportLimits::default())
                .unwrap();
        assert_eq!(second.inserted, 0);
        assert_eq!(second.existing, payload.len());
        assert_eq!(second.skipped, 0);
        assert!(second.skipped_entries.is_empty());
        assert!(second.inserted_bookmarks.is_empty());
        assert_eq!(f.db.list_bookmarks().unwrap().len(), 2);
    }

    /// T-38: Invalid, wrong-format, and oversized entries are skipped with stable
    /// reasons without aborting valid entries in the same batch.
    #[test]
    fn import_bookmarks_skips_invalid_wrong_format_and_oversized_entries_individually() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open_in_memory().unwrap();

        let txt_path = dir.path().join("notes.txt");
        let epub_path = dir.path().join("book.epub");
        let pdf_path = dir.path().join("paper.pdf");
        std::fs::write(&txt_path, "hello world").unwrap();
        std::fs::write(&epub_path, "epub").unwrap();
        std::fs::write(&pdf_path, "pdf").unwrap();

        let txt_doc = db.register_document(&txt_path).unwrap();
        let epub_doc = db.register_document(&epub_path).unwrap();
        let pdf_doc = db.register_document(&pdf_path).unwrap();

        // 1. TXT document: invalid TXT range, wrong-format Md & Pdf, and one valid TXT entry.
        let txt_report = db
            .import_bookmarks(
                &txt_doc.id,
                &[
                    ImportBookmarkEntry {
                        anchor: AnchorLocation::Txt {
                            start_byte_offset: 5,
                            end_byte_offset: 5,
                            line_index: 0,
                        },
                        label: Some("empty range".to_owned()),
                        created_at: None,
                    },
                    ImportBookmarkEntry {
                        anchor: AnchorLocation::Md {
                            ast_node_id: "heading-1".to_owned(),
                            offset: 0,
                        },
                        label: Some("md on txt".to_owned()),
                        created_at: None,
                    },
                    ImportBookmarkEntry {
                        anchor: AnchorLocation::Txt {
                            start_byte_offset: 0,
                            end_byte_offset: 5,
                            line_index: 0,
                        },
                        label: Some("valid txt".to_owned()),
                        created_at: None,
                    },
                ],
                &ImportLimits::default(),
            )
            .unwrap();
        assert_eq!(txt_report.inserted, 1);
        assert_eq!(txt_report.existing, 0);
        assert_eq!(txt_report.skipped, 2);
        assert_eq!(
            txt_report.skipped_entries,
            vec![
                SkippedBookmark {
                    index: 0,
                    reason: BookmarkSkipReason::InvalidAnchor,
                },
                SkippedBookmark {
                    index: 1,
                    reason: BookmarkSkipReason::FormatMismatch,
                },
            ]
        );
        assert_eq!(txt_report.inserted_bookmarks[0].label, "valid txt");

        // 2. EPUB document: Pdf on Epub, oversized CFI, oversized href, and one valid EPUB entry.
        let limits = ImportLimits::default();
        let valid_rect = NormalizedRect {
            x: 0.1,
            y: 0.1,
            width: 0.2,
            height: 0.1,
        };
        let epub_report = db
            .import_bookmarks(
                &epub_doc.id,
                &[
                    ImportBookmarkEntry {
                        anchor: AnchorLocation::Pdf {
                            page_index: 0,
                            rects: vec![valid_rect],
                            page_spans: None,
                        },
                        label: Some("pdf on epub".to_owned()),
                        created_at: None,
                    },
                    ImportBookmarkEntry {
                        anchor: AnchorLocation::Epub {
                            cfi_range: "a".repeat(limits.max_cfi_bytes + 1),
                            chapter_href: "ch1.xhtml".to_owned(),
                        },
                        label: Some("huge cfi".to_owned()),
                        created_at: None,
                    },
                    ImportBookmarkEntry {
                        anchor: AnchorLocation::Epub {
                            cfi_range: "epubcfi(/6/2!/4/2)".to_owned(),
                            chapter_href: "b".repeat(limits.max_href_bytes + 1),
                        },
                        label: Some("huge href".to_owned()),
                        created_at: None,
                    },
                    ImportBookmarkEntry {
                        anchor: AnchorLocation::Epub {
                            cfi_range: "epubcfi(/6/2!/4/2)".to_owned(),
                            chapter_href: "ch1.xhtml".to_owned(),
                        },
                        label: Some("valid epub".to_owned()),
                        created_at: None,
                    },
                ],
                &limits,
            )
            .unwrap();
        assert_eq!(epub_report.inserted, 1);
        assert_eq!(epub_report.skipped, 3);
        assert_eq!(
            epub_report.skipped_entries,
            vec![
                SkippedBookmark {
                    index: 0,
                    reason: BookmarkSkipReason::FormatMismatch,
                },
                SkippedBookmark {
                    index: 1,
                    reason: BookmarkSkipReason::AnchorLimitExceeded,
                },
                SkippedBookmark {
                    index: 2,
                    reason: BookmarkSkipReason::AnchorLimitExceeded,
                },
            ]
        );

        // 3. PDF document: too many rects, too many pageSpans, span with too many rects, and one valid PDF entry.
        let small_limits = ImportLimits {
            max_rects: 2,
            max_page_spans: 2,
            ..ImportLimits::default()
        };
        let pdf_report = db
            .import_bookmarks(
                &pdf_doc.id,
                &[
                    ImportBookmarkEntry {
                        anchor: AnchorLocation::Pdf {
                            page_index: 0,
                            rects: vec![valid_rect, valid_rect, valid_rect],
                            page_spans: None,
                        },
                        label: None,
                        created_at: None,
                    },
                    ImportBookmarkEntry {
                        anchor: AnchorLocation::Pdf {
                            page_index: 0,
                            rects: vec![valid_rect],
                            page_spans: Some(vec![
                                crate::domain::PdfPageSpan {
                                    page_index: 0,
                                    rects: vec![valid_rect],
                                },
                                crate::domain::PdfPageSpan {
                                    page_index: 1,
                                    rects: vec![valid_rect],
                                },
                                crate::domain::PdfPageSpan {
                                    page_index: 2,
                                    rects: vec![valid_rect],
                                },
                            ]),
                        },
                        label: None,
                        created_at: None,
                    },
                    ImportBookmarkEntry {
                        anchor: AnchorLocation::Pdf {
                            page_index: 0,
                            rects: vec![valid_rect],
                            page_spans: Some(vec![crate::domain::PdfPageSpan {
                                page_index: 0,
                                rects: vec![valid_rect, valid_rect, valid_rect],
                            }]),
                        },
                        label: None,
                        created_at: None,
                    },
                    ImportBookmarkEntry {
                        anchor: AnchorLocation::Pdf {
                            page_index: 4,
                            rects: vec![valid_rect],
                            page_spans: None,
                        },
                        label: Some("valid pdf".to_owned()),
                        created_at: None,
                    },
                ],
                &small_limits,
            )
            .unwrap();
        assert_eq!(pdf_report.inserted, 1);
        assert_eq!(pdf_report.skipped, 3);
        assert_eq!(
            pdf_report.skipped_entries,
            vec![
                SkippedBookmark {
                    index: 0,
                    reason: BookmarkSkipReason::AnchorLimitExceeded,
                },
                SkippedBookmark {
                    index: 1,
                    reason: BookmarkSkipReason::AnchorLimitExceeded,
                },
                SkippedBookmark {
                    index: 2,
                    reason: BookmarkSkipReason::AnchorLimitExceeded,
                },
            ]
        );
    }

    #[test]
    fn import_bookmarks_preserves_valid_utc_timestamps_and_falls_back_otherwise() {
        let mut f = fixture();
        let entries = vec![
            ImportBookmarkEntry {
                anchor: AnchorLocation::Txt {
                    start_byte_offset: 0,
                    end_byte_offset: 1,
                    line_index: 0,
                },
                label: Some("whole seconds".to_owned()),
                created_at: Some("2024-02-29T23:59:59Z".to_owned()),
            },
            ImportBookmarkEntry {
                anchor: AnchorLocation::Txt {
                    start_byte_offset: 2,
                    end_byte_offset: 3,
                    line_index: 1,
                },
                label: Some("millis".to_owned()),
                created_at: Some("2026-11-21T02:55:34.123Z".to_owned()),
            },
            ImportBookmarkEntry {
                anchor: AnchorLocation::Txt {
                    start_byte_offset: 4,
                    end_byte_offset: 5,
                    line_index: 2,
                },
                label: Some("missing ts".to_owned()),
                created_at: None,
            },
            ImportBookmarkEntry {
                anchor: AnchorLocation::Txt {
                    start_byte_offset: 6,
                    end_byte_offset: 7,
                    line_index: 3,
                },
                label: Some("non-utc offset".to_owned()),
                created_at: Some("2026-11-21T02:55:34+08:00".to_owned()),
            },
            ImportBookmarkEntry {
                anchor: AnchorLocation::Txt {
                    start_byte_offset: 8,
                    end_byte_offset: 9,
                    line_index: 4,
                },
                label: Some("non-leap feb 29".to_owned()),
                created_at: Some("2026-02-29T00:00:00Z".to_owned()),
            },
            ImportBookmarkEntry {
                anchor: AnchorLocation::Txt {
                    start_byte_offset: 10,
                    end_byte_offset: 11,
                    line_index: 5,
                },
                label: Some("garbage".to_owned()),
                created_at: Some("not-a-timestamp".to_owned()),
            },
        ];

        let report =
            f.db.import_bookmarks(&f.document_id, &entries, &ImportLimits::default())
                .unwrap();
        assert_eq!(report.inserted, 6);
        assert_eq!(
            report.inserted_bookmarks[0].created_at,
            "2024-02-29T23:59:59Z"
        );
        assert_eq!(
            report.inserted_bookmarks[1].created_at,
            "2026-11-21T02:55:34.123Z"
        );
        for bookmark in &report.inserted_bookmarks[2..] {
            assert!(
                is_valid_iso8601_utc(&bookmark.created_at),
                "fallback timestamp must be valid ISO-8601 UTC, got {}",
                bookmark.created_at
            );
            assert_ne!(bookmark.created_at, "2026-11-21T02:55:34+08:00");
            assert_ne!(bookmark.created_at, "2026-02-29T00:00:00Z");
            assert_ne!(bookmark.created_at, "not-a-timestamp");
        }
    }

    #[test]
    fn bookmark_label_normalization_strips_control_and_bidi_chars_and_truncates() {
        let mut f = fixture();
        // `create_bookmark` and `import_bookmarks` share the same label sanitizer.
        let created = f
            .db
            .create_bookmark(&CreateBookmarkInput {
                document_id: f.document_id.clone(),
                anchor: AnchorLocation::Txt {
                    start_byte_offset: 0,
                    end_byte_offset: 4,
                    line_index: 0,
                },
                label: Some(
                    "\u{0000}\u{202E}   \n  Hello\u{0007}\u{007F}\u{0085}\u{202A}\u{2066}World\u{2069}  \nSecond"
                        .to_owned(),
                ),
            })
            .unwrap();
        assert_eq!(created.label, "HelloWorld");

        let long_label = "x".repeat(120);
        let report =
            f.db.import_bookmarks(
                &f.document_id,
                &[
                    ImportBookmarkEntry {
                        anchor: AnchorLocation::Txt {
                            start_byte_offset: 10,
                            end_byte_offset: 14,
                            line_index: 4,
                        },
                        label: Some("\u{0001}\u{001F}\u{007F}\u{009F}\u{202E}\u{2067}".to_owned()),
                        created_at: None,
                    },
                    ImportBookmarkEntry {
                        anchor: AnchorLocation::Txt {
                            start_byte_offset: 20,
                            end_byte_offset: 24,
                            line_index: 5,
                        },
                        label: Some(long_label),
                        created_at: None,
                    },
                ],
                &ImportLimits::default(),
            )
            .unwrap();
        assert_eq!(report.inserted, 2);
        // Control/bidi-only label falls back to `anchor.default_bookmark_label()`.
        assert_eq!(report.inserted_bookmarks[0].label, "Line 5");
        // Long label is truncated to `max_bookmark_label_chars` (80) with trailing ellipsis.
        assert_eq!(report.inserted_bookmarks[1].label.chars().count(), 80);
        assert!(report.inserted_bookmarks[1].label.ends_with('…'));
    }

    #[test]
    fn import_bookmarks_enforces_max_bookmarks_per_book_cap_while_classifying_existing() {
        let mut f = fixture();
        let limits = ImportLimits {
            max_bookmarks_per_book: 2,
            ..ImportLimits::default()
        };

        let entries = vec![
            ImportBookmarkEntry {
                anchor: AnchorLocation::Txt {
                    start_byte_offset: 0,
                    end_byte_offset: 2,
                    line_index: 0,
                },
                label: Some("One".to_owned()),
                created_at: None,
            },
            ImportBookmarkEntry {
                anchor: AnchorLocation::Txt {
                    start_byte_offset: 4,
                    end_byte_offset: 6,
                    line_index: 1,
                },
                label: Some("Two".to_owned()),
                created_at: None,
            },
            ImportBookmarkEntry {
                anchor: AnchorLocation::Txt {
                    start_byte_offset: 8,
                    end_byte_offset: 10,
                    line_index: 2,
                },
                label: Some("Three (over cap)".to_owned()),
                created_at: None,
            },
        ];

        let first =
            f.db.import_bookmarks(&f.document_id, &entries, &limits)
                .unwrap();
        assert_eq!(first.inserted, 2);
        assert_eq!(first.existing, 0);
        assert_eq!(first.skipped, 1);
        assert_eq!(
            first.skipped_entries,
            vec![SkippedBookmark {
                index: 2,
                reason: BookmarkSkipReason::BookmarkCapExceeded,
            }]
        );

        // Re-importing when already at the cap still classifies the existing two as `existing`
        // and only skips the third new entry as `BookmarkCapExceeded`.
        let second =
            f.db.import_bookmarks(&f.document_id, &entries, &limits)
                .unwrap();
        assert_eq!(second.inserted, 0);
        assert_eq!(second.existing, 2);
        assert_eq!(second.skipped, 1);
        assert_eq!(
            second.skipped_entries,
            vec![SkippedBookmark {
                index: 2,
                reason: BookmarkSkipReason::BookmarkCapExceeded,
            }]
        );
    }

    #[test]
    fn import_bookmarks_rejects_unknown_document() {
        let mut f = fixture();
        let err =
            f.db.import_bookmarks("nonexistent-doc", &[], &ImportLimits::default())
                .unwrap_err();
        assert!(matches!(
            err,
            CoreError::NotFound {
                entity: "document",
                ..
            }
        ));
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
                location_label: None,
                expected_file_hash: None,
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
                    pane_layout: WorkspacePaneLayout::default(),
                })
                .unwrap();
            assert_eq!(
                saved,
                WorkspaceSession {
                    open_document_ids: vec![first.id.clone(), second.id.clone()],
                    active_document_id: Some(second.id.clone()),
                    immersive: true,
                    pane_layout: WorkspacePaneLayout::default(),
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
                pane_layout: WorkspacePaneLayout::default(),
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
                location_label: None,
                expected_file_hash: None,
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

    fn excerpt_input(
        document_id: &str,
        notebook_id: &str,
        parent_node_id: Option<&str>,
    ) -> CreateExcerptInput {
        CreateExcerptInput {
            document_id: document_id.to_owned(),
            notebook_id: notebook_id.to_owned(),
            anchor: txt_anchor(),
            excerpt_text: Some("excerpt".to_owned()),
            excerpt_image_png: None,
            color: "#fde047".to_owned(),
            parent_node_id: parent_node_id.map(str::to_owned),
            pos_x: 10.0,
            pos_y: 20.0,
            location_label: None,
            expected_file_hash: None,
        }
    }

    #[test]
    fn delete_card_removes_graph_atomically_reroots_children_and_restores_on_undo() {
        let mut db = Database::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("book.txt");
        std::fs::write(&file, "root middle leaf").unwrap();
        let doc = db.register_document(&file).unwrap();
        let notebook = db.create_notebook("Study").unwrap();

        let root = db
            .create_excerpt(&excerpt_input(&doc.id, &notebook.id, None))
            .unwrap();
        let middle = db
            .create_excerpt(&excerpt_input(&doc.id, &notebook.id, Some(&root.node.id)))
            .unwrap();
        let leaf = db
            .create_excerpt(&excerpt_input(&doc.id, &notebook.id, Some(&middle.node.id)))
            .unwrap();

        // Give `middle` custom notes, tags, layout, and an extra cross-link edge.
        let updated_middle = db
            .update_card(
                &middle.card.id,
                &CardPatch {
                    title: Some("Edited middle".to_owned()),
                    markdown_notes: Some("Important synthesis note".to_owned()),
                    tags: Some(vec!["key".to_owned(), "synthesis".to_owned()]),
                },
            )
            .unwrap();
        db.update_node_layout(
            &middle.node.id,
            &NodeLayoutPatch {
                pos_x: 123.5,
                pos_y: 456.25,
                is_collapsed: true,
            },
        )
        .unwrap();
        let cross_edge = db
            .create_edge(
                &notebook.id,
                &leaf.node.id,
                &middle.node.id,
                Some("supports"),
            )
            .unwrap();

        // Delete middle: removes middle card, middle node, and all 3 edges touching middle;
        // re-roots leaf (does not delete leaf); keeps middle's highlight in annotations.
        let deleted = db.delete_card(&middle.card.id).unwrap();
        assert_eq!(deleted.card_id, middle.card.id);
        assert_eq!(deleted.node_ids, vec![middle.node.id.clone()]);
        assert_eq!(deleted.rerooted_child_node_ids, vec![leaf.node.id.clone()]);
        assert_eq!(deleted.edge_ids.len(), 3);

        let graph = db.load_notebook_graph(&notebook.id).unwrap();
        assert_eq!(graph.annotations.len(), 3);
        assert!(
            graph
                .annotations
                .iter()
                .any(|a| a.id == middle.annotation.id)
        );
        assert_eq!(graph.cards.len(), 2);
        assert!(graph.cards.iter().all(|c| c.id != middle.card.id));
        assert_eq!(graph.nodes.len(), 2);
        let leaf_node = graph.nodes.iter().find(|n| n.id == leaf.node.id).unwrap();
        assert_eq!(leaf_node.parent_node_id, None);
        assert!(graph.edges.is_empty());

        // Deleting a nonexistent card returns a stable `not_found` error.
        let err = db.delete_card(&middle.card.id).unwrap_err();
        assert_eq!(err.code(), "not_found");

        // Undo brings back the card (with notes & tags), node (position, parent, collapsed),
        // edges (parent, child, cross-link), and re-attaches leaf's parent_node_id.
        let restored = db.restore_card(&middle.card.id).unwrap();
        assert_eq!(restored.card, updated_middle);
        assert_eq!(restored.nodes.len(), 1);
        assert_eq!(restored.nodes[0].id, middle.node.id);
        assert_eq!(restored.nodes[0].parent_node_id, Some(root.node.id.clone()));
        assert_eq!(restored.nodes[0].pos_x, 123.5);
        assert_eq!(restored.nodes[0].pos_y, 456.25);
        assert!(restored.nodes[0].is_collapsed);
        assert_eq!(restored.edges.len(), 3);
        assert!(
            restored
                .edges
                .iter()
                .any(|e| e.id == cross_edge.id && e.label.as_deref() == Some("supports"))
        );
        assert_eq!(restored.reparented_children.len(), 1);
        assert_eq!(restored.reparented_children[0].id, leaf.node.id);
        assert_eq!(
            restored.reparented_children[0].parent_node_id,
            Some(middle.node.id.clone())
        );

        let after_restore = db.load_notebook_graph(&notebook.id).unwrap();
        assert_eq!(after_restore.cards.len(), 3);
        assert_eq!(after_restore.nodes.len(), 3);
        assert_eq!(after_restore.edges.len(), 3);

        // Restoring again returns `not_found`.
        let err = db.restore_card(&middle.card.id).unwrap_err();
        assert_eq!(err.code(), "not_found");
    }

    #[test]
    fn delete_card_handles_source_removed_cards_and_purges_snapshots_on_relaunch() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("cards.sqlite3");
        let file = dir.path().join("book.txt");
        std::fs::write(&file, "orphaned source").unwrap();

        let (notebook_id, card_id) = {
            let mut db = Database::open(&db_path).unwrap();
            let doc = db.register_document(&file).unwrap();
            let notebook = db.create_notebook("Study").unwrap();
            let created = db
                .create_excerpt(&excerpt_input(&doc.id, &notebook.id, None))
                .unwrap();

            // Delete the highlight so the card becomes "Source removed".
            db.delete_annotation(&created.annotation.id).unwrap();
            let graph = db.load_notebook_graph(&notebook.id).unwrap();
            assert!(graph.cards[0].annotation_ids.is_empty());

            // Deleting the "Source removed" card succeeds.
            db.delete_card(&created.card.id).unwrap();
            let graph = db.load_notebook_graph(&notebook.id).unwrap();
            assert!(graph.cards.is_empty());
            assert!(graph.nodes.is_empty());

            // Undo within the same session restores the card, and then undoing the highlight
            // re-links it.
            let restored = db.restore_card(&created.card.id).unwrap();
            assert!(restored.card.annotation_ids.is_empty());
            let restored_ann = db.restore_annotation(&created.annotation.id).unwrap();
            assert_eq!(
                restored_ann.cards[0].annotation_ids,
                vec![created.annotation.id.clone()]
            );

            // Delete the card again and close the database without undoing.
            db.delete_card(&created.card.id).unwrap();
            (notebook.id, created.card.id)
        };

        // Reopening purges ephemeral card undo snapshots.
        let mut reopened = Database::open(&db_path).unwrap();
        let graph = reopened.load_notebook_graph(&notebook_id).unwrap();
        assert!(graph.cards.is_empty());
        assert_eq!(
            reopened.restore_card(&card_id).unwrap_err().code(),
            "not_found"
        );
    }

    #[test]
    fn workspace_session_persists_and_sanitizes_pane_layout() {
        let db = Database::open_in_memory().unwrap();
        let default_session = db.get_workspace_session().unwrap();
        assert_eq!(default_session.pane_layout, WorkspacePaneLayout::default());

        let saved = db
            .save_workspace_session(&WorkspaceSession {
                open_document_ids: vec![],
                active_document_id: None,
                immersive: false,
                pane_layout: WorkspacePaneLayout {
                    mind_map_open: true,
                    inspector_open: true,
                    mind_map_size: Some(42.5),
                    inspector_size: Some(24.0),
                },
            })
            .unwrap();
        assert!(saved.pane_layout.mind_map_open);
        assert!(saved.pane_layout.inspector_open);
        assert_eq!(saved.pane_layout.mind_map_size, Some(42.5));
        assert_eq!(saved.pane_layout.inspector_size, Some(24.0));
        assert_eq!(db.get_workspace_session().unwrap(), saved);

        // Out-of-range widths are dropped rather than collapsing the reader.
        let sanitized = db
            .save_workspace_session(&WorkspaceSession {
                open_document_ids: vec![],
                active_document_id: None,
                immersive: true,
                pane_layout: WorkspacePaneLayout {
                    mind_map_open: true,
                    inspector_open: false,
                    mind_map_size: Some(10.0),
                    inspector_size: Some(95.0),
                },
            })
            .unwrap();
        assert_eq!(sanitized.pane_layout.mind_map_size, None);
        assert_eq!(sanitized.pane_layout.inspector_size, None);
        assert!(sanitized.immersive);
    }

    #[test]
    fn staged_hash_commits_recheck_format_and_hash_collisions_under_transaction() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(&dir.path().join("staged.sqlite3")).unwrap();

        let unsupported = dir.path().join("archive.zip");
        std::fs::write(&unsupported, "zip").unwrap();
        assert!(matches!(
            db.register_document_with_hash(&unsupported, "deadbeef"),
            Err(CoreError::UnsupportedFormat(_))
        ));

        let first_path = dir.path().join("first.txt");
        let second_path = dir.path().join("second.txt");
        let replacement_path = dir.path().join("replacement.txt");
        let wrong_format_path = dir.path().join("other.pdf");
        std::fs::write(&first_path, "first content").unwrap();
        std::fs::write(&second_path, "second content").unwrap();
        std::fs::write(&replacement_path, "replacement content").unwrap();
        std::fs::write(&wrong_format_path, "pdf bytes").unwrap();

        let first_hash = hash_document_for_registration(&first_path).unwrap();
        let first = db
            .register_document_with_hash(&first_path, &first_hash)
            .unwrap();
        assert_eq!(first.file_hash, first_hash);

        // Compute hash for `replacement_path` outside the DB, then simulate another
        // registration winning the race with the same content before commit.
        let replacement_hash = hash_document_for_relink(first.format, &replacement_path).unwrap();
        let _raced = db
            .register_document_with_hash(&replacement_path, &replacement_hash)
            .unwrap();

        assert!(matches!(
            db.relink_document_with_hash(&first.id, &replacement_path, &replacement_hash),
            Err(CoreError::InvalidGraph(_))
        ));
        assert!(matches!(
            db.relink_document_with_hash(&first.id, &wrong_format_path, "anyhash"),
            Err(CoreError::UnsupportedFormat(_))
        ));
        // Original record remains untouched after failed relink commits.
        assert_eq!(db.get_document(&first.id).unwrap().file_hash, first_hash);

        // Valid staged relink commits cleanly.
        let second_hash = hash_document_for_relink(first.format, &second_path).unwrap();
        let relinked = db
            .relink_document_with_hash(&first.id, &second_path, &second_hash)
            .unwrap();
        assert!(relinked.content_changed);
        assert_eq!(relinked.document.file_hash, second_hash);
        assert_eq!(relinked.document.title, "second");

        // Lock-free file verification matches the committed record.
        let verified = verify_document_file(&relinked.document).unwrap();
        assert_eq!(verified.state, DocumentSourceState::Ok);
        assert_eq!(
            verified.current_file_hash.as_deref(),
            Some(second_hash.as_str())
        );
    }

    #[test]
    fn import_document_creates_with_sanitized_title_null_last_opened_and_preserves_md_r2_01() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("synapse.sqlite3");
        let mut db = Database::open(&db_path).unwrap();
        let lib = db.managed_library().unwrap().clone();

        let bytes = b"# Research Notes\nHello world\n";
        let hash = hash_file(&{
            let tmp = dir.path().join("seed.md");
            std::fs::write(&tmp, bytes).unwrap();
            tmp
        })
        .unwrap();

        let mut staged = lib
            .begin_stage(DocumentFormat::Txt, "md", &hash, bytes.len() as u64)
            .unwrap();
        staged.write_chunk(bytes).unwrap();
        let managed_path = staged.finish().unwrap();
        assert!(managed_path.ends_with(format!("{hash}.md")));

        let result = db
            .import_document(
                &managed_path,
                &hash,
                " \u{202E}Research Notes\u{0007} ",
                DocumentFormat::Txt,
            )
            .unwrap();
        let ImportDocumentResult::Created(doc) = result else {
            panic!("expected Created, got {result:?}");
        };
        assert_eq!(doc.title, "Research Notes");
        assert_ne!(doc.title, hash);
        assert_eq!(doc.format, DocumentFormat::Txt);
        assert_eq!(doc.file_path, managed_path.to_string_lossy());
        assert_eq!(doc.last_opened_at, None);
    }

    #[test]
    fn import_document_leaves_healthy_record_untouched_t21() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(&dir.path().join("synapse.sqlite3")).unwrap();

        let original_path = dir.path().join("original.txt");
        std::fs::write(&original_path, "healthy local content").unwrap();
        let original = db.register_document(&original_path).unwrap();
        assert!(original.last_opened_at.is_some());

        let cursor = AnchorLocation::Txt {
            start_byte_offset: 0,
            end_byte_offset: 7,
            line_index: 0,
        };
        db.update_document_cursor(&original.id, &cursor, Some(0.4))
            .unwrap();

        let managed_copy = dir
            .path()
            .join("library")
            .join(format!("{}.txt", original.file_hash));
        std::fs::create_dir_all(managed_copy.parent().unwrap()).unwrap();
        std::fs::write(&managed_copy, "healthy local content").unwrap();

        let result = db
            .import_document(
                &managed_copy,
                &original.file_hash,
                "Peer Title Should Not Overwrite",
                DocumentFormat::Txt,
            )
            .unwrap();
        let ImportDocumentResult::AlreadyPresent(returned) = result else {
            panic!("expected AlreadyPresent, got {result:?}");
        };
        assert_eq!(returned.id, original.id);
        assert_eq!(returned.file_path, original.file_path);
        assert_eq!(returned.title, original.title);
        assert_eq!(returned.last_opened_at, original.last_opened_at);
        assert_eq!(returned.last_cursor_anchor, Some(cursor));
        assert_eq!(returned.last_progress, Some(0.4));
    }

    #[test]
    fn import_document_repairs_missing_file_without_dropping_study_records_t23() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(&dir.path().join("synapse.sqlite3")).unwrap();

        let original_path = dir.path().join("missing-soon.md");
        std::fs::write(&original_path, "# My Book\nChapter 1\n").unwrap();
        let original = db.register_document(&original_path).unwrap();
        let notebook = db.create_notebook("Notes").unwrap();

        let cursor = AnchorLocation::Txt {
            start_byte_offset: 0,
            end_byte_offset: 9,
            line_index: 0,
        };
        db.update_document_cursor(&original.id, &cursor, Some(0.25))
            .unwrap();
        let bookmark = db
            .create_bookmark(&CreateBookmarkInput {
                document_id: original.id.clone(),
                anchor: cursor.clone(),
                label: Some("Start".to_owned()),
            })
            .unwrap();
        let excerpt = db
            .create_excerpt(&CreateExcerptInput {
                document_id: original.id.clone(),
                notebook_id: notebook.id.clone(),
                anchor: cursor.clone(),
                excerpt_text: Some("My Book".to_owned()),
                excerpt_image_png: None,
                color: "#fde68a".to_owned(),
                parent_node_id: None,
                pos_x: 10.0,
                pos_y: 20.0,
                location_label: None,
                expected_file_hash: None,
            })
            .unwrap();

        // Remove the original file so the local record is now Missing.
        std::fs::remove_file(&original_path).unwrap();

        let replacement_path = dir
            .path()
            .join("library")
            .join(format!("{}.md", original.file_hash));
        std::fs::create_dir_all(replacement_path.parent().unwrap()).unwrap();
        std::fs::write(&replacement_path, "# My Book\nChapter 1\n").unwrap();

        let result = db
            .import_document(
                &replacement_path,
                &original.file_hash,
                "Different Peer Title",
                DocumentFormat::Txt,
            )
            .unwrap();
        let ImportDocumentResult::Repaired(repaired) = result else {
            panic!("expected Repaired, got {result:?}");
        };

        assert_eq!(repaired.id, original.id);
        assert_eq!(repaired.file_path, replacement_path.to_string_lossy());
        assert_eq!(repaired.title, original.title);
        assert_eq!(repaired.format, original.format);
        assert_eq!(repaired.last_opened_at, original.last_opened_at);
        assert_eq!(repaired.last_cursor_anchor, Some(cursor));
        assert_eq!(repaired.last_progress, Some(0.25));

        // Bookmarks, annotations, and cards stay attached.
        let bookmarks = db.list_bookmarks().unwrap();
        assert_eq!(bookmarks.len(), 1);
        assert_eq!(bookmarks[0].id, bookmark.id);
        let graph = db.load_notebook_graph(&notebook.id).unwrap();
        assert_eq!(graph.annotations.len(), 1);
        assert_eq!(graph.annotations[0].id, excerpt.annotation.id);
        assert_eq!(graph.cards.len(), 1);
        assert_eq!(graph.cards[0].id, excerpt.card.id);
    }

    #[test]
    fn import_document_resolves_file_hash_unique_races_cleanly_t26() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("race.sqlite3");
        let mut db = Database::open(&db_path).unwrap();

        let file_path = dir.path().join("shared.txt");
        std::fs::write(&file_path, "race content").unwrap();
        let hash = hash_file(&file_path).unwrap();

        let first = db
            .import_document(&file_path, &hash, "Shared Book", DocumentFormat::Txt)
            .unwrap();
        let ImportDocumentResult::Created(first_doc) = first else {
            panic!("expected Created");
        };

        // Deterministic simulation of a concurrent writer winning between SELECT and INSERT.
        let race_result =
            insert_imported_document_row(&db.conn, &file_path, &hash, "Raced", DocumentFormat::Txt)
                .unwrap();
        let ImportDocumentResult::AlreadyPresent(raced_doc) = race_result else {
            panic!("expected AlreadyPresent on UNIQUE race, got {race_result:?}");
        };
        assert_eq!(raced_doc.id, first_doc.id);

        // Multi-threaded race against the same on-disk SQLite database.
        let file2 = dir.path().join("concurrent.txt");
        std::fs::write(&file2, "concurrent content").unwrap();
        let hash2 = hash_file(&file2).unwrap();

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let mut handles = Vec::new();
        for idx in 0..2 {
            let db_path = db_path.clone();
            let file2 = file2.clone();
            let hash2 = hash2.clone();
            let barrier = std::sync::Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                let mut thread_db = Database::open(&db_path).unwrap();
                barrier.wait();
                thread_db
                    .import_document(&file2, &hash2, &format!("Book {idx}"), DocumentFormat::Txt)
                    .unwrap()
            }));
        }
        let outcomes: Vec<ImportDocumentResult> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        let created_count = outcomes
            .iter()
            .filter(|res| matches!(res, ImportDocumentResult::Created(_)))
            .count();
        let already_count = outcomes
            .iter()
            .filter(|res| matches!(res, ImportDocumentResult::AlreadyPresent(_)))
            .count();
        assert_eq!(created_count, 1);
        assert_eq!(already_count, 1);
        assert_eq!(outcomes[0].document().id, outcomes[1].document().id);
    }

    #[test]
    fn export_reads_omit_file_path_and_last_opened_at_t14() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(&dir.path().join("export.sqlite3")).unwrap();

        let secret_path = dir.path().join("private-notes.md");
        std::fs::write(&secret_path, "# Secret\nLine 2\n").unwrap();
        let doc = db.register_document(&secret_path).unwrap();
        assert!(doc.last_opened_at.is_some());

        let cursor = AnchorLocation::Txt {
            start_byte_offset: 0,
            end_byte_offset: 8,
            line_index: 0,
        };
        db.update_document_cursor(&doc.id, &cursor, Some(0.5))
            .unwrap();
        db.create_bookmark(&CreateBookmarkInput {
            document_id: doc.id.clone(),
            anchor: cursor.clone(),
            label: Some("Intro".to_owned()),
        })
        .unwrap();

        let catalog = db.export_catalog_books().unwrap();
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].document_id, doc.id);
        assert_eq!(catalog[0].file_hash, doc.file_hash);
        assert_eq!(catalog[0].format, DocumentFormat::Txt);
        assert_eq!(catalog[0].extension, "md");
        assert!(catalog[0].has_position);
        assert_eq!(catalog[0].bookmark_count, 1);

        let position = db.export_document_position(&doc.id).unwrap().unwrap();
        assert_eq!(position.anchor, cursor);
        assert_eq!(position.progress, Some(0.5));

        let bookmarks = db.export_document_bookmarks(&doc.id).unwrap();
        assert_eq!(bookmarks.len(), 1);
        assert_eq!(bookmarks[0].label, "Intro");
        assert_eq!(bookmarks[0].anchor, cursor);

        // Verify serialized export payloads never leak local paths or last_opened_at.
        let catalog_json = serde_json::to_string(&catalog).unwrap();
        let position_json = serde_json::to_string(&position).unwrap();
        let bookmarks_json = serde_json::to_string(&bookmarks).unwrap();
        for payload in [&catalog_json, &position_json, &bookmarks_json] {
            assert!(!payload.contains("filePath"));
            assert!(!payload.contains("file_path"));
            assert!(!payload.contains("lastOpenedAt"));
            assert!(!payload.contains("last_opened_at"));
            assert!(!payload.contains("private-notes.md"));
        }

        assert!(matches!(
            db.export_document_position("missing-id"),
            Err(CoreError::NotFound { .. })
        ));
        assert!(matches!(
            db.export_document_bookmarks("missing-id"),
            Err(CoreError::NotFound { .. })
        ));
    }

    #[test]
    fn sole_connection_reconciliation_protects_concurrent_instance_r3_01_r3_08() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("synapse.sqlite3");

        let mut first = Database::open(&db_path).unwrap();
        assert!(first.is_sole_connection());
        let lib = first.managed_library().unwrap().clone();

        // Simulate an active transfer (.part) and a freshly published file not yet committed,
        // plus a committed `.md` file and an unreferenced `.txt` file sharing the same hash.
        let bytes = b"# Sole connection test";
        let hash = hash_file(&{
            let seed = dir.path().join("seed.md");
            std::fs::write(&seed, bytes).unwrap();
            seed
        })
        .unwrap();

        let mut staged_md = lib
            .begin_stage(DocumentFormat::Txt, "md", &hash, bytes.len() as u64)
            .unwrap();
        staged_md.write_chunk(bytes).unwrap();
        let kept_md = staged_md.finish().unwrap();
        first
            .import_document(&kept_md, &hash, "Kept Markdown", DocumentFormat::Txt)
            .unwrap();

        let unreferenced_txt = lib.library_dir().join(format!("{hash}.txt"));
        std::fs::write(&unreferenced_txt, bytes).unwrap();

        std::fs::create_dir_all(lib.staging_dir()).unwrap();
        let in_flight_part = lib.staging_dir().join("in-flight.part");
        std::fs::write(&in_flight_part, b"partial").unwrap();

        // Opening a second connection while `first` is alive must NOT reconcile.
        {
            let second = Database::open(&db_path).unwrap();
            assert!(!second.is_sole_connection());
            assert!(in_flight_part.exists());
            assert!(unreferenced_txt.exists());
            assert!(kept_md.exists());
        }

        // Once all connections close, the next sole-connection open reconciles cleanly.
        drop(first);
        let reopened = Database::open(&db_path).unwrap();
        assert!(reopened.is_sole_connection());
        assert!(!in_flight_part.exists());
        assert!(!unreferenced_txt.exists());
        assert!(kept_md.exists());
    }

    #[cfg(unix)]
    #[test]
    fn database_open_does_not_traverse_symlinked_sync_staging_directory_t19() {
        let app_data = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let external_file = external.path().join("do-not-delete.txt");
        std::fs::write(&external_file, b"precious user file").unwrap();

        std::os::unix::fs::symlink(external.path(), app_data.path().join("sync-staging")).unwrap();

        let db = Database::open(&app_data.path().join("synapse.sqlite3")).unwrap();
        assert!(db.is_sole_connection());
        assert!(external_file.exists());
        assert_eq!(
            std::fs::read(&external_file).unwrap(),
            b"precious user file"
        );
    }

    #[cfg(unix)]
    #[test]
    fn database_open_does_not_traverse_symlinked_library_directory_t19() {
        let app_data = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let external_file = external.path().join("do-not-delete.pdf");
        std::fs::write(&external_file, b"%PDF-1.7 precious").unwrap();

        std::os::unix::fs::symlink(external.path(), app_data.path().join("library")).unwrap();

        let db = Database::open(&app_data.path().join("synapse.sqlite3")).unwrap();
        assert!(db.is_sole_connection());
        assert!(external_file.exists());
        assert_eq!(std::fs::read(&external_file).unwrap(), b"%PDF-1.7 precious");
    }

    #[test]
    fn hide_document_from_recent_persists_preserves_study_records_and_clears_on_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("recent-hide.sqlite3");
        let file = dir.path().join("study.txt");
        std::fs::write(&file, "hello study world").unwrap();

        let (doc_id, annotation_id, bookmark_id, card_id, notebook_id) = {
            let mut db = Database::open(&db_path).unwrap();
            let doc = db.register_document(&file).unwrap();
            assert_eq!(doc.hidden_from_recent_at, None);

            db.update_document_cursor(&doc.id, &txt_anchor(), Some(0.4))
                .unwrap();
            let notebook = db.create_notebook("Study").unwrap();
            let created = db
                .create_excerpt(&CreateExcerptInput {
                    document_id: doc.id.clone(),
                    notebook_id: notebook.id.clone(),
                    anchor: txt_anchor(),
                    excerpt_text: Some("hello".to_owned()),
                    excerpt_image_png: None,
                    color: "#fde047".to_owned(),
                    parent_node_id: None,
                    pos_x: 10.0,
                    pos_y: 20.0,
                    location_label: None,
                    expected_file_hash: None,
                })
                .unwrap();
            let bookmark = db
                .create_bookmark(&CreateBookmarkInput {
                    document_id: doc.id.clone(),
                    anchor: txt_anchor(),
                    label: Some("Start".to_owned()),
                })
                .unwrap();

            let hidden = db.hide_document_from_recent(&doc.id).unwrap();
            assert!(hidden.hidden_from_recent_at.is_some());

            // list_documents keeps the row and all study records stay untouched.
            let docs = db.list_documents().unwrap();
            assert_eq!(docs.len(), 1);
            assert_eq!(docs[0].hidden_from_recent_at, hidden.hidden_from_recent_at);
            assert_eq!(docs[0].last_cursor_anchor, Some(txt_anchor()));
            assert_eq!(docs[0].last_progress, Some(0.4));

            let graph = db.load_notebook_graph(&notebook.id).unwrap();
            assert_eq!(graph.annotations.len(), 1);
            assert_eq!(graph.annotations[0].id, created.annotation.id);
            assert_eq!(graph.cards.len(), 1);
            assert_eq!(graph.cards[0].id, created.card.id);
            let bookmarks = db.list_bookmarks().unwrap();
            assert_eq!(bookmarks.len(), 1);
            assert_eq!(bookmarks[0].id, bookmark.id);

            (
                doc.id,
                created.annotation.id,
                bookmark.id,
                created.card.id,
                notebook.id,
            )
        };

        // Flag persists across database reopen and study records remain intact.
        let mut reopened = Database::open(&db_path).unwrap();
        let docs = reopened.list_documents().unwrap();
        assert_eq!(docs.len(), 1);
        assert!(docs[0].hidden_from_recent_at.is_some());
        let graph = reopened.load_notebook_graph(&notebook_id).unwrap();
        assert_eq!(graph.annotations.len(), 1);
        assert_eq!(graph.annotations[0].id, annotation_id);
        assert_eq!(graph.cards.len(), 1);
        assert_eq!(graph.cards[0].id, card_id);
        let bookmarks = reopened.list_bookmarks().unwrap();
        assert_eq!(bookmarks.len(), 1);
        assert_eq!(bookmarks[0].id, bookmark_id);

        // touch_document_opened clears the flag.
        let touched = reopened.touch_document_opened(&doc_id).unwrap();
        assert_eq!(touched.hidden_from_recent_at, None);

        // Hiding again, then re-registering the same file clears the flag.
        let hidden_again = reopened.hide_document_from_recent(&doc_id).unwrap();
        assert!(hidden_again.hidden_from_recent_at.is_some());
        let registered_again = reopened.register_document(&file).unwrap();
        assert_eq!(registered_again.id, doc_id);
        assert_eq!(registered_again.hidden_from_recent_at, None);

        // Hiding again, then relinking clears the flag.
        let hidden_before_relink = reopened.hide_document_from_recent(&doc_id).unwrap();
        assert!(hidden_before_relink.hidden_from_recent_at.is_some());
        let moved = dir.path().join("study-moved.txt");
        std::fs::rename(&file, &moved).unwrap();
        let relinked = reopened.relink_document(&doc_id, &moved).unwrap();
        assert_eq!(relinked.document.hidden_from_recent_at, None);

        // Unknown document id returns NotFound.
        assert!(matches!(
            reopened.hide_document_from_recent("missing-document"),
            Err(CoreError::NotFound {
                entity: "document",
                ..
            })
        ));
    }

    #[test]
    fn set_document_display_title_sanitizes_persists_and_clears_only_on_content_relink() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("display-titles.sqlite3");
        let file = dir.path().join("pg1342-images-3.txt");
        std::fs::write(&file, "It is a truth universally acknowledged.").unwrap();

        let (doc_id, original_hash) = {
            let db = Database::open(&db_path).unwrap();
            let doc = db.register_document(&file).unwrap();
            assert_eq!(doc.title, "pg1342-images-3");
            assert_eq!(doc.display_title, None);

            // Sanitizes controls, bidi formatting, and multiline input; preserves file stem `title`.
            let updated = db
                .set_document_display_title(
                    &doc.id,
                    Some("\n\x00\u{202E}  Pride and\u{2066} Prejudice \x1F\nSecond Line"),
                    &doc.file_hash,
                )
                .unwrap()
                .unwrap();
            assert_eq!(updated.title, "pg1342-images-3");
            assert_eq!(
                updated.display_title.as_deref(),
                Some("Pride and Prejudice")
            );

            // Truncates at 512 chars with ellipsis.
            let long_title = "书".repeat(600);
            let truncated = db
                .set_document_display_title(&doc.id, Some(&long_title), &doc.file_hash)
                .unwrap()
                .unwrap();
            let stored = truncated.display_title.as_deref().unwrap();
            assert_eq!(stored.chars().count(), 512);
            assert!(stored.ends_with('…'));

            // Whitespace / controls-only becomes None (NULL).
            let blank = db
                .set_document_display_title(&doc.id, Some(" \n\u{202E}\x00 "), &doc.file_hash)
                .unwrap()
                .unwrap();
            assert_eq!(blank.display_title, None);

            // Setting back to a meaningful title persists across reopen.
            db.set_document_display_title(&doc.id, Some("Pride and Prejudice"), &doc.file_hash)
                .unwrap()
                .unwrap();

            // Mismatched hash returns Ok(None) and leaves display_title untouched.
            let mismatch = db
                .set_document_display_title(&doc.id, Some("Wrong Source"), "deadbeef")
                .unwrap();
            assert_eq!(mismatch, None);
            assert_eq!(
                db.get_document(&doc.id).unwrap().display_title.as_deref(),
                Some("Pride and Prejudice")
            );

            (doc.id, doc.file_hash)
        };

        let mut reopened = Database::open(&db_path).unwrap();
        let loaded = reopened.get_document(&doc_id).unwrap();
        assert_eq!(loaded.title, "pg1342-images-3");
        assert_eq!(loaded.display_title.as_deref(), Some("Pride and Prejudice"));

        // Same-hash relink (moved/renamed file) keeps `display_title`.
        let moved = dir.path().join("renamed-file.txt");
        std::fs::rename(&file, &moved).unwrap();
        let same_hash = reopened.relink_document(&doc_id, &moved).unwrap();
        assert!(!same_hash.content_changed);
        assert_eq!(same_hash.document.title, "renamed-file");
        assert_eq!(
            same_hash.document.display_title.as_deref(),
            Some("Pride and Prejudice")
        );

        // Content-changing relink clears `display_title`, and stale hash write returns None.
        std::fs::write(&moved, "A different edition with different bytes.").unwrap();
        let changed = reopened.relink_document(&doc_id, &moved).unwrap();
        assert!(changed.content_changed);
        assert_eq!(changed.document.display_title, None);
        let stale_write = reopened
            .set_document_display_title(&doc_id, Some("Old Edition Title"), &original_hash)
            .unwrap();
        assert_eq!(stale_write, None);
        assert_eq!(reopened.get_document(&doc_id).unwrap().display_title, None);

        // Passing None explicitly clears `display_title`.
        reopened
            .set_document_display_title(
                &doc_id,
                Some("Temporary Title"),
                &changed.document.file_hash,
            )
            .unwrap()
            .unwrap();
        let cleared = reopened
            .set_document_display_title(&doc_id, None, &changed.document.file_hash)
            .unwrap()
            .unwrap();
        assert_eq!(cleared.display_title, None);

        // Unknown document id returns NotFound.
        assert!(matches!(
            reopened.set_document_display_title("missing-doc", Some("Title"), "deadbeef"),
            Err(CoreError::NotFound {
                entity: "document",
                ..
            })
        ));
    }

    #[test]
    fn annotation_location_label_sanitizes_persists_names_captures_and_migrates() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("location-labels.sqlite3");

        // 1. Seed a schema-v17 database with a pre-existing annotation (no location_label column).
        {
            let mut conn = Connection::open(&db_path).unwrap();
            for (version, sql) in (1_u32..).zip(&MIGRATIONS[..17]) {
                let tx = conn.transaction().unwrap();
                tx.execute_batch(sql).unwrap();
                tx.pragma_update(None, "user_version", version).unwrap();
                tx.commit().unwrap();
            }
            conn.execute(
                "INSERT INTO documents (id, title, file_path, file_hash, format, encoding)
                 VALUES ('doc-old', 'old-book', '/tmp/old-book.txt', 'hash-old', 'txt', 'utf-8')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO study_notebooks (id, title) VALUES ('nb-1', 'Study')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO annotations (id, document_id, notebook_id, anchor_type, anchor_payload_json, excerpt_text, color)
                 VALUES ('ann-old', 'doc-old', 'nb-1', 'txt',
                     '{\"format\":\"txt\",\"startByteOffset\":0,\"endByteOffset\":4,\"lineIndex\":0}',
                     'legacy excerpt', '#fde047')",
                [],
            )
            .unwrap();
        }

        // 2. Opening migrates to the latest schema and reads legacy annotations with `location_label: None`.
        let mut db = Database::open(&db_path).unwrap();
        assert_eq!(db.schema_version().unwrap() as usize, MIGRATIONS.len());
        let initial_graph = db.load_notebook_graph("nb-1").unwrap();
        assert_eq!(initial_graph.annotations.len(), 1);
        assert_eq!(initial_graph.annotations[0].id, "ann-old");
        assert_eq!(initial_graph.annotations[0].location_label, None);

        // 3. New excerpts sanitize control chars / newlines and cap length.
        let txt_file = dir.path().join("notes.txt");
        std::fs::write(&txt_file, "hello world").unwrap();
        let txt_doc = db.register_document(&txt_file).unwrap();
        let long_label = format!("  \u{202E}{}\nsecond line", "章".repeat(200));
        let excerpt = db
            .create_excerpt(&CreateExcerptInput {
                document_id: txt_doc.id.clone(),
                notebook_id: "nb-1".to_owned(),
                anchor: txt_anchor(),
                excerpt_text: Some("hello".to_owned()),
                excerpt_image_png: None,
                color: "#fde047".to_owned(),
                parent_node_id: None,
                pos_x: 0.0,
                pos_y: 0.0,
                location_label: Some(long_label),
                expected_file_hash: None,
            })
            .unwrap();
        let stored_label = excerpt.annotation.location_label.as_deref().unwrap();
        assert_eq!(stored_label.chars().count(), LOCATION_LABEL_MAX_CHARS);
        assert!(stored_label.ends_with('…'));
        assert!(!stored_label.contains('\u{202E}'));

        // Blank / control-only labels normalize to None.
        let blank_ann = db
            .create_annotation(&CreateAnnotationInput {
                document_id: txt_doc.id.clone(),
                notebook_id: "nb-1".to_owned(),
                anchor: txt_anchor(),
                excerpt_text: Some("hello".to_owned()),
                excerpt_image_png: None,
                note: None,
                color: "#fde047".to_owned(),
                style: AnnotationStyle::Highlight,
                location_label: Some("  \u{0007}\t\n  ".to_owned()),
                expected_file_hash: None,
            })
            .unwrap();
        assert_eq!(blank_ann.location_label, None);

        // 4. Captures use `"Figure · <label>"` when location_label is present, else `"Image excerpt"`.
        let pdf_file = dir.path().join("book.pdf");
        std::fs::write(&pdf_file, "pdf bytes").unwrap();
        let pdf_doc = db.register_document(&pdf_file).unwrap();
        let pdf_anchor = AnchorLocation::Pdf {
            page_index: 11,
            rects: vec![NormalizedRect {
                x: 0.1,
                y: 0.1,
                width: 0.4,
                height: 0.3,
            }],
            page_spans: None,
        };
        let capture_with_label = db
            .create_excerpt(&CreateExcerptInput {
                document_id: pdf_doc.id.clone(),
                notebook_id: "nb-1".to_owned(),
                anchor: pdf_anchor.clone(),
                excerpt_text: None,
                excerpt_image_png: Some(PNG_BASE64.to_owned()),
                color: "#fde047".to_owned(),
                parent_node_id: None,
                pos_x: 10.0,
                pos_y: 20.0,
                location_label: Some("p. 12".to_owned()),
                expected_file_hash: None,
            })
            .unwrap();
        assert_eq!(capture_with_label.card.title, "Figure · p. 12");
        assert_eq!(
            capture_with_label.annotation.location_label.as_deref(),
            Some("p. 12")
        );

        let capture_without_label = db
            .create_excerpt(&CreateExcerptInput {
                document_id: pdf_doc.id.clone(),
                notebook_id: "nb-1".to_owned(),
                anchor: pdf_anchor,
                excerpt_text: None,
                excerpt_image_png: Some(PNG_BASE64.to_owned()),
                color: "#fde047".to_owned(),
                parent_node_id: None,
                pos_x: 30.0,
                pos_y: 40.0,
                location_label: None,
                expected_file_hash: None,
            })
            .unwrap();
        assert_eq!(capture_without_label.card.title, "Image excerpt");
        assert_eq!(capture_without_label.annotation.location_label, None);

        // 5. Soft-delete + restore preserves location_label.
        db.delete_annotation(&capture_with_label.annotation.id)
            .unwrap();
        let restored = db
            .restore_annotation(&capture_with_label.annotation.id)
            .unwrap();
        assert_eq!(restored.annotation.location_label.as_deref(), Some("p. 12"));
    }

    #[test]
    fn relink_clears_annotation_location_labels_only_when_content_changes() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("relink-locations.sqlite3");
        let original = dir.path().join("original.txt");
        let other = dir.path().join("other.txt");
        std::fs::write(&original, "Old chapter\nLine one\nLine two\n").unwrap();
        std::fs::write(&other, "Unrelated book content\n").unwrap();

        let (doc_id, nb_id, active_id, deleted_id, other_ann_id) = {
            let mut db = Database::open(&db_path).unwrap();
            let doc = db.register_document(&original).unwrap();
            let other_doc = db.register_document(&other).unwrap();
            let nb = db.create_notebook("Study").unwrap();

            let active = db
                .create_excerpt(&CreateExcerptInput {
                    document_id: doc.id.clone(),
                    notebook_id: nb.id.clone(),
                    anchor: txt_anchor(),
                    excerpt_text: Some("Old chapter".to_owned()),
                    excerpt_image_png: None,
                    color: "#fde047".to_owned(),
                    parent_node_id: None,
                    pos_x: 0.0,
                    pos_y: 0.0,
                    location_label: Some("Old chapter · Line 1".to_owned()),
                    expected_file_hash: None,
                })
                .unwrap();
            let to_delete = db
                .create_excerpt(&CreateExcerptInput {
                    document_id: doc.id.clone(),
                    notebook_id: nb.id.clone(),
                    anchor: txt_anchor(),
                    excerpt_text: Some("Line one".to_owned()),
                    excerpt_image_png: None,
                    color: "#fde047".to_owned(),
                    parent_node_id: None,
                    pos_x: 10.0,
                    pos_y: 20.0,
                    location_label: Some("Old chapter · Line 2".to_owned()),
                    expected_file_hash: None,
                })
                .unwrap();
            let other_excerpt = db
                .create_excerpt(&CreateExcerptInput {
                    document_id: other_doc.id.clone(),
                    notebook_id: nb.id.clone(),
                    anchor: txt_anchor(),
                    excerpt_text: Some("Unrelated".to_owned()),
                    excerpt_image_png: None,
                    color: "#fde047".to_owned(),
                    parent_node_id: None,
                    pos_x: 30.0,
                    pos_y: 40.0,
                    location_label: Some("Other · Line 1".to_owned()),
                    expected_file_hash: None,
                })
                .unwrap();

            // Soft-delete one annotation before relinking.
            db.delete_annotation(&to_delete.annotation.id).unwrap();

            // 1. Same-hash rename preserves location_label on active and soft-deleted rows.
            let renamed = dir.path().join("renamed.txt");
            std::fs::rename(&original, &renamed).unwrap();
            let same_hash = db.relink_document(&doc.id, &renamed).unwrap();
            assert!(!same_hash.content_changed);
            let after_rename = db.load_notebook_graph(&nb.id).unwrap();
            assert_eq!(
                after_rename
                    .annotations
                    .iter()
                    .find(|a| a.id == active.annotation.id)
                    .unwrap()
                    .location_label
                    .as_deref(),
                Some("Old chapter · Line 1")
            );

            // 2. Content-changing relink clears location_label for this document (including soft-deleted),
            //    leaving unrelated documents untouched.
            let revised = dir.path().join("revised.txt");
            std::fs::write(&revised, "Completely rewritten edition.\n").unwrap();
            let changed = db.relink_document(&doc.id, &revised).unwrap();
            assert!(changed.content_changed);

            let after_change = db.load_notebook_graph(&nb.id).unwrap();
            assert_eq!(
                after_change
                    .annotations
                    .iter()
                    .find(|a| a.id == active.annotation.id)
                    .unwrap()
                    .location_label,
                None
            );
            assert_eq!(
                after_change
                    .annotations
                    .iter()
                    .find(|a| a.id == other_excerpt.annotation.id)
                    .unwrap()
                    .location_label
                    .as_deref(),
                Some("Other · Line 1")
            );

            // Restoring the soft-deleted annotation after content-changing relink returns None.
            let restored = db.restore_annotation(&to_delete.annotation.id).unwrap();
            assert_eq!(restored.annotation.location_label, None);

            (
                doc.id,
                nb.id,
                active.annotation.id,
                to_delete.annotation.id,
                other_excerpt.annotation.id,
            )
        };

        // 3. Reopening the database preserves the cleared labels and the unrelated doc's label.
        let reopened = Database::open(&db_path).unwrap();
        assert_eq!(reopened.get_document(&doc_id).unwrap().title, "revised");
        let graph = reopened.load_notebook_graph(&nb_id).unwrap();
        assert_eq!(
            graph
                .annotations
                .iter()
                .find(|a| a.id == active_id)
                .unwrap()
                .location_label,
            None
        );
        assert_eq!(
            graph
                .annotations
                .iter()
                .find(|a| a.id == deleted_id)
                .unwrap()
                .location_label,
            None
        );
        assert_eq!(
            graph
                .annotations
                .iter()
                .find(|a| a.id == other_ann_id)
                .unwrap()
                .location_label
                .as_deref(),
            Some("Other · Line 1")
        );

        // 4. Stale expected_file_hash is rejected in both create_excerpt and create_annotation.
        let mut reopened_mut = reopened;
        let current_hash = reopened_mut.get_document(&doc_id).unwrap().file_hash;
        assert!(matches!(
            reopened_mut.create_excerpt(&CreateExcerptInput {
                document_id: doc_id.clone(),
                notebook_id: nb_id.clone(),
                anchor: txt_anchor(),
                excerpt_text: Some("stale".to_owned()),
                excerpt_image_png: None,
                color: "#fde047".to_owned(),
                parent_node_id: None,
                pos_x: 0.0,
                pos_y: 0.0,
                location_label: Some("Old chapter · Line 1".to_owned()),
                expected_file_hash: Some("stale-hash".to_owned()),
            }),
            Err(CoreError::InvalidAnchor(_))
        ));
        assert!(matches!(
            reopened_mut.create_annotation(&CreateAnnotationInput {
                document_id: doc_id.clone(),
                notebook_id: nb_id.clone(),
                anchor: txt_anchor(),
                excerpt_text: Some("stale".to_owned()),
                excerpt_image_png: None,
                note: None,
                color: "#fde047".to_owned(),
                style: AnnotationStyle::Highlight,
                location_label: Some("Old chapter · Line 1".to_owned()),
                expected_file_hash: Some("stale-hash".to_owned()),
            }),
            Err(CoreError::InvalidAnchor(_))
        ));
        // Matching expected_file_hash succeeds.
        let fresh = reopened_mut
            .create_excerpt(&CreateExcerptInput {
                document_id: doc_id,
                notebook_id: nb_id,
                anchor: txt_anchor(),
                excerpt_text: Some("fresh".to_owned()),
                excerpt_image_png: None,
                color: "#fde047".to_owned(),
                parent_node_id: None,
                pos_x: 0.0,
                pos_y: 0.0,
                location_label: Some("Revised · Line 1".to_owned()),
                expected_file_hash: Some(current_hash),
            })
            .unwrap();
        assert_eq!(
            fresh.annotation.location_label.as_deref(),
            Some("Revised · Line 1")
        );
    }
}
