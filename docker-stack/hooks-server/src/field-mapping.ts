import type { HookEvent } from "./hook-events";

export const EVENTS_TO_EMIT: ReadonlySet<string> = new Set<string>([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Stop",
  "StopFailure",
  "TeammateIdle",
  "InstructionsLoaded",
  "ConfigChange",
  "CwdChanged",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "PreCompact",
  "PostCompact",
  "Elicitation",
  "ElicitationResult",
]);

function stringify(obj: unknown): string {
  if (obj === null || obj === undefined) return "";
  return typeof obj === "string" ? obj : JSON.stringify(obj);
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return "";
}

function prop(obj: unknown, key: string): unknown {
  if (obj && typeof obj === "object") {
    return (obj as Record<string, unknown>)[key];
  }
  return undefined;
}

export function safeBooleanString(value: unknown): string {
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") {
    const lowered = value.toLowerCase();
    if (lowered === "true") return "true";
    if (lowered === "false") return "false";
  }
  return "false";
}

const URL_PATTERN = /\bhttps?:\/\/[^\s"'`<>|;&)\\]+/gi;

export function extractUrlsFromCommand(command: unknown): string[] {
  if (typeof command !== "string" || command.length === 0) return [];
  const matches = command.match(URL_PATTERN) || [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const m of matches) {
    const trimmed = m.replace(/[.,:;!?)\]}'"]+$/, "");
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    urls.push(trimmed);
    if (urls.length >= 10) break;
  }
  return urls;
}

