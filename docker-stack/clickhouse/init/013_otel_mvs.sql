-- 013_otel_mvs.sql
-- Schema v3 (additive). The ten materialized views fed by Claude Code's own OTel
-- events (tool_result, tool_decision, compaction). They write into the same target
-- tables as the old hook-fed views, so old rows and new rows show together.
-- All ten are created here, so an upgrade from 1.1.0 captures everything right
-- after the stack rebuild, before /migrate-db. A database that got v3 from an
-- older copy of this file can miss some of them or have an older query: v6 runs
-- this file again (IF NOT EXISTS creates only what is missing) and v7 gives every
-- view the query of this file.
-- Needs OTEL_LOG_TOOL_DETAILS=1 for tool_input and tool_parameters.
-- OTel tool events carry agent_id but no agent type, so agent_type stays empty.
-- Every view writes source = 'otel'. The column is added by 015_source_column.sql
-- (schema v7); until then ClickHouse leaves the value out.

-- ============================================================
-- credential_exposures: a successful read of a file whose path matches a
-- sensitive pattern. One view and one pattern list for every way to read:
--   Read tool            tool_input.file_path
--   Grep tool            tool_input.path
--   Bash / PowerShell    each file after cat, type, head, tail, less, more,
--                        Get-Content or gc (as a command word, see the delete view)
-- A shell path is stored as written, so it can be relative. For the match every
-- path gets a leading '/', so "cat .env" matches the same rule as ".../.env".
-- KEEP IN SYNC with transform/redact_credential_content in
-- docker-stack/otel-collector-config.yaml. It removes the file text from the
-- trace of the same reads, with the same read commands and the same file names.
-- Change both files together.
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.credential_exposures_otel_mv
TO claudalytics.credential_exposures
AS
WITH
    LogAttributes['tool_name'] AS read_tool,
    if(read_tool = 'Bash',
       JSONExtractString(LogAttributes['tool_parameters'], 'full_command'),
       JSONExtractString(LogAttributes['tool_input'], 'command')) AS cmd,
    arrayFlatten(arrayMap(
        read_call -> extractAll(read_call, '(?:"[^"]*"|\'[^\']*\'|[^\\s"\'])+'),
        extractAll(cmd, '(?:^|[;&|({\\n`]|\\b(?:then|do|else|sudo)\\s)\\s*(?i:cat|type|head|tail|less|more|get-content|gc)\\s+([^;&|\\n]*)')
    )) AS shell_read_words,
    multiIf(
        read_tool IN ('Bash', 'PowerShell'),
        arrayMap(shell_read_word -> replaceRegexpAll(shell_read_word, '["\']|[)]+$', ''), shell_read_words),
        read_tool = 'Grep',
        [JSONExtractString(LogAttributes['tool_input'], 'path')],
        [JSONExtractString(LogAttributes['tool_input'], 'file_path')]
    ) AS read_paths,
    [
        ('/\\.env$',                                '.env',                  'env'),
        ('/\\.env\\.[^/]+$',                        '.env.*',                'env'),
        ('/appsettings\\.[^/]+\\.json$',            'appsettings.*.json',    'dotnet'),
        ('/secrets\\.json$',                         'secrets.json',          'dotnet'),
        ('/local\\.settings\\.json$',                'local.settings.json',   'azure'),
        ('\\.tfvars$',                               '*.tfvars',              'terraform'),
        ('/terraform\\.tfstate',                     'terraform.tfstate',     'terraform'),
        ('/\\.aws/credentials$',                     '.aws/credentials',      'cloud'),
        ('/\\.aws/config$',                          '.aws/config',           'cloud'),
        ('/\\.kube/config$',                         '.kube/config',          'kubernetes'),
        ('/credentials\\.json$',                     'credentials.json',      'cloud'),
        ('/credentials\\.yaml$',                     'credentials.yaml',      'cloud'),
        ('/service[-_]?account[^/]*\\.json$',        'service-account*.json', 'gcp'),
        ('/token\\.json$',                           'token.json',            'cloud'),
        ('/id_(rsa|ed25519|ecdsa|dsa)',              'id_*',                  'ssh'),
        ('\\.pem$',                                  '*.pem',                 'certificate'),
        ('\\.key$',                                  '*.key',                 'certificate'),
        ('\\.p12$',                                  '*.p12',                 'certificate'),
        ('\\.pfx$',                                  '*.pfx',                 'certificate'),
        ('\\.jks$',                                  '*.jks',                 'certificate'),
        ('/\\.npmrc$',                               '.npmrc',                'package-manager'),
        ('/\\.pypirc$',                              '.pypirc',               'package-manager'),
        ('/\\.gemrc$',                               '.gemrc',                'package-manager'),
        ('/\\.nuget/NuGet\\.Config$',                '.nuget/NuGet.Config',   'package-manager'),
        ('/\\.netrc$',                               '.netrc',                'auth'),
        ('/\\.pgpass$',                              '.pgpass',               'database'),
        ('/\\.my\\.cnf$',                            '.my.cnf',              'database'),
        ('/\\.htpasswd$',                            '.htpasswd',             'auth'),
        ('/\\.docker/config\\.json$',                '.docker/config.json',   'docker'),
        ('/\\.dockercfg$',                           '.dockercfg',            'docker'),
        ('/kubeconfig$',                             'kubeconfig',            'kubernetes'),
        ('/vault\\.ya?ml$',                          'vault.yml',             'ansible'),
        ('vault[-_]pass(word)?',                     'vault-password',        'ansible'),
        ('/keystore\\.properties$',                  'keystore.properties',   'android'),
        ('/local\\.properties$',                     'local.properties',      'android'),
        ('/\\.github/secrets',                       '.github/secrets',       'ci'),
        ('/secrets\\.ya?ml$',                        'secrets.yml',           'generic'),
        ('/secrets?\\.toml$',                        'secrets.toml',          'generic')
    ] AS patterns,
    arrayDistinct(arrayFilter(
        read_path -> read_path != '' AND arrayExists(p -> match(concat('/', read_path), p.1), patterns),
        arrayMap(read_path -> replaceAll(read_path, '\\', '/'), read_paths)
    )) AS exposed_paths
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    LogAttributes['agent_id'] AS agent_id,
    '' AS agent_type,
    arrayJoin(exposed_paths) AS file_path,
    arrayElement(splitByChar('/', file_path), -1) AS file_name,
    arrayFirst(p -> match(concat('/', file_path), p.1), patterns).2 AS matched_label,
    arrayFirst(p -> match(concat('/', file_path), p.1), patterns).3 AS pattern_category,
    'otel' AS source
