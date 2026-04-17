# Claude Analytics Docker Stack

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

## First Run

On first `docker compose up`, ClickHouse automatically:

- Creates the `claude_analytics` database
- Creates the `sessions` table

The OTel Collector creates `otel_logs`, `otel_metrics`, and `otel_traces` tables
when it receives its first batch of telemetry data.

The `sessions_mv` materialized view is created by the `/init-claude-analytics`
plugin skill after the first telemetry session arrives.

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

Run `/preflight-check` from the repo root in Claude Code before `docker compose up`. It detects host port conflicts and tells you which process to stop. Do **not** remap Claudalytics' own ports — the hooks server and OTel exporter are configured for these exact port numbers, and changing them cascades into per-project configuration.

Required ports: 13000, 4317, 4318, 4319, 8123, 9000, 13133
