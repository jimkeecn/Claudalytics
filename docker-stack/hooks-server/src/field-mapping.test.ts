import { describe, it, expect } from "vitest";
import {
  EVENTS_TO_EMIT,
  HOOK_CAPTURE_MARKER,
  HOOK_EVENT_SOURCE,
  mapHookRequest,
  mapHookToAttributes,
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
    "ConfigChange",
    "CwdChanged",
    "InstructionsLoaded",
    "Notification",
    "SubagentStart",
    "Elicitation",
    "ElicitationResult",
    "TeammateIdle",
    "PostToolUse",
  ] as const;

  it("has exactly the events OTel cannot give", () => {
    expect([...EVENTS_TO_EMIT].sort()).toEqual([...EXPECTED].sort());
  });

  it("rejects unknown names", () => {
    expect(EVENTS_TO_EMIT.has("SomethingElse")).toBe(false);
    expect(EVENTS_TO_EMIT.has("")).toBe(false);
  });
});

describe("event.source", () => {
  it("is hook on every event that is sent on", () => {
    for (const eventName of EVENTS_TO_EMIT) {
      const attrs = mapHookToAttributes(
        event({ hook_event_name: eventName, tool_name: "WebSearch" }),
      );
      expect(attrs!["event.source"]).toBe("hook");
    }
    expect(HOOK_EVENT_SOURCE).toBe("hook");
  });

  it("is not taken from the payload: Claude Code's own source field stays apart", () => {
    const attrs = mapHookToAttributes(
      event({ hook_event_name: "SessionStart", source: "startup" }),
    );
    expect(attrs!["source"]).toBe("startup");
    expect(attrs!["event.source"]).toBe("hook");
  });
});

describe("ids from Claude Code", () => {
  it("stores the tool call id and the subagent id under the names OTel rows use", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "PostToolUse",
        tool_name: "WebSearch",
        tool_use_id: "toolu_01",
        agent_id: "agent_01",
        prompt_id: "prompt_01",
      }),
    )!;
    expect(attrs["tool_use_id"]).toBe("toolu_01");
    expect(attrs["agent_id"]).toBe("agent_01");
    expect(attrs["session.id"]).toBe("s");
    expect(attrs["prompt.id"]).toBe("prompt_01");
    expect(attrs).not.toHaveProperty("use_id");
    expect(attrs).not.toHaveProperty("agent.id");
  });

  it("makes up no id: an event without one has an empty agent_id and no tool_use_id", () => {
    for (const eventName of EVENTS_TO_EMIT) {
      if (eventName === "PostToolUse") continue;
      const attrs = mapHookToAttributes(event({ hook_event_name: eventName }))!;
      expect(attrs["agent_id"]).toBe("");
      expect(attrs["prompt.id"]).toBe("");
      expect(attrs).not.toHaveProperty("tool_use_id");
    }
    const webSearchWithoutId = mapHookToAttributes(
      event({ hook_event_name: "PostToolUse", tool_name: "WebSearch" }),
    )!;
    expect(webSearchWithoutId["tool_use_id"]).toBe("");
  });
});

describe("mapHookRequest — hook-capture marker", () => {
  it("re-emits a marked SessionEnd", () => {
    const attrs = mapHookRequest(
      event({ hook_event_name: "SessionEnd", reason: "logout" }),
      HOOK_CAPTURE_MARKER,
    );
    expect(attrs!["event.name"]).toBe("hooks.SessionEnd");
  });

  it("produces no row for an unmarked SessionEnd (old plugin copy)", () => {
    expect(
      mapHookRequest(event({ hook_event_name: "SessionEnd" }), null),
    ).toBeNull();
  });

  it("produces no row for a wrong marker value", () => {
    expect(
      mapHookRequest(event({ hook_event_name: "SessionEnd" }), "other"),
    ).toBeNull();
  });

  it("produces no row for a marked WorktreeCreate", () => {
    expect(
      mapHookRequest(
        event({ hook_event_name: "WorktreeCreate" }),
        HOOK_CAPTURE_MARKER,
      ),
    ).toBeNull();
  });

  it("produces no row for a marked Bash PostToolUse", () => {
    expect(
      mapHookRequest(
        event({
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "curl https://a.com" },
        }),
        HOOK_CAPTURE_MARKER,
      ),
    ).toBeNull();
  });

  it("re-emits a marked WebSearch PostToolUse", () => {
    const attrs = mapHookRequest(
      event({
        hook_event_name: "PostToolUse",
        tool_name: "WebSearch",
        tool_input: { query: "q" },
        tool_response: { results: [{ content: [{ url: "https://r.com" }] }] },
      }),
      HOOK_CAPTURE_MARKER,
    );
    expect(attrs!["search_urls"]).toBe('["https://r.com"]');
  });
});

