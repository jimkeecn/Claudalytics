-- 014_otel_views_v2.sql
-- Schema v6 (additive). The second version of websites_visited_search_mv and
-- sessions as a plain view. Both keep their names. On an upgraded database the
-- older objects are dropped first by v5 (destructive, run /migrate-db); on a fresh
-- install they are never created.
-- v6 also runs 013_otel_mvs.sql again before this file, see the note there.
-- The target tables do not change.
-- websites_visited_search_mv writes source = 'hook'. The column is added by
-- 015_source_column.sql (schema v7); until then ClickHouse leaves the value out.
-- v7 also gives the view of an upgraded database the SQL of this file.

-- ============================================================
-- websites_visited: WebSearch result URLs from the hook-capture plugin
-- (OTel + hooks mode). OTel log events have no result URLs, so this hook-fed
-- view stays. Local addresses are left out here too.
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.websites_visited_search_mv
TO claudalytics.websites_visited
AS
WITH
    arrayFilter(
        result_url -> lower(extract(result_url, '://(\\[[^\\]]*\\]|[^/:?#]+)')) NOT IN ('localhost', '127.0.0.1', '[::1]', 'host.docker.internal'),
        JSONExtract(LogAttributes['search_urls'], 'Array(String)')
    ) AS url_array
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    arrayJoin(url_array) AS url,
    extract(url, '://(\\[[^\\]]*\\]|[^/:?#]+)') AS domain,
    'WebSearch' AS source_tool,
    toUInt16(0) AS http_status,
    toUInt64(0) AS fetch_bytes,
    'hook' AS source
FROM claudalytics.otel_logs
WHERE LogAttributes['event.name'] = 'hooks.PostToolUse'
  AND LogAttributes['tool_name'] = 'WebSearch'
  AND LogAttributes['search_urls'] != ''
  AND notEmpty(url_array);

-- ============================================================
-- sessions: one row per session and project, read straight from otel_logs.
-- It was a ReplacingMergeTree table filled by sessions_mv. Each insert batch
-- wrote its own min / max / count and the engine kept only the newest row, so
-- started_at and otel_event_count were those of the last batch. A plain view
-- has no stored state: it is right for every batch, it covers the events that
-- arrived before the views existed, and it needs no backfill. It lives as long
-- as otel_logs (90 days), the same as the old table.
-- has_hook_data is 1 when the hook-capture plugin sent a row (event hooks.*).
-- ============================================================
CREATE VIEW IF NOT EXISTS claudalytics.sessions
AS
SELECT
    LogAttributes['session.id'] AS session_id,
    ResourceAttributes['project.name'] AS project_name,
    toDateTime(min(Timestamp)) AS started_at,
    toDateTime(max(Timestamp)) AS last_event_at,
    count() AS otel_event_count,
    toUInt8(countIf(NOT startsWith(LogAttributes['event.name'], 'hooks.')) > 0) AS has_otel_data,
    toUInt8(countIf(startsWith(LogAttributes['event.name'], 'hooks.')) > 0) AS has_hook_data
FROM claudalytics.otel_logs
WHERE LogAttributes['session.id'] != ''
GROUP BY
    session_id,
    project_name;
