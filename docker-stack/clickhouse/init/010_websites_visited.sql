-- 010_websites_visited.sql
-- Auto-executed by ClickHouse on first container start.
--
-- Stores URLs visited via WebFetch, WebSearch, and Bash commands.
-- Pre-parsed at insert time — no JSON extraction needed at query time.

CREATE TABLE IF NOT EXISTS claude_analytics.websites_visited (
    timestamp DateTime64(9),
    project_name LowCardinality(String),
    session_id String,
    url String,
    domain LowCardinality(String),
    source_tool LowCardinality(String),
    http_status UInt16 DEFAULT 0,
    fetch_bytes UInt64 DEFAULT 0
) ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (project_name, session_id, timestamp)
TTL toDateTime(timestamp) + INTERVAL 90 DAY;
