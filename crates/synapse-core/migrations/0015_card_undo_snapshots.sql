-- Ephemeral card deletion snapshots for session Undo Delete (issue #116).
-- Applied exactly once by `db::migrate`, tracked through `PRAGMA user_version` (version 15).
-- Released migrations are immutable: change the schema by adding a new file.
--
-- Deleting a card removes its `note_cards` row, its `mindmap_nodes` row(s), its
-- `card_annotations` links, and its connected `mindmap_edges` in one transaction,
-- while re-rooting child nodes (`parent_node_id = NULL`). Undo history lives for
-- the current session only, so `Database::open` purges snapshots on sole-connection
-- startup, alongside soft-deleted annotations.

CREATE TABLE deleted_card_snapshots (
    card_id       TEXT PRIMARY KEY NOT NULL,
    snapshot_json TEXT NOT NULL,
    deleted_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
