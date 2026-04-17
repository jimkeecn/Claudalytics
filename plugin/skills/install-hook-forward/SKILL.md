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
# Claudalytics - Generic forward hook
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

## Step 3 — Verify the written file

Use the Read tool to read `.claude/hooks/forward-hook.sh` back, then compare it **line-by-line** against the script content in Step 2. Transcription errors are common in multi-line bash — actively look for:

- Positional parameters: `$1`, `$2`, `$@`, `$#` — easy to drop the digit (`$1` → `$`)
- Quoted expansions: `"$var"`, `"${var}"`, `"${1:-unknown}"` — easy to mismatch quotes or drop content
- Escape sequences and redirects: `2>/dev/null`, `>&1`, `>/dev/null`, `|`, `&&`, `||`
- The background subshell `( ... & ) >/dev/null 2>&1` — the grouping parentheses and the trailing `&` are easy to drop
- `printf '{"continue": true}\n'` — the JSON braces and `\n` are easy to corrupt

If ANY character differs from the source block, **re-write the file** using the exact Step 2 content, and re-verify. Do NOT proceed to Step 4 until the written file matches byte-for-byte.

## Step 4 — Make executable

```bash
chmod +x .claude/hooks/forward-hook.sh
```

## Step 5 — Clean up old script

```bash
rm -f .claude/hooks/session-start-forward.sh
```

## Step 6 — Return

Return `installed (v1.0.0)` to the caller.
