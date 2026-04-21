import { describe, it, expect } from "vitest";
import {
  EVENTS_TO_EMIT,
  extractUrlsFromCommand,
  mapHookToAttributes,
  safeBooleanString,
} from "./field-mapping";
import type { HookEvent } from "./hook-events";

// Helper: build a minimal HookEvent-shaped object and cast through unknown so
// tests can express just the fields each case cares about.
function event(fields: Record<string, unknown>): HookEvent {
  return {
    session_id: "s",
    transcript_path: "/t",
    cwd: "/c",
    ...fields,
  } as unknown as HookEvent;
}

describe("EVENTS_TO_EMIT", () => {
  const EXPECTED = [
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
  ] as const;

  it("has exactly the 26 expected hook event names", () => {
    expect([...EVENTS_TO_EMIT].sort()).toEqual([...EXPECTED].sort());
  });

  it("rejects unknown names", () => {
    expect(EVENTS_TO_EMIT.has("SomethingElse")).toBe(false);
    expect(EVENTS_TO_EMIT.has("")).toBe(false);
  });
});

describe("safeBooleanString", () => {
  it.each([
    [true, "true"],
    [false, "false"],
    ["true", "true"],
    ["TRUE", "true"],
    ["True", "true"],
    ["false", "false"],
    ["FALSE", "false"],
    ["False", "false"],
    [undefined, "false"],
    [null, "false"],
    [0, "false"],
    [1, "false"],
    ["", "false"],
    ["random", "false"],
    [{}, "false"],
    [[], "false"],
  ])("safeBooleanString(%p) → %s", (input, expected) => {
    expect(safeBooleanString(input)).toBe(expected);
  });
});

describe("extractUrlsFromCommand", () => {
  it("returns [] for non-string input", () => {
    expect(extractUrlsFromCommand(undefined)).toEqual([]);
    expect(extractUrlsFromCommand(null)).toEqual([]);
    expect(extractUrlsFromCommand(42)).toEqual([]);
    expect(extractUrlsFromCommand({})).toEqual([]);
  });

  it("returns [] for empty string", () => {
    expect(extractUrlsFromCommand("")).toEqual([]);
  });

  it("extracts a single https URL", () => {
    expect(extractUrlsFromCommand("curl https://example.com/foo")).toEqual([
      "https://example.com/foo",
    ]);
  });

  it("extracts multiple URLs in command order", () => {
    const cmd = "curl https://a.com && wget http://b.com/x";
    expect(extractUrlsFromCommand(cmd)).toEqual([
      "https://a.com",
      "http://b.com/x",
    ]);
  });

  it("trims trailing punctuation", () => {
    expect(extractUrlsFromCommand("Visit https://example.com.")).toEqual([
      "https://example.com",
    ]);
    expect(extractUrlsFromCommand("(see https://example.com/x),")).toEqual([
      "https://example.com/x",
    ]);
    expect(extractUrlsFromCommand("[ref: https://example.com/y]")).toEqual([
      "https://example.com/y",
    ]);
  });

  it("deduplicates identical URLs", () => {
    const cmd = "curl https://a.com; curl https://a.com";
    expect(extractUrlsFromCommand(cmd)).toEqual(["https://a.com"]);
  });

  it("caps output at 10 URLs", () => {
    const urls = Array.from({ length: 15 }, (_, i) => `https://a${i}.com`);
    const cmd = urls.join(" && ");
    const extracted = extractUrlsFromCommand(cmd);
    expect(extracted).toHaveLength(10);
    expect(extracted[0]).toBe("https://a0.com");
    expect(extracted[9]).toBe("https://a9.com");
  });
});

describe("mapHookToAttributes — gate", () => {
  it("returns null for unknown event names", () => {
    expect(mapHookToAttributes(event({ hook_event_name: "Nope" }))).toBeNull();
  });

  it("returns null for empty event name", () => {
    expect(mapHookToAttributes(event({ hook_event_name: "" }))).toBeNull();
  });
});

