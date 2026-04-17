-- 005_file_mutations_mv.sql
-- Materialized views that track file mutations from multiple event sources.
--
-- IMPORTANT: These views depend on otel_logs (created by OTel Collector on
-- first write). Run manually or via /init-claudalytics skill:
--
--   cat 005_file_mutations_mv.sql | curl -s http://localhost:8123/ --data-binary @-
--
-- Multiple MVs feed into the same file_mutations target table.
-- This is the standard ClickHouse pattern for multi-source materialization.

-- ============================================================
-- MV 1: Edit tool → action = 'update'
-- Edit only works on existing files, so always an update.
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.file_mutations_edit_mv
TO claudalytics.file_mutations
AS
WITH
    replaceAll(LogAttributes['edit.file_path'], '\\', '/') AS fp,
    arrayElement(splitByRegexp('[/]', fp), length(splitByRegexp('[/]', fp))) AS fname,
    if(position(fname, '.') > 0,
       arrayElement(splitByChar('.', fname), length(splitByChar('.', fname))),
       '') AS fext
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    LogAttributes['agent.id'] AS agent_id,
    LogAttributes['agent.type'] AS agent_type,
    fp AS file_path,
    fname AS file_name,
    fext AS file_extension,
    if(length(fp) > length(fname) + 1,
       substringUTF8(fp, 1, length(fp) - length(fname) - 1),
       '') AS directory,
    'update' AS action,
    'Edit' AS tool_name
FROM claudalytics.otel_logs
WHERE LogAttributes['event.name'] = 'hooks.PostToolUse'
  AND LogAttributes['tool_name'] = 'Edit'
  AND LogAttributes['edit.file_path'] != '';

-- ============================================================
-- MV 2: Write tool → action = 'write'
-- Cannot distinguish create vs overwrite from tool_input.
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.file_mutations_write_mv
TO claudalytics.file_mutations
AS
WITH
    replaceAll(LogAttributes['write.file_path'], '\\', '/') AS fp,
    arrayElement(splitByRegexp('[/]', fp), length(splitByRegexp('[/]', fp))) AS fname,
    if(position(fname, '.') > 0,
       arrayElement(splitByChar('.', fname), length(splitByChar('.', fname))),
       '') AS fext
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    LogAttributes['agent.id'] AS agent_id,
    LogAttributes['agent.type'] AS agent_type,
    fp AS file_path,
    fname AS file_name,
    fext AS file_extension,
    if(length(fp) > length(fname) + 1,
       substringUTF8(fp, 1, length(fp) - length(fname) - 1),
       '') AS directory,
    'write' AS action,
    'Write' AS tool_name
FROM claudalytics.otel_logs
WHERE LogAttributes['event.name'] = 'hooks.PostToolUse'
  AND LogAttributes['tool_name'] = 'Write'
  AND LogAttributes['write.file_path'] != '';

-- ============================================================
-- MV 3: Bash delete → action = 'delete'
-- Best-effort regex on rm/del/rmdir/unlink commands.
-- Extracts the path argument after the rm flags.
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.file_mutations_delete_mv
TO claudalytics.file_mutations
AS
WITH
    LogAttributes['tool_input'] AS raw_input,
    -- Extract the command string from JSON
    JSONExtractString(raw_input, 'command') AS cmd,
    -- Extract the path after rm [-rf] or similar: grab last non-flag argument
    replaceAll(
        extractAll(cmd, '(?:rm\\s+(?:-[rfRd]+\\s+)*|del\\s+|rmdir\\s+|unlink\\s+)([^;&|\\n]+)')[1],
        '\\', '/'
    ) AS fp_raw,
    -- Trim quotes and trailing whitespace
    trim(BOTH '"' FROM trim(BOTH '\'' FROM trimRight(fp_raw))) AS fp,
    arrayElement(splitByRegexp('[/]', fp), length(splitByRegexp('[/]', fp))) AS fname,
    if(position(fname, '.') > 0,
       arrayElement(splitByChar('.', fname), length(splitByChar('.', fname))),
       '') AS fext
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    LogAttributes['agent.id'] AS agent_id,
    LogAttributes['agent.type'] AS agent_type,
    fp AS file_path,
    fname AS file_name,
    fext AS file_extension,
    if(length(fp) > length(fname) + 1,
       substringUTF8(fp, 1, length(fp) - length(fname) - 1),
       '') AS directory,
    'delete' AS action,
    'Bash' AS tool_name
FROM claudalytics.otel_logs
WHERE LogAttributes['event.name'] = 'hooks.PostToolUse'
  AND LogAttributes['tool_name'] = 'Bash'
  AND match(cmd, '\\b(rm|del|rmdir|unlink)\\s')
  AND fp != '';

-- ============================================================
-- MV 4: FileChanged → action = 'changed'
-- External file change notifications from Claude Code.
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.file_mutations_changed_mv
TO claudalytics.file_mutations
AS
WITH
    replaceAll(LogAttributes['file_path'], '\\', '/') AS fp,
    arrayElement(splitByRegexp('[/]', fp), length(splitByRegexp('[/]', fp))) AS fname,
    if(position(fname, '.') > 0,
       arrayElement(splitByChar('.', fname), length(splitByChar('.', fname))),
       '') AS fext
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    LogAttributes['agent.id'] AS agent_id,
    LogAttributes['agent.type'] AS agent_type,
    fp AS file_path,
    fname AS file_name,
    fext AS file_extension,
    if(length(fp) > length(fname) + 1,
       substringUTF8(fp, 1, length(fp) - length(fname) - 1),
       '') AS directory,
    coalesce(nullIf(LogAttributes['change_type'], ''), 'changed') AS action,
    'FileChanged' AS tool_name
FROM claudalytics.otel_logs
WHERE LogAttributes['event.name'] = 'hooks.FileChanged'
  AND LogAttributes['file_path'] != '';
