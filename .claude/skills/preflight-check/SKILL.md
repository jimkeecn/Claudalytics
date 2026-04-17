---
name: preflight-check
description: Pre-install port availability check for the Claudalytics Docker stack. Verifies all required host ports are free before `docker compose up`. Does NOT change any port, does NOT modify any file — it only reports conflicts and asks the user to free the ports.
---

# /preflight-check

Read-only host port availability check. Run this **before** `docker compose up -d` to avoid cryptic Docker bind errors.

**Design rule:** This skill NEVER suggests changing Claudalytics' own ports. The hook scripts, OTel exporter env vars, and internal container configs are tightly coupled to these port numbers — changing them cascades into per-project configuration and breaks existing installs. If a port is in use, the user must free it.

## Required host ports

| Port  | Purpose                        |
| ----- | ------------------------------ |
| 13000 | Grafana UI                     |
| 4317  | OTel collector (gRPC receiver) |
| 4318  | OTel collector (HTTP receiver) |
| 4319  | Hooks server                   |
| 8123  | ClickHouse HTTP interface      |
| 9000  | ClickHouse native TCP          |
| 13133 | OTel collector health endpoint |

## Step 1 — Detect if our stack is already running

If our containers are already up, they legitimately hold these ports — that's not a conflict.

```bash
docker ps --filter "name=claudalytics" --format "{{.Names}}" 2>/dev/null
```

If any of `claudalytics-clickhouse`, `claudalytics-otel`, `claudalytics-hooks`, `claudalytics-grafana` appear, mark those ports as "held by us" and skip the conflict check for them. If all 4 are running, report "Stack already running" and stop.

## Step 2 — Detect platform

```bash
uname -s
```

`Linux` / `Darwin` / `MINGW*` / `MSYS*` → Step 3a. Otherwise → Step 3b.

## Step 3a — Check each port (Linux / macOS / Git Bash / WSL)

For each port, prefer `lsof`; fall back to `ss` then `netstat`.

```bash
lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null \
  || ss -lntp "sport = :$PORT" 2>/dev/null \
  || netstat -ano 2>/dev/null | grep -E "LISTEN(ING)?" | grep -E "[:.]$PORT\b"
```

Record `available` / `in_use`. If in use, capture PID and process name.

## Step 3b — Check each port (Windows PowerShell)

```powershell
Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object {
    $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
    "$($_.OwningProcess) $($proc.ProcessName)"
  }
```

Invoke from bash via `powershell.exe -NoProfile -Command "..."` if needed.

## Step 4 — Report

```
Claudalytics — Preflight Port Check
====================================

  Required Host Ports
  ───────────────────
    13000   Grafana UI                       [AVAILABLE / IN USE by <process> (PID <pid>) / held by claudalytics-grafana]
    4317    OTel collector (gRPC)            [...]
    4318    OTel collector (HTTP)            [...]
    4319    Hooks server                     [...]
    8123    ClickHouse HTTP                  [...]
    9000    ClickHouse native TCP            [...]
    13133   OTel collector health            [...]

  Result: [All ports available — safe to run 'docker compose up -d'
         / N conflict(s) found — free the listed ports before continuing
         / Stack already running — run /validate-infra to check health]
```

## Step 5 — If conflicts exist, give actionable terminate commands

For each conflict, print process info and the platform-appropriate kill command. NEVER suggest remapping Claudalytics ports.

```
Conflicts
─────────
Port 13000 is held by: node (PID 28431)
  To free:
    Linux/macOS/WSL     kill 28431       (or kill -9 28431 if it won't exit)
    Windows PowerShell  Stop-Process -Id 28431 -Force
    Windows cmd         taskkill /PID 28431 /F
```

End with:

```
Free the listed ports and re-run /preflight-check.
Do NOT change the ports in docker-compose.yaml — Claudalytics' hooks
and OTel exporter are configured for these exact port numbers.
```

## Step 6 — Exit condition

- **All available** → tell the user: `Safe to proceed. Run: cd docker-stack && docker compose up -d --build`
- **Any in use (not by us)** → STOP. Do not propose port changes. Do not attempt `docker compose up`.
- **All held by our containers** → `Stack already running. Run /validate-infra to check health.`

## Notes

- This skill is **read-only**. It does not start, stop, or modify anything.
- If the user cannot free a port (e.g., a shared corporate service), that is a deployment blocker. Document it for them; do not offer workarounds that change Claudalytics' port numbers.
- Keep the port list above in sync with `docker-stack/docker-compose.yaml`. If the compose file changes the host-side mappings, update this skill.
