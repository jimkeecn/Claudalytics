#!/usr/bin/env bash
# Claudalytics - Generic forward hook (plugin-hosted).
# Forwards hook payload to hooks server via fire-and-forget POST.
# Resolves projectName in priority order:
#   1. $1 positional arg (legacy / explicit override)
#   2. project_name in $CLAUDE_PROJECT_DIR/.claude/analytics.json
#   3. basename of $CLAUDE_PROJECT_DIR
#   4. "unknown"

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
PROJECT_NAME="${1:-}"

if [ -z "$PROJECT_NAME" ] && [ -f "$PROJECT_DIR/.claude/analytics.json" ]; then
  PROJECT_NAME=$(grep -o '"project_name"[[:space:]]*:[[:space:]]*"[^"]*"' "$PROJECT_DIR/.claude/analytics.json" 2>/dev/null \
    | sed 's/.*"project_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
fi

if [ -z "$PROJECT_NAME" ] && [ -n "$PROJECT_DIR" ]; then
  PROJECT_NAME=$(basename "$PROJECT_DIR")
fi

PROJECT_NAME="${PROJECT_NAME:-unknown}"
HOOKS_URL="http://localhost:4319/hook?projectName=${PROJECT_NAME}"

payload=$(cat)

(
  curl -sS --max-time 2 -X POST \
    -H "Content-Type: application/json" \
    --data-raw "$payload" \
    "$HOOKS_URL" >/dev/null 2>&1 &
) >/dev/null 2>&1

printf '{"continue": true}\n'
exit 0
