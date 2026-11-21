import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { EVENTS_TO_EMIT } from "./field-mapping";

const PLUGIN_DIR = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "plugin-hook-capture",
);
const HOOKS_FILE = path.join(PLUGIN_DIR, "hooks", "hooks.json");
const FORWARD_HOOK = path.join(PLUGIN_DIR, "hooks", "forward-hook.sh");
const HEALTH_CHECK = path.join(
  PLUGIN_DIR,
  "hooks",
  "session-start-health-check.sh",
);

interface HookCommand {
  type: string;
  command: string;
  async?: boolean;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

const hooksConfig = JSON.parse(fs.readFileSync(HOOKS_FILE, "utf-8")) as {
  hooks: Record<string, HookGroup[]>;
};
const allHooks = Object.values(hooksConfig.hooks).flatMap((groups) =>
  groups.flatMap((group) => group.hooks),
);
const isForwarder = (hook: HookCommand) =>
  hook.command.includes("forward-hook.sh");

describe("claudalytics-hook-capture hooks.json", () => {
  it("lists exactly the events the hooks server re-emits", () => {
    expect(Object.keys(hooksConfig.hooks).sort()).toEqual(
      [...EVENTS_TO_EMIT].sort(),
    );
  });

  it("has no Worktree or FileChanged hook", () => {
    for (const eventName of Object.keys(hooksConfig.hooks)) {
      expect(eventName).not.toMatch(/^Worktree|^FileChanged$/);
    }
  });

  it("runs every forwarder async", () => {
    const forwarders = allHooks.filter(isForwarder);
    expect(forwarders).toHaveLength(EVENTS_TO_EMIT.size);
    for (const forwarder of forwarders) {
      expect(forwarder.async).toBe(true);
    }
  });

  it("keeps the health check synchronous and on SessionStart only", () => {
    const healthChecks = allHooks.filter((hook) => !isForwarder(hook));
    expect(healthChecks).toHaveLength(1);
    expect(healthChecks[0]!.command).toContain("session-start-health-check.sh");
    expect(healthChecks[0]!.async).toBeUndefined();
    expect(
      hooksConfig.hooks["SessionStart"]![0]!.hooks.map((hook) => hook.command),
    ).toContain(healthChecks[0]!.command);
  });

  it("runs the health check only at startup and resume, with a 5 second timeout", () => {
    const [healthCheckGroup, forwarderGroup] =
      hooksConfig.hooks["SessionStart"]!;
    expect(healthCheckGroup!.matcher).toBe("startup|resume");
    expect(healthCheckGroup!.hooks).toHaveLength(1);
    expect(healthCheckGroup!.hooks[0]!.timeout).toBe(5);
    expect(forwarderGroup!.matcher).toBeUndefined();
    expect(forwarderGroup!.hooks.every(isForwarder)).toBe(true);
  });

  it("forwards PostToolUse only for WebSearch", () => {
    const groups = hooksConfig.hooks["PostToolUse"]!;
    expect(groups.map((group) => group.matcher)).toEqual(["WebSearch"]);
  });
});

describe("forward-hook.sh", () => {
  it("prints nothing and exits 0", () => {
    const result = spawnSync("bash", [FORWARD_HOOK], {
      input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "t" }),
      env: { ...process.env, CLAUDALYTICS_HOOKS_URL: "http://127.0.0.1:1" },
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  let workDir = "";

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "forward-hook-"));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function makeProject(folderName: string, resourceAttributes?: string) {
    const projectDir = path.join(workDir, folderName);
    fs.mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
    if (resourceAttributes !== undefined) {
      fs.writeFileSync(
        path.join(projectDir, ".claude", "settings.local.json"),
        JSON.stringify(
          {
            permissions: { allow: ["Bash(npm test)"] },
            env: { OTEL_RESOURCE_ATTRIBUTES: resourceAttributes },
          },
          null,
          2,
        ),
      );
    }
    return projectDir;
  }

  async function postedQuery(projectDir: string, scriptArgs: string[] = []) {
    let receivedUrl = "";
    const hooksServer = http.createServer();
    const requestArrived = new Promise<void>((resolve) => {
      hooksServer.on(
        "request",
        (req: http.IncomingMessage, res: http.ServerResponse) => {
          receivedUrl = req.url ?? "";
          res.end("{}");
          resolve();
        },
      );
    });
    await new Promise<void>((resolve) =>
      hooksServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = hooksServer.address() as AddressInfo;
    try {
      const result = spawnSync("bash", [FORWARD_HOOK, ...scriptArgs], {
        input: JSON.stringify({
          hook_event_name: "SessionEnd",
          session_id: "t",
        }),
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: projectDir,
          CLAUDALYTICS_HOOKS_URL: `http://127.0.0.1:${port}`,
        },
        encoding: "utf-8",
      });
      expect(result.stdout).toBe("");
      await Promise.race([
        requestArrived,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      return new URL(receivedUrl, "http://localhost").searchParams;
    } finally {
      await new Promise<void>((resolve) => hooksServer.close(() => resolve()));
    }
  }

  it("keeps the project name and the marker when the name has &, # and spaces", async () => {
    const projectName = "a&b #c d";
    const projectDir = makeProject(
      "some-folder",
      `project.name=${projectName}`,
    );
    const query = await postedQuery(projectDir);
    expect(query.get("projectName")).toBe(projectName);
    expect(query.get("via")).toBe("hook-capture");
  });

  it("reads project.name from settings.local.json, not the folder name", async () => {
    const projectDir = makeProject("some-folder", "project.name=my_project");
    const query = await postedQuery(projectDir);
    expect(query.get("projectName")).toBe("my_project");
  });

  it("finds project.name when it is not the first pair", async () => {
    const projectDir = makeProject(
      "some-folder",
      "team.name=core, project.name=second-pair,env=dev",
    );
    const query = await postedQuery(projectDir);
    expect(query.get("projectName")).toBe("second-pair");
  });

  it("uses the first argument before the settings file", async () => {
    const projectDir = makeProject("some-folder", "project.name=my_project");
    const query = await postedQuery(projectDir, ["from-argument"]);
    expect(query.get("projectName")).toBe("from-argument");
  });

  it("reads the main checkout's settings file in a git worktree", async () => {
    const mainCheckout = makeProject(
      "main-checkout",
      "project.name=my_project",
    );
    const worktree = path.join(workDir, "feature-worktree");
    const git = (...args: string[]) =>
      spawnSync(
        "git",
        [
          "-C",
          mainCheckout,
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t",
          ...args,
        ],
        { encoding: "utf-8" },
      );
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "first");
    expect(git("worktree", "add", "-q", worktree).status).toBe(0);
    const query = await postedQuery(worktree);
    expect(query.get("projectName")).toBe("my_project");
  });

  it("uses the folder name when no settings file has a project name", async () => {
    const projectDir = makeProject("plain-folder");
    const query = await postedQuery(projectDir);
    expect(query.get("projectName")).toBe("plain-folder");
  });

  it("ignores OTEL_RESOURCE_ATTRIBUTES that has no project.name", async () => {
    const projectDir = makeProject("plain-folder", "team.name=core");
    const query = await postedQuery(projectDir);
    expect(query.get("projectName")).toBe("plain-folder");
  });

  it("doesn't read an old analytics.json", async () => {
    const projectDir = makeProject("plain-folder");
    fs.writeFileSync(
      path.join(projectDir, ".claude", "analytics.json"),
      JSON.stringify({ project_name: "old-name" }),
    );
    const query = await postedQuery(projectDir);
    expect(query.get("projectName")).toBe("plain-folder");
  });
});

describe("session-start-health-check.sh", () => {
  const pathKey =
    Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ??
    "PATH";

  function runHealthCheck(extraEnv: Record<string, string>) {
    const startedAt = Date.now();
    const result = spawnSync("bash", [HEALTH_CHECK], {
      input: "",
      env: { ...process.env, ...extraEnv },
      encoding: "utf-8",
      timeout: 15000,
    });
    return { ...result, elapsedMs: Date.now() - startedAt };
  }

  function expectOnlySystemMessage(stdout: string) {
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const output = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(output)).toEqual(["systemMessage"]);
    return String(output["systemMessage"]);
  }

  it("prints one systemMessage object when nothing is reachable", () => {
    const result = runHealthCheck({
      CLAUDALYTICS_CONTAINER_PREFIX: "no-such-prefix",
      CLAUDALYTICS_HOOKS_URL: "http://127.0.0.1:1",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const message = expectOnlySystemMessage(result.stdout);
    expect(message).toContain("Hooks server not responding");
  });

  it("stops waiting for a docker that hangs, well within the hook timeout", () => {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-docker-"));
    fs.writeFileSync(
      path.join(fakeBin, "docker"),
      "#!/usr/bin/env bash\nsleep 30\n",
      { mode: 0o755 },
    );
    try {
      const result = runHealthCheck({
        [pathKey]: `${fakeBin}${path.delimiter}${process.env[pathKey] ?? ""}`,
        CLAUDALYTICS_HOOKS_URL: "http://127.0.0.1:1",
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.elapsedMs).toBeLessThan(4000);
      const message = expectOnlySystemMessage(result.stdout);
      expect(message).toContain("Docker did not answer in time");
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});
