-- 009_compaction_events_mv.sql
-- Materialized views that capture PreCompact and PostCompact into a small
-- dedicated table. Dashboard ASOF JOIN runs on this tiny table instead of
-- the full otel_logs.
--
-- IMPORTANT: Depends on otel_logs. Run manually or via /init-claudalytics:
--   cat 009_compaction_events_mv.sql | curl -s http://localhost:8123/ --data-binary @-

-- MV 1: PreCompact events
CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.compaction_events_pre_mv
TO claudalytics.compaction_events
AS
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    'pre' AS event_phase,
    LogAttributes['trigger'] AS trigger,
    LogAttributes['custom_instructions'] AS custom_instructions
FROM claudalytics.otel_logs
WHERE LogAttributes['event.name'] = 'hooks.PreCompact';

-- MV 2: PostCompact events
CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.compaction_events_post_mv
TO claudalytics.compaction_events
AS
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    'post' AS event_phase,
    LogAttributes['trigger'] AS trigger,
    '' AS custom_instructions
FROM claudalytics.otel_logs
WHERE LogAttributes['event.name'] = 'hooks.PostCompact';