export function mapHookToAttributes(
  data: HookEvent,
): Record<string, string> | null {
  const eventName = data.hook_event_name;
  if (!EVENTS_TO_EMIT.has(eventName)) return null;

  const attrs: Record<string, string> = {
    "event.name": `hooks.${eventName}`,
    "session.id": data.session_id || "",
    permission_mode: data.permission_mode || "",
    "agent.id": data.agent_id || "",
    "agent.type": data.agent_type || "",
    transcript_path: data.transcript_path || "",
    cwd: data.cwd || "",
  };

  switch (eventName) {
    case "SessionStart":
      attrs["source"] = safeString(prop(data, "source"));
      attrs["model"] = safeString(prop(data, "model"));
      break;

    case "SessionEnd":
      attrs["reason"] = safeString(prop(data, "reason"));
      break;

    case "UserPromptSubmit":
      attrs["prompt"] = safeString(prop(data, "prompt"));
      break;

    case "PreToolUse": {
      const toolName = safeString(prop(data, "tool_name"));
      const toolInput = prop(data, "tool_input");
      attrs["tool_name"] = toolName;
      attrs["use_id"] = safeString(prop(data, "tool_use_id"));
      attrs["tool_input"] = stringify(toolInput);
      if (toolName === "Read" && toolInput) {
        attrs["read.file_path"] = safeString(prop(toolInput, "file_path"));
      }
      if (toolName === "Edit" && toolInput) {
        attrs["edit.file_path"] = safeString(prop(toolInput, "file_path"));
      }
      if (toolName === "Write" && toolInput) {
        attrs["write.file_path"] = safeString(prop(toolInput, "file_path"));
      }
      break;
    }

    case "PostToolUse": {
      const toolName = safeString(prop(data, "tool_name"));
      const toolInput = prop(data, "tool_input");
      const toolResponse = prop(data, "tool_response");
      attrs["tool_name"] = toolName;
      attrs["use_id"] = safeString(prop(data, "tool_use_id"));
      attrs["tool_input"] = stringify(toolInput);
      if (toolName === "Read" && toolInput) {
        attrs["read.file_path"] = safeString(prop(toolInput, "file_path"));
      }
      if (toolName === "Edit" && toolInput) {
        attrs["edit.file_path"] = safeString(prop(toolInput, "file_path"));
      }
      if (toolName === "Write" && toolInput) {
        attrs["write.file_path"] = safeString(prop(toolInput, "file_path"));
      }
      if (toolName === "Agent" && toolResponse) {
        attrs["agent.total_duration_ms"] = safeString(
          prop(toolResponse, "totalDurationMs"),
        );
        attrs["agent.total_tokens"] = safeString(
          prop(toolResponse, "totalTokens"),
        );
        attrs["agent.total_tool_count"] = safeString(
          prop(toolResponse, "totalToolUseCount"),
        );
        const usage = prop(toolResponse, "usage");
        if (usage) {
          attrs["agent.input_tokens"] = safeString(prop(usage, "input_tokens"));
          attrs["agent.output_tokens"] = safeString(
            prop(usage, "output_tokens"),
          );
          attrs["agent.cache_read_tokens"] = safeString(
            prop(usage, "cache_read_input_tokens"),
          );
        }
        const toolStats = prop(toolResponse, "toolStats");
        if (toolStats) {
          attrs["agent.tool_stats"] = JSON.stringify(toolStats);
        }
      }
      if (toolName === "WebSearch" && toolResponse) {
        const rawResults = prop(toolResponse, "results");
        const results: unknown[] = Array.isArray(rawResults) ? rawResults : [];
        const urls: string[] = [];
        for (const r of results) {
          const rawItems = prop(r, "content");
          const items: unknown[] = Array.isArray(rawItems) ? rawItems : [];
          for (const item of items) {
            const url = prop(item, "url");
            if (typeof url === "string") urls.push(url);
            if (urls.length >= 10) break;
          }
          if (urls.length >= 10) break;
        }
        if (urls.length) attrs["search_urls"] = JSON.stringify(urls);
        const durationSeconds = prop(toolResponse, "durationSeconds");
        if (typeof durationSeconds === "number") {
          attrs["search_duration_ms"] = String(
            Math.round(durationSeconds * 1000),
          );
        }
      }
      if (toolName === "WebFetch" && toolResponse) {
        const code = prop(toolResponse, "code");
        const bytes = prop(toolResponse, "bytes");
        if (code !== undefined) attrs["http_status"] = safeString(code);
        if (bytes !== undefined) attrs["fetch_bytes"] = safeString(bytes);
      }
      if (toolName === "Bash" && toolInput) {
        const urls = extractUrlsFromCommand(prop(toolInput, "command"));
        if (urls.length) attrs["bash_urls"] = JSON.stringify(urls);
      }
      break;
    }

    case "PostToolUseFailure": {
      const toolName = safeString(prop(data, "tool_name"));
      const toolInput = prop(data, "tool_input");
      attrs["tool_name"] = toolName;
      attrs["use_id"] = safeString(prop(data, "tool_use_id"));
      attrs["tool_input"] = stringify(toolInput);
      attrs["error"] = safeString(prop(data, "error"));
      attrs["is_interrupt"] = safeBooleanString(prop(data, "is_interrupt"));
      if (toolName === "Bash" && toolInput) {
        const urls = extractUrlsFromCommand(prop(toolInput, "command"));
        if (urls.length) attrs["bash_urls"] = JSON.stringify(urls);
      }
      break;
    }

    case "PermissionRequest": {
      const suggestions = prop(data, "permission_suggestions");
      attrs["tool_name"] = safeString(prop(data, "tool_name"));
      attrs["tool_input"] = stringify(prop(data, "tool_input"));
      attrs["permission_suggestions"] = suggestions
        ? JSON.stringify(suggestions)
        : "";
      break;
    }

    case "PermissionDenied":
      attrs["tool_name"] = safeString(prop(data, "tool_name"));
      attrs["use_id"] = safeString(prop(data, "tool_use_id"));
      attrs["tool_input"] = stringify(prop(data, "tool_input"));
      attrs["reason"] = safeString(prop(data, "reason"));
      break;

    case "Notification":
      attrs["message"] = safeString(prop(data, "message"));
      attrs["title"] = safeString(prop(data, "title"));
      attrs["notification_type"] = safeString(prop(data, "notification_type"));
      break;

    case "SubagentStart":
      break;

    case "SubagentStop":
      attrs["agent.transcript_path"] = safeString(
        prop(data, "agent_transcript_path"),
      );
      attrs["agent.last_message"] = safeString(
        prop(data, "last_assistant_message"),
      );
      attrs["stop_hook_active"] = safeBooleanString(
        prop(data, "stop_hook_active"),
      );
      break;

    case "TaskCreated":
    case "TaskCompleted":
      attrs["task.id"] = safeString(prop(data, "task_id"));
      attrs["task.subject"] = safeString(prop(data, "task_subject"));
      attrs["task.description"] = safeString(prop(data, "task_description"));
      attrs["teammate.name"] = safeString(prop(data, "teammate_name"));
      attrs["team.name"] = safeString(prop(data, "team_name"));
      break;

    case "Stop":
      break;

    case "StopFailure":
      attrs["error"] = safeString(prop(data, "error"));
      attrs["error_details"] = safeString(prop(data, "error_details"));
      attrs["last_assistant_message"] = safeString(
        prop(data, "last_assistant_message"),
      );
      break;

    case "TeammateIdle":
      attrs["teammate.name"] = safeString(prop(data, "teammate_name"));
      attrs["team.name"] = safeString(prop(data, "team_name"));
      break;

    case "InstructionsLoaded":
      attrs["file_path"] = safeString(prop(data, "file_path"));
      attrs["memory_type"] = safeString(prop(data, "memory_type"));
      attrs["load_reason"] = safeString(prop(data, "load_reason"));
      attrs["globs"] = safeString(prop(data, "globs"));
      attrs["trigger_file_path"] = safeString(prop(data, "trigger_file_path"));
      attrs["parent_file_path"] = safeString(prop(data, "parent_file_path"));
      break;

    case "ConfigChange":
      attrs["source"] = safeString(prop(data, "source"));
      attrs["file_path"] = safeString(prop(data, "file_path"));
      break;

    case "CwdChanged": {
      const newCwd = prop(data, "new_cwd");
      attrs["old_cwd"] = safeString(prop(data, "old_cwd"));
      attrs["new_cwd"] = safeString(newCwd ?? prop(data, "cwd"));
      break;
    }

    case "FileChanged":
      attrs["file_path"] = safeString(prop(data, "file_path"));
      attrs["event"] = safeString(prop(data, "event"));
      break;

    case "WorktreeCreate":
      break;

    case "WorktreeRemove":
      attrs["worktree.path"] = safeString(prop(data, "worktree_path"));
      break;

    case "PreCompact":
      attrs["trigger"] = safeString(prop(data, "trigger"));
      attrs["custom_instructions"] = safeString(
        prop(data, "custom_instructions"),
      );
      break;

    case "PostCompact":
      attrs["trigger"] = safeString(prop(data, "trigger"));
      attrs["compact_summary"] = safeString(prop(data, "compact_summary"));
      break;

    case "Elicitation":
      attrs["mcp_server_name"] = safeString(prop(data, "mcp_server_name"));
      attrs["message"] = safeString(prop(data, "message"));
      attrs["mode"] = safeString(prop(data, "mode"));
      attrs["requested_schema"] = safeString(prop(data, "requested_schema"));
      break;

    case "ElicitationResult":
      attrs["mcp_server_name"] = safeString(prop(data, "mcp_server_name"));
      attrs["action"] = safeString(prop(data, "action"));
      attrs["content"] = safeString(prop(data, "content"));
      attrs["mode"] = safeString(prop(data, "mode"));
      attrs["elicitation_id"] = safeString(prop(data, "elicitation_id"));
      break;
  }

  return attrs;
}
