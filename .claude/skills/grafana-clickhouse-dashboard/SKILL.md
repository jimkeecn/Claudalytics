---
name: grafana-clickhouse-dashboard
description: Pitfalls and correct patterns when writing Grafana dashboard JSON for the grafana-clickhouse-datasource plugin. Use when creating or debugging ClickHouse-backed Grafana dashboards.
---

# Grafana ClickHouse Dashboard Pitfalls

Hard-won lessons from debugging the Claudalytics OTel dashboard. Apply these rules when writing or editing Grafana dashboard JSON that uses the `grafana-clickhouse-datasource` plugin.

## Rule 1: format must be numeric, not string

The plugin unmarshals `format` into a Go `sqlutil.FormatQueryOption` (an integer type).

```json
// WRONG — causes "cannot unmarshal string into Go struct field"
{ "rawSql": "SELECT ...", "format": "table" }
{ "rawSql": "SELECT ...", "format": "time_series" }

// CORRECT
{ "rawSql": "SELECT ...", "format": 1, "queryType": "sql" }   // table
{ "rawSql": "SELECT ...", "format": 2, "queryType": "sql" }   // time series
```

| Value | Meaning |
|-------|---------|
| `1` | Table (stat panels, tables, pie charts, bar charts) |
| `2` | Time series (timeseries panels with time column) |

Always include `"queryType": "sql"` on every target.

## Rule 2: Know where OTel attributes live in ClickHouse

The OTel Collector's ClickHouse exporter creates tables with two attribute maps:

| Column | Contains | Set by |
|--------|----------|--------|
| `ResourceAttributes` | Resource-level context: `project.name`, `service.name`, `os.type`, `host.arch` | `OTEL_RESOURCE_ATTRIBUTES` env var + SDK defaults |
| `LogAttributes` | Per-event data: `session.id`, `event.name`, `model`, `cost_usd`, `tool_name`, `input_tokens` | Claude Code OTel SDK per event |

Common mistake: assuming `project.name` is in `LogAttributes` because `session.id` is. They live in different maps.

To discover what's actually in each map:

```sql
-- Check ResourceAttributes keys
SELECT DISTINCT mapKeys(ResourceAttributes) FROM claudalytics.otel_logs LIMIT 1

-- Check LogAttributes keys
SELECT DISTINCT mapKeys(LogAttributes) FROM claudalytics.otel_logs LIMIT 1

-- Check actual values for a specific key
SELECT ResourceAttributes['project.name'], count() FROM claudalytics.otel_logs GROUP BY 1
```

## Rule 3: Grafana caches provisioned dashboards

Grafana reads provisioned dashboard JSON files on startup and caches them in its internal database. Changing the file on disk does NOT immediately update the dashboard.

To force a reload:
```bash
cd docker-stack && docker compose restart grafana
```

Then hard-refresh the browser with Ctrl+Shift+R to clear browser cache too.

The `updateIntervalSeconds: 30` in `dashboards.yaml` should poll for changes, but in practice a restart is more reliable, especially when the dashboard `version` field hasn't been incremented.

## Rule 4: Validate queries in ClickHouse first

Before putting a query into dashboard JSON, test it directly in ClickHouse:

```bash
MSYS_NO_PATHCONV=1 docker exec claudalytics-clickhouse clickhouse-client --query "YOUR QUERY HERE"
```

The `MSYS_NO_PATHCONV=1` prefix is required on Windows Git Bash to prevent path translation of Linux paths inside the query.

## Rule 5: Template variable queries for ClickHouse

Grafana template variables with `type: "query"` use a different query path than panel queries. They do NOT support the `format` field — just provide the raw SQL string in the `query` field.

The ClickHouse plugin returns the first column as the variable value and the second column (if present) as the display text.

```json
{
  "name": "project",
  "type": "query",
  "datasource": { "type": "grafana-clickhouse-datasource", "uid": "clickhouse-claudalytics" },
  "query": "SELECT DISTINCT project_name FROM claudalytics.sessions FINAL ORDER BY project_name"
}
```

## Reference: Complete target structure

```json
{
  "refId": "A",
  "rawSql": "SELECT count() AS total FROM claudalytics.otel_logs WHERE $__timeFilter(Timestamp)",
  "format": 1,
  "queryType": "sql",
  "datasource": {
    "type": "grafana-clickhouse-datasource",
    "uid": "clickhouse-claudalytics"
  }
}
```

Source: [grafana/clickhouse-datasource dashboard examples](https://github.com/grafana/clickhouse-datasource/blob/main/src/dashboards/query-analysis.json)
