---
name: validate-infra
description: Read-only validation of Claudalytics Docker infrastructure. Checks all containers, ClickHouse tables, materialized views, and service endpoints. Does NOT create, modify, or inject anything.
---

# /validate-infra

Read-only health check for the Claudalytics Docker stack. Validates that all containers, tables, materialized views, and service endpoints are working correctly.

**This skill does NOT create, modify, or inject anything.** It only reads and reports.

**Expected schema version:** `7`

## What it checks

1. Docker containers: clickhouse, otel-collector, grafana, hooks-server (schema bootstrap, `/health` and backfill; its hook receiver is optional, used in hooks mode)
2. ClickHouse tables: schema_version, sessions (a plain view over otel_logs since v6), credential_exposures, file_mutations, blocked_tools, compaction_events, websites_visited, otel_logs
3. Materialized views (11): websites_visited_search_mv, credential_exposures_otel_mv, file_mutations_edit_otel_mv, file_mutations_write_otel_mv, file_mutations_delete_otel_mv, blocked_tools_otel_mv, compaction_events_otel_mv, websites_visited_fetch_otel_mv, websites_visited_search_otel_mv, websites_visited_shell_otel_mv, websites_visited_mcp_otel_mv. The 11 legacy hook views must be gone after v4, and `sessions_mv` after v5.
4. Service endpoints: OTel Collector (13133), hooks-server (4319), Grafana (13000)

## Step 1 — Check Docker containers

Run via Bash:

```bash
docker ps --format "{{.Names}}\t{{.Status}}" --filter "name=claudalytics" 2>&1
```

Check that all 4 containers appear:

- `claudalytics-clickhouse` — should show `(healthy)`
- `claudalytics-otel`
- `claudalytics-grafana`
- `claudalytics-hooks` — should show `(healthy)`

Record each as running/stopped/missing.

## Step 2 — Check ClickHouse tables

For each table, run:

```bash
curl -s "http://localhost:8123/" --data-binary "EXISTS TABLE claudalytics.<TABLE_NAME>"
```

Expected: `1` for each.

Tables to check: `schema_version`, `sessions`, `credential_exposures`, `file_mutations`, `blocked_tools`, `compaction_events`, `websites_visited`, `otel_logs`

## Step 3 — Check schema version

```bash
curl -s "http://localhost:8123/" --data-binary "SELECT max(version) FROM claudalytics.schema_version"
```

Compare result to expected version `7`. Record as current/behind/missing. Version 2 may be missing; it is reserved for the `claudalytics-saas` repo. v7 is additive (the `source` column of the five target tables, filled by every view): the hooks server applies it by itself at its start, so a database at `6` with an empty `mvs_pending` only needs a hooks server of this release.

## Step 4 — Check materialized views

For each MV, run:

```bash
curl -s "http://localhost:8123/" --data-binary "EXISTS TABLE claudalytics.<MV_NAME>"
```

Expected: `1` for each.

MVs to check (11): `websites_visited_search_mv`, `credential_exposures_otel_mv`, `file_mutations_edit_otel_mv`, `file_mutations_write_otel_mv`, `file_mutations_delete_otel_mv`, `blocked_tools_otel_mv`, `compaction_events_otel_mv`, `websites_visited_fetch_otel_mv`, `websites_visited_search_otel_mv`, `websites_visited_shell_otel_mv`, `websites_visited_mcp_otel_mv`

While `/health` lists `v4_drop_legacy_hook_mvs` or `v5_drop_replaced_otel_views` in `mvs_pending`, `sessions_mv` still exists and `sessions` is still a table. The ten `*_otel_mv` views exist already: v3 creates them all. Only a database that got v3 from an older development copy of `013_otel_mvs.sql` can miss some of them until v6 is applied. Report that as "migration pending, run `/migrate-db`", not as an error.

Legacy hook views, expected `0` for each after v4: `credential_exposures_mv`, `file_mutations_edit_mv`, `file_mutations_write_mv`, `file_mutations_delete_mv`, `file_mutations_changed_mv`, `blocked_tools_pre_mv`, `blocked_tools_post_mv`, `compaction_events_pre_mv`, `compaction_events_post_mv`, `websites_visited_fetch_mv`, `websites_visited_bash_mv`

Note: If `otel_logs` doesn't exist yet, all MVs will be missing — this is expected on fresh installs before the first OTel data arrives. Report this as "pending bootstrap" not as an error.

## Step 5 — Check service endpoints

```bash
curl -sf -o /dev/null -w "%{http_code}" http://localhost:13133/ 2>/dev/null
curl -sf http://localhost:4319/health 2>/dev/null
curl -sf -o /dev/null -w "%{http_code}" http://localhost:13000/api/health 2>/dev/null
```

For hooks-server, parse the JSON response to extract `version`, `schema_version`, `bootstrap` status and `mvs_pending`.

## Step 6 — Present report

```
Claudalytics — Infrastructure Validation
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

  Materialized Views ([N]/11)
  ───────────────────────────
    websites_visited_search_mv        [✓ / ✗]
    credential_exposures_otel_mv      [✓ / ✗]
    file_mutations_edit_otel_mv       [✓ / ✗]
    file_mutations_write_otel_mv      [✓ / ✗]
    file_mutations_delete_otel_mv     [✓ / ✗]
    blocked_tools_otel_mv             [✓ / ✗]
    compaction_events_otel_mv         [✓ / ✗]
    websites_visited_fetch_otel_mv    [✓ / ✗]
    websites_visited_search_otel_mv   [✓ / ✗]
    websites_visited_shell_otel_mv    [✓ / ✗]
    websites_visited_mcp_otel_mv      [✓ / ✗]
    Legacy hook views left            [none / list]

  Service Endpoints
  ─────────────────
    OTel Collector  http://localhost:13133   [200 / unreachable]
    Hooks Server    http://localhost:4319    [ok v1.1.0 schema:v7 bootstrap:complete pending:none / ...]
                                             (hook receiver: optional, used in hooks mode)
    Grafana         http://localhost:13000   [200 / unreachable]

  Result: [All checks passed / N issues found]
```

If issues found, append specific fix suggestions:

- Containers missing → `cd docker-stack && docker compose up -d --build`
- MVs missing + otel_logs missing → "Normal on fresh install. Start a Claude Code session with the plugin to generate first OTel data. MVs will auto-create."
- MVs missing + otel_logs exists → "Bootstrap may not have completed. Check: `docker logs claudalytics-hooks`"
- Schema behind → "Rebuild hooks-server: `cd docker-stack && docker compose up -d --build`"
- `mvs_pending` lists `v4_drop_legacy_hook_mvs`, or legacy hook views are left → "Run `/migrate-db` (drop-only step)"
- `mvs_pending` lists `v5_drop_replaced_otel_views` → "Run `/migrate-db` (Step 3B)"
