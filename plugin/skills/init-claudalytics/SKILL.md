---
name: init-claudalytics
description: Connect this project to the Claudalytics Docker stack. Configures OTel telemetry and writes the project name. Hook scripts ship with the plugin — no per-project script install.
---

# /init-claudalytics

**Prerequisites:**

- Claudalytics plugin installed and enabled (hooks are declared inside the plugin, not in this project).
- Docker stack running (`docker compose up -d` from docker-stack/).

## Step 0 — Progress Tracker

Create these tasks:

1. `Health check` — `Checking Docker stack`
2. `Detect project name` — `Detecting project name`
3. `Clean up legacy install` — `Removing old per-project hook files`
4. `Check OTel settings` — `Checking OTel settings`
5. `Write configuration` — `Writing configuration`
6. `Write analytics.json` — `Writing analytics.json`
7. `Report` — `Generating report`

---

## Step 1 — Health Check

Check OTel Collector:

```bash
curl -sf -o /dev/null -w "%{http_code}" http://localhost:13133/
```

If it fails → STOP: tell the user to run `docker compose up -d` from docker-stack/.

Check Hooks Server:

```bash
curl -sf http://localhost:4319/health
```

From the response, store `HOOKS_SERVER_REACHABLE`, `HOOKS_SERVER_VERSION`, `HOOKS_SCHEMA_VERSION`, `HOOKS_BOOTSTRAP`.

If it fails → WARN (don't stop); hook events won't be captured until the server is up, but OTel metrics/traces will still flow.

---

## Step 2 — Detect Project Name

Check `.claude/analytics.json` for `project_name`. If not found, check `.claude/settings.local.json` for `OTEL_RESOURCE_ATTRIBUTES` containing `project.name=`.

If found → ask the user: keep or detect a new name.

If not found → auto-detect:

```bash
node -e "try{console.log(require('./package.json').name)}catch(e){process.exit(1)}" 2>/dev/null \
  || git remote get-url origin 2>/dev/null | sed 's|.*/||;s|\.git$||' \
  || basename "$(pwd)"
```

Convert underscores to hyphens. Validate: letters, digits, hyphens only.

**Always ask the user to confirm** using `AskUserQuestion`:

- **Use "<DETECTED_NAME>" (Recommended)** — accept the auto-detected name
- **Enter custom name** — let the user type a different name

Store the confirmed name as `PROJECT_NAME`.

---

## Step 3 — Clean Up Legacy Install

Earlier versions of Claudalytics installed hook scripts into every project and wrote 26 hook entries into `.claude/settings.local.json`. Those are now obsolete because hooks ship with the plugin.

Remove the old script files (safe if they don't exist):

```bash
rm -f .claude/hooks/forward-hook.sh
rm -f .claude/hooks/session-start-health-check.sh
rm -f .claude/hooks/session-start-forward.sh
```

Read `.claude/settings.local.json`. In the `hooks` object, remove any hook entry whose `command` references one of the paths above, OR whose `url` points at `http://localhost:4319/hook` (legacy HTTP hooks). If removing a hook entry empties its event array, remove the event key entirely. **Do not touch hook entries unrelated to Claudalytics.**

---

## Step 4 — Check OTel Configuration

Read `.claude/settings.local.json`.

- **Case A:** OTel keys present with correct values (`CLAUDE_CODE_ENABLE_TELEMETRY`=`1`, `OTEL_EXPORTER_OTLP_ENDPOINT`=`http://localhost:4317`, `OTEL_TRACES_EXPORTER`=`otlp`) → `OTEL_MODE` = `skip_otel`.
- **Case B:** OTel keys present but differ → show conflicts, ask user: Replace or Skip. Store the answer as `OTEL_MODE`.
- **Case C:** No OTel keys → `OTEL_MODE` = `replace`.

---

## Step 5 — Write Configuration

Read-modify-write `.claude/settings.local.json`. Preserve existing keys.

Skip this step entirely if `OTEL_MODE` = `skip_otel`.

If `OTEL_MODE` = `replace`, set:

```
CLAUDE_CODE_ENABLE_TELEMETRY        = 1
OTEL_METRICS_EXPORTER               = otlp
OTEL_LOGS_EXPORTER                  = otlp
OTEL_EXPORTER_OTLP_PROTOCOL         = grpc
OTEL_EXPORTER_OTLP_ENDPOINT         = http://localhost:4317
OTEL_LOG_TOOL_DETAILS               = 1
OTEL_LOG_USER_PROMPTS               = 1
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA = 1
OTEL_TRACES_EXPORTER                = otlp
OTEL_LOG_TOOL_CONTENT               = 1
OTEL_METRIC_EXPORT_INTERVAL         = 10000
OTEL_LOGS_EXPORT_INTERVAL           = 5000
OTEL_RESOURCE_ATTRIBUTES            = project.name=<PROJECT_NAME>
```

### Verify

Write `.claude/settings.local.json` and read it back. Confirm:

1. `OTEL_RESOURCE_ATTRIBUTES` contains `project.name=<PROJECT_NAME>`.
2. No hook entry inside `hooks` references `.claude/hooks/forward-hook.sh`, `.claude/hooks/session-start-health-check.sh`, or `http://localhost:4319/hook` (all cleanup from Step 3 took effect).

---

## Step 6 — Write .claude/analytics.json

```json
{
  "project_name": "<PROJECT_NAME>",
  "configured_at": "<ISO_TIMESTAMP>"
}
```

Add `.claude/analytics.json` to the project's `.gitignore` if not already present.

The plugin-hosted `forward-hook.sh` reads `project_name` from this file at runtime. If the file is missing, it falls back to `basename "$CLAUDE_PROJECT_DIR"` — meaning hook events still flow, but under the directory name.

Set `ACTION` for the Step 7 report: `initialized` if `.claude/analytics.json` did not exist before this run, `reconfigured` if it did.

---

## Step 7 — Report

Check services:

```bash
curl -sf -o /dev/null -w "%{http_code}" http://localhost:8123/ 2>/dev/null
curl -sf -o /dev/null -w "%{http_code}" http://localhost:13133/
curl -sf -o /dev/null -w "%{http_code}" http://localhost:13000/api/health
```

Present:

```
Claudalytics — Project Connected
=====================================

  Project:  <PROJECT_NAME>
  Action:   <initialized | reconfigured>

  Services
    ClickHouse      http://localhost:8123   [STATUS]
    OTel Collector  http://localhost:4317   [STATUS]
    Grafana         http://localhost:13000  [STATUS]
    Hooks Server    http://localhost:4319   [STATUS]

  OTel:   [configured / skipped]
  Hooks:  declared by the Claudalytics plugin (active whenever the plugin is enabled)

  Dashboard: http://localhost:13000/d/claude-otel-overview
  Grafana:   admin / admin

  ACTION REQUIRED: Restart the Claude Code session for OTel env vars to take effect.
```

Mark all tasks as `completed`.
