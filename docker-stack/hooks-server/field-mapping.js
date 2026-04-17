const EVENTS_TO_EMIT = new Set([
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

function stringify(obj) {
  if (obj === null || obj === undefined) return "";
  return typeof obj === "string" ? obj : JSON.stringify(obj);
}

function safeString(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

const URL_PATTERN = /\bhttps?:\/\/[^\s"'`<>|;&)\\]+/gi;

function extractUrlsFromCommand(command) {
  if (typeof command !== "string" || command.length === 0) return [];
  const matches = command.match(URL_PATTERN) || [];
  const seen = new Set();
  const urls = [];
  for (const m of matches) {
    const trimmed = m.replace(/[.,:;!?)\]}'"]+$/, "");
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    urls.push(trimmed);
    if (urls.length >= 10) break;
  }
  return urls;
}

function mapHookToAttributes(data) {
  const eventName = data.hook_event_name;
  if (!EVENTS_TO_EMIT.has(eventName)) return null;

  const attrs = {
    "event.name": `hooks.${eventName}`,
    "session.id": data.session_id || "",
    permission_mode: data.permission_mode || "",
    "agent.id": data.agent_id || "",
    "agent.type": data.agent_type || "",
  };

  switch (eventName) {
    case "SessionStart":
      attrs["source"] = data.source || "";
      attrs["model"] = data.model || "";
      break;

    case "SessionEnd":
      attrs["reason"] = data.reason || "";
      break;

    case "UserPromptSubmit":
      attrs["prompt"] = safeString(data.prompt);
      break;

    case "PreToolUse":
      attrs["tool_name"] = data.tool_name || "";
      attrs["use_id"] = data.tool_use_id || "";
      attrs["tool_input"] = stringify(data.tool_input);
      if (data.tool_name === "Read" && data.tool_input) {
        attrs["read.file_path"] = safeString(data.tool_input.file_path);
      }
      if (data.tool_name === "Edit" && data.tool_input) {
        attrs["edit.file_path"] = safeString(data.tool_input.file_path);
      }
      if (data.tool_name === "Write" && data.tool_input) {
        attrs["write.file_path"] = safeString(data.tool_input.file_path);
      }
      break;

    case "PostToolUse":
      attrs["tool_name"] = data.tool_name || "";
      attrs["use_id"] = data.tool_use_id || "";
      attrs["tool_input"] = stringify(data.tool_input);
      if (data.tool_name === "Read" && data.tool_input) {
        attrs["read.file_path"] = safeString(data.tool_input.file_path);
      }
      if (data.tool_name === "Edit" && data.tool_input) {
        attrs["edit.file_path"] = safeString(data.tool_input.file_path);
      }
      if (data.tool_name === "Write" && data.tool_input) {
        attrs["write.file_path"] = safeString(data.tool_input.file_path);
      }
      if (data.tool_name === "Agent" && data.tool_response) {
        const resp = data.tool_response;
        attrs["agent.total_duration_ms"] = String(resp.totalDurationMs ?? "");
        attrs["agent.total_tokens"] = String(resp.totalTokens ?? "");
        attrs["agent.total_tool_count"] = String(resp.totalToolUseCount ?? "");
        if (resp.usage) {
          attrs["agent.input_tokens"] = String(resp.usage.input_tokens ?? "");
          attrs["agent.output_tokens"] = String(resp.usage.output_tokens ?? "");
          attrs["agent.cache_read_tokens"] = String(
            resp.usage.cache_read_input_tokens ?? "",
          );
        }
        if (resp.toolStats) {
          attrs["agent.tool_stats"] = JSON.stringify(resp.toolStats);
        }
      }
      if (data.tool_name === "WebSearch" && data.tool_response) {
        const results = Array.isArray(data.tool_response.results)
          ? data.tool_response.results
          : [];
        const urls = [];
        for (const r of results) {
          const items = Array.isArray(r.content) ? r.content : [];
          for (const item of items) {
            if (item && typeof item.url === "string") urls.push(item.url);
            if (urls.length >= 10) break;
          }
          if (urls.length >= 10) break;
        }
        if (urls.length) attrs["search_urls"] = JSON.stringify(urls);
        if (typeof data.tool_response.durationSeconds === "number") {
          attrs["search_duration_ms"] = String(
            Math.round(data.tool_response.durationSeconds * 1000),
          );
        }
      }
      if (data.tool_name === "WebFetch" && data.tool_response) {
        const resp = data.tool_response;
        if (resp.code !== undefined) attrs["http_status"] = String(resp.code);
        if (resp.bytes !== undefined) attrs["fetch_bytes"] = String(resp.bytes);
      }
      if (data.tool_name === "Bash" && data.tool_input) {
        const urls = extractUrlsFromCommand(data.tool_input.command);
        if (urls.length) attrs["bash_urls"] = JSON.stringify(urls);
      }
      break;

    case "PostToolUseFailure":
      attrs["tool_name"] = data.tool_name || "";
      attrs["use_id"] = data.tool_use_id || "";
      attrs["tool_input"] = stringify(data.tool_input);
      attrs["error"] = data.error || "";
      attrs["is_interrupt"] = String(data.is_interrupt || false);
      if (data.tool_name === "Bash" && data.tool_input) {
        const urls = extractUrlsFromCommand(data.tool_input.command);
        if (urls.length) attrs["bash_urls"] = JSON.stringify(urls);
      }
      break;

    case "PermissionRequest":
      attrs["tool_name"] = data.tool_name || "";
      attrs["tool_input"] = stringify(data.tool_input);
      attrs["permission_suggestions"] = data.permission_suggestions
        ? JSON.stringify(data.permission_suggestions)
        : "";
      break;

    case "PermissionDenied":
      attrs["tool_name"] = data.tool_name || "";
      attrs["tool_input"] = stringify(data.tool_input);
      attrs["reason"] = data.reason || "";
      break;

    case "Notification":
      attrs["message"] = safeString(data.message);
      attrs["notification_type"] = data.notification_type || "";
      break;

    case "SubagentStart":
      break;

    case "SubagentStop":
      attrs["agent.transcript_path"] = data.agent_transcript_path || "";
      attrs["agent.last_message"] = safeString(data.last_assistant_message);
      break;

    case "TaskCreated":
    case "TaskCompleted":
      attrs["task.id"] = data.task_id || "";
      attrs["task.subject"] = data.task_subject || "";
      attrs["task.description"] = safeString(data.task_description);
      break;

    case "Stop":
      attrs["stop_hook_active"] = String(data.stop_hook_active || false);
      attrs["last_assistant_message"] = safeString(data.last_assistant_message);
      break;

    case "StopFailure":
      attrs["error"] = data.error || "";
      break;

    case "TeammateIdle":
      attrs["teammate.id"] = data.teammate_id || "";
      attrs["teammate.name"] = data.teammate_name || "";
      break;

    case "InstructionsLoaded":
      attrs["file_path"] = data.file_path || "";
      attrs["memory_type"] = data.memory_type || "";
      attrs["load_reason"] = data.load_reason || "";
      break;

    case "ConfigChange":
      attrs["source"] = data.source || "";
      attrs["file_path"] = data.file_path || "";
      break;

    case "CwdChanged":
      attrs["old_cwd"] = data.old_cwd || "";
      attrs["new_cwd"] = data.new_cwd || data.cwd || "";
      break;

    case "FileChanged":
      attrs["file_path"] = data.file_path || "";
      attrs["change_type"] = data.change_type || "";
      break;

    case "WorktreeCreate":
    case "WorktreeRemove":
      attrs["worktree.path"] = data.worktree_path || "";
      attrs["worktree.branch"] = data.branch || "";
      break;

    case "PreCompact":
    case "PostCompact":
      attrs["trigger"] = data.trigger || "";
      attrs["custom_instructions"] = safeString(data.custom_instructions);
      break;

    case "Elicitation":
      attrs["server"] = data.server || "";
      attrs["message"] = safeString(data.message);
      break;

    case "ElicitationResult":
      attrs["server"] = data.server || "";
      attrs["response"] = stringify(data.response);
      break;
  }

  return attrs;
}

module.exports = { mapHookToAttributes, EVENTS_TO_EMIT };
