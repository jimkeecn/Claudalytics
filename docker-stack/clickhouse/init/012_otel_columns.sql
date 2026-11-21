-- 012_otel_columns.sql
-- Schema v3 (additive). Columns that the OTel-fed views in 013_otel_mvs.sql fill.
-- Old rows get the default value.

ALTER TABLE claudalytics.blocked_tools
    ADD COLUMN IF NOT EXISTS decision_source LowCardinality(String) DEFAULT '';

ALTER TABLE claudalytics.compaction_events
    ADD COLUMN IF NOT EXISTS duration_ms UInt64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS pre_tokens UInt64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS post_tokens UInt64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS success LowCardinality(String) DEFAULT '';

ALTER TABLE claudalytics.websites_visited
    ADD COLUMN IF NOT EXISTS search_query String DEFAULT '';
