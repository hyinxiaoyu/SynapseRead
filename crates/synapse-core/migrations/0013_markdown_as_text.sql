-- Markdown documents open with the TXT engine (issue #99, ADR 0007).
-- Applied exactly once by `db::migrate`, tracked through `PRAGMA user_version` (version 13).
-- Released migrations are immutable: change the schema by adding a new file.
--
-- Earlier builds registered `.md` and `.markdown` files as `md`, a format with no
-- reader, so they opened as tabs with nothing to read. They now register as `txt`.
-- Registration matches known files by content hash and keeps the stored format, so
-- without this a file opened before the upgrade would stay unreadable.
--
-- No reader ever produced an `md` anchor, so these documents have none in practice.
-- One that somehow does keeps its `md` format, because core rejects `md` annotations
-- and bookmarks on a `txt` document. A converted document's saved position is
-- cleared, since the TXT engine cannot interpret an `md` cursor anchor.
--
-- Backup and rollback limits:
-- - Forward-only migration: advancing `PRAGMA user_version` to 13 rewrites `format`
--   on qualifying `documents` rows. No schema changes.
-- - Rollback: there is no automatic down-migration. An older binary opens these rows
--   with its TXT engine, which reads them correctly, or restore a pre-upgrade backup.

UPDATE documents
SET format = 'txt',
    last_cursor_anchor = NULL,
    last_progress = NULL
WHERE format = 'md'
  AND NOT EXISTS (
      SELECT 1 FROM annotations
      WHERE annotations.document_id = documents.id AND annotations.anchor_type = 'md'
  )
  AND NOT EXISTS (
      SELECT 1 FROM bookmarks
      WHERE bookmarks.document_id = documents.id AND bookmarks.anchor_type = 'md'
  );