describe("mapHookToAttributes — common attrs", () => {
  it("populates all seven common fields when provided", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "SessionStart",
        session_id: "abc",
        transcript_path: "/t.jsonl",
        cwd: "/repo",
        permission_mode: "default",
        agent_id: "a1",
        agent_type: "Explore",
        source: "startup",
        model: "claude-opus-4-7",
      }),
    );
    expect(attrs).not.toBeNull();
    expect(attrs!["event.name"]).toBe("hooks.SessionStart");
    expect(attrs!["session.id"]).toBe("abc");
    expect(attrs!["permission_mode"]).toBe("default");
    expect(attrs!["agent.id"]).toBe("a1");
    expect(attrs!["agent.type"]).toBe("Explore");
    expect(attrs!["transcript_path"]).toBe("/t.jsonl");
    expect(attrs!["cwd"]).toBe("/repo");
  });

  it("defaults missing common fields to empty strings", () => {
    const attrs = mapHookToAttributes({
      hook_event_name: "SessionStart",
    } as unknown as HookEvent);
    expect(attrs!["session.id"]).toBe("");
    expect(attrs!["permission_mode"]).toBe("");
    expect(attrs!["agent.id"]).toBe("");
    expect(attrs!["agent.type"]).toBe("");
    expect(attrs!["transcript_path"]).toBe("");
    expect(attrs!["cwd"]).toBe("");
  });
});

