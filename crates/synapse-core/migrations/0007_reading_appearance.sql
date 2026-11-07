-- Reading appearance: named faces, margins, justification, and image dimming
-- (reader UX, issues #21, #22, #29).
-- Applied exactly once by `db::migrate`, tracked through `PRAGMA user_version` (version 7).
-- Released migrations are immutable: change the schema by adding a new file.
--
-- The table is unchanged; the stored JSON moves to the new shape so it keeps
-- deserializing under `deny_unknown_fields`:
-- - `readingWidth` (the container width) becomes `margins` (page padding). The
--   column is now capped by the reading measure, so the narrowest width maps to
--   the widest margins and the full width to the narrowest.
-- - `fontFamily` generic families become the faces they rendered first:
--   `serif` -> `charter`, `sans` -> `sf-pro`. `mono` is unchanged.
-- - `justify` starts on (the previous behaviour) and `dimImages` off.
-- - `theme` is kept: `auto` is the default only for new installs.
--
-- Backup and rollback limits:
-- - Forward-only migration: advancing `PRAGMA user_version` to 7 rewrites the single
--   `reading_preferences` row. A row that is not valid JSON is left as it was.
-- - Rollback: there is no automatic down-migration. An older binary cannot read the
--   new JSON and falls back to an error, so restore a pre-upgrade database backup.

UPDATE reading_preferences
SET preferences_json = json_set(
        json_remove(preferences_json, '$.readingWidth'),
        '$.margins',
        CASE json_extract(preferences_json, '$.readingWidth')
            WHEN 'narrow' THEN 'wide'
            WHEN 'full' THEN 'narrow'
            ELSE 'normal'
        END,
        '$.fontFamily',
        CASE json_extract(preferences_json, '$.fontFamily')
            WHEN 'serif' THEN 'charter'
            WHEN 'sans' THEN 'sf-pro'
            WHEN 'mono' THEN 'mono'
            ELSE 'original'
        END,
        '$.justify', json('true'),
        '$.dimImages', json('false')
    ),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 1
  AND json_valid(preferences_json)
  AND json_type(preferences_json, '$.readingWidth') IS NOT NULL;
