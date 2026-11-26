-- Store an optional human-readable location label reported by the reader when
-- creating an annotation or excerpt (for example "Ch. 3 · p. 41", "Line 6", or
-- an EPUB chapter title), so MindMap cards and the Inspector can show where an
-- excerpt came from without inspecting AnchorLocation (issue #125).
-- Applied exactly once by `db::migrate`, tracked through `PRAGMA user_version` (version 18).
-- Released migrations are immutable: change the schema by adding a new file.
--
-- Backup and rollback limits:
-- - Forward-only migration: advancing `PRAGMA user_version` to 18 adds one nullable
--   column to `annotations` without touching existing rows.
-- - Rollback: there is no automatic down-migration. An older binary ignores the
--   column, or restore a pre-upgrade backup.

ALTER TABLE annotations ADD COLUMN location_label TEXT;
