-- 007_blocked_tools_mv.sql
-- Materialized views that track tool_use lifecycle for blocked tool detection.
--
-- IMPORTANT: Depends on otel_logs. Run manually or via /init-claudalytics:
--   cat 007_blocked_tools_mv.sql | curl -s http://localhost:8123/ --data-binary @-
--
-- Two MVs feed into blocked_tools (ReplacingMergeTree):
-- 1. PreToolUse → insert with completed=0
-- 2. PostToolUse/PostToolUseFailure → insert with completed=1
-- ReplacingMergeTree keeps the row with highest `completed` value per use_id.
-- Query with FINAL: completed=0 means blocked (pre seen, no post arrived).

-- MV 1: PreToolUse → completed=0 (pending)
CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.blocked_tools_pre_mv
TO claudalytics.blocked_tools
AS
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    LogAttributes['use_id'] AS use_id,
    LogAttributes['tool_name'] AS tool_name,
    substring(LogAttributes['tool_input'], 1, 200) AS tool_input,
    toUInt8(0) AS completed
FROM claudalytics.otel_logs
WHERE LogAttributes['event.name'] = 'hooks.PreToolUse'
  AND LogAttributes['use_id'] != '';

-- MV 2: PostToolUse + PostToolUseFailure → completed=1 (resolved)
CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.blocked_tools_post_mv
TO claudalytics.blocked_tools
AS
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    LogAttributes['use_id'] AS use_id,
    LogAttributes['tool_name'] AS tool_name,
    '' AS tool_input,
    toUInt8(1) AS completed
FROM claudalytics.otel_logs
WHERE LogAttributes['event.name'] IN ('hooks.PostToolUse', 'hooks.PostToolUseFailure')
  AND LogAttributes['use_id'] != '';
