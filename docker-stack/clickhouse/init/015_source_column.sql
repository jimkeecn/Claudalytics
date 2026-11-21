-- 015_source_column.sql
-- Schema v7 (additive). Every row of a target table says which trigger wrote it:
--   otel   a view fed by Claude Code's own OTel events
--   hook   a view fed by the hook-capture plugin (websites_visited_search_mv)
-- Old rows keep an empty source: many of them came from 1.x hooks, and nothing on
-- them says so. The same value is in otel_logs as LogAttributes['event.source'].
--
-- The views fill the column with the fixed value in their own SQL (013 and 014).
-- After this file, v7 gives each existing view that SQL with
-- ALTER TABLE ... MODIFY QUERY (see viewsWithNewQuery in migrations.ts). The view
-- is changed in place, so no event is missed and nothing is dropped.

ALTER TABLE claudalytics.credential_exposures
    ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT '';

ALTER TABLE claudalytics.file_mutations
    ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT '';

ALTER TABLE claudalytics.blocked_tools
    ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT '';

ALTER TABLE claudalytics.compaction_events
    ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT '';

ALTER TABLE claudalytics.websites_visited
    ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT '';
