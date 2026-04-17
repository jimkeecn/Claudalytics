const http = require("http");
const fs = require("fs");
const path = require("path");
const { mapHookToAttributes, EVENTS_TO_EMIT } = require("./field-mapping");
const { emitLog, shutdownOtel } = require("./otel-emitter");
const { runBootstrap, getHealthInfo } = require("./migrations");

const PORT = 4319;
const LOGS_DIR = path.join(__dirname, "logs");
const MAX_CLI_DISPLAY = 1000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const isDebug = LOG_LEVEL === "debug";

let requestSeq = 0;

function timestamp() {
  return new Date().toISOString();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function logSection(title) {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(80)}`);
}

function logSeparator() {
  console.log("-".repeat(80));
}

function truncateForDisplay(text, max = MAX_CLI_DISPLAY) {
  if (typeof text !== "string") return text;
  if (text.length <= max) return text;
  return text.slice(0, max) + `... [truncated, ${text.length} chars total]`;
}

function truncateDeepForDisplay(obj, depth = 0) {
  if (depth > 20) return obj;

  if (typeof obj === "string") {
    return truncateForDisplay(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => truncateDeepForDisplay(item, depth + 1));
  }

  if (obj !== null && typeof obj === "object") {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = truncateDeepForDisplay(value, depth + 1);
    }
    return result;
  }

  return obj;
}

function getSessionLogPath(sessionId) {
  const safeId = (sessionId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(LOGS_DIR, `${safeId}.jsonl`);
}

function appendLogEntry(sessionId, entry) {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
  const logPath = getSessionLogPath(sessionId);
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

const server = http.createServer((req, res) => {
  const seq = ++requestSeq;
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

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
  const bodyChunks = [];
  req.on("data", (chunk) => {
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

    let parsed;
    try {
      parsed = JSON.parse(rawBody.toString("utf-8"));
    } catch {
      console.error(`  #${seq} ERROR: Could not parse JSON body`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ continue: true }));
      return;
    }

    const hookEvent = parsed.hook_event_name || "unknown";
    const sessionId = parsed.session_id || "unknown";

    logSection(`#${seq}  [${timestamp()}]  ${hookEvent}  session=${sessionId}`);
    console.log(`  Path: ${req.url}  |  Body: ${formatBytes(rawBody.length)}`);

    const keySummary = Object.keys(parsed).join(", ");
    console.log(`  Keys: ${keySummary}`);

    if (parsed.tool_name) console.log(`  Tool: ${parsed.tool_name}`);
    if (parsed.agent_type)
      console.log(`  Agent: ${parsed.agent_type} (${parsed.agent_id || ""})`);
    if (parsed.source) console.log(`  Source: ${parsed.source}`);
    if (parsed.model) console.log(`  Model: ${parsed.model}`);

    const entry = {
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
        `  [DEBUG SessionStart] source=${parsed.source}, model=${parsed.model}`,
      );
      console.log(
        `  [DEBUG SessionStart] Full payload: ${JSON.stringify(parsed, null, 2).slice(0, 2000)}`,
      );
    }

    if (EVENTS_TO_EMIT.has(hookEvent)) {
      const projectName =
        parsedUrl.searchParams.get("projectName") || "unknown";
      const attrs = mapHookToAttributes(parsed);
      if (attrs) {
        emitLog(projectName, attrs);
        console.log(
          `  OTel: emitted hooks.${hookEvent} (project: ${projectName})`,
        );
      }
    }

    console.log(`  Logged to session: ${sessionId}`);
    logSeparator();

    let response = { continue: true };

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
});

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

process.on("SIGINT", async () => {
  await shutdownOtel();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await shutdownOtel();
  process.exit(0);
});