FROM claudalytics.otel_logs
WHERE LogAttributes['event.name'] = 'tool_result'
  AND read_tool IN ('Read', 'Grep', 'Bash', 'PowerShell')
  AND LogAttributes['success'] = 'true'
  AND notEmpty(exposed_paths);

-- ============================================================
-- file_mutations: Edit → 'update'
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.file_mutations_edit_otel_mv
TO claudalytics.file_mutations
AS
WITH
    replaceAll(JSONExtractString(LogAttributes['tool_input'], 'file_path'), '\\', '/') AS fp,
    arrayElement(splitByRegexp('[/]', fp), length(splitByRegexp('[/]', fp))) AS fname,
    if(position(fname, '.') > 0,
       arrayElement(splitByChar('.', fname), length(splitByChar('.', fname))),
       '') AS fext
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    LogAttributes['agent_id'] AS agent_id,
    '' AS agent_type,
    fp AS file_path,
    fname AS file_name,
    fext AS file_extension,
    if(length(fp) > length(fname) + 1,
       substringUTF8(fp, 1, length(fp) - length(fname) - 1),
       '') AS directory,
    'update' AS action,
    'Edit' AS tool_name,
    'otel' AS source
FROM claudalytics.otel_logs
WHERE LogAttributes['event.name'] = 'tool_result'
  AND LogAttributes['tool_name'] = 'Edit'
  AND LogAttributes['success'] = 'true'
  AND fp != '';

-- ============================================================
-- file_mutations: Write → 'write'
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.file_mutations_write_otel_mv
TO claudalytics.file_mutations
AS
WITH
    replaceAll(JSONExtractString(LogAttributes['tool_input'], 'file_path'), '\\', '/') AS fp,
    arrayElement(splitByRegexp('[/]', fp), length(splitByRegexp('[/]', fp))) AS fname,
    if(position(fname, '.') > 0,
       arrayElement(splitByChar('.', fname), length(splitByChar('.', fname))),
       '') AS fext
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    LogAttributes['agent_id'] AS agent_id,
    '' AS agent_type,
    fp AS file_path,
    fname AS file_name,
    fext AS file_extension,
    if(length(fp) > length(fname) + 1,
       substringUTF8(fp, 1, length(fp) - length(fname) - 1),
       '') AS directory,
    'write' AS action,
    'Write' AS tool_name,
    'otel' AS source
