# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/jimkeecn/Claudalytics/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/jimkeecn/Claudalytics/releases/tag/v1.1.0
[1.0.0]: https://github.com/jimkeecn/Claudalytics/commit/3a0a831
