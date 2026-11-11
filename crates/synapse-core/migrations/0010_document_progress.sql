-- How far through each document the reader is, for the Recent list (reader UX, issue #52).
-- Applied exactly once by `db::migrate`, tracked through `PRAGMA user_version` (version 10).
-- Released migrations are immutable: change the schema by adding a new file.
--
-- `last_progress` is a fraction `0..1` of the document, written together with
-- `last_cursor_anchor` by `update_document_cursor`. The anchor alone cannot give it:
-- an EPUB anchor is a CFI, and only the reader that measured the book's text knows
-- what share of the book lies before it. NULL means the reader did not know, so the
-- list shows no percentage rather than a stale one.
--
-- Backup and rollback limits:
-- - Forward-only migration: advancing `PRAGMA user_version` to 10 adds one nullable
--   column to `documents` without touching existing rows.
-- - Rollback: there is no automatic down-migration. An older binary does not select
--   the column, so it only loses the percentage, or restore a pre-upgrade backup.

ALTER TABLE documents ADD COLUMN last_progress REAL
    CHECK (last_progress IS NULL OR (last_progress >= 0 AND last_progress <= 1));
