-- SynapseRead core schema (V1).
-- Applied exactly once by `db::migrate`, tracked through `PRAGMA user_version`.
-- Released migrations are immutable: change the schema by adding a new file.

CREATE TABLE documents (
    id                 TEXT PRIMARY KEY NOT NULL,
    title              TEXT NOT NULL,
    file_path          TEXT NOT NULL,
    -- Content identity: moving a file on disk must not orphan its annotations.
    file_hash          TEXT NOT NULL UNIQUE,
    format             TEXT NOT NULL CHECK (format IN ('pdf', 'epub', 'txt', 'md')),
    encoding           TEXT NOT NULL DEFAULT 'utf-8',
    last_cursor_anchor TEXT,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE study_notebooks (
    id            TEXT PRIMARY KEY NOT NULL,
    title         TEXT NOT NULL,
    viewport_json TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE annotations (
    id                  TEXT PRIMARY KEY NOT NULL,
    -- RESTRICT: deleting a document must never silently destroy the user's excerpts.
    document_id         TEXT NOT NULL REFERENCES documents (id) ON DELETE RESTRICT,
    notebook_id         TEXT NOT NULL REFERENCES study_notebooks (id) ON DELETE CASCADE,
    anchor_type         TEXT NOT NULL CHECK (anchor_type IN ('pdf', 'epub', 'txt', 'md')),
    anchor_payload_json TEXT NOT NULL,
    excerpt_text        TEXT,
    excerpt_image_path  TEXT,
    color               TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_annotations_document ON annotations (document_id);
CREATE INDEX idx_annotations_notebook ON annotations (notebook_id);

CREATE TABLE note_cards (
    id             TEXT PRIMARY KEY NOT NULL,
    notebook_id    TEXT NOT NULL REFERENCES study_notebooks (id) ON DELETE CASCADE,
    title          TEXT NOT NULL,
    markdown_notes TEXT NOT NULL DEFAULT '',
    tags_json      TEXT NOT NULL DEFAULT '[]',
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_note_cards_notebook ON note_cards (notebook_id);

-- Many-to-many: merging excerpts leaves one card pointing at several annotations.
CREATE TABLE card_annotations (
    card_id       TEXT NOT NULL REFERENCES note_cards (id) ON DELETE CASCADE,
    annotation_id TEXT NOT NULL REFERENCES annotations (id) ON DELETE CASCADE,
    PRIMARY KEY (card_id, annotation_id)
) WITHOUT ROWID;
CREATE INDEX idx_card_annotations_annotation ON card_annotations (annotation_id);

CREATE TABLE mindmap_nodes (
    id             TEXT PRIMARY KEY NOT NULL,
    notebook_id    TEXT NOT NULL REFERENCES study_notebooks (id) ON DELETE CASCADE,
    card_id        TEXT NOT NULL REFERENCES note_cards (id) ON DELETE CASCADE,
    -- NULL means a floating root; removing a parent promotes its children.
    parent_node_id TEXT REFERENCES mindmap_nodes (id) ON DELETE SET NULL,
    pos_x          REAL NOT NULL DEFAULT 0,
    pos_y          REAL NOT NULL DEFAULT 0,
    is_collapsed   INTEGER NOT NULL DEFAULT 0 CHECK (is_collapsed IN (0, 1)),
    style_json     TEXT
);
CREATE INDEX idx_mindmap_nodes_notebook ON mindmap_nodes (notebook_id);
CREATE INDEX idx_mindmap_nodes_card ON mindmap_nodes (card_id);
CREATE INDEX idx_mindmap_nodes_parent ON mindmap_nodes (parent_node_id);

CREATE TABLE mindmap_edges (
    id             TEXT PRIMARY KEY NOT NULL,
    notebook_id    TEXT NOT NULL REFERENCES study_notebooks (id) ON DELETE CASCADE,
    source_node_id TEXT NOT NULL REFERENCES mindmap_nodes (id) ON DELETE CASCADE,
    target_node_id TEXT NOT NULL REFERENCES mindmap_nodes (id) ON DELETE CASCADE,
    label          TEXT,
    UNIQUE (source_node_id, target_node_id),
    CHECK (source_node_id <> target_node_id)
);
CREATE INDEX idx_mindmap_edges_notebook ON mindmap_edges (notebook_id);
CREATE INDEX idx_mindmap_edges_target ON mindmap_edges (target_node_id);
