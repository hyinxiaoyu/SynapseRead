-- Workspace session and recent documents schema (V1.4 / R09).
-- Applied exactly once by `db::migrate`, tracked through `PRAGMA user_version` (version 5).
-- Released migrations are immutable: change the schema by adding a new file.
--
-- Backup and rollback limits:
-- - Forward-only migration: advancing `PRAGMA user_version` to 5 adds `last_opened_at`
--   on `documents` and creates the singleton `workspace_session` table.
-- - Backups: copy `synapseread.sqlite3` (and sibling `captures/`) while the app is closed,
--   or after checkpointing WAL (`PRAGMA wal_checkpoint(TRUNCATE)`).
-- - Rollback: there is no automatic down-migration. An older binary opening a v5 database
--   will ignore `last_opened_at` and `workspace_session`, or the user can restore a
--   pre-upgrade database backup.

ALTER TABLE documents ADD COLUMN last_opened_at TEXT;
CREATE INDEX idx_documents_last_opened ON documents (last_opened_at DESC, created_at DESC);

CREATE TABLE workspace_session (
    id                 INTEGER PRIMARY KEY CHECK (id = 1),
    open_document_ids  TEXT NOT NULL DEFAULT '[]',
    active_document_id TEXT,
    updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
