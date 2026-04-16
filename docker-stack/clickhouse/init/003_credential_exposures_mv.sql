-- 003_credential_exposures_mv.sql
-- Materialized view that auto-detects credential file access from otel_logs.
--
-- IMPORTANT: This file is NOT auto-executed on container start because it
-- depends on otel_logs which is created by the OTel Collector on first write.
-- Run this manually or via the /init-claude-analytics skill:
--
--   cat 003_credential_exposures_mv.sql | curl -s http://localhost:8123/ --data-binary @-
--
-- The view fires on every INSERT into otel_logs, checks if the event is a
-- PostToolUse Read with a file_path matching any of 38 sensitive patterns,
-- and inserts a row into credential_exposures with the matched label/category.
--
-- Uses arrayFilter + arrayFirst to match against an inline pattern array,
-- avoiding the need for external config files or hook scripts.

CREATE MATERIALIZED VIEW IF NOT EXISTS claude_analytics.credential_exposures_mv
TO claude_analytics.credential_exposures
AS
WITH
    -- Extract attributes from the log entry
    -- Normalize Windows backslashes to forward slashes for regex matching
    replaceAll(LogAttributes['read.file_path'], '\\', '/') AS file_path,
    LogAttributes['event.name'] AS event_name,
    LogAttributes['tool_name'] AS tool_name,
    LogAttributes['session.id'] AS session_id,
    LogAttributes['agent.id'] AS agent_id,
    LogAttributes['agent.type'] AS agent_type,
    ResourceAttributes['project.name'] AS project_name,

    -- Inline pattern definitions: [pattern, label, category]
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

    -- Find the first matching pattern tuple
    arrayFirst(
        p -> match(file_path, p.1),
        patterns
    ) AS matched

SELECT
    Timestamp AS timestamp,
    project_name,
    session_id,
    agent_id,
    agent_type,
    file_path,
    -- Extract just the filename from the path (last segment after / or \)
    arrayElement(
        splitByRegexp('[/\\\\]', file_path),
        length(splitByRegexp('[/\\\\]', file_path))
    ) AS file_name,
    matched.2 AS matched_label,
    matched.3 AS pattern_category
FROM claude_analytics.otel_logs
WHERE
    event_name = 'hooks.PostToolUse'
    AND tool_name = 'Read'
    AND file_path != ''
    AND matched.1 != '';