describe("mapHookToAttributes — gate", () => {
  it("returns null for unknown event names", () => {
    expect(mapHookToAttributes(event({ hook_event_name: "Nope" }))).toBeNull();
  });

  it("returns null for empty event name", () => {
    expect(mapHookToAttributes(event({ hook_event_name: "" }))).toBeNull();
  });

  it.each([
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "PermissionDenied",
    "SubagentStop",
    "TaskCreated",
    "TaskCompleted",
    "Stop",
    "StopFailure",
    "PreCompact",
    "PostCompact",
    "FileChanged",
    "WorktreeCreate",
    "WorktreeRemove",
  ])("returns null for %s, which OTel covers or which was dropped", (name) => {
    expect(mapHookToAttributes(event({ hook_event_name: name }))).toBeNull();
  });

  it.each(["Bash", "Read", "Edit", "Write", "WebFetch", "Agent"])(
    "returns null for a %s PostToolUse",
    (toolName) => {
      expect(
        mapHookToAttributes(
          event({ hook_event_name: "PostToolUse", tool_name: toolName }),
        ),
      ).toBeNull();
    },
  );
});

describe("mapHookToAttributes — common attrs", () => {
  it("populates all common fields when provided", () => {
    const attrs = mapHookToAttributes(
      event({
        hook_event_name: "SessionStart",
        session_id: "abc",
        prompt_id: "p1",
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
    expect(attrs!["prompt.id"]).toBe("p1");
    expect(attrs!["permission_mode"]).toBe("default");
    expect(attrs!["agent_id"]).toBe("a1");
    expect(attrs!["agent.type"]).toBe("Explore");
    expect(attrs!["transcript_path"]).toBe("/t.jsonl");
    expect(attrs!["cwd"]).toBe("/repo");
  });

  it("defaults missing common fields to empty strings", () => {
    const attrs = mapHookToAttributes({
      hook_event_name: "SessionStart",
    } as unknown as HookEvent);
    expect(attrs!["session.id"]).toBe("");
    expect(attrs!["prompt.id"]).toBe("");
    expect(attrs!["permission_mode"]).toBe("");
    expect(attrs!["agent_id"]).toBe("");
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
      event({
        hook_event_name: "SubagentStart",
        agent_id: "sa",
        agent_type: "Explore",
      }),
    );
    expect(attrs!["agent_id"]).toBe("sa");
    expect(attrs!["agent.type"]).toBe("Explore");
    expect(Object.keys(attrs!).every((k) => !k.startsWith("subagent"))).toBe(
      true,
    );
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

describe("mapHookToAttributes — WebSearch PostToolUse", () => {
  const webSearch = (toolResponse: Record<string, unknown>) =>
    mapHookToAttributes(
      event({
        hook_event_name: "PostToolUse",
        tool_name: "WebSearch",
        tool_use_id: "tu_2",
        tool_input: { query: "q" },
        tool_response: toolResponse,
      }),
    )!;

  it("emits tool_name, tool_use_id and tool_input", () => {
    const attrs = webSearch({});
    expect(attrs["tool_name"]).toBe("WebSearch");
    expect(attrs["tool_use_id"]).toBe("tu_2");
    expect(attrs["tool_input"]).toBe('{"query":"q"}');
  });

  it("extracts URLs from results (cap at 10)", () => {
    const results = Array.from({ length: 3 }, (_, r) => ({
      content: Array.from({ length: 5 }, (_, i) => ({
        url: `https://r${r}-${i}.com`,
      })),
    }));
    const urls = JSON.parse(webSearch({ results })["search_urls"]!) as string[];
    expect(urls).toHaveLength(10);
  });

  it("emits search_duration_ms rounded from durationSeconds", () => {
    expect(webSearch({ durationSeconds: 2.345 })["search_duration_ms"]).toBe(
      "2345",
    );
  });

  it("with no results and no duration emits neither attr", () => {
    const attrs = webSearch({});
    expect(attrs["search_urls"]).toBeUndefined();
    expect(attrs["search_duration_ms"]).toBeUndefined();
  });
});
