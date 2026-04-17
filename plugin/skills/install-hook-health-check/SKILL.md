---
name: install-hook-health-check
description: Install the SessionStart health check script (.claude/hooks/session-start-health-check.sh). Always writes the script when invoked.
---

# install-hook-health-check

## Step 1 — Create directory

```bash
mkdir -p .claude/hooks
```

## Step 2 — Write script

Write this exact content to `.claude/hooks/session-start-health-check.sh`:

```bash
#!/usr/bin/env bash
# Claudalytics - SessionStart health check hook
# VERSION: 1.0.0

DOCKER_CONTAINERS=("claudalytics-clickhouse" "claudalytics-otel" "claudalytics-grafana" "claudalytics-hooks")
HOOKS_SERVER_URL="http://localhost:4319/health"

docker_healthy=true
hooks_healthy=true
down_containers=()

for container in "${DOCKER_CONTAINERS[@]}"; do
  running=$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)
  if [ "$running" != "true" ]; then
    docker_healthy=false
    down_containers+=("$container")
  fi
done

hooks_status=$(curl -sf -o /dev/null -w "%{http_code}" "$HOOKS_SERVER_URL" 2>/dev/null)
if [ "$hooks_status" != "200" ]; then
  hooks_healthy=false
fi

escape_for_json() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

if [ "$docker_healthy" = true ] && [ "$hooks_healthy" = true ]; then
  context="[claudalytics] All services healthy. Docker stack and hooks server running. Dashboards: http://localhost:13000"
  sysmsg="[claudalytics] Services healthy. Dashboards: http://localhost:13000"
else
  context="[claudalytics] WARNING: Monitoring services are NOT fully operational."
  sysmsg="[claudalytics] WARNING: Monitoring services are NOT fully operational."
  if [ "$docker_healthy" = false ]; then
    detail=" Containers down: ${down_containers[*]}. Run: docker compose up -d from Claudalytics/docker-stack."
    context="$context$detail"
    sysmsg="$sysmsg$detail"
  fi
  if [ "$hooks_healthy" = false ]; then
    detail=" Hooks server not responding on port 4319. Run: docker compose up -d from Claudalytics/docker-stack."
    context="$context$detail"
    sysmsg="$sysmsg$detail"
  fi
fi

escaped_context=$(escape_for_json "$context")
escaped_sysmsg=$(escape_for_json "$sysmsg")

printf '{\n  "hookSpecificOutput": {\n    "hookEventName": "SessionStart",\n    "additionalContext": "%s"\n  },\n  "systemMessage": "%s"\n}\n' "$escaped_context" "$escaped_sysmsg"

exit 0
```

## Step 3 — Verify the written file

Use the Read tool to read `.claude/hooks/session-start-health-check.sh` back, then compare it **line-by-line** against the script content in Step 2. Transcription errors are common in multi-line bash — actively look for:

- Positional parameters: `$1`, `$2`, `$@`, `$#` — easy to drop the digit (`$1` → `$`)
- Quoted expansions: `"$var"`, `"${var}"`, `"$1"` — easy to mismatch quotes or drop content
- Escape sequences inside printf / strings: `\\`, `\"`, `\n`, `\r`, `\t`
- Pipe chains and redirects: `2>/dev/null`, `>&2`, `|`, `&&`, `||`
- Array syntax: `"${arr[@]}"`, `"${arr[*]}"`
- The `printf` format string at the end — the sequence of `\n`, `"`, `{`, `}` characters is easy to corrupt

If ANY character differs from the source block, **re-write the file** using the exact Step 2 content, and re-verify. Do NOT proceed to Step 4 until the written file matches byte-for-byte.

## Step 4 — Make executable

```bash
chmod +x .claude/hooks/session-start-health-check.sh
```

## Step 5 — Return

Return `installed (v1.0.0)` to the caller.
