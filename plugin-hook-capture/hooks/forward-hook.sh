#!/usr/bin/env bash
# Claudalytics hook capture - forwards a hook payload to the hooks server via fire-and-forget POST.
# Posts to $CLAUDALYTICS_HOOKS_URL (default http://localhost:4319) with via=hook-capture,
# the marker the hooks server needs before it sends an event on to OTel.
# Prints nothing, because Claude Code reads hook stdout as data on some events.
# Resolves projectName in priority order:
#   1. $1 positional arg (legacy / explicit override)
#   2. project.name in OTEL_RESOURCE_ATTRIBUTES of $CLAUDE_PROJECT_DIR/.claude/settings.local.json
#   3. the same in the main checkout's .claude/settings.local.json (session in a git worktree)
#   4. basename of $CLAUDE_PROJECT_DIR
#   5. "unknown"
# It reads the file because Claude Code passes no OTEL_* variable to a hook process.

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
PROJECT_NAME="${1:-}"

# $1 is a comma-separated key=value list. project.name can be any pair, and the name can hold spaces.
project_name_from_attributes() {
  local pairs pair
  IFS=',' read -ra pairs <<<"$1"
  for pair in "${pairs[@]}"; do
    pair="${pair#"${pair%%[![:space:]]*}"}"
    pair="${pair%"${pair##*[![:space:]]}"}"
    if [[ "$pair" == project.name=* ]]; then
      printf '%s' "${pair#project.name=}"
      return
    fi
  done
}

read_project_name() {
  [ -f "$1/.claude/settings.local.json" ] || return
  project_name_from_attributes "$(
    grep -m 1 -o '"OTEL_RESOURCE_ATTRIBUTES"[[:space:]]*:[[:space:]]*"[^"]*"' "$1/.claude/settings.local.json" 2>/dev/null \
      | sed 's/.*"OTEL_RESOURCE_ATTRIBUTES"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/'
  )"
}

url_encode() {
  local LC_ALL=C text="$1" encoded="" char index
  for ((index = 0; index < ${#text}; index++)); do
    char="${text:index:1}"
    case "$char" in
      [a-zA-Z0-9.~_-]) encoded+="$char" ;;
      *) encoded+=$(printf '%%%02X' "'$char") ;;
    esac
  done
  printf '%s' "$encoded"
}

if [ -z "$PROJECT_NAME" ]; then
  PROJECT_NAME=$(read_project_name "$PROJECT_DIR")
fi

if [ -z "$PROJECT_NAME" ]; then
  git_common_dir=$(git -C "$PROJECT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
  if [ -n "$git_common_dir" ]; then
    PROJECT_NAME=$(read_project_name "$(dirname "$git_common_dir")")
  fi
fi

if [ -z "$PROJECT_NAME" ] && [ -n "$PROJECT_DIR" ]; then
  PROJECT_NAME=$(basename "$PROJECT_DIR")
fi

PROJECT_NAME="${PROJECT_NAME:-unknown}"
HOOKS_URL="${CLAUDALYTICS_HOOKS_URL:-http://localhost:4319}/hook?projectName=$(url_encode "$PROJECT_NAME")&via=hook-capture"

payload=$(cat)

(
  curl -sS --max-time 2 -X POST \
    -H "Content-Type: application/json" \
    --data-raw "$payload" \
    "$HOOKS_URL" >/dev/null 2>&1 &
) >/dev/null 2>&1

exit 0
