-- 008_compaction_events.sql
-- Auto-executed by ClickHouse on first container start.
--
-- Stores PreCompact and PostCompact events in a small dedicated table.
-- Dashboard queries join within this table (tiny) instead of otel_logs (huge).

CREATE TABLE IF NOT EXISTS claudalytics.compaction_events (
    timestamp DateTime64(9),
    project_name LowCardinality(String),
    session_id String,
    event_phase LowCardinality(String),
    trigger LowCardinality(String) DEFAULT '',
    custom_instructions String DEFAULT ''
) ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (project_name, session_id, timestamp)
TTL toDateTime(timestamp) + INTERVAL 90 DAY;
