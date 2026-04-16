-- 006_blocked_tools.sql
-- Auto-executed by ClickHouse on first container start.
--
-- Tracks tool_use lifecycle: PreToolUse inserts with completed=0,
-- PostToolUse/PostToolUseFailure inserts with completed=1.
-- ReplacingMergeTree deduplicates by use_id, keeping the latest version.
-- Query with FINAL: rows where completed=0 are blocked tool calls.

CREATE TABLE IF NOT EXISTS claude_analytics.blocked_tools (
    timestamp DateTime64(9),
    project_name LowCardinality(String),
    session_id String,
    use_id String,
    tool_name LowCardinality(String),
    tool_input String DEFAULT '',
    completed UInt8 DEFAULT 0
) ENGINE = ReplacingMergeTree(completed)
ORDER BY (project_name, use_id)
TTL toDateTime(timestamp) + INTERVAL 90 DAY;
