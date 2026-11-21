import type { HookEvent } from "./hook-events";

// The ids are Claude Code's own (session_id, prompt_id, tool_use_id, agent_id),
// stored under the names OTel rows use, so a hook row and an OTel row of the same
// call can be matched. An event that has no id gets none: nothing is made up.
// Only the events OTel cannot give. PostToolUse is kept for WebSearch result URLs only.
export const EVENTS_TO_EMIT: ReadonlySet<string> = new Set<string>([
  "SessionStart",
  "SessionEnd",
  "ConfigChange",
  "CwdChanged",
  "InstructionsLoaded",
  "Notification",
  "SubagentStart",
  "Elicitation",
  "ElicitationResult",
  "TeammateIdle",
  "PostToolUse",
]);

// The claudalytics-hook-capture plugin adds via=hook-capture to its requests.
// Old plugin copies send no marker, so their requests are only written to the JSONL log.
export const HOOK_CAPTURE_MARKER = "hook-capture";

// Every row says which trigger wrote it. The collector writes "otel" on a log
// record that has no event.source, so a hook row and an OTel row of the same
// tool call can be told apart.
export const HOOK_EVENT_SOURCE = "hook";

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

export function mapHookRequest(
  data: HookEvent,
  via: string | null,
): Record<string, string> | null {
  if (via !== HOOK_CAPTURE_MARKER) return null;
  return mapHookToAttributes(data);
}

export function mapHookToAttributes(
  data: HookEvent,
): Record<string, string> | null {
  const eventName = data.hook_event_name;
  if (!EVENTS_TO_EMIT.has(eventName)) return null;
  if (
    eventName === "PostToolUse" &&
    safeString(prop(data, "tool_name")) !== "WebSearch"
  ) {
    return null;
  }

  const attrs: Record<string, string> = {
    "event.name": `hooks.${eventName}`,
    "event.source": HOOK_EVENT_SOURCE,
    "session.id": data.session_id || "",
    "prompt.id": data.prompt_id || "",
    permission_mode: data.permission_mode || "",
    agent_id: data.agent_id || "",
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

    case "PostToolUse": {
      const toolResponse = prop(data, "tool_response");
      attrs["tool_name"] = safeString(prop(data, "tool_name"));
      attrs["tool_use_id"] = safeString(prop(data, "tool_use_id"));
      attrs["tool_input"] = stringify(prop(data, "tool_input"));
      if (toolResponse) {
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
      break;
    }

    case "Notification":
      attrs["message"] = safeString(prop(data, "message"));
      attrs["title"] = safeString(prop(data, "title"));
      attrs["notification_type"] = safeString(prop(data, "notification_type"));
      break;

    case "SubagentStart":
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
