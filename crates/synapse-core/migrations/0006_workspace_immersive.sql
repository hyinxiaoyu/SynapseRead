-- Immersive reading mode in the workspace session (reader UX, issue #23).
-- Applied exactly once by `db::migrate`, tracked through `PRAGMA user_version` (version 6).
-- Released migrations are immutable: change the schema by adding a new file.
--
-- Backup and rollback limits:
-- - Forward-only migration: advancing `PRAGMA user_version` to 6 adds `immersive`
--   on the singleton `workspace_session` row. Existing sessions read as not immersive.
-- - Rollback: there is no automatic down-migration. An older binary opening a v6 database
--   ignores the column, or the user can restore a pre-upgrade database backup.

ALTER TABLE workspace_session ADD COLUMN immersive INTEGER NOT NULL DEFAULT 0;
