# Claudalytics Docker Stack

Local telemetry collection stack for Claude Code sessions.

## Quick Start

**Before `docker compose up`, run `/preflight-check` from the repo root in Claude Code** to verify all required host ports are free. The hooks server and OTel exporter are tightly coupled to these port numbers — if a port is in use, free it; do **not** remap Claudalytics' ports.

```bash
cd docker-stack
docker compose up -d
```

## Services

| Service               | URL                    | Credentials             |
| --------------------- | ---------------------- | ----------------------- |
| Grafana               | http://localhost:13000 | admin / admin           |
| OTel Collector (gRPC) | localhost:4317         | -                       |
| OTel Collector (HTTP) | localhost:4318         | -                       |
| ClickHouse (HTTP)     | http://localhost:8123  | default / (no password) |
| ClickHouse (native)   | localhost:9000         | default / (no password) |
| Hooks server          | http://localhost:4319  | -                       |

## First Run

On first `docker compose up`, ClickHouse creates the `claudalytics` database and
the `schema_version` table.

The OTel Collector creates `otel_logs`, `otel_traces` and the `otel_metrics_*`
tables when it starts.

The hooks server runs the schema setup at each start, as soon as `otel_logs`
exists: it creates the other tables, the materialized views and the `sessions`
view from `clickhouse/init/`, and applies every additive migration that
`schema_version` doesn't list yet. A fresh install ends at schema v7 with
nothing to do by hand. On an upgrade, the two destructive steps wait for
`/migrate-db`: v4 drops the old hook-fed views, and v5 drops the old WebSearch
result view, `sessions_mv` and the old `sessions` table. The hooks server applies v6 by
itself at its next start after v5, and then v7. v7 is additive: it adds the
`source` column to the five target tables and changes the 11 views in place
(`ALTER TABLE ... MODIFY QUERY`), so each new row says whether an OTel event
(`otel`) or a hook event (`hook`) wrote it. Old rows keep an empty `source`.

## Hooks Server

The hooks server is needed in both capture modes. It runs the schema setup,
answers `/health`, holds the transcript backfill tool (`npm run backfill`), and
receives hook events from the optional `claudalytics-hook-capture` plugin in
OTel + hooks mode. It re-emits only requests marked `via=hook-capture`, so an
old 1.1.0 plugin copy can't count anything twice.

The hook scripts post to `http://localhost:4319`. To use another hooks server,
set `CLAUDALYTICS_HOOKS_URL` in your shell or in the `env` of your user settings
file.

## Test Stack

`docker-compose.test.yaml` runs a second stack (project `claudalytics-test`)
for development and migration tests. It has its own container names
(`cctest-*`), volumes, hooks-server image and local-only ports, so it never
touches the live stack. Always pass both files, in this order:

```bash
docker compose -f docker-compose.yaml -f docker-compose.test.yaml up -d --build
```

A command with only the base file, or with the files in the other order,
targets the live stack.

| Service               | Test port              |
| --------------------- | ---------------------- |
| Grafana               | http://127.0.0.1:23000 |
| OTel Collector (gRPC) | 127.0.0.1:14317        |
| OTel Collector (HTTP) | 127.0.0.1:14318        |
| OTel Collector health | 127.0.0.1:14133        |
| Hooks server          | http://127.0.0.1:14319 |
| ClickHouse (HTTP)     | http://127.0.0.1:18123 |
| ClickHouse (native)   | 127.0.0.1:19000        |

To send a test session there, point `OTEL_EXPORTER_OTLP_ENDPOINT` to
`http://localhost:14317`, and in hooks mode set
`CLAUDALYTICS_HOOKS_URL=http://localhost:14319` and
`CLAUDALYTICS_CONTAINER_PREFIX=cctest` (used by the SessionStart health check).
Use an isolated `CLAUDE_CONFIG_DIR` for this, so your real settings stay as
they are.

The test ClickHouse mounts `clickhouse/test-no-ttl-merges.xml`, so it runs no
TTL merge and keeps data that you copy in from the live volume, even when it is
older than 90 days.

## Stop / Start

```bash
docker compose stop       # Stop containers (keep data)
docker compose up -d      # Start containers
```

## Full Reset

```bash
docker compose down -v    # Remove containers AND all data
```

## Port Conflicts

Run `/preflight-check` from the repo root in Claude Code before `docker compose up`. It detects host port conflicts and tells you which process to stop. Do **not** remap Claudalytics' own ports — the hooks server and OTel exporter are configured for these exact port numbers, and changing them cascades into your user settings file and the hook scripts.

Required ports: 13000, 4317, 4318, 4319, 8123, 9000, 13133
