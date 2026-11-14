-- Page turns: `flip` is now `curl` (reader UX, issue #86).
-- Applied exactly once by `db::migrate`, tracked through `PRAGMA user_version` (version 11).
-- Released migrations are immutable: change the schema by adding a new file.
--
-- The table is unchanged; the stored JSON is rewritten so a row carries the name
-- this build writes. `PageTransition` also accepts `flip` as an alias, so a row
-- that was never rewritten — or one an older build writes after this migration
-- ran — still loads as `Curl` instead of falling back to the default.
--
-- Backup and rollback limits:
-- - Forward-only migration: advancing `PRAGMA user_version` to 11 rewrites the single
--   `reading_preferences` row. A row that is not valid JSON is left as it was.
-- - Rollback: there is no automatic down-migration. An older binary reads `curl` as a
--   mode it does not know and falls back to `slide`, so restore a pre-upgrade backup.

UPDATE reading_preferences
SET preferences_json = json_set(preferences_json, '$.pageTransition', 'curl'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 1
  AND json_valid(preferences_json)
  AND json_extract(preferences_json, '$.pageTransition') = 'flip';
