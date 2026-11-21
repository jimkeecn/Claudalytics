# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-11-21

### Added

- **Transcript backfill** (`docker-stack/hooks-server`, `npm run backfill -- --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--dry-run]`). Recovers telemetry from Claude Code's local session journals (`~/.claude/projects/**/*.jsonl`) for windows when the OTel pipeline was offline — the live ingest path has no buffer, so stack downtime is otherwise silent, permanent data loss. Emits through the same OTLP path, preserves original timestamps, idempotent by `request_id`. See the README section [Recovering missed telemetry](README.md#recovering-missed-telemetry-transcript-backfill).
  - **Scope is limited to `api_request` rows** (one per assistant turn): `model`, token counts and an estimated cost. Rows are tagged `event.source=transcript_backfill`; `duration_ms` is left blank (absent from transcripts).
  - **The cost of a backfilled row is estimated from your own data.** Transcripts hold tokens but no cost, and the repo has no price list. At each run the tool works out the price per token type (input, output, cache read, 5-minute and 1-hour cache write) of each model from the real `api_request` rows in ClickHouse, writes the result to `cost_usd` and marks the row with `cost_usd_source=estimated`. Real rows whose cost is more than their tokens (a web search request has a fee per search) are left out of the rates. A model gets no cost when one set of rates explains fewer than 20 of its real rows, or less than half of them. `--dry-run` prints the rates per model, the number of real rows behind them, the fit error and the total cost. The cost panels now include backfilled rows.
  - **Not recoverable from transcripts:** hook events (`PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`SessionStart`, …), `tool_result`/`tool_decision`, file mutations, blocked tools, websites visited, traces, and metrics. The materialized views fed by those events stay empty for an outage window.
- **Test stack** (`docker-stack/docker-compose.test.yaml`). Runs a second stack (project `claudalytics-test`) with its own container names (`cctest-*`), volumes, hooks-server image tag and local-only ports, for development and migration tests. Always pass both files, in this order: `docker compose -f docker-compose.yaml -f docker-compose.test.yaml <command>`. In the other order, the command targets the live project.
- **Test stack keeps the seeded live data** (`docker-stack/clickhouse/test-no-ttl-merges.xml`, mounted only by `docker-compose.test.yaml`). It sets `max_number_of_merges_with_ttl_in_pool` to `0`, so the test ClickHouse assigns no TTL merge and doesn't delete the copied rows that are older than 90 days.
- **`CLAUDALYTICS_HOOKS_URL`**: when it is set, `forward-hook.sh` posts to that hooks server instead of `http://localhost:4319`.
- **OTel-fed materialized views** (`docker-stack/clickhouse/init/013_otel_mvs.sql`). Ten views fill `credential_exposures`, `file_mutations`, `blocked_tools`, `compaction_events` and `websites_visited` from Claude Code's own `tool_result`, `tool_decision` and `compaction` events, so this data no longer needs hooks. Schema v3 creates all ten (Edit, Write, shell deletes, credential file reads, rejected tool calls, compactions, WebSearch queries, WebFetch URLs, shell URLs, MCP page fetches), so an upgrade from 1.1.0 captures all of this right after the stack rebuild. They write into the existing tables, so old rows stay visible.
- **Deletes in shell commands are tracked, in Bash and in PowerShell.** A delete is `rm`, `del`, `rmdir`, `unlink`, `Remove-Item` or `ri`, and the row stores the real tool name.
  - Every delete in a command gets a row: `rm a.txt && rm -f b.txt` gives two rows. A delete of several files gives one row per file: `rm a.txt b.txt` gives two rows.
  - When the command starts with `cd <folder> &&` (or `;`) and has no other `cd`, a relative path is stored as `<folder>/<path>`.
  - Flags are skipped (such as `-v`, `--force`, `--`, `-Recurse`), also after the path (`Remove-Item x -Recurse -Force` stores `x`). Quotes keep a path with spaces in one piece.
  - A delete counts only as a command word, so `grep -ri`, `docker run --rm` and an `rm x` inside a quoted text are not deletes.
  - Known limit: OTel keeps only about the first 128 characters of a PowerShell command that is longer than 512 characters, so a delete or URL after that point is missed. Bash is not affected, because OTel sends its full command.
- **A credential file read through the shell or through Grep is flagged.** Credential Exposures saw only the Read tool. It now also sees `cat`, `type`, `head`, `tail`, `less`, `more`, `Get-Content` and `gc` in a Bash or PowerShell command, and a Grep whose `path` is such a file. All of them use the same 38 file-name patterns. A path from a shell command is stored as it was written, so it can be relative.
- **Websites Visited has more sources and fewer wrong rows.**
  - URLs in PowerShell commands are tracked, like URLs in Bash commands.
  - A URL in a shell command counts only when it is an argument of a fetch command: `curl`, `wget`, `Invoke-WebRequest`, `iwr`, `Invoke-RestMethod` or `irm`. A URL that is only text (a prompt for `claude -p`, an `echo`, the body of a heredoc, a request body or header) gets no row. One command gives at most 10 rows.
  - A page fetched through an MCP tool gets a row, when the tool has a `url` or `urls` input. The tool column shows `mcp__<server>__<tool>`.
  - Local addresses (`localhost`, `127.0.0.1`, `::1`, `host.docker.internal`) are left out, so health checks no longer show as websites.
- **The text of a credential file is not stored** (processor `transform/redact_credential_content` in `docker-stack/otel-collector-config.yaml`). With `OTEL_LOG_TOOL_CONTENT=1`, Claude Code sends the text of every file it reads to `otel_traces`. When the file name matches one of the Credential Exposures patterns, the collector now stores `[redacted: credential file]` in place of the text. This covers the Read tool, the text of a Write or Edit in the trace, and the output of a Bash command that reads the file with `cat`, `type`, `head`, `tail`, `less`, `more`, `Get-Content` or `gc`. The row in Credential Exposures stays. Not covered: a secret typed in a command, the output of other commands (`grep`, `sed`, `env`, a script), the `tool_input` of a Write or Edit in `otel_logs`, a prompt or an answer that repeats the secret, and the full API bodies of `OTEL_LOG_RAW_API_BODIES`. Rows stored before this change keep their text until they expire. The collector reads its config only at start, so restart it after the update (`docker compose restart otel-collector`).
- **New columns** (`docker-stack/clickhouse/init/012_otel_columns.sql`): `blocked_tools.decision_source` (`user_reject`, `user_abort` for an interrupted permission ask, `config` or `hook`), `compaction_events.duration_ms`, `pre_tokens`, `post_tokens` and `success`, and `websites_visited.search_query` (the WebSearch query). Old rows get empty or zero values.
- **Hook rows carry `prompt.id`**, so they join to prompt cost.
- **Every record says what wrote it.** In `otel_logs` the attribute `event.source` is `otel` (Claude Code's own telemetry, set by the collector on a record that has no value yet), `hook` (the hook-capture plugin, set by the hooks server) or `transcript_backfill`. The five tables behind the panels (`credential_exposures`, `file_mutations`, `blocked_tools`, `compaction_events`, `websites_visited`) have a new `source` column (`docker-stack/clickhouse/init/015_source_column.sql`): the view `websites_visited_search_mv` writes `hook`, the other ten views write `otel`. Rows from before schema v7 keep an empty source. Session History, Websites Visited, Credential Exposure Detail and Most Modified Files show the source as a column. No row is removed as a duplicate: one WebSearch call shows as an OTel row (the query) and as hook rows (the result URLs).
- **Folder changes (`CwdChanged`) arrive in OTel + hooks mode.** Claude Code sends this event to a plugin only when a settings file has a `CwdChanged` hook too, so the hook-capture plugin alone never got it. `/init-claudalytics` now writes one `CwdChanged` hook that does nothing (`exit 0 # claudalytics: ...`) into `.claude/settings.local.json` in OTel + hooks mode, and removes exactly that hook in OTel only mode. Your own hooks stay. Run `/init-claudalytics` once more in a project that already uses OTel + hooks mode.
- **New optional plugin `claudalytics-hook-capture`** (`plugin-hook-capture/`, off by default with `defaultEnabled: false`). It forwards only the events OTel cannot give: SessionStart, SessionEnd, ConfigChange, CwdChanged, InstructionsLoaded, Notification, SubagentStart, Elicitation, ElicitationResult, TeammateIdle, and PostToolUse for WebSearch. Its forwarders run async, print nothing and add `via=hook-capture`.
- **Dashboard "Memory Files" panel.** It lists the auto-memory files that Claude wrote or edited (`~/.claude/projects/<project>/memory/`), from `file_mutations`. Reading a memory file is not visible, only writes. The dashboard now has 38 panels.
- **Full text in dashboard tables.** No panel query cuts text any more. A table still shows one line per row: hover a cell and click the eye icon (inspect) to read the whole value. Cell inspect is on in Session History, Top Expensive Prompts, Recent Errors, Websites Visited, Slowest WebFetch URLs, Memory Files, Subagent Usage, Blocked Actions by Tool, Compaction Events, Config Changes Audit Log, Credential Exposure Detail and Most Modified Files.
- **Dashboard variable "Startup events"** (Hide / Show, default Hide). Session History hides the events that Claude Code sends at every start (`plugin_loaded`, `hook_registered`, `mcp_server_connection`, `managed_settings_resolved`). Pick Show to see them.

### Changed

- **Dashboard "API Latency Percentiles per Model [KAN-22]"** now groups dynamically by `model` instead of two hardcoded model strings, so every model (incl. new releases) appears with no dashboard edit.
- **Schema v4 drops the 11 hook-fed materialized views** through a new drop-only step in `/migrate-db`. The tables and their rows are kept. Fresh installs no longer create these views and record v4 by themselves. `websites_visited_search_mv` stays.
- **Schema v5 drops the old WebSearch result view, `sessions_mv` and the old `sessions` table** (destructive, a new step in `/migrate-db`). The views are `websites_visited_search_mv` and `sessions_mv`. No OTel-fed view is dropped. The five target tables and their rows are kept. A fresh install records v5 by itself.
- **Hook rows store Claude Code's ids under the OTel names.** The tool call id is `tool_use_id` (was `use_id`) and the subagent id is `agent_id` (was `agent.id`), as on OTel rows, so a hook row and an OTel row of the same call can be matched. Hook rows that are already stored keep the old names; Session History reads both. No id is made up: an event that Claude Code sends without an id has none.
- **Schema v7 is applied automatically** when v6 is recorded and the hooks server starts. It adds the `source` column and gives each of the 11 views its new query in place (`ALTER TABLE ... MODIFY QUERY`). Nothing is dropped and no event is missed, so it needs no `/migrate-db` step.
- **Schema v6 is applied automatically** when v5 is recorded and the hooks server starts (`014_otel_views_v2.sql`). It creates `websites_visited_search_mv` again, now without local addresses, and creates `sessions` as a view. It also runs `013_otel_mvs.sql` once more, which creates only an OTel-fed view that is missing.
- **`sessions` is a plain view over `otel_logs`**, no longer a table filled by `sessions_mv`. The table kept only the last insert batch of a session, so `started_at` and `otel_event_count` were wrong, and `has_hook_data` could be 0 for a session with hook rows. The view is right for every session, also for events that arrived before the upgrade, and needs no backfill. It lives as long as `otel_logs` (90 days), the same as the old table. The Project and Session drop-downs of the dashboard read it.
- **Schema version numbers.** Version 2 is reserved (the `claudalytics-saas` repo uses it). The hooks-server bootstrap now applies every migration that is not recorded in `schema_version`, not only versions above the highest one, so an upgrade and a fresh install (1, 3, 4, 5, 6, 7) both work. It stops at the first migration that is not applied, so a later one never runs before an earlier one, and a pending v4 or v5 is never hidden.
- **`/validate-infra`** expects schema v7, the new list of 11 materialized views and `sessions` as a view. It reports any legacy hook view that is left, reports a pending v4 or v5 as "run `/migrate-db`", and marks the hook receiver as optional (used in hooks mode).
- **hooks-server re-emits only marked requests** (`via=hook-capture`, from the hook-capture plugin), and only the events OTel cannot give (`PostToolUse` only for WebSearch), so an old 1.1.0 plugin copy can't double count. Every request is still written to the JSONL log.
- **hooks-server answers `{}` to every hook**, so old v1.0 HTTP hooks no longer add text to Claude's context.
- **hooks-server startup text** describes its role: schema bootstrap, `/health`, transcript backfill and the optional hook receiver. It no longer says to configure hooks in `.claude/settings.local.json`.
- **The `claudalytics` plugin ships no hooks.** All hooks moved to `claudalytics-hook-capture`, so with only `claudalytics` enabled, Claude Code registers no Claudalytics hook.
- **The SessionStart health check moved to `claudalytics-hook-capture`.** It prints nothing when the stack is healthy and only a short `systemMessage` when it is not, never text for Claude's context. It reads `CLAUDALYTICS_HOOKS_URL` and `CLAUDALYTICS_CONTAINER_PREFIX` (default `claudalytics`).
- **The health check never holds up a session.** It runs only at startup and resume (not after `/compact` or `/clear`), has a 5-second hook timeout, makes one `docker inspect` call instead of four, and stops waiting for Docker after 2.5 seconds, so a hanging Docker gives a warning in about 3 seconds.
- **`/init-claudalytics` writes the OTel export variables to the user settings file** (`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json`), because Claude Code 2.1.282 and later ignore them in project files. It adds only missing keys, asks before it changes a key with a different value (for example another endpoint), and doesn't add `OTEL_LOG_ASSISTANT_RESPONSES`.
- **`/init-claudalytics` keeps only `project.name` in `.claude/settings.local.json`.** It removes the telemetry keys Claude Code ignores there (also `OTEL_LOG_RAW_API_BODIES`), but keeps a repo's opt-out values (`none` exporters, `0` content flags, `CLAUDE_CODE_ENABLE_TELEMETRY=0`) and every other key.
- **`/init-claudalytics` asks for a capture mode**, OTel only (default) or OTel + hooks, and turns `claudalytics-hook-capture` on or off for the project. Run it again to switch. If the CLI can't run inside the session, it prints the two commands to run with `!` or in a terminal, and says to run `claude plugin marketplace update claudalytics` first when the plugin is not found.
- **`/init-claudalytics` backs up every settings file before it changes it** (`<file>.claudalytics-backup-<time>`), adds `.claude/*.claudalytics-backup-*` to the project's `.gitignore` so a backup is never committed, changes nothing when it runs again with the same answers, and warns when the project still has an old 1.1.0 copy with hooks, with the commands that update it.
- **`/init-claudalytics` never prints a settings file.** It reads and changes the settings files only through `settings-tool.mjs` (one Node.js process per step), which prints just the values the step needs. The tool stops on invalid JSON or a non-object `env`, keeps a BOM and the file's line endings, writes through a temp file and a rename, and reads the file back after the write: if the write fails or anything outside the changed keys differs, it puts the backup back and stops. Every failure, also a read-only file, is one short message. It also stops on a number with 16 or more digits (which it could not keep exactly), hides the user and password in an endpoint URL that it shows, and finds the project root with git when the project folder is not given. Node.js is now required.
- **`/init-claudalytics` keeps an existing project name as it is**, unless it has a space, comma, `=`, `%` or quote, so a project's history doesn't split across two names. A new name still gets spaces and underscores turned into hyphens. The fallback from `package.json` to the git remote and the folder name now works.
- **The project name is stored in one place only**: `project.name` in `OTEL_RESOURCE_ATTRIBUTES` of `.claude/settings.local.json`. `/init-claudalytics` no longer writes `.claude/analytics.json`: it takes the name from an old file when the settings file has none, then deletes the file. `forward-hook.sh` reads the name from `.claude/settings.local.json`.
- **`/init-claudalytics` report** says to start Claude Code in the project's root folder (on Windows a session started in a sub-folder shows as `unassigned`), and to copy `.claude/settings.local.json` into a worktree made with `git worktree add`, which otherwise shows as `unassigned`.
- **`/migrate-db` drop steps (v4 and v5) count only rows newer than one cutoff, 89 days back**, and use the same cutoff value for the count before and the count after (and `blocked_tools` with `FINAL`), so a TTL purge or a merge can't look like data loss. If a count still goes down, the skill stops and asks instead of suggesting a restore. After each step it restarts the hooks server.
- **Marketplace description** says "OTel analytics for Claude Code, with optional hook capture" instead of "OTel + Hooks analytics".
- **`/migrate-db` backup command** works in Git Bash on Windows (`MSYS_NO_PATHCONV=1`) and writes the tarball to a folder outside the repo.
- **Dashboard Config Change panels** say that they need OTel + hooks mode, and the audit log shows this text when it is empty.
- **Dashboard "Blocked Actions" and "Blocked Rate"** split rejected calls by reason (`user_reject`, `user_abort`, `config`, `hook`). Rows written by hooks before the upgrade show as `legacy: no PostToolUse`.
- **Dashboard compaction panels** read the OTel compaction event, with its duration and tokens. Older hook pre/post pairs still show, with a computed duration.
- **Dashboard "Websites Visited"** shows the WebSearch query.
- **Dashboard "Session History"** also shows `assistant_response`, `api_refusal`, `api_retries_exhausted` and `subagent_completed`, and marks subagent tool calls with `↳`.
- **Dashboard "Session History" rows say more.** A Write, Edit or Read result shows the file path. A tool decision shows what was accepted or rejected: the Bash command, the MCP tool, the skill or the subagent type. The detail column holds the full text and fills the panel, so the table needs no side scroll.
- **Dashboard "Top Expensive Prompts"** has one row per prompt (it groups by prompt id), and the prompt is the first column.
- **Dashboard "Skills Used"** shows the number of calls per trigger (slash command, nested skill, other) and the last use, in place of the duration and success columns.
- **Dashboard "Subagent Usage"** has the columns `completed_runs`, `total_run_ms` and `avg_run_ms` in place of `total_duration_ms` and `avg_duration_ms`. A run is one finished turn of a subagent, so a subagent that is continued later counts as more than one run, and a subagent that is still running is not counted yet.
- **Dashboard "Commits vs Cost per Day"** says in its description that the commit count can be too high.
- **Dashboard table columns** for prompts, session ids, URLs, skill names and error details are wider.

### Fixed

- **Session History no longer shows `?` rows.** `hook_registered`, `plugin_loaded`, `managed_settings_resolved`, `retention_sweep`, `at_mention`, `auth` and the raw API body events now have a kind and a short detail. A plugin row prints `@version` only when the plugin has a version. An event the panel does not know yet shows its event name instead of `?`.
- **Worktrees work again while the plugin is enabled.** Removed the `WorktreeCreate` and `WorktreeRemove` hooks. `WorktreeCreate` broke every worktree (`claude --worktree`, worktree subagents, `EnterWorktree`), because Claude Code read the hook output as the worktree path. `WorktreeRemove` could mark a worktree as removed without deleting it.
- **`forward-hook.sh` prints nothing.** It used to print `{"continue": true}`, and some hook events read that output as data. It still exits 0.
- **A migration that fails is no longer recorded as applied.** If one of its SQL files fails, is missing or has no statement, the hooks server doesn't record the version, lists it in `mvs_pending`, shows `bootstrap: "error"` in `/health` and tries again every 30 seconds.
- **Hook rows from a git worktree keep the project name.** When the worktree's `.claude/settings.local.json` has no `project.name`, `forward-hook.sh` reads the main checkout's file instead of using the folder name.
- **A project name with spaces or `&`, `#` no longer loses hook requests.** `forward-hook.sh` URL-encodes the name, so the request and its `via=hook-capture` marker arrive intact.
- **Dashboard "Total Tokens"** now counts cache tokens (`cache_read_tokens`, `cache_creation_tokens`). It read attribute names that OTel doesn't send.
- **Dashboard "Session History"** shows user prompts again (a message sent while Claude works shows as `prompt (mid-turn)`), reads `skill.name` and `response`, and shows a hook row only when OTel has no row for the same thing.
- **Dashboard "Total OTel Events", "Events Over Time" and "Model Usage"** no longer count hook rows. Model Usage counts API requests only. Totals for dates before the upgrade go down, because the old hook rows in `otel_logs` are no longer counted.
- **Dashboard "Recent Errors"** has its own panel id (43). It shared id 29 with "Memory Files".
- **Dashboard "Prompt Length Distribution"** counts each turn once, so a message sent while Claude works is not a new prompt. "Top Expensive Prompts" shows the first prompt of the turn.
- **Messages that the user did not type are no longer counted as prompts.** Claude Code stores an agent hand-back (text that starts with `<agent-message`) and a task notification (`<task-notification`) as `user_prompt` events. "Prompt Length Distribution", "Top Expensive Prompts" and the prompts column of "Per-User Cost Leaderboard" leave them out. "Session History" shows them as `agent hand-back` and `task notification`.
- **Dashboard "Total Sessions" and the sessions column of "Per-User Cost Leaderboard"** count only sessions with a prompt or an API call. A start with `--continue` sends its startup events under a session id that is never used again, and these ids were counted as sessions.
- **Dashboard "Total Sessions"** follows the time range and the Session filter of the dashboard. It counted every session of the project, whatever time range or session was picked.
- **Dashboard "Cache Hit-Rate Trend"** includes cache creation tokens: `cache_read / (cache_read + cache_creation + input)`. Without them the rate was always close to 100%.
- **Dashboard "Subagent Usage"** shows the real model and the real run time of a subagent, from its `subagent_completed` events. It showed the model as `inherit`, and for a background subagent the few milliseconds that the Agent tool call takes. The model is still `inherit` when a subagent has no finished run and no model of its own.
- **Dashboard "Skills Used"** counts every skill activation (`skill_activated` events). It counted only calls of the Skill tool, so a skill started with a slash command was missing.
- **Dashboard "Tool Usage", "Tool Execution Latency Percentiles" and "Tool Decisions"** leave out `SubagentHandback`, an internal tool of Claude Code.
- **Dashboard "Recent Errors"** shows the error text first, then the tool input.
- **Dashboard "API Latency Percentiles per Model"** leaves out an API request that has no duration. A row from the transcript backfill has none, and it was counted as 0 ms, which pulled the percentiles down.
- **hooks-server tests pass on a Windows checkout.** A new `.gitattributes` keeps LF line endings in `plugin/skills/init-claudalytics/settings-tool.mjs`: with `core.autocrlf`, its first line ended in CRLF and vitest could not load the file. In a checkout that still has CRLF, delete the file and run `git checkout -- plugin/skills/init-claudalytics/settings-tool.mjs` once.

### Removed

- **The hooks of the `claudalytics` plugin** (`plugin/hooks/`). The optional `claudalytics-hook-capture` plugin has the few hooks that are left.
- **The 11 hook-fed materialized views** and their SQL files (schema v4).
- **The `sessions` table and `sessions_mv`** (schema v5). `sessions` is now a view.
- **`.claude/analytics.json`.** `/init-claudalytics` deletes it when it runs again.

### Documentation

- **README and the four translations** describe the OTel-only default, the optional hook-capture plugin, the new place for the OTel variables, what they capture from every repo and how a repo opts out, the upgrade order from 1.1.0, rollback, known limits, and how to move a pinned marketplace.
- **`docker-stack/README.md`** describes the hooks server's role, `CLAUDALYTICS_HOOKS_URL` and the test stack, and no longer says that `/init-claudalytics` creates `sessions_mv`.
- **The README no longer links to `docs/transcript-backfill.md`**, which never existed. The README backfill section is the reference.
- **README "Known limits"** has new entries: a failed Edit is not recorded, the commit count can be too high, a session started in a sub-folder shows as `unassigned` on Windows, what the credential file redaction does not cover, events sent while the collector is down are lost, which shell URLs and deletes are not seen, old rows keep the old rules, and the subagent type, git branch and commit id are not shown.
- **README** describes schema v5, v6 and v7 in the upgrade steps, the source label, the id names on hook rows, the `CwdChanged` settings hook, the full-text inspect in tables, the "Startup events" variable and the 38 panels.
- **`/migrate-db` and `/validate-infra`** describe the v5 and v6 steps, the automatic v7 step and the new view list.

### Migration

From 1.1.0 or 1.0.0, follow [Upgrading from 1.1.0](README.md#upgrading-from-110) in the README, in that order. In short:

1. Close every Claude Code session and back up the ClickHouse volume.
2. Add the OTel block to the user settings file, start a new session in each project and check that OTel rows arrive. Do this before `git pull`.
3. `git pull`, then `docker compose up -d --build` and `docker compose restart otel-collector` in `docker-stack`. The hooks server applies schema v3 by itself: it creates the ten OTel-fed views, so nothing is missed between this step and step 4.
4. Run `/migrate-db` in the Claudalytics repo, right after step 3. It applies the two destructive steps, v4 and v5, and restarts the hooks server, which then applies v6 and v7 by itself.
5. Update the plugins: `claude plugin marketplace update claudalytics`, then `claude plugin update claudalytics@claudalytics` in each project.
6. Run `/init-claudalytics` again in each project. It also removes the 1.0.0 per-project hook files and the old `.claude/analytics.json`, and in OTel + hooks mode it writes the `CwdChanged` settings hook.
7. Optional: `npm run backfill` for the days when OTel export was off.

What the schema steps do to your data:

- **v3, v6 and v7 (automatic)** only add columns and views, and v7 changes the query of the views in place. No row is changed or deleted. Rows from before v7 have an empty `source`.
- **v4 (`/migrate-db`)** drops the 11 hook-fed views. No table is dropped.
- **v5 (`/migrate-db`)** drops two views (`websites_visited_search_mv`, `sessions_mv`) and the old `sessions` table. No OTel-fed view is dropped. The rows of `credential_exposures`, `file_mutations`, `blocked_tools`, `compaction_events` and `websites_visited` are kept. The rows of `sessions` are dropped, and the new `sessions` view gives the same sessions again from `otel_logs`.
- Rows that are already stored keep the old rules. The new rules for deletes, credential reads and websites count for new events only.
- **Nothing is missed between step 3 and `/migrate-db`.** In our test of this time window, 13 of 13 kinds of events got their row (file edits and writes, shell deletes, credential file reads, rejected tool calls, compactions, URLs from WebFetch, shell commands and MCP tools, WebSearch queries). Still do step 4 right after step 3: until then the old views and the old `sessions` table are still there. During the v5 step itself (about 15 seconds) the Project and Session drop-downs of the dashboard are empty, and in OTel + hooks mode a WebSearch gets no rows for its result URLs.

## [1.1.0] - 2026-04-21

### Changed

- **Hooks moved into the plugin.** Hook scripts (`forward-hook.sh`, `session-start-health-check.sh`) now ship in `plugin/hooks/` and are referenced via `${CLAUDE_PLUGIN_ROOT}`. Hook declarations live in `plugin/hooks/hooks.json` and apply automatically whenever the plugin is enabled. Projects no longer carry per-project copies of the scripts or 26 hook entries in their `.claude/settings.local.json`.
- **`forward-hook.sh` resolves `projectName` at runtime.** It reads `$CLAUDE_PROJECT_DIR/.claude/analytics.json`, falling back to the directory basename. No per-project URL baking required.
- **`/init-claudalytics` slimmed down.** New flow: health check → detect project name → clean up legacy install → write OTel env vars → write `analytics.json` → report. Per-script compatibility tracking removed (scripts are now versioned with the plugin).
- **`.claude/analytics.json` shrunk** to `{ project_name, configured_at }`. The `health_check_script`, `forward_script`, and `hooks_config` fields are no longer written.
- **Hooks server: TypeScript migration + unit tests.** Internal refactor; no API change.
- **Session history: duplicate events deduplicated** between the OTel and hooks pipelines for a cleaner timeline.

### Removed

- `plugin/skills/install-hook-forward/` skill.
- `plugin/skills/install-hook-health-check/` skill.

### Fixed

- Docker compose now comes up cleanly on first boot without needing a retry.

### Documentation

- README FAQ entry for the Windows WinNAT port conflict (`net stop winnat` / `net start winnat`) that can block port 4318 at `docker compose up` time.

### Migration

Run `/init-claudalytics` once in every project that was configured under 1.0.0. Step 3 automatically removes the legacy `.claude/hooks/*.sh` files and prunes the stale hook entries from `.claude/settings.local.json`. OTel env vars and the project name are preserved.

## [1.0.0] - 2026-04-17

### Added

- Initial open-source release.
- ClickHouse + OTel Collector + Grafana Docker stack (`docker-stack/`).
- Hooks capture server on port 4319 with ClickHouse schema auto-bootstrap.
- Claudalytics plugin with `/init-claudalytics`, `/preflight-check`, `/validate-infra`, `/migrate-db` slash commands.
- 37-panel Grafana dashboard: sessions, cost, tokens, tool usage, latency, security, workflow analytics.
- Materialized views for credential exposure detection, file mutation tracking, blocked action detection, and websites visited.

[Unreleased]: https://github.com/jimkeecn/Claudalytics/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/jimkeecn/Claudalytics/releases/tag/v2.0.0
[1.1.0]: https://github.com/jimkeecn/Claudalytics/releases/tag/v1.1.0
[1.0.0]: https://github.com/jimkeecn/Claudalytics/commit/3a0a831
