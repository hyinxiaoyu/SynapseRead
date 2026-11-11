-- Per-document PDF layout: display mode, zoom, rotation, and cover page (reader UX, issue #51).
-- Applied exactly once by `db::migrate`, tracked through `PRAGMA user_version` (version 9).
-- Released migrations are immutable: change the schema by adding a new file.
--
-- One row holds the whole layout. The fields are read and written together because
-- they depend on each other: `scale` only means something under the `custom` zoom
-- mode, and `cover_page_alone` only under `two-page`. Splitting them would let a
-- partial write leave a document with a layout nobody chose.
--
-- A PDF without a row opens with the display and zoom mode of the most recently
-- saved row, so there is no separate "last used" table to keep in step. That layout
-- is written as the PDF's own row the first time it is read, so a PDF reopens in
-- the layout it was shown even if another PDF's layout changes later. Saves use
-- `INSERT OR REPLACE`, which gives the newest save the highest rowid: unlike
-- `updated_at`, that order holds for two saves in the same millisecond.
--
-- Backup and rollback limits:
-- - Forward-only migration: advancing `PRAGMA user_version` to 9 creates
--   `pdf_document_layouts` without altering existing tables.
-- - Rollback: there is no automatic down-migration. An older binary ignores the
--   table, so every PDF opens in the default layout, or restore a pre-upgrade
--   database backup.

CREATE TABLE pdf_document_layouts (
    document_id      TEXT PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
    display_mode     TEXT NOT NULL
        CHECK (display_mode IN ('continuous', 'single', 'two-page')),
    zoom_mode        TEXT NOT NULL
        CHECK (zoom_mode IN ('fit-width', 'fit-page', 'actual-size', 'custom')),
    scale            REAL NOT NULL CHECK (scale >= 0.25 AND scale <= 4),
    rotation         INTEGER NOT NULL CHECK (rotation IN (0, 90, 180, 270)),
    cover_page_alone INTEGER NOT NULL CHECK (cover_page_alone IN (0, 1)),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
