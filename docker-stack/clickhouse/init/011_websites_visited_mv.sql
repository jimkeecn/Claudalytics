-- 011_websites_visited_mv.sql
-- Materialized views that extract URLs from WebFetch, WebSearch, and Bash
-- tool events into a pre-parsed websites_visited table.
--
-- IMPORTANT: Depends on otel_logs. Run manually or via /init-claude-analytics:
--   cat 011_websites_visited_mv.sql | curl -s http://localhost:8123/ --data-binary @-

-- MV 1: WebFetch → single URL per event
CREATE MATERIALIZED VIEW IF NOT EXISTS claude_analytics.websites_visited_fetch_mv
TO claude_analytics.websites_visited
AS
WITH
    JSONExtractString(LogAttributes['tool_input'], 'url') AS raw_url
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    raw_url AS url,
    extractAll(raw_url, '://([^/:]+)')[1] AS domain,
    'WebFetch' AS source_tool,
    toUInt16OrZero(LogAttributes['http_status']) AS http_status,
    toUInt64OrZero(LogAttributes['fetch_bytes']) AS fetch_bytes
FROM claude_analytics.otel_logs
WHERE LogAttributes['event.name'] = 'hooks.PostToolUse'
  AND LogAttributes['tool_name'] = 'WebFetch'
  AND raw_url != '';

-- MV 2: WebSearch → multiple URLs per event (arrayJoin)
CREATE MATERIALIZED VIEW IF NOT EXISTS claude_analytics.websites_visited_search_mv
TO claude_analytics.websites_visited
AS
WITH
    JSONExtract(LogAttributes['search_urls'], 'Array(String)') AS url_array
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    arrayJoin(url_array) AS url,
    extractAll(url, '://([^/:]+)')[1] AS domain,
    'WebSearch' AS source_tool,
    toUInt16(0) AS http_status,
    toUInt64(0) AS fetch_bytes
FROM claude_analytics.otel_logs
WHERE LogAttributes['event.name'] = 'hooks.PostToolUse'
  AND LogAttributes['tool_name'] = 'WebSearch'
  AND LogAttributes['search_urls'] != '';

-- MV 3: Bash → URLs extracted from commands (arrayJoin)
CREATE MATERIALIZED VIEW IF NOT EXISTS claude_analytics.websites_visited_bash_mv
TO claude_analytics.websites_visited
AS
WITH
    JSONExtract(LogAttributes['bash_urls'], 'Array(String)') AS url_array
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    arrayJoin(url_array) AS url,
    extractAll(url, '://([^/:]+)')[1] AS domain,
    'Bash' AS source_tool,
    toUInt16(0) AS http_status,
    toUInt64(0) AS fetch_bytes
FROM claude_analytics.otel_logs
WHERE LogAttributes['event.name'] IN ('hooks.PostToolUse', 'hooks.PostToolUseFailure')
  AND LogAttributes['tool_name'] = 'Bash'
  AND LogAttributes['bash_urls'] != '';
