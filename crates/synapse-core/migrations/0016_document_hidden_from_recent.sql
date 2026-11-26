-- Hide a document from Continue reading and the Recent list without deleting
-- its study records (reader UX, issue #126).
-- Applied exactly once by `db::migrate`, tracked through `PRAGMA user_version` (version 16).
-- Released migrations are immutable: change the schema by adding a new file.
--
-- `hidden_from_recent_at` is an RFC 3339 UTC timestamp set when the user clicks
-- Remove from Recent. Reopening or relinking the document clears it back to NULL.
--
-- Backup and rollback limits:
-- - Forward-only migration: advancing `PRAGMA user_version` to 16 adds one nullable
--   column to `documents` without touching existing rows.
-- - Rollback: there is no automatic down-migration. An older binary does not select
--   the column, so it only ignores the hidden state, or restore a pre-upgrade backup.

ALTER TABLE documents ADD COLUMN hidden_from_recent_at TEXT;
