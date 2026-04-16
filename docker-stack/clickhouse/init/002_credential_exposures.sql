-- 002_credential_exposures.sql
-- Auto-executed by ClickHouse on first container start via docker-entrypoint-initdb.d.
--
-- Creates the credential_exposures target table and a materialized view that
-- auto-detects when the Read tool accesses sensitive files (credentials, keys,
-- secrets). Detection is purely database-driven — no hook scripts needed.
--
-- NOTE: The materialized view (credential_exposures_mv) depends on otel_logs,
-- which is created by the OTel Collector on first write. If otel_logs does not
-- exist yet, this script will still create the target table. The MV creation
-- is handled by the /init-claude-analytics skill after first telemetry arrives.

-- Target table for credential exposure events
CREATE TABLE IF NOT EXISTS claude_analytics.credential_exposures (
    timestamp DateTime64(9),
    project_name LowCardinality(String),
    session_id String,
    agent_id String DEFAULT '',
    agent_type LowCardinality(String) DEFAULT '',
    file_path String,
    file_name String,
    matched_label String,
    pattern_category LowCardinality(String)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (project_name, session_id, timestamp)
TTL toDateTime(timestamp) + INTERVAL 90 DAY;
