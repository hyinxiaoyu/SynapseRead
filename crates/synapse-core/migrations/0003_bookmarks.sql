-- Independent bookmarks schema (V1.1 / R06).
-- Applied exactly once by `db::migrate`, tracked through `PRAGMA user_version` (version 3).
-- Released migrations are immutable: change the schema by adding a new file.
--
-- Backup and rollback limits:
-- - Forward-only migration: advancing `PRAGMA user_version` to 3 adds `bookmarks` and
--   `idx_bookmarks_document` without altering existing tables (`documents`,
--   `study_notebooks`, `annotations`, `note_cards`, `card_annotations`, `mindmap_nodes`,
--   `mindmap_edges`, `reading_preferences`).
-- - Backups: copy `synapseread.sqlite3` (and sibling `captures/`) while the app is closed,
--   or after checkpointing WAL (`PRAGMA wal_checkpoint(TRUNCATE)`).
-- - Rollback: there is no automatic down-migration. An older binary opening a v3 database
--   will skip `MIGRATIONS` and ignore `bookmarks`, or the user can restore a pre-upgrade
--   database backup.

CREATE TABLE bookmarks (
    id                  TEXT PRIMARY KEY NOT NULL,
    document_id         TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    anchor_type         TEXT NOT NULL CHECK (anchor_type IN ('pdf', 'epub', 'txt', 'md')),
    anchor_payload_json TEXT NOT NULL,
    location_key        TEXT NOT NULL,
    label               TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (document_id, location_key)
);
CREATE INDEX idx_bookmarks_document ON bookmarks (document_id);
