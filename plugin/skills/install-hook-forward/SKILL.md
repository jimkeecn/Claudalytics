---
name: install-hook-forward
description: Install the generic forward hook script (.claude/hooks/forward-hook.sh). Always writes the script when invoked.
---

# install-hook-forward

## Step 1 — Create directory

```bash
mkdir -p .claude/hooks
```

## Step 2 — Write script

Write this exact content to `.claude/hooks/forward-hook.sh`:

```bash
#!/usr/bin/env bash
# Claude Analytics - Generic forward hook
# VERSION: 1.0.0
# Forwards hook payload to hooks server via fire-and-forget POST.
# Used for SessionStart and all command-only hook events.
#
# Usage: "$CLAUDE_PROJECT_DIR"/.claude/hooks/forward-hook.sh <PROJECT_NAME>

PROJECT_NAME="${1:-unknown}"
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
```

## Step 3 — Make executable

```bash
chmod +x .claude/hooks/forward-hook.sh
```

## Step 4 — Clean up old script

```bash
rm -f .claude/hooks/session-start-forward.sh
```

## Step 5 — Return

Return `installed (v1.0.0)` to the caller.
