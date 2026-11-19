-- Persist MindMap and Inspector pane open/closed state and widths (issue #119).
-- Applied exactly once by `db::migrate`, tracked through `PRAGMA user_version` (version 14).
-- Released migrations are immutable: change the schema by adding a new file.
--
-- Backup and rollback limits:
-- - Forward-only migration: adds pane visibility and optional percentage widths to
--   the singleton `workspace_session` row. Existing sessions start with both panes closed.
-- - Rollback: an older binary ignores the new columns.

ALTER TABLE workspace_session ADD COLUMN mind_map_open INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspace_session ADD COLUMN inspector_open INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspace_session ADD COLUMN mind_map_size REAL;
ALTER TABLE workspace_session ADD COLUMN inspector_size REAL;