FROM claudalytics.otel_logs
WHERE LogAttributes['event.name'] = 'tool_result'
  AND LogAttributes['tool_name'] = 'Write'
  AND LogAttributes['success'] = 'true'
  AND fp != '';

-- ============================================================
-- file_mutations: Bash / PowerShell delete → 'delete', one row per deleted path.
-- Bash: tool_parameters.full_command (complete). PowerShell has no full_command,
-- so it uses tool_input.command, which keeps only about 128 characters when the
-- command is longer than 512 characters (known limit).
-- A delete counts only as a command word: at the start, after ; & | ( { or a new
-- line, or after then / do / else / sudo / git. So grep -ri, docker run --rm and
-- "rm x" inside a quoted prompt are not deletes.
-- Every delete in the command is read, and "rm a b" gives two rows. Quotes keep
-- a path with spaces in one piece. Flags and redirects are skipped.
-- When the command starts with cd <folder> && (or ;) and has no other cd, a
-- relative path is stored as <folder>/<path>.
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.file_mutations_delete_otel_mv
TO claudalytics.file_mutations
AS
WITH
    LogAttributes['tool_name'] AS shell_tool,
    if(shell_tool = 'Bash',
       JSONExtractString(LogAttributes['tool_parameters'], 'full_command'),
       JSONExtractString(LogAttributes['tool_input'], 'command')) AS cmd,
    extractAll(cmd, '(?:^|[;&|({\\n]|\\b(?:then|do|else)\\s)\\s*(?:sudo\\s+|git\\s+)?(?:rm|del|rmdir|unlink|(?i:remove-item|ri))\\s+([^;&|\\n]*)') AS delete_calls,
    arrayFlatten(arrayMap(
        delete_call -> extractAll(
            replaceRegexpAll(delete_call, '(?i)(?:^|\\s)-(?:ErrorAction|ea|WarningAction|Include|Exclude|Filter)\\s+\\S+', ' '),
            '(?:"[^"]*"|\'[^\']*\'|[^\\s"\'])+'),
        delete_calls)) AS delete_words,
    arrayFilter(
        delete_word -> delete_word != '' AND NOT match(delete_word, '^-|[<>]|^[{}()]+$'),
        arrayMap(
            delete_word -> replaceRegexpOne(
                trim(BOTH ',' FROM replaceAll(replaceRegexpAll(delete_word, '["\']|[)]+$', ''), '\\', '/')),
                '(.)/+$', '\\1'),
            delete_words)) AS written_paths,
    replaceRegexpOne(
        replaceAll(
            replaceRegexpAll(
                extract(cmd, '^\\s*(?:cd|(?i:set-location))\\s+("[^"]+"|\'[^\']+\'|[^\\s;&|"\']+)\\s*(?:&&|;)'),
                '["\']', ''),
            '\\', '/'),
        '(.)/+$', '\\1') AS start_folder,
    countMatches(cmd, '(?:^|[;&|({\\n]|\\b(?:then|do|else)\\s)\\s*(?i:cd|chdir|pushd|popd|set-location|sl)\\s') = 1 AS has_one_cd,
    arrayMap(
        written_path -> if(
            start_folder != '' AND has_one_cd AND NOT match(written_path, '^(?:/|~|\\$|%|[A-Za-z]:)'),
            concat(start_folder, '/', replaceRegexpOne(written_path, '^(?:\\./)+', '')),
            written_path),
        written_paths) AS delete_paths
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    LogAttributes['agent_id'] AS agent_id,
    '' AS agent_type,
    arrayJoin(delete_paths) AS file_path,
    arrayElement(splitByChar('/', file_path), -1) AS file_name,
    if(position(file_name, '.') > 0,
       arrayElement(splitByChar('.', file_name), -1),
       '') AS file_extension,
    if(length(file_path) > length(file_name) + 1,
       substringUTF8(file_path, 1, length(file_path) - length(file_name) - 1),
       '') AS directory,
    'delete' AS action,
    shell_tool AS tool_name,
    'otel' AS source
FROM claudalytics.otel_logs
WHERE LogAttributes['event.name'] = 'tool_result'
  AND shell_tool IN ('Bash', 'PowerShell')
  AND LogAttributes['success'] = 'true'
  AND notEmpty(delete_paths);

-- ============================================================
-- blocked_tools: rejected tool calls. source is user_reject, user_abort
-- (an interrupted permission ask), config or hook.
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.blocked_tools_otel_mv
TO claudalytics.blocked_tools
AS
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    LogAttributes['tool_use_id'] AS use_id,
    LogAttributes['tool_name'] AS tool_name,
    substring(LogAttributes['tool_parameters'], 1, 200) AS tool_input,
    toUInt8(0) AS completed,
    LogAttributes['source'] AS decision_source,
    'otel' AS source
FROM claudalytics.otel_logs
WHERE LogAttributes['event.name'] = 'tool_decision'
  AND LogAttributes['decision'] = 'reject'
  AND LogAttributes['tool_use_id'] != '';

-- ============================================================
-- compaction_events: one row per compaction, with its duration and tokens
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.compaction_events_otel_mv
TO claudalytics.compaction_events
AS
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    'compaction' AS event_phase,
    LogAttributes['trigger'] AS trigger,
    '' AS custom_instructions,
    toUInt64OrZero(LogAttributes['duration_ms']) AS duration_ms,
    toUInt64OrZero(LogAttributes['pre_tokens']) AS pre_tokens,
    toUInt64OrZero(LogAttributes['post_tokens']) AS post_tokens,
    LogAttributes['success'] AS success,
    'otel' AS source
FROM claudalytics.otel_logs
WHERE LogAttributes['event.name'] = 'compaction';

-- ============================================================
-- websites_visited: WebFetch URL. OTel has no HTTP status or byte count.
-- Local addresses (localhost, 127.0.0.1, ::1, host.docker.internal) are left out.
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.websites_visited_fetch_otel_mv
TO claudalytics.websites_visited
AS
WITH
    JSONExtractString(LogAttributes['tool_input'], 'url') AS raw_url
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    raw_url AS url,
    extract(raw_url, '://(\\[[^\\]]*\\]|[^/:?#]+)') AS domain,
    'WebFetch' AS source_tool,
    toUInt16(0) AS http_status,
    toUInt64(0) AS fetch_bytes,
    '' AS search_query,
    'otel' AS source
FROM claudalytics.otel_logs
WHERE LogAttributes['event.name'] = 'tool_result'
  AND LogAttributes['tool_name'] = 'WebFetch'
  AND LogAttributes['success'] = 'true'
  AND raw_url != ''
  AND lower(domain) NOT IN ('localhost', '127.0.0.1', '[::1]', 'host.docker.internal');

-- ============================================================
-- websites_visited: WebSearch query. Result URLs are not in OTel log events,
-- so url stays empty (hooks mode still adds them through websites_visited_search_mv).
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.websites_visited_search_otel_mv
TO claudalytics.websites_visited
AS
WITH
    JSONExtractString(LogAttributes['tool_input'], 'query') AS query
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    '' AS url,
    '' AS domain,
    'WebSearch' AS source_tool,
    toUInt16(0) AS http_status,
    toUInt64(0) AS fetch_bytes,
    query AS search_query,
    'otel' AS source
FROM claudalytics.otel_logs
WHERE LogAttributes['event.name'] = 'tool_result'
  AND LogAttributes['tool_name'] = 'WebSearch'
  AND LogAttributes['success'] = 'true'
  AND query != '';

-- ============================================================
-- websites_visited: URLs fetched by a Bash / PowerShell command (success or not).
-- A URL counts only when it is an argument of curl, wget, Invoke-WebRequest, iwr,
-- Invoke-RestMethod or irm, and that word is a command word: at the start, after
-- ; & | ( { ` or a new line, or after then / do / else / sudo / time. A URL that
-- is only text (a prompt for claude -p, an echo, a commit message) is not counted.
-- Before the search:
--   - the body of a heredoc is cut out, so a URL in a note or in a script that is
--     only written to a file is not counted;
--   - the value of a data, header, proxy, referer or user-agent option is cut
--     out, so a URL inside a request body is not counted.
-- Trailing punctuation is trimmed, duplicates are removed, at most 10 URLs.
-- Local addresses (localhost, 127.0.0.1, ::1, host.docker.internal) are left out.
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.websites_visited_shell_otel_mv
TO claudalytics.websites_visited
AS
WITH
    LogAttributes['tool_name'] AS shell_tool,
    if(shell_tool = 'Bash',
       JSONExtractString(LogAttributes['tool_parameters'], 'full_command'),
       JSONExtractString(LogAttributes['tool_input'], 'command')) AS cmd,
    arrayFold(
        (cmd_text, heredoc_word) -> replaceRegexpAll(
            cmd_text,
            concat('(?s)(<<-?\\s*["\']?', heredoc_word, '["\']?[^\\n]*)\\n.*?\\n[ \\t]*', heredoc_word, '[ \\t]*(\\n|$)'),
            '\\1\\2'),
        arrayDistinct(extractAll(cmd, '(?:^|[^<])<<-?\\s*["\']?([A-Za-z_][A-Za-z0-9_]*)')),
        cmd) AS cmd_without_heredocs,
    extractAll(
        cmd_without_heredocs,
        '(?:^|[;&|({\\n`]|\\b(?:then|do|else|sudo|time)\\s)\\s*(?i:curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm)(?:\\.exe)?\\s+((?:"[^"]*"|\'[^\']*\'|[^;&|\\n"\'])*)'
    ) AS fetch_calls,
    arrayFlatten(arrayMap(
        fetch_call -> extractAll(
            replaceRegexpAll(
                fetch_call,
                '(?:^|\\s)(?:-[dHAexF]|--data[\\w-]*|--header|--user-agent|--referer|--proxy|--form[\\w-]*|(?i:-body|-headers|-proxy|-useragent))[\\s=]+(?:"[^"]*"|\'[^\']*\'|\\S+)',
                ' '),
            '(?i)\\bhttps?://[^\\s"\'`<>|;)\\\\]+'),
        fetch_calls)) AS fetched_urls,
    arraySlice(
        arrayDistinct(arrayFilter(
            fetched_url -> lower(extract(fetched_url, '://(\\[[^\\]]*\\]|[^/:?#]+)')) NOT IN ('localhost', '127.0.0.1', '[::1]', 'host.docker.internal'),
            arrayMap(
                fetched_url -> replaceRegexpOne(fetched_url, '[.,:;!?)\\]}\'"]+$', ''),
                fetched_urls)
        )),
        1, 10
    ) AS url_array
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    arrayJoin(url_array) AS url,
    extract(url, '://(\\[[^\\]]*\\]|[^/:?#]+)') AS domain,
    shell_tool AS source_tool,
    toUInt16(0) AS http_status,
    toUInt64(0) AS fetch_bytes,
    '' AS search_query,
    'otel' AS source
FROM claudalytics.otel_logs
WHERE LogAttributes['event.name'] = 'tool_result'
  AND shell_tool IN ('Bash', 'PowerShell')
  AND notEmpty(url_array);

-- ============================================================
-- websites_visited: a page fetched through an MCP tool. Every MCP call is a
-- tool_result with tool_name 'mcp_tool'; the server and tool names are in
-- tool_parameters. A row is written for the 'url' input and for each entry of a
-- 'urls' input, when it is an http(s) address. source_tool is written the way
-- Claude Code names the tool: mcp__<server>__<tool>.
-- Local addresses (localhost, 127.0.0.1, ::1, host.docker.internal) are left out.
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.websites_visited_mcp_otel_mv
TO claudalytics.websites_visited
AS
WITH
    arrayDistinct(arrayFilter(
        input_url -> match(input_url, '^(?i)https?://')
            AND lower(extract(input_url, '://(\\[[^\\]]*\\]|[^/:?#]+)')) NOT IN ('localhost', '127.0.0.1', '[::1]', 'host.docker.internal'),
        arrayConcat(
            [JSONExtractString(LogAttributes['tool_input'], 'url')],
            JSONExtract(LogAttributes['tool_input'], 'urls', 'Array(String)'))
    )) AS url_array
SELECT
    Timestamp AS timestamp,
    ResourceAttributes['project.name'] AS project_name,
    LogAttributes['session.id'] AS session_id,
    arrayJoin(url_array) AS url,
    extract(url, '://(\\[[^\\]]*\\]|[^/:?#]+)') AS domain,
    concat('mcp__',
           JSONExtractString(LogAttributes['tool_parameters'], 'mcp_server_name'),
           '__',
           JSONExtractString(LogAttributes['tool_parameters'], 'mcp_tool_name')) AS source_tool,
    toUInt16(0) AS http_status,
    toUInt64(0) AS fetch_bytes,
    '' AS search_query,
    'otel' AS source
FROM claudalytics.otel_logs
WHERE LogAttributes['event.name'] = 'tool_result'
  AND LogAttributes['tool_name'] = 'mcp_tool'
  AND LogAttributes['success'] = 'true'
  AND notEmpty(url_array);
