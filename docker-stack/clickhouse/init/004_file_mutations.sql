-- 004_file_mutations.sql
-- Auto-executed by ClickHouse on first container start via docker-entrypoint-initdb.d.
--
-- Tracks every file mutation (update, write, delete) during Claude sessions.
-- Read-only operations are excluded — this focuses on what Claude changed.

CREATE TABLE IF NOT EXISTS claudalytics.file_mutations (
    timestamp DateTime64(9),
    project_name LowCardinality(String),
    session_id String,
    agent_id String DEFAULT '',
    agent_type LowCardinality(String) DEFAULT '',
    file_path String,
    file_name String,
    file_extension LowCardinality(String),
    directory String,
    action LowCardinality(String),
    tool_name LowCardinality(String)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (project_name, session_id, timestamp)
TTL toDateTime(timestamp) + INTERVAL 90 DAY;
