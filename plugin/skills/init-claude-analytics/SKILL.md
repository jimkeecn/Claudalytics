---
name: init-claude-analytics
description: Connect this project to the Claude Analytics Docker stack. Configures OTel telemetry, hooks capture, and installs SessionStart scripts.
---

# /init-claude-analytics

**Prerequisites:** Docker stack running (`docker compose up -d` from docker-stack/).

## Compatibility Versions

```json
{
  "health_check_script": "1.0.0",
  "forward_script": "1.0.0",
  "hooks_config": "1.0.0"
}
```

## Step 0 — Progress Tracker

Create 6 tasks:

1. `Health check` — `Checking Docker stack`
2. `Detect project name` — `Detecting project name`
3. `Check compatibility` — `Checking compatibility`
4. `Check OTel settings` — `Checking OTel settings`
5. `Write configuration` — `Writing configuration`
6. `Write compatibility + report` — `Generating report`

---

## Step 1 — Health Check

Check OTel Collector:

```bash
curl -sf -o /dev/null -w "%{http_code}" http://localhost:13133/
```

If fails → STOP: tell user to run `docker compose up -d` from docker-stack/.

Check Hooks Server:

```bash
curl -sf http://localhost:4319/health
```

Store from response: `HOOKS_SERVER_REACHABLE`, `HOOKS_SERVER_VERSION`, `HOOKS_SCHEMA_VERSION`, `HOOKS_BOOTSTRAP`.

