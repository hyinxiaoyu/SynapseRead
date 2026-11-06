-- Reading preferences schema (V1.1 / R03).
-- Applied exactly once by `db::migrate`, tracked through `PRAGMA user_version` (version 2).
-- Released migrations are immutable: change the schema by adding a new file.
--
-- Backup and rollback limits:
-- - Forward-only migration: advancing `PRAGMA user_version` to 2 adds `reading_preferences`
--   without altering existing tables (`documents`, `study_notebooks`, `annotations`,
--   `note_cards`, `card_annotations`, `mindmap_nodes`, `mindmap_edges`).
-- - Backups: copy `synapseread.sqlite3` (and sibling `captures/`) while the app is closed,
--   or after checkpointing WAL (`PRAGMA wal_checkpoint(TRUNCATE)`).
-- - Rollback: there is no automatic down-migration. An older V1 binary opening a v2
--   database will skip `MIGRATIONS` (since `user_version` >= 1) and ignore
--   `reading_preferences`, or the user can restore a pre-upgrade database backup.

CREATE TABLE reading_preferences (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    preferences_json TEXT NOT NULL,
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
