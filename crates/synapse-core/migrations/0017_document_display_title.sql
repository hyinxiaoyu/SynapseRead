-- Store an optional human-readable metadata title extracted from the document
-- (for example EPUB dc:title or PDF Info.Title), keeping the filename stem in
-- `title` intact (reader UX, issue #129).
-- Applied exactly once by `db::migrate`, tracked through `PRAGMA user_version` (version 17).
-- Released migrations are immutable: change the schema by adding a new file.
--
-- Backup and rollback limits:
-- - Forward-only migration: advancing `PRAGMA user_version` to 17 adds one nullable
--   column to `documents` without touching existing rows.
-- - Rollback: there is no automatic down-migration. An older binary ignores the
--   column and falls back to `title`, or restore a pre-upgrade backup.

ALTER TABLE documents ADD COLUMN display_title TEXT;
