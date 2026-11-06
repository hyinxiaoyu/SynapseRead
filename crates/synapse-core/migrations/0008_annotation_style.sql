-- Annotation style: highlights and underlines (reader UX, issue #28).
-- Applied exactly once by `db::migrate`, tracked through `PRAGMA user_version` (version 8).
-- Released migrations are immutable: change the schema by adding a new file.
--
-- Backup and rollback limits:
-- - Forward-only migration: advancing `PRAGMA user_version` to 8 adds a `style` column
--   to `annotations`. Existing rows, and every excerpt, are highlights.
-- - Rollback: there is no automatic down-migration. An older binary ignores the column,
--   so underlines read back as highlights, or restore a pre-upgrade database backup.

ALTER TABLE annotations
    ADD COLUMN style TEXT NOT NULL DEFAULT 'highlight'
    CHECK (style IN ('highlight', 'underline'));
