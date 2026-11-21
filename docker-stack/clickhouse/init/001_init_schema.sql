-- 001_init_schema.sql
-- Auto-executed by ClickHouse on first container start via docker-entrypoint-initdb.d.
--
-- Creates:
-- 1. schema_version — tracks applied migrations (hooks-server auto-bootstrap)
--
-- NOTE: MVs, MV target tables and the sessions view are NOT created here. They
-- depend on otel_logs (created by OTel Collector on first write). The hooks-server
-- auto-bootstrap polls for otel_logs and creates them automatically.
-- sessions (session browsing and Grafana variable queries) is a view over
-- otel_logs since schema v6: see 014_otel_views_v2.sql.

-- Migration tracking table (seeded at v0 — hooks-server applies v1+)
CREATE TABLE IF NOT EXISTS claudalytics.schema_version (
    version UInt32,
    name String,
    description String DEFAULT '',
    applied_at DateTime DEFAULT now()
) ENGINE = MergeTree
ORDER BY version;
