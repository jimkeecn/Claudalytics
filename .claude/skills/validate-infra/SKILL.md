---
name: validate-infra
description: Read-only validation of Claude Analytics Docker infrastructure. Checks all containers, ClickHouse tables, materialized views, and service endpoints. Does NOT create, modify, or inject anything.
---

# /validate-infra

Read-only health check for the Claude Analytics Docker stack. Validates that all containers, tables, materialized views, and service endpoints are working correctly.

**This skill does NOT create, modify, or inject anything.** It only reads and reports.

**Expected schema version:** `1`

## What it checks

1. Docker containers: clickhouse, otel-collector, grafana, hooks-server
2. ClickHouse tables: schema_version, sessions, credential_exposures, file_mutations, blocked_tools, compaction_events, websites_visited, otel_logs
3. Materialized views (14): sessions_mv, credential_exposures_mv, file_mutations_edit_mv, file_mutations_write_mv, file_mutations_delete_mv, file_mutations_changed_mv, blocked_tools_pre_mv, blocked_tools_post_mv, compaction_events_pre_mv, compaction_events_post_mv, websites_visited_fetch_mv, websites_visited_search_mv, websites_visited_bash_mv
4. Service endpoints: OTel Collector (13133), hooks-server (4319), Grafana (13000)

## Step 1 — Check Docker containers

Run via Bash:

```bash
docker ps --format "{{.Names}}\t{{.Status}}" --filter "name=claude-analytics" 2>&1
```

Check that all 4 containers appear:

- `claude-analytics-clickhouse` — should show `(healthy)`
- `claude-analytics-otel`
- `claude-analytics-grafana`
- `claude-analytics-hooks` — should show `(healthy)`

Record each as running/stopped/missing.

## Step 2 — Check ClickHouse tables

For each table, run:

```bash
curl -s "http://localhost:8123/" --data-binary "EXISTS TABLE claude_analytics.<TABLE_NAME>"
```

Expected: `1` for each.

Tables to check: `schema_version`, `sessions`, `credential_exposures`, `file_mutations`, `blocked_tools`, `compaction_events`, `websites_visited`, `otel_logs`

## Step 3 — Check schema version

```bash
curl -s "http://localhost:8123/" --data-binary "SELECT max(version) FROM claude_analytics.schema_version"
```

Compare result to expected version `1`. Record as current/behind/missing.

## Step 4 — Check materialized views

For each MV, run:

```bash
curl -s "http://localhost:8123/" --data-binary "EXISTS TABLE claude_analytics.<MV_NAME>"
```

Expected: `1` for each.

MVs to check (14): `sessions_mv`, `credential_exposures_mv`, `file_mutations_edit_mv`, `file_mutations_write_mv`, `file_mutations_delete_mv`, `file_mutations_changed_mv`, `blocked_tools_pre_mv`, `blocked_tools_post_mv`, `compaction_events_pre_mv`, `compaction_events_post_mv`, `websites_visited_fetch_mv`, `websites_visited_search_mv`, `websites_visited_bash_mv`

Note: If `otel_logs` doesn't exist yet, all MVs will be missing — this is expected on fresh installs before the first OTel data arrives. Report this as "pending bootstrap" not as an error.

## Step 5 — Check service endpoints

```bash
curl -sf -o /dev/null -w "%{http_code}" http://localhost:13133/ 2>/dev/null
curl -sf http://localhost:4319/health 2>/dev/null
curl -sf -o /dev/null -w "%{http_code}" http://localhost:13000/api/health 2>/dev/null
```

For hooks-server, parse the JSON response to extract `version`, `schema_version`, and `bootstrap` status.

## Step 6 — Present report

```
Claude Analytics — Infrastructure Validation
=============================================

  Docker Containers
  ─────────────────
    clickhouse      [running (healthy) / stopped / missing]
    otel-collector  [running / stopped / missing]
    grafana         [running / stopped / missing]
    hooks-server    [running (healthy) / stopped / missing]

  ClickHouse Schema
  ─────────────────
    schema_version   [exists / missing]   version: [N] ([current / behind])
    sessions         [exists / missing]
    otel_logs        [exists / pending (no OTel data yet)]

  MV Target Tables
  ────────────────
    credential_exposures  [exists / missing]
    file_mutations        [exists / missing]
    blocked_tools         [exists / missing]
    compaction_events     [exists / missing]
    websites_visited      [exists / missing]

  Materialized Views ([N]/14)
  ───────────────────────────
    sessions_mv                    [✓ / ✗]
    credential_exposures_mv        [✓ / ✗]
    file_mutations_edit_mv         [✓ / ✗]
    file_mutations_write_mv        [✓ / ✗]
    file_mutations_delete_mv       [✓ / ✗]
    file_mutations_changed_mv      [✓ / ✗]
    blocked_tools_pre_mv           [✓ / ✗]
    blocked_tools_post_mv          [✓ / ✗]
    compaction_events_pre_mv       [✓ / ✗]
    compaction_events_post_mv      [✓ / ✗]
    websites_visited_fetch_mv      [✓ / ✗]
    websites_visited_search_mv     [✓ / ✗]
    websites_visited_bash_mv       [✓ / ✗]

  Service Endpoints
  ─────────────────
    OTel Collector  http://localhost:13133   [200 / unreachable]
    Hooks Server    http://localhost:4319    [ok v1.1.0 schema:v1 bootstrap:complete / ...]
    Grafana         http://localhost:13000   [200 / unreachable]

  Result: [All checks passed / N issues found]
```

If issues found, append specific fix suggestions:

- Containers missing → `cd docker-stack && docker compose up -d --build`
- MVs missing + otel_logs missing → "Normal on fresh install. Start a Claude Code session with the plugin to generate first OTel data. MVs will auto-create."
- MVs missing + otel_logs exists → "Bootstrap may not have completed. Check: `docker logs claude-analytics-hooks`"
- Schema behind → "Rebuild hooks-server: `cd docker-stack && docker compose up -d --build`"
