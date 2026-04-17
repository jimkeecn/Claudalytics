<div align="center">

[English](README.md) | [中文](docs/README.zh-CN.md) | [日本語](docs/README.ja.md) | [Français](docs/README.fr.md) | [Deutsch](docs/README.de.md)

# Claudalytics

**Local analytics dashboard for Claude Code**

Track costs, tokens, tool usage, and session activity across all your projects.
Zero cloud dependencies. Your data stays on your machine.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Plugin-blueviolet)]()
[![ClickHouse](https://img.shields.io/badge/ClickHouse-24.8-yellow)]()
[![Grafana](https://img.shields.io/badge/Grafana-11.4-orange)]()

[Installation](#installation) · [Features](#features) · [Updating](#updating) · [Team Use](#team-use) · [Languages](#languages)

</div>

---

![Dashboard Overview](images/heroshot.png)

## Installation

### 1. Start the analytics stack

```bash
git clone https://github.com/jimkeecn/Claudalytics.git
cd Claudalytics/docker-stack
docker compose up -d --build
```

Wait ~30 seconds. Then go back to the repo root and open Claude Code:

```bash
cd ..
claude
```

Run `/validate-infra` to verify all 4 containers, tables, and materialized views are healthy.

### 2. Install the plugin in your project

Open any project in Claude Code and install the plugin:

```
/install-plugin /full/path/to/Claudalytics/plugin
```

### 3. Initialize

```
/init-claude-analytics
```

Follow the prompts — confirm your project name, and the skill configures everything.

### 4. Restart Claude Code and open dashboards

Restart your session for telemetry to take effect, then open:

**http://localhost:3000** (admin / admin)

Navigate to: **Home > Dashboards > Claude Analytics > Claude Analytics - OTel Overview**

That's it. Data starts flowing immediately.

---

## Features

### Session Timeline

Every action in a single view — prompts, API calls, tool executions, subagent dispatches, permission requests, compaction events — merged from OTel and hooks into one chronological timeline.

![Session History](images/sectionHistory.png)

### Cost & Token Analytics

Track spending across sessions, models, and projects. See cost per 1K output tokens, token usage over time, cache hit rates, and identify your most expensive sessions and prompts.

### Skill & Subagent Tracking

Monitor which skills and subagents Claude uses, their success rates, duration, and model selection. Spot inefficiencies — high re-invocation rates mean the first attempt likely failed.

<div align="center">
<img src="images/skillUsed.png" width="320" />
<img src="images/subAgents.png" width="640" />
</div>

### Credential Exposure Detection

Automatically detects when Claude reads sensitive files — `.env`, AWS credentials, SSH keys, certificates, database configs — across 38 patterns in 13 categories. No configuration needed. Powered by a ClickHouse materialized view that pattern-matches in real-time.

![Credential Exposures](images/credentialExposure.png)

### File Mutation Tracking

Every file Claude edits, writes, or deletes is tracked with action type, file extension, and directory. See which files get modified most and spot unexpected deletions.

![Most Modified Files](images/mostModifiedFiles.png)

### Blocked Action Detection

Tool calls that were denied or cancelled are automatically detected by tracking PreToolUse events that never received a PostToolUse response. Useful for auditing what Claude tried to do but was stopped from doing.

### Tool Latency & Slow URLs

Identify performance bottlenecks — which tools are slowest at p50/p95, and which URLs take the longest to fetch.

![Tool Latency and Slow WebFetch](images/slowAgentAndWebFetch.png)

### 37 Dashboard Panels

| Category | Panels                                                                                  |
| -------- | --------------------------------------------------------------------------------------- |
| KPIs     | Sessions, events, cost/1K tokens, total tokens, per-user cost                           |
| Cost     | Cost over time, top expensive sessions/prompts, cost per active minute, commits vs cost |
| Tools    | Tool usage, model usage, accept/reject rates, cache hit-rate                            |
| Latency  | API latency percentiles, tool execution latency, slowest WebFetch URLs                  |
| Timeline | Full session event history (2000 row limit)                                             |
| Workflow | Skills used, websites visited, MCP server calls, subagent usage                         |
| Files    | Most modified files with action breakdown                                               |
| Code     | Lines of code per user, prompt length distribution                                      |
| Security | Blocked actions, blocked rate over time, credential exposures                           |
| Ops      | Config changes, compaction events/frequency, recent errors                              |
| Feedback | Survey funnel                                                                           |

---

## Updating

```bash
cd Claudalytics
git pull
cd docker-stack
docker compose up -d --build
```

Additive schema changes (new tables, new materialized views) are applied automatically by the hooks-server on startup. If a release includes destructive schema changes (column type changes, re-partitioning), run `/migrate-db` from the Claudalytics project — it will walk you through a safe, side-by-side migration with backup prompts.

Then re-run `/init-claude-analytics` in each project to update hook scripts and configuration if a new version is available. The skill only updates what's behind — it won't touch what's already current.

---

## Team Use

This project is designed for individual developers. To adapt it for a team:

1. **Deploy to a shared server** — the Docker stack works on any server. Each developer points their OTel endpoint and hooks URL to the server address instead of localhost
2. **Add a team name attribute** — include `team.name` in `OTEL_RESOURCE_ATTRIBUTES` alongside `project.name`
3. **Update the forward skills** to forwarding the team.name as well in the forward scripts.
4. **Update ClickHouse tables** — add a `team_name` column to the target tables and materialized views
5. **Update Grafana** — add a Team dropdown variable and filter all panels by it

**Before deploying to a server, you must secure the stack:**

- Set a ClickHouse password (the default config has no authentication)
- Change the Grafana admin password
- Restrict port access with a firewall — only expose ports 4317 (OTel gRPC), 4319 (hooks), and 3000 (Grafana)
- Add TLS for encrypted transport

The Docker Compose file works on a cloud server as-is — but without these security steps, your telemetry data is exposed to anyone who can reach the ports.

---

<div align="center">

**Built with [Claude Code](https://claude.ai/code)**

If this project helps your workflow, give it a star!

</div>
