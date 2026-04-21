import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { mapHookToAttributes, EVENTS_TO_EMIT } from "./field-mapping";
import { emitLog, shutdownOtel } from "./otel-emitter";
import { runBootstrap, getHealthInfo } from "./migrations";
import type { HookEvent } from "./hook-events";

const PORT = 4319;
const LOGS_DIR = path.join(__dirname, "..", "logs");
const MAX_CLI_DISPLAY = 1000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const isDebug = LOG_LEVEL === "debug";

let requestSeq = 0;

function timestamp(): string {
  return new Date().toISOString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function logSection(title: string): void {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(80)}`);
}

function logSeparator(): void {
  console.log("-".repeat(80));
}

function truncateForDisplay(text: unknown, max: number = MAX_CLI_DISPLAY): unknown {
  if (typeof text !== "string") return text;
  if (text.length <= max) return text;
  return text.slice(0, max) + `... [truncated, ${text.length} chars total]`;
}

function truncateDeepForDisplay(obj: unknown, depth = 0): unknown {
  if (depth > 20) return obj;

  if (typeof obj === "string") {
    return truncateForDisplay(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => truncateDeepForDisplay(item, depth + 1));
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = truncateDeepForDisplay(value, depth + 1);
    }
    return result;
  }

  return obj;
}

// Suppress "unused" warning while keeping behavior parity with original.
void truncateDeepForDisplay;

function getSessionLogPath(sessionId: string): string {
  const safeId = (sessionId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(LOGS_DIR, `${safeId}.jsonl`);
}

interface LogEntry {
  sequence: number;
  timestamp: string;
  hook_event: string;
  path: string | undefined;
  raw_size_bytes: number;
  data: unknown;
}

function appendLogEntry(sessionId: string, entry: LogEntry): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
  const logPath = getSessionLogPath(sessionId);
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

const server = http.createServer(
  (req: http.IncomingMessage, res: http.ServerResponse) => {
    const seq = ++requestSeq;
    const parsedUrl = new URL(req.url || "/", `http://localhost:${PORT}`);

    if (req.method === "GET" && parsedUrl.pathname === "/health") {
      const healthInfo = getHealthInfo();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          server: "hooks_capture",
          ...healthInfo,
        }),
      );
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    let bodySize = 0;
    const bodyChunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_BYTES) {
        req.destroy();
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "Body too large", limit: MAX_BODY_BYTES }),
        );
        return;
      }
      bodyChunks.push(chunk);
    });

    req.on("end", () => {
      if (bodySize > MAX_BODY_BYTES) return;
      const rawBody = Buffer.concat(bodyChunks);

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawBody.toString("utf-8")) as Record<string, unknown>;
      } catch {
        console.error(`  #${seq} ERROR: Could not parse JSON body`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ continue: true }));
        return;
      }

      const hookEvent =
        typeof parsed["hook_event_name"] === "string"
          ? parsed["hook_event_name"]
          : "unknown";
      const sessionId =
        typeof parsed["session_id"] === "string"
          ? parsed["session_id"]
          : "unknown";

      logSection(
        `#${seq}  [${timestamp()}]  ${hookEvent}  session=${sessionId}`,
      );
      console.log(`  Path: ${req.url}  |  Body: ${formatBytes(rawBody.length)}`);

      const keySummary = Object.keys(parsed).join(", ");
      console.log(`  Keys: ${keySummary}`);

      if (typeof parsed["tool_name"] === "string") {
        console.log(`  Tool: ${parsed["tool_name"]}`);
      }
      if (typeof parsed["agent_type"] === "string") {
        const agentId =
          typeof parsed["agent_id"] === "string" ? parsed["agent_id"] : "";
        console.log(`  Agent: ${parsed["agent_type"]} (${agentId})`);
      }
      if (typeof parsed["source"] === "string") {
        console.log(`  Source: ${parsed["source"]}`);
      }
      if (typeof parsed["model"] === "string") {
        console.log(`  Model: ${parsed["model"]}`);
      }

      const entry: LogEntry = {
        sequence: seq,
        timestamp: timestamp(),
        hook_event: hookEvent,
        path: req.url,
        raw_size_bytes: rawBody.length,
        data: parsed,
      };

      appendLogEntry(sessionId, entry);

      if (hookEvent === "SessionStart" && isDebug) {
        console.log(
          `  [DEBUG SessionStart] Raw keys: ${JSON.stringify(Object.keys(parsed))}`,
        );
        console.log(
          `  [DEBUG SessionStart] source=${String(parsed["source"])}, model=${String(parsed["model"])}`,
        );
        console.log(
          `  [DEBUG SessionStart] Full payload: ${JSON.stringify(parsed, null, 2).slice(0, 2000)}`,
        );
      }

      if (EVENTS_TO_EMIT.has(hookEvent)) {
        const projectName =
          parsedUrl.searchParams.get("projectName") || "unknown";
        const attrs = mapHookToAttributes(parsed as unknown as HookEvent);
        if (attrs) {
          emitLog(projectName, attrs);
          console.log(
            `  OTel: emitted hooks.${hookEvent} (project: ${projectName})`,
          );
        }
      }

      console.log(`  Logged to session: ${sessionId}`);
      logSeparator();

      let response: Record<string, unknown> = { continue: true };

      if (hookEvent === "SessionStart") {
        response = {
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: `[hooks-capture] Logging hooks to ${LOGS_DIR}`,
          },
        };
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    });
  },
);

server.listen(PORT, () => {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

  console.log(`\n${"=".repeat(80)}`);
  console.log("  Hooks Capture Server");
  console.log(`  Listening on: http://localhost:${PORT}`);
  console.log("  Endpoints:");
  console.log("    POST /hook  — receive any Claude Code hook event");
  console.log("    GET  /health — health check");
  console.log(`  Logs dir:  ${LOGS_DIR}`);
  console.log(`  Full history: enabled (JSONL append, no truncation)`);
  console.log(`  Max body: ${formatBytes(MAX_BODY_BYTES)}`);
  console.log(`${"=".repeat(80)}`);
  console.log("");
  console.log(
    "  Configure hooks in .claude/settings.local.json (run /init-claudalytics):",
  );
  console.log('    "hooks": {');
  console.log('      "EventName": [{"hooks": [{"type": "http",');
  console.log(
    `        "url": "http://localhost:${PORT}/hook?projectName=YOUR_PROJECT"}]}]`,
  );
  console.log("    }");
  console.log("");
  console.log("Waiting for hook events...\n");

  runBootstrap();
});

const shutdown = async (): Promise<never> => {
  await shutdownOtel();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