describe("mapHookToAttributes — per-event cases", () => {
  it("SessionStart emits source + model", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "SessionStart",
        source: "resume",
        model: "claude-opus-4-7",
      }),
    );
    expect(attrs!["source"]).toBe("resume");
    expect(attrs!["model"]).toBe("claude-opus-4-7");
  });

  it("SessionEnd emits reason", () => {
    const attrs = mapHookToAttributes(
      event({ hook_event_name: "SessionEnd", reason: "logout" }),
    );
    expect(attrs!["reason"]).toBe("logout");
  });

  it("UserPromptSubmit emits prompt", () => {
    const attrs = mapHookToAttributes(
      event({ hook_event_name: "UserPromptSubmit", prompt: "hi" }),
    );
    expect(attrs!["prompt"]).toBe("hi");
  });

  it("PostToolUseFailure emits tool_name, use_id, error, is_interrupt", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_use_id: "tu_1",
        tool_input: { command: "ls" },
        error: "boom",
        is_interrupt: true,
      }),
    );
    expect(attrs!["tool_name"]).toBe("Bash");
    expect(attrs!["use_id"]).toBe("tu_1");
    expect(attrs!["error"]).toBe("boom");
    expect(attrs!["is_interrupt"]).toBe("true");
  });

  it("PostToolUseFailure extracts bash_urls when Bash command contains URLs", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_use_id: "tu_x",
        tool_input: { command: "curl https://failed.example.com/x" },
        error: "timeout",
      }),
    );
    expect(attrs!["bash_urls"]).toBe('["https://failed.example.com/x"]');
  });

  it("PermissionRequest serializes permission_suggestions array", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        permission_suggestions: [{ type: "addRule" }],
      }),
    );
    expect(attrs!["tool_name"]).toBe("Bash");
    expect(attrs!["permission_suggestions"]).toBe('[{"type":"addRule"}]');
  });

  it("PermissionRequest emits empty string when suggestions absent", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: {},
      }),
    );
    expect(attrs!["permission_suggestions"]).toBe("");
  });

  it("PermissionDenied emits tool_name, use_id, reason", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "PermissionDenied",
        tool_name: "Bash",
        tool_use_id: "tu_9",
        tool_input: {},
        reason: "user declined",
      }),
    );
    expect(attrs!["tool_name"]).toBe("Bash");
    expect(attrs!["use_id"]).toBe("tu_9");
    expect(attrs!["reason"]).toBe("user declined");
  });

  it("Notification emits message, title, notification_type", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "Notification",
        message: "hi",
        title: "T",
        notification_type: "permission_prompt",
      }),
    );
    expect(attrs!["message"]).toBe("hi");
    expect(attrs!["title"]).toBe("T");
    expect(attrs!["notification_type"]).toBe("permission_prompt");
  });

  it("SubagentStart produces only common attrs", () => {
    const attrs = mapHookToAttributes(
      event({ hook_event_name: "SubagentStart", agent_id: "sa", agent_type: "Explore" }),
    );
    expect(attrs!["agent.id"]).toBe("sa");
    expect(attrs!["agent.type"]).toBe("Explore");
    expect(Object.keys(attrs!).every((k) => !k.startsWith("subagent"))).toBe(true);
  });

  it("SubagentStop emits agent.transcript_path, agent.last_message, stop_hook_active", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "SubagentStop",
        agent_transcript_path: "/path.jsonl",
        last_assistant_message: "done",
        stop_hook_active: true,
      }),
    );
    expect(attrs!["agent.transcript_path"]).toBe("/path.jsonl");
    expect(attrs!["agent.last_message"]).toBe("done");
    expect(attrs!["stop_hook_active"]).toBe("true");
  });

  it("SubagentStop stop_hook_active coercion for string input", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "SubagentStop",
        agent_transcript_path: "",
        last_assistant_message: "",
        stop_hook_active: "FALSE",
      }),
    );
    expect(attrs!["stop_hook_active"]).toBe("false");
  });

  it("TaskCreated emits task.id, task.subject, task.description, teammate.name, team.name", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "TaskCreated",
        task_id: "t1",
        task_subject: "Do it",
        task_description: "Details",
        teammate_name: "alex",
        team_name: "eng",
      }),
    );
    expect(attrs!["task.id"]).toBe("t1");
    expect(attrs!["task.subject"]).toBe("Do it");
    expect(attrs!["task.description"]).toBe("Details");
    expect(attrs!["teammate.name"]).toBe("alex");
    expect(attrs!["team.name"]).toBe("eng");
  });

  it("TaskCompleted shares TaskCreated's shape", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "TaskCompleted",
        task_id: "t1",
        task_subject: "Do it",
        task_description: "Details",
        teammate_name: "",
        team_name: "",
      }),
    );
    expect(attrs!["task.id"]).toBe("t1");
    expect(attrs!["task.subject"]).toBe("Do it");
  });

  it("Stop produces only common attrs", () => {
    const attrs = mapHookToAttributes(
      event({ hook_event_name: "Stop" }),
    );
    expect(attrs!["event.name"]).toBe("hooks.Stop");
    expect("stop_hook_active" in attrs!).toBe(false);
    expect("last_assistant_message" in attrs!).toBe(false);
  });

  it("StopFailure emits error, error_details, last_assistant_message", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "StopFailure",
        error: "rate_limit",
        error_details: "429 Too Many",
        last_assistant_message: "API Error: Rate limit",
      }),
    );
    expect(attrs!["error"]).toBe("rate_limit");
    expect(attrs!["error_details"]).toBe("429 Too Many");
    expect(attrs!["last_assistant_message"]).toBe("API Error: Rate limit");
  });

  it("TeammateIdle emits teammate.name and team.name", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "TeammateIdle",
        teammate_name: "sam",
        team_name: "eng",
      }),
    );
    expect(attrs!["teammate.name"]).toBe("sam");
    expect(attrs!["team.name"]).toBe("eng");
  });

  it("InstructionsLoaded emits file_path, memory_type, load_reason, plus optional fields", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "InstructionsLoaded",
        file_path: "CLAUDE.md",
        memory_type: "Project",
        load_reason: "session_start",
        globs: ["**/*.md"],
        trigger_file_path: "/repo",
        parent_file_path: "/parent",
      }),
    );
    expect(attrs!["file_path"]).toBe("CLAUDE.md");
    expect(attrs!["memory_type"]).toBe("Project");
    expect(attrs!["load_reason"]).toBe("session_start");
    expect(attrs!["globs"]).toBe('["**/*.md"]');
    expect(attrs!["trigger_file_path"]).toBe("/repo");
    expect(attrs!["parent_file_path"]).toBe("/parent");
  });

  it("ConfigChange emits source and file_path", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "ConfigChange",
        source: "user_settings",
        file_path: "/s.json",
      }),
    );
    expect(attrs!["source"]).toBe("user_settings");
    expect(attrs!["file_path"]).toBe("/s.json");
  });

  it("CwdChanged emits old_cwd and new_cwd", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "CwdChanged",
        old_cwd: "/a",
        new_cwd: "/b",
      }),
    );
    expect(attrs!["old_cwd"]).toBe("/a");
    expect(attrs!["new_cwd"]).toBe("/b");
  });

  it("CwdChanged falls back to cwd when new_cwd missing", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "CwdChanged",
        old_cwd: "/a",
        cwd: "/fallback",
      }),
    );
    expect(attrs!["new_cwd"]).toBe("/fallback");
  });

  it("FileChanged emits file_path and event (wire field, not change_type)", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "FileChanged",
        file_path: "/foo.txt",
        event: "change",
      }),
    );
    expect(attrs!["file_path"]).toBe("/foo.txt");
    expect(attrs!["event"]).toBe("change");
  });

  it("WorktreeCreate produces only common attrs", () => {
    const attrs = mapHookToAttributes(
      event({ hook_event_name: "WorktreeCreate" }),
    );
    expect(Object.keys(attrs!)).not.toContain("worktree.path");
  });

  it("WorktreeRemove emits worktree.path", () => {
    const attrs = mapHookToAttributes(
      event({ hook_event_name: "WorktreeRemove", worktree_path: "/wt" }),
    );
    expect(attrs!["worktree.path"]).toBe("/wt");
  });

  it("PreCompact emits trigger and custom_instructions", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "PreCompact",
        trigger: "manual",
        custom_instructions: "do it",
      }),
    );
    expect(attrs!["trigger"]).toBe("manual");
    expect(attrs!["custom_instructions"]).toBe("do it");
  });

  it("PostCompact emits trigger and compact_summary", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "PostCompact",
        trigger: "auto",
        compact_summary: "summary",
      }),
    );
    expect(attrs!["trigger"]).toBe("auto");
    expect(attrs!["compact_summary"]).toBe("summary");
  });

  it("Elicitation emits mcp_server_name, message, mode, requested_schema", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "Elicitation",
        mcp_server_name: "srv",
        message: "msg",
        mode: "blocking",
        requested_schema: { type: "object" },
      }),
    );
    expect(attrs!["mcp_server_name"]).toBe("srv");
    expect(attrs!["message"]).toBe("msg");
    expect(attrs!["mode"]).toBe("blocking");
    expect(attrs!["requested_schema"]).toBe('{"type":"object"}');
  });

  it("ElicitationResult emits mcp_server_name, action, content, mode, elicitation_id", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "ElicitationResult",
        mcp_server_name: "srv",
        action: "accept",
        content: { a: 1 },
        mode: "blocking",
        elicitation_id: "e1",
      }),
    );
    expect(attrs!["mcp_server_name"]).toBe("srv");
    expect(attrs!["action"]).toBe("accept");
    expect(attrs!["content"]).toBe('{"a":1}');
    expect(attrs!["mode"]).toBe("blocking");
    expect(attrs!["elicitation_id"]).toBe("e1");
  });
});

