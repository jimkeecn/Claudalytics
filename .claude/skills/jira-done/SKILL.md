---
name: jira-done
description: Transition a JIRA issue to Done with a summary comment. Works around the Atlassian MCP transition_issue comment bug by splitting into two calls.
---

# /jira-done

Transition a JIRA issue to Done and add a completion comment.

## Usage

```
/jira-done KAN-16
```

If no issue key is provided, ask the user for it.

## Why this skill exists

The Atlassian MCP `jira_transition_issue` tool fails when a `comment` parameter is passed — it rejects plain markdown with "Operation value must be an Atlassian Document". This skill works around the bug by always splitting into two separate calls.

## Process

### Step 1 — Parse the issue key

Extract the issue key from the user's input (e.g. `KAN-16`). If not provided, use `AskUserQuestion` to ask for it.

### Step 2 — Get current issue context

Call `mcp__atlassian__jira_get_issue` with the issue key to understand what the ticket is about.

### Step 3 — Get available transitions

Call `mcp__atlassian__jira_get_transitions` with the issue key. Find the transition where `name` is `Done` (or the closest match like `Closed`, `Resolved`). Store the `id`.

If no Done-like transition exists, show the user the available transitions and ask which one to use.

### Step 4 — Transition the issue (NO comment)

Call `mcp__atlassian__jira_transition_issue` with:

- `issue_key`: the issue key
- `transition_id`: the ID from Step 3

**IMPORTANT:** Do NOT pass a `comment` parameter. This will fail with an Atlassian Document Format error.

### Step 5 — Add completion comment separately

Write a short summary comment (under 500 words) based on the issue description and any context from the conversation. Then call `mcp__atlassian__jira_add_comment` with:

- `issue_key`: the issue key
- `body`: the summary comment in markdown

### Step 6 — Confirm

Tell the user the issue has been transitioned to Done and the comment has been added.
