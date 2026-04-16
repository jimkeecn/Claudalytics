# Claude Analytics Docker Stack

Local telemetry collection stack for Claude Code sessions.

## Quick Start

```bash
cd docker-stack
docker compose up -d
```

## Services

| Service | URL | Credentials |
|---------|-----|-------------|
| Grafana | http://localhost:3000 | admin / admin |
| OTel Collector (gRPC) | localhost:4317 | - |
| OTel Collector (HTTP) | localhost:4318 | - |
| ClickHouse (HTTP) | http://localhost:8123 | default / (no password) |
| ClickHouse (native) | localhost:9000 | default / (no password) |

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

If a port is already in use, either stop the conflicting service or
create a `docker-compose.override.yaml` to remap ports.

Required ports: 3000, 4317, 4318, 8123, 9000, 13133
