//! SQLite persistence: migrations and every query the app runs.

use std::path::{Path, PathBuf};

use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params};
use serde::de::DeserializeOwned;
use uuid::Uuid;

use crate::domain::{
    AnchorLocation, Annotation, CardPatch, CreateExcerptInput, CreatedExcerpt, Document,
    DocumentFormat, MindMapEdge, MindMapNode, NodeLayoutPatch, NoteCard, NotebookGraph,
    StudyNotebook, Viewport,
};
use crate::fs_reader::{UTF8_LABEL, hash_file};
use crate::{CoreError, CoreResult};

/// Ordered and append-only: a migration's position is its schema version.
const MIGRATIONS: &[&str] = &[include_str!("../migrations/0001_init.sql")];

const CARD_TITLE_MAX_CHARS: usize = 80;

/// Owns the single SQLite connection.
pub struct Database {
    conn: Connection,
}

impl Database {
    /// Opens (or creates) the database at `path` and brings its schema up to date.
    pub fn open(path: &Path) -> CoreResult<Self> {
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> CoreResult<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> CoreResult<Self> {
        // foreign_keys is per-connection and off by default in SQLite.
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate(&mut conn)?;
        Ok(Self { conn })
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
            "INSERT INTO documents (id, title, file_path, file_hash, format, encoding)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (file_hash) DO UPDATE SET file_path = excluded.file_path",
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

    pub fn update_document_cursor(
        &self,
        document_id: &str,
        anchor: &AnchorLocation,
    ) -> CoreResult<()> {
        anchor.validate()?;
        let changed = self.conn.execute(
            "UPDATE documents SET last_cursor_anchor = ?2 WHERE id = ?1",
            params![document_id, serde_json::to_string(anchor)?],
        )?;
        expect_changed(changed, "document", document_id)
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
    pub fn create_excerpt(&mut self, input: &CreateExcerptInput) -> CoreResult<CreatedExcerpt> {
        input.anchor.validate()?;
        let has_text = input
            .excerpt_text
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty());
        if !has_text && input.excerpt_image_path.is_none() {
            return Err(CoreError::InvalidAnchor(
                "an excerpt needs text or a captured image".to_owned(),
            ));
        }

        let tx = self.conn.transaction()?;
        check_anchor_matches_document(&tx, &input.document_id, &input.anchor)?;
        if let Some(parent_id) = &input.parent_node_id {
            check_node_in_notebook(&tx, parent_id, &input.notebook_id)?;
        }

        let anchor_type = input.anchor.format().as_str();
        let annotation_id = new_id();
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
                input.excerpt_image_path,
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
            [&annotation_id],
            map_annotation,
        )?;
        let mut card = tx.query_row(
            &format!("{CARD_SELECT} WHERE id = ?1"),
            [&card_id],
            map_card,
        )?;
        card.annotation_ids = vec![annotation_id];
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
    if first_line.chars().count() <= CARD_TITLE_MAX_CHARS {
        return first_line.to_owned();
    }
    let mut title: String = first_line.chars().take(CARD_TITLE_MAX_CHARS - 1).collect();
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
    last_cursor_anchor, created_at FROM documents";

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
        created_at: row.get(7)?,
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
    excerpt_text, excerpt_image_path, color, created_at FROM annotations";

fn map_annotation(row: &Row<'_>) -> rusqlite::Result<Annotation> {
    Ok(Annotation {
        id: row.get(0)?,
        document_id: row.get(1)?,
        notebook_id: row.get(2)?,
        anchor: json_column(row, 3)?,
        excerpt_text: row.get(4)?,
        excerpt_image_path: row.get(5)?,
        color: row.get(6)?,
        created_at: row.get(7)?,
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
            excerpt_image_path: None,
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
        f.db.update_document_cursor(&f.document_id, &txt_anchor())
            .unwrap();
        let document = f.db.list_documents().unwrap().remove(0);
        assert_eq!(document.last_cursor_anchor, Some(txt_anchor()));
        assert!(matches!(
            f.db.update_document_cursor("missing", &txt_anchor()),
            Err(CoreError::NotFound { .. })
        ));
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

        input.excerpt_text = None;
        input.excerpt_image_path = Some("captures/a.png".to_owned());
        let created = f.db.create_excerpt(&input).unwrap();
        assert_eq!(created.card.title, "Image excerpt");
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
}
