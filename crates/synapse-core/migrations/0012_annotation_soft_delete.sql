-- Annotation soft delete, so Undo Delete restores the original row (issue #97).
-- Applied exactly once by `db::migrate`, tracked through `PRAGMA user_version` (version 12).
-- Released migrations are immutable: change the schema by adding a new file.
--
-- A deleted annotation keeps its id, its `card_annotations` links, and its capture
-- file until the next launch, so Undo can bring all three back. Undo history lives
-- in memory only, so `Database::open` purges whatever is still deleted.
ALTER TABLE annotations ADD COLUMN deleted_at TEXT;