describe("mapHookToAttributes — PreToolUse sub-branches", () => {
  const baseline = (tool: string, toolInput: Record<string, unknown>) =>
    mapHookToAttributes(
      event({
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_use_id: "tu_1",
        tool_input: toolInput,
      }),
    )!;

  it("baseline emits tool_name, use_id, tool_input", () => {
    const attrs = baseline("UnknownTool", { anything: 1 });
    expect(attrs["tool_name"]).toBe("UnknownTool");
    expect(attrs["use_id"]).toBe("tu_1");
    expect(attrs["tool_input"]).toBe('{"anything":1}');
  });

  it("Read sub-branch emits read.file_path", () => {
    expect(baseline("Read", { file_path: "/x" })["read.file_path"]).toBe("/x");
  });

  it("Edit sub-branch emits edit.file_path", () => {
    expect(baseline("Edit", { file_path: "/x" })["edit.file_path"]).toBe("/x");
  });

  it("Write sub-branch emits write.file_path", () => {
    expect(baseline("Write", { file_path: "/x" })["write.file_path"]).toBe("/x");
  });

  it("no sub-branch key added for other tools", () => {
    const attrs = baseline("Glob", { pattern: "**/*.ts" });
    expect(attrs["read.file_path"]).toBeUndefined();
    expect(attrs["edit.file_path"]).toBeUndefined();
    expect(attrs["write.file_path"]).toBeUndefined();
  });
});

