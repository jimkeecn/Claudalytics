# Must Read References

## Tools list

When you are working on the tools related content, please check this page for information.

<url>https://code.claude.com/docs/en/tools-reference</url>

## Hooks list

Reference for Claude Code hook events, configuration schema, JSON input/output formats, exit codes, async hooks, HTTP hooks, prompt hooks, and MCP tool hooks.

<url>https://code.claude.com/docs/en/hooks</url>

## Monitoring

Learn how to enable and configure OpenTelemetry for Claude Code.

<url>https://code.claude.com/docs/en/monitoring-usage</url>

## Security

Learn about Claude Code’s security safeguards and best practices for safe usage.

<url>https://code.claude.com/docs/en/security</url>

## Proxy Server

Configure Claude Code for enterprise environments with proxy servers, custom Certificate Authorities (CA), and mutual Transport Layer Security (mTLS) authentication.

<url>https://code.claude.com/docs/en/network-config</url>

## Stop Reasons

When you make a request to the Messages API, Claude's response includes a stop_reason field that indicates why the model stopped generating its response. Understanding these values is crucial for building robust applications that handle different response types appropriately.

<url>https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons</url>

# Must do

## MCP JIRA

When starting to work on a JIRA tasks or story. make sure move the JIRA task into In Progress column. and after completion, make sure write a short summary comments into the current JIRA ticket (no more than 500 words).

# Include Git Commit information to JIRA card

everytime we need to include git commit information such as git commit id and git commit information to the JIRA card that is completed.

# Update Plugin Version Number

When the plugin folder involved with change such as skill or hook server. make sure update the version number both in the plugin.json and marketpplace.json and also the version number inside the SKILL.md for script `session-start-health-check.sh` so the skill can check if the current script required an update.
