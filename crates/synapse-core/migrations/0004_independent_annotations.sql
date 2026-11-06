-- Independent highlights and notes schema (V1.1 / R07).
-- Applied exactly once by `db::migrate`, tracked through `PRAGMA user_version` (version 4).
-- Released migrations are immutable: change the schema by adding a new file.
--
-- Backup and rollback limits:
-- - Forward-only migration: advancing `PRAGMA user_version` to 4 adds a nullable `note`
--   column to `annotations` so independent highlights and notes can store commentary
--   without creating a `note_cards` or `mindmap_nodes` row. Existing rows default to `NULL`.
-- - Backups: copy `synapseread.sqlite3` (and sibling `captures/`) while the app is closed,
--   or after checkpointing WAL (`PRAGMA wal_checkpoint(TRUNCATE)`).
-- - Rollback: there is no automatic down-migration. An older binary opening a v4 database
--   will skip `MIGRATIONS` and ignore `annotations.note`, or the user can restore a
--   pre-upgrade database backup.

ALTER TABLE annotations ADD COLUMN note TEXT;