If fails → WARN (don't stop).

---

## Step 2 — Detect Project Name

Check `.claude/analytics.json` for `project_name`. If not found, check `.claude/settings.local.json` for `OTEL_RESOURCE_ATTRIBUTES` containing `project.name=`.

If found → ask user: keep or detect new name.

If not found → auto-detect:

```bash
node -e "try{console.log(require('./package.json').name)}catch(e){process.exit(1)}" 2>/dev/null \
  || git remote get-url origin 2>/dev/null | sed 's|.*/||;s|\.git$||' \
  || basename "$(pwd)"
```

Convert underscores to hyphens. Validate: letters, digits, hyphens only.

**Always ask the user to confirm the detected name** using `AskUserQuestion`:

- **Use "<DETECTED_NAME>" (Recommended)** — accept the auto-detected name
- **Enter custom name** — let the user type a different name

Store the confirmed name as `PROJECT_NAME`.

---

## Step 3 — Check Compatibility

Read `.claude/analytics.json`.

**File missing** → `INSTALL_MODE` = `fresh`. Proceed to Step 4.

**File exists** → compare against Compatibility Versions above.

All match → `INSTALL_MODE` = `current`. Verify OTel + hooks in settings.local.json are correct:

- `OTEL_RESOURCE_ATTRIBUTES` has correct project name
- `CLAUDE_CODE_ENABLE_TELEMETRY` = `1`
- `hooks` object has correct `projectName` in URLs
- `SessionStart` has two command hooks referencing `forward-hook.sh` and `session-start-health-check.sh`
- Command-only events (`InstructionsLoaded`, `StopFailure`, `CwdChanged`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`) use `type: "command"` with `forward-hook.sh`, NOT `type: "http"`
- All 26 events present (19 HTTP + 6 command-only + SessionStart)
- No HTTP hooks pointing at `localhost:4319` on any command-only event

If all correct → skip to Step 6. If ANY check fails → `INSTALL_MODE` = `repair`, proceed to Step 4.

Some differ → `INSTALL_MODE` = `update`. Store flags:

- `UPDATE_HEALTH_CHECK` = true if `health_check_script` differs
- `UPDATE_FORWARD` = true if `forward_script` differs
- `UPDATE_HOOKS_CONFIG` = true if `hooks_config` differs

Proceed to Step 4.

---

## Step 4 — Check OTel Configuration

Read `.claude/settings.local.json`.

**Case A:** OTel keys present with correct values (`CLAUDE_CODE_ENABLE_TELEMETRY`=`1`, `OTEL_EXPORTER_OTLP_ENDPOINT`=`http://localhost:4317`, `OTEL_TRACES_EXPORTER`=`otlp`) → `OTEL_MODE` = `skip_otel`.

**Case B:** OTel keys present but differ → show conflicts, ask user: Replace or Skip. Store as `OTEL_MODE`.

**Case C:** No OTel keys → `OTEL_MODE` = `replace`.

---

## Step 5 — Write Configuration

Read-modify-write `.claude/settings.local.json`. Preserve existing keys.

### Part A: OTel Env Vars

Skip if `OTEL_MODE` = `skip_otel`.

If `replace`, set:

```
CLAUDE_CODE_ENABLE_TELEMETRY       = 1
OTEL_METRICS_EXPORTER              = otlp
OTEL_LOGS_EXPORTER                 = otlp
OTEL_EXPORTER_OTLP_PROTOCOL        = grpc
OTEL_EXPORTER_OTLP_ENDPOINT        = http://localhost:4317
OTEL_LOG_TOOL_DETAILS              = 1
OTEL_LOG_USER_PROMPTS              = 1
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA = 1
OTEL_TRACES_EXPORTER               = otlp
OTEL_LOG_TOOL_CONTENT              = 1
OTEL_METRIC_EXPORT_INTERVAL        = 10000
OTEL_LOGS_EXPORT_INTERVAL          = 5000
OTEL_RESOURCE_ATTRIBUTES           = project.name=<PROJECT_NAME>
```

### Part B: Install Hook Scripts

**`fresh` or `repair`** → invoke BOTH install skills.

**`update`** → invoke ONLY skills for mismatched scripts:

- `UPDATE_HEALTH_CHECK` = true → `Skill` tool: `install-hook-health-check`
- `UPDATE_FORWARD` = true → `Skill` tool: `install-hook-forward`
- Script already current → skip, record `up to date`.

### Part C: Hooks Configuration

**`fresh`, `repair`, or `UPDATE_HOOKS_CONFIG` = true** → write full hooks config below.

**`update` with `UPDATE_HOOKS_CONFIG` = false** → skip this part.

```
HOOKS_URL = http://localhost:4319/hook?projectName=<PROJECT_NAME>
```

`SessionStart` uses TWO command hooks (no HTTP — Claude Code ignores HTTP on SessionStart):

```json
"SessionStart": [{"hooks": [
  {"type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/session-start-health-check.sh"},
  {"type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/forward-hook.sh <PROJECT_NAME>"}
]}]
```

**Command-only events** — these events only support `type: "command"`, NOT HTTP. Use the forward script:

`InstructionsLoaded`, `StopFailure`, `CwdChanged`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`

Each gets ONE command hook:

```json
"<EVENT>": [{"hooks": [
  {"type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/forward-hook.sh <PROJECT_NAME>"}
]}]
```

**HTTP events** — these support HTTP hooks with `HOOKS_URL`:

`SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `Notification`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `ConfigChange`, `PreCompact`, `PostCompact`, `Elicitation`, `ElicitationResult`, `TeammateIdle`

Merge with existing hooks. If event already has analytics URL, replace it. Remove any HTTP hook under SessionStart pointing at localhost:4319. Remove any HTTP hook under command-only events pointing at localhost:4319 (leftover from older versions).

### Part D: Verify

Write `.claude/settings.local.json`. Read back and confirm:

1. `OTEL_RESOURCE_ATTRIBUTES` has correct project name
2. `hooks` object has all events (19 HTTP + 6 command-only + SessionStart)
3. HTTP hook URLs contain correct `projectName`
4. `SessionStart` has two command entries, no HTTP entry
5. Command-only events have command entries, no HTTP entries
6. Both `.sh` scripts exist and are executable (`session-start-health-check.sh`, `forward-hook.sh`)

---

## Step 6 — Write .claude/analytics.json

```json
{
  "health_check_script": "1.0.0",
  "forward_script": "1.0.0",
  "hooks_config": "1.0.0",
  "project_name": "<PROJECT_NAME>",
  "configured_at": "<ISO_TIMESTAMP>"
}
```

Use Compatibility Versions for script versions. For skipped scripts, keep existing value from analytics.json.

Add `.claude/analytics.json` to project's `.gitignore` if not present.

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
Claude Analytics — Project Connected
=====================================

  Project:  <PROJECT_NAME>
  Mode:     <fresh / update / repair / current>

  Services
    ClickHouse      http://localhost:8123   [STATUS]
    OTel Collector  http://localhost:4317   [STATUS]
    Grafana         http://localhost:13000  [STATUS]
    Hooks Server    http://localhost:4319   [STATUS]

  OTel: [configured / skipped]
  Hooks: 19 HTTP events + 6 command-forward events + 2 SessionStart commands
  Scripts:
    health-check  [installed / up to date / updated]
    forward       [installed / up to date / updated]

  Compatibility:
    health_check_script  1.0.0  ✓
    forward_script       1.0.0  ✓
    hooks_config         1.0.0  ✓

  Dashboard: http://localhost:13000/d/claude-otel-overview
  Grafana: admin / admin

  ACTION REQUIRED: Restart Claude Code session for OTel to take effect.
```

Mark all tasks as `completed`.