describe("mapHookToAttributes — PostToolUse sub-branches", () => {
  const post = (
    tool: string,
    toolInput: Record<string, unknown>,
    toolResponse: Record<string, unknown> = {},
  ) =>
    mapHookToAttributes(
      event({
        hook_event_name: "PostToolUse",
        tool_name: tool,
        tool_use_id: "tu_2",
        tool_input: toolInput,
        tool_response: toolResponse,
      }),
    )!;

  it("Agent emits total_duration_ms, total_tokens, total_tool_count", () => {
    const attrs = post(
      "Agent",
      {},
      { totalDurationMs: 1234, totalTokens: 500, totalToolUseCount: 3 },
    );
    expect(attrs["agent.total_duration_ms"]).toBe("1234");
    expect(attrs["agent.total_tokens"]).toBe("500");
    expect(attrs["agent.total_tool_count"]).toBe("3");
  });

  it("Agent emits usage breakdown when present", () => {
    const attrs = post(
      "Agent",
      {},
      {
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          cache_read_input_tokens: 50,
        },
      },
    );
    expect(attrs["agent.input_tokens"]).toBe("100");
    expect(attrs["agent.output_tokens"]).toBe("200");
    expect(attrs["agent.cache_read_tokens"]).toBe("50");
  });

  it("Agent omits usage breakdown when usage absent", () => {
    const attrs = post("Agent", {}, {});
    expect(attrs["agent.input_tokens"]).toBeUndefined();
    expect(attrs["agent.output_tokens"]).toBeUndefined();
    expect(attrs["agent.cache_read_tokens"]).toBeUndefined();
  });

  it("Agent emits tool_stats when present", () => {
    const attrs = post("Agent", {}, { toolStats: { Read: 5, Bash: 2 } });
    expect(attrs["agent.tool_stats"]).toBe('{"Read":5,"Bash":2}');
  });

  it("WebSearch extracts URLs from results (cap at 10)", () => {
    const results = Array.from({ length: 3 }, (_, r) => ({
      content: Array.from({ length: 5 }, (_, i) => ({
        url: `https://r${r}-${i}.com`,
      })),
    }));
    const attrs = post("WebSearch", { query: "q" }, { results });
    const urls = JSON.parse(attrs["search_urls"]!) as string[];
    expect(urls).toHaveLength(10);
  });

  it("WebSearch emits search_duration_ms rounded from durationSeconds", () => {
    const attrs = post("WebSearch", { query: "q" }, { durationSeconds: 2.345 });
    expect(attrs["search_duration_ms"]).toBe("2345");
  });

  it("WebSearch with no results and no duration emits neither attr", () => {
    const attrs = post("WebSearch", { query: "q" }, {});
    expect(attrs["search_urls"]).toBeUndefined();
    expect(attrs["search_duration_ms"]).toBeUndefined();
  });

  it("WebFetch emits http_status and fetch_bytes when present", () => {
    const attrs = post("WebFetch", { url: "u", prompt: "p" }, { code: 200, bytes: 4096 });
    expect(attrs["http_status"]).toBe("200");
    expect(attrs["fetch_bytes"]).toBe("4096");
  });

  it("WebFetch omits http_status and fetch_bytes when absent", () => {
    const attrs = post("WebFetch", { url: "u", prompt: "p" }, {});
    expect(attrs["http_status"]).toBeUndefined();
    expect(attrs["fetch_bytes"]).toBeUndefined();
  });

  it("Bash extracts bash_urls from command", () => {
    const attrs = post("Bash", { command: "curl https://a.com" }, {});
    expect(attrs["bash_urls"]).toBe('["https://a.com"]');
  });

  it("Bash omits bash_urls when command has no URLs", () => {
    const attrs = post("Bash", { command: "ls -la" }, {});
    expect(attrs["bash_urls"]).toBeUndefined();
  });

  it("Read sub-branch emits read.file_path", () => {
    expect(post("Read", { file_path: "/x" })["read.file_path"]).toBe("/x");
  });

  it("Edit sub-branch emits edit.file_path", () => {
    expect(post("Edit", { file_path: "/x" })["edit.file_path"]).toBe("/x");
  });

  it("Write sub-branch emits write.file_path", () => {
    expect(post("Write", { file_path: "/x" })["write.file_path"]).toBe("/x");
  });
});
