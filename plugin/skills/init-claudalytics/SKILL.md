---
name: init-claudalytics
description: Connect this project to the Claudalytics Docker stack. Writes the OTel export variables to the user settings file, keeps only the project name in .claude/settings.local.json, and sets the capture mode (OTel only, or OTel + hooks). Run it again to change the mode.
---

# /init-claudalytics

**Prerequisites:**

- The `claudalytics` plugin is installed and enabled.
- Docker stack running (`docker compose up -d` from docker-stack/).

Rules for every step:

- Run every command from the project's root folder. Don't `cd` anywhere, also not to the plugin folder: the settings tool works on the folder given by `--project-dir`, and it stops if it would work in the plugin folder.
- Read and change the settings files (the user `settings.json`, `.claude/settings.local.json`, `.claude/settings.json`) **only** with the settings tool below. Never `cat`, `Read`, `grep` or edit them yourself, and never print a whole settings file: they can hold tokens (`env`, `apiKeyHelper`, MCP headers), and with OTel tool content on, command output goes to ClickHouse.
- The tool resolves the user settings file as `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json`. Never write a literal `~/.claude` path.
- The tool backs up a file before it changes it (`<file>.claudalytics-backup-<YYYYMMDD-HHMMSS>`), changes only the keys named in this skill, writes nothing when nothing changes, and reads the file back. If the read-back differs anywhere else, it puts the backup back and stops.
- Every tool command prints one JSON line. If it exits with any code other than 0, STOP: show the user its one-line `stop` message (or the one line it printed) and run no later step.

The settings tool:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/init-claudalytics/settings-tool.mjs" --project-dir "${CLAUDE_PROJECT_DIR}" <command>
```

## Step 0 — Progress Tracker

Create these tasks:

1. `Health check` — `Checking Docker stack`
2. `Detect project name` — `Detecting project name`
3. `Check legacy install` — `Looking for old per-project hooks`
4. `Choose capture mode` — `Choosing capture mode`
5. `User OTel settings` — `Checking the user settings file`
6. `Project settings` — `Updating .claude/settings.local.json`
7. `Apply capture mode` — `Turning hook capture on or off`
8. `Git-ignore backups` — `Updating .gitignore`
9. `Report` — `Generating report`

---

## Step 1 — Health Check

Check Node.js, which the settings tool needs:

```bash
node --version
```

If it fails → STOP: "Node.js is needed to change the settings files safely. Install Node.js 18 or later, then run /init-claudalytics again." Don't change the files any other way.

Check OTel Collector:

```bash
curl -sf -o /dev/null -w "%{http_code}" http://localhost:13133/
```

If it fails → STOP: tell the user to run `docker compose up -d` from docker-stack/.

Check Hooks Server:

```bash
curl -sf http://localhost:4319/health
```

If it fails → WARN (don't stop). The hooks server also runs the schema setup, and OTel + hooks mode needs it to receive hook events.

---

## Step 2 — Detect Project Name

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/init-claudalytics/settings-tool.mjs" --project-dir "${CLAUDE_PROJECT_DIR}" detect-name
```

It reads `project.name` from `OTEL_RESOURCE_ATTRIBUTES` in `.claude/settings.local.json`. That is the only place the name is stored. If there is no name there, it takes `project_name` from an old `.claude/analytics.json` (written by earlier versions), so the project keeps its dashboard history.

