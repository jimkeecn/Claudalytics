-- 001_init_schema.sql
-- Auto-executed by ClickHouse on first container start via docker-entrypoint-initdb.d.
--
-- Creates:
-- 1. schema_version — tracks applied migrations (hooks-server auto-bootstrap)
-- 2. sessions — session browsing and Grafana variable queries
--
-- NOTE: MVs and MV target tables are NOT created here. They depend on otel_logs
-- (created by OTel Collector on first write). The hooks-server auto-bootstrap
-- polls for otel_logs and creates all MVs + target tables automatically.

-- Migration tracking table (seeded at v0 — hooks-server applies v1+)
CREATE TABLE IF NOT EXISTS claudalytics.schema_version (
    version UInt32,
    name String,
    description String DEFAULT '',
    applied_at DateTime DEFAULT now()
) ENGINE = MergeTree
ORDER BY version;

CREATE TABLE IF NOT EXISTS claudalytics.sessions (
    session_id String,
    project_name LowCardinality(String),
    started_at DateTime,
    last_event_at DateTime,
    otel_event_count UInt32 DEFAULT 0,
    has_otel_data UInt8 DEFAULT 1,
    has_hook_data UInt8 DEFAULT 0
) ENGINE = ReplacingMergeTree(last_event_at)
ORDER BY (project_name, session_id)
TTL started_at + INTERVAL 90 DAY;