- **`existing` is set** → the project already has a name, and its dashboard history is under that name. If `existing.keep` is `true`, keep it **exactly as it is** (don't change `_` or anything else). Ask with `AskUserQuestion`: **Keep "<existing.value>" (Recommended)** or **Enter custom name**. If `existing.keep` is `false`, the name has a space, comma, `=`, `%` or quote, which `OTEL_RESOURCE_ATTRIBUTES` can't hold: offer **Use "<existing.suggested>" (Recommended)** and **Enter custom name**, and say that old rows stay under the old name.
- **`detected` is set** → no name yet. The tool tried `package.json`, then the git remote, then the folder name, and made the result safe. Ask: **Use "<detected.suggested>" (Recommended)** or **Enter custom name**.

For a custom name, run the tool with `normalize-name "<typed name>"` and use its `suggested` value.

Store the confirmed name as `PROJECT_NAME`. Remember whether the tool printed `existing` or `detected`, for `ACTION` in Step 10.

---

## Step 3 — Check for a Legacy Install

Claudalytics 1.0 installed hook scripts into every project and wrote 26 hook entries into `.claude/settings.local.json`. Look for them:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/init-claudalytics/settings-tool.mjs" --project-dir "${CLAUDE_PROJECT_DIR}" project-status
```

`legacyHookEntries` counts the hook entries that run `.claude/hooks/forward-hook.sh`, `.claude/hooks/session-start-health-check.sh` or `.claude/hooks/session-start-forward.sh`, or that post to `http://localhost:4319/hook`. `legacyHookScripts` lists those script files. Change nothing now: Step 8 removes the entries after it has backed up the file, and deletes the scripts only after the file no longer points at them. Hook entries that are not from Claudalytics stay.

---

## Step 4 — Detect the Current Capture Mode

```bash
claude plugin list --json
```

Look at the entries that apply to this project: scope `user`, or scope `project` / `local` with a `projectPath` equal to this folder.

- `CURRENT_MODE` = `otel+hooks` if `claudalytics-hook-capture@claudalytics` is installed and `enabled` for this project, else `otel-only`.
- Old copy: for `claudalytics@claudalytics`, check its folder (`readFromFolder` if the entry has it, else `installPath`). If that folder contains `hooks/hooks.json`, it is a 1.1.0 copy with the old hooks. Print this once, with the commands as they are:

  ```
  This project still has the old 1.1.0 hooks (WorktreeCreate bug). To update it, run:
    claude plugin marketplace update claudalytics
    claude plugin update claudalytics@claudalytics --scope project   (from this project's root folder)
  Then start a new session.
  ```

If `claude plugin list` fails, read `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json` (it has no tokens), and take the `enabledPlugins` entries from `hookCaptureEntry` (`.claude/settings.local.json`) and `sharedHookCaptureEntry` (`.claude/settings.json`) in the Step 3 output.

## Step 5 — Choose Capture Mode

Ask with `AskUserQuestion` (show `CURRENT_MODE`):

- **OTel only (Recommended)** — Claude Code's own telemetry. No Claudalytics hook runs.
- **OTel + hooks** — also turns on the `claudalytics-hook-capture` plugin for this project. It adds what OTel cannot give: config changes, folder changes (`cd`), the session end reason, WebSearch result URLs, and a stack health check at session start. Needs the hooks server. It also writes one `CwdChanged` hook that does nothing into `.claude/settings.local.json` (see Step 7).

Store the answer as `CAPTURE_MODE` (`otel-only` or `otel+hooks`).

---

## Step 6 — User OTel Settings (once per machine)

Claude Code 2.1.282 and later ignore the OTel export variables in project files, so they go in the user settings file:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/init-claudalytics/settings-tool.mjs" --project-dir "${CLAUDE_PROJECT_DIR}" user-status
```

It prints the file path (`USER_SETTINGS` for the report), whether the file exists, and its `state` against this block: the `missing` keys and, for each `different` key, your value and the Claudalytics value. It prints no other value from the file.

```
CLAUDE_CODE_ENABLE_TELEMETRY        = 1
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA = 1
OTEL_METRICS_EXPORTER               = otlp
OTEL_LOGS_EXPORTER                  = otlp
OTEL_TRACES_EXPORTER                = otlp
OTEL_EXPORTER_OTLP_PROTOCOL         = grpc
OTEL_EXPORTER_OTLP_ENDPOINT         = http://localhost:4317
OTEL_LOG_USER_PROMPTS               = 1
OTEL_LOG_TOOL_DETAILS               = 1
OTEL_LOG_TOOL_CONTENT               = 1
OTEL_METRIC_EXPORT_INTERVAL         = 10000
OTEL_LOGS_EXPORT_INTERVAL           = 5000
OTEL_RESOURCE_ATTRIBUTES            = project.name=unassigned
```

Don't add `OTEL_LOG_ASSISTANT_RESPONSES`. When it is unset, it follows `OTEL_LOG_USER_PROMPTS`.

- **`state` = `all_present`** → `USER_OTEL` = `keep`. Don't ask, don't write.
- **`state` = `some_missing`** → ask with `AskUserQuestion`:
  - **Add the missing keys (Recommended)** → `USER_OTEL` = `add_missing`
  - **Skip** → `USER_OTEL` = `keep` (telemetry stays off where nothing else sets it)
- **`state` = `some_different`** (for example another endpoint) → show each `different` key as `KEY: yours → Claudalytics`, then ask:
  - **Keep my values, add only the missing keys (Recommended)** → `USER_OTEL` = `add_missing`
  - **Use the Claudalytics values** → `USER_OTEL` = `replace`
  - **Skip** → `USER_OTEL` = `keep`

In the question, tell the user: "These settings turn on OTel export for every repo on this machine, and send prompts, commands and file paths to the local stack, and also tool content: the text of files Claude reads or writes, and command output (up to 60 KB per tool call, stored in `otel_traces`). A repo can turn this down in its `.claude/settings.local.json`: `none` for `OTEL_LOGS_EXPORTER`, `OTEL_METRICS_EXPORTER` and `OTEL_TRACES_EXPORTER` (no export), or `0` for `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS` and `OTEL_LOG_TOOL_CONTENT` (metadata only)."

---

## Step 7 — Project Settings (`.claude/settings.local.json`)

The tool makes these changes in Step 8. Nothing else in the file changes. In `env`:

1. Set `OTEL_RESOURCE_ATTRIBUTES` to `project.name=<PROJECT_NAME>`. If it already holds other `key=value` pairs (comma-separated), keep them and change only `project.name`.
2. Remove these keys. Claude Code ignores them in project files:
   - `CLAUDE_CODE_ENABLE_TELEMETRY`, except when the value is `0` or `false` (keep it: it turns telemetry off for this repo)
   - `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`, `ENABLE_ENHANCED_TELEMETRY_BETA`
   - `OTEL_LOGS_EXPORTER`, `OTEL_METRICS_EXPORTER`, `OTEL_TRACES_EXPORTER`, except when the value is `none` (keep it: it turns export off for this repo)
   - `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, except when the value is `0` or `false` (keep it: it turns capture off for this repo)
   - `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_RAW_API_BODIES`, `OTEL_RESOURCE_INCLUDE_HOST`
   - every `OTEL_EXPORTER_OTLP_*` key whose name ends in `_ENDPOINT`, `_HEADERS`, `_PROTOCOL`, `_CERTIFICATE`, `_CLIENT_KEY` or `_INSECURE`
3. Remove `OTEL_METRIC_EXPORT_INTERVAL` if it is `10000` and `OTEL_LOGS_EXPORT_INTERVAL` if it is `5000` (the user block has them). Keep other values.

In `hooks`: remove the legacy Claudalytics entries from Step 3, and an event key that ends up empty.

Also in `hooks`, the `CwdChanged` hook. Claude Code sends a folder change to a plugin only when a settings file has a `CwdChanged` hook too, so the plugin alone never gets the event.

- `CAPTURE_MODE` = `otel+hooks`: add this entry to `hooks.CwdChanged`, if it is not there yet. It does nothing; the hook-capture plugin does the forwarding.

  ```json
  {
    "hooks": [
      {
        "type": "command",
        "command": "exit 0 # claudalytics: lets the hook-capture plugin receive CwdChanged",
        "async": true
      }
    ]
  }
  ```

- `CAPTURE_MODE` = `otel-only`: remove that entry, and `CwdChanged` or `hooks` if it ends up empty.

JSON has no comments, so the text after `#` in the command marks the hook as ours: the tool adds and removes only a hook with exactly this command. Your own `CwdChanged` hooks and the hooks of other events stay as they are. `exit 0 # ...` is valid in every shell that can run a hook command: `sh` on macOS and Linux, Git Bash on Windows, and PowerShell on Windows without Git Bash.

In `enabledPlugins`: if `CAPTURE_MODE` = `otel-only`, set `"claudalytics-hook-capture@claudalytics": false`. If `CAPTURE_MODE` = `otel+hooks`, the entry is left to Step 9.

`keysToRemove` in the Step 3 output lists the env keys that go (names only).

## Step 8 — Back Up and Write the Settings Files

If `USER_OTEL` is `add_missing` or `replace`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/init-claudalytics/settings-tool.mjs" --project-dir "${CLAUDE_PROJECT_DIR}" user-write <add_missing|replace>
```

Then, always:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/init-claudalytics/settings-tool.mjs" --project-dir "${CLAUDE_PROJECT_DIR}" project-write "<PROJECT_NAME>" <otel-only|otel+hooks>
```

Each command does the whole change in one process: it reads the file (a BOM is fine), stops on invalid JSON or when `env` is not an object, backs up the file before the first write, writes 2-space JSON with the file's own line endings, reads it back, and compares every other top-level key with the backup. On any difference it puts the backup back and stops. A missing file is created, with no backup. `status` is `created`, `written` or `unchanged`, and `backup` is the backup path or `null`. `cwdChangedHook` is `added`, `already_there`, `removed` or `none`: remember it for the report.

`project-write` deletes the old 1.0 script files from Step 3 only after the settings file is written. It then deletes an old `.claude/analytics.json`, which nothing reads any more: if `removedAnalyticsFile` is `true`, remember it for the report. If `rawApiBodiesRemoved` is `true`, remember it for the report: `OTEL_LOG_RAW_API_BODIES` works only from the user settings file, and it records full API bodies from every repo, so the skill doesn't move it.

If a command exits with any code other than 0 → STOP and show its one-line message. Don't run Step 9 or later.

---

## Step 9 — Apply the Capture Mode

**`otel+hooks`:**

```bash
claude plugin install claudalytics-hook-capture@claudalytics --scope local
claude plugin enable claudalytics-hook-capture@claudalytics --scope local --json
```

`install` succeeds when the plugin is already installed. `enable` exits 1 when the plugin is already on: if its JSON has `"alreadyInGoalState": true`, count it as success. If `install` fails because the plugin is not found, the local marketplace copy is older than this release: tell the user to run `claude plugin marketplace update claudalytics` first, then the two commands. If a command fails for any other reason, don't retry. Tell the user to run both commands themselves: type each one with a `!` in front in the Claude Code prompt, or run them in a separate terminal from this project's root folder, or turn the plugin on in the **Installed** tab of `/plugin`.

**`otel-only`:** nothing to run. The `false` entry from Step 7 turns hook capture off for this project.

---

## Step 10 — Git-ignore the Backup Files

Add `.claude/*.claudalytics-backup-*` to the project's `.gitignore`, on its own line, if it is not already there. Don't remove a `.claude/analytics.json` line that an earlier version added.

The hook-capture plugin's `forward-hook.sh` reads `project.name` from `.claude/settings.local.json`. In a git worktree that has no such name, it reads the main checkout's file.

Set `ACTION` for the report: `initialized` if Step 2 printed `detected` (the project had no name before this run), `reconfigured` if something changed, `unchanged` if nothing changed.

---

## Step 11 — Report

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

  Project:       <PROJECT_NAME>
  Action:        <initialized | reconfigured | unchanged>
  Capture mode:  <OTel only | OTel + hooks>

  Files
    <USER_SETTINGS>              [OTel keys added / replaced / unchanged]
    .claude/settings.local.json  [updated / unchanged]
    Backups:                     [paths, or none]

  Services
    ClickHouse      http://localhost:8123   [STATUS]
    OTel Collector  http://localhost:4317   [STATUS]
    Grafana         http://localhost:13000  [STATUS]
    Hooks Server    http://localhost:4319   [STATUS]

  Dashboard: http://localhost:13000/d/claude-otel-overview
  Grafana:   admin / admin

  NEXT: run /reload-plugins or start a new session. New OTel settings apply in a new session.
```

Add these lines when they apply:

- The old-hooks warning from Step 4.
- If `cwdChangedHook` was `added`: "Added one `CwdChanged` hook that does nothing to `.claude/settings.local.json`. Claude Code sends folder changes to the hook-capture plugin only when a settings file has such a hook."
- If `cwdChangedHook` was `removed`: "Removed the Claudalytics `CwdChanged` hook from `.claude/settings.local.json`. OTel only mode does not record folder changes."
- If `removedAnalyticsFile` was `true`: "Removed the old `.claude/analytics.json`. The project name is now stored only in `.claude/settings.local.json`."
- "OTEL_LOG_RAW_API_BODIES was removed from this project file. It works only from the user settings file."
- "Project settings apply after you trust this folder. Until then, sessions here show as `unassigned`."
- In `otel+hooks` mode, if Step 9 could not run the commands: the two commands for the user to run (with `claude plugin marketplace update claudalytics` first if `install` said not found).
- Always: "Start Claude Code in this project's root folder. On Windows, Claude Code reads `.claude/settings.local.json` only from the folder you start it in, so a session started in a sub-folder shows as `unassigned`."
- Always: "A worktree that you make with `git worktree add` gets no `.claude/settings.local.json`, so its sessions show as `unassigned`. Copy this project's `.claude/settings.local.json` into such a worktree."

Mark all tasks as `completed`.
