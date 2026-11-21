import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const SETTINGS_TOOL = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "plugin",
  "skills",
  "init-claudalytics",
  "settings-tool.mjs",
);

interface SettingsFormat {
  exists: boolean;
  settings: Record<string, unknown>;
  hasBom: boolean;
  lineEnding: string;
  endsWithNewline: boolean;
}

interface SettingsToolModule {
  readSettings(file: string): SettingsFormat;
  writeSafely(
    file: string,
    current: SettingsFormat,
    nextSettings: Record<string, unknown>,
    changedKeys: string[],
    readBack?: (target: string) => string,
    writeFile?: (file: string, text: string, mode?: number) => void,
  ): string | null;
  StopError: new (message: string) => Error;
}

let workDir = "";
let projectDir = "";
let configDir = "";
let userFile = "";
let projectFile = "";
let analyticsFile = "";

function runTool(...args: string[]) {
  return runToolIn(projectDir, ["--project-dir", projectDir, ...args]);
}

function runToolIn(
  folder: string,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  const result = spawnSync("node", [SETTINGS_TOOL, ...args], {
    cwd: folder,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, ...extraEnv },
    encoding: "utf-8",
  });
  const output = JSON.parse(result.stdout.trim() || "{}") as Record<
    string,
    unknown
  >;
  return { status: result.status, stdout: result.stdout, output };
}

function backupsOf(file: string) {
  return fs
    .readdirSync(path.dirname(file))
    .filter((name) =>
      name.startsWith(`${path.basename(file)}.claudalytics-backup-`),
    );
}

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "")) as {
    env?: Record<string, string>;
    [key: string]: unknown;
  };
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-tool-"));
  projectDir = path.join(workDir, "my_project");
  configDir = path.join(workDir, "config");
  fs.mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
  fs.mkdirSync(configDir);
  userFile = path.join(configDir, "settings.json");
  projectFile = path.join(projectDir, ".claude", "settings.local.json");
  analyticsFile = path.join(projectDir, ".claude", "analytics.json");
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("settings-tool user file", () => {
  it("creates a missing user file with the 13 keys and no backup", () => {
    const { status, output } = runTool("user-write", "add_missing");
    expect(status).toBe(0);
    expect(output["status"]).toBe("created");
    expect(Object.keys(readJson(userFile).env!)).toHaveLength(13);
    expect(backupsOf(userFile)).toEqual([]);
  });

  it("adds only missing keys, keeps the other keys and their order, and backs up first", () => {
    const original = {
      model: "sonnet",
      env: { MY_VAR: "keep", OTEL_EXPORTER_OTLP_ENDPOINT: "http://other:4317" },
      apiKeyHelper: "print-token.sh",
    };
    fs.writeFileSync(userFile, JSON.stringify(original, null, 2) + "\n");
    const { status, output } = runTool("user-write", "add_missing");
    expect(status).toBe(0);
    const written = readJson(userFile);
    expect(Object.keys(written)).toEqual(["model", "env", "apiKeyHelper"]);
    expect(written.env!["OTEL_EXPORTER_OTLP_ENDPOINT"]).toBe(
      "http://other:4317",
    );
    expect(Object.keys(written.env!).slice(0, 2)).toEqual([
      "MY_VAR",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
    ]);
    expect(written.env!["OTEL_RESOURCE_ATTRIBUTES"]).toBe(
      "project.name=unassigned",
    );
    const backups = backupsOf(userFile);
    expect(backups).toHaveLength(1);
    expect(output["backup"]).toContain(backups[0]);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(configDir, backups[0]!), "utf-8"),
      ) as unknown,
    ).toEqual(original);

    const rerun = runTool("user-write", "add_missing");
    expect(rerun.output["status"]).toBe("unchanged");
    expect(backupsOf(userFile)).toHaveLength(1);
  });

  it("replaces a different value only in replace mode", () => {
    fs.writeFileSync(
      userFile,
      JSON.stringify({
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://other:4317" },
      }),
    );
    runTool("user-write", "replace");
    expect(readJson(userFile).env!["OTEL_EXPORTER_OTLP_ENDPOINT"]).toBe(
      "http://localhost:4317",
    );
  });

  it("stops on invalid JSON, writes nothing and doesn't print the file", () => {
    const brokenText = '{ "env": { "ANTHROPIC_API_KEY": "secret-token-123", }';
    fs.writeFileSync(userFile, brokenText);
    for (const command of ["user-status", "user-write"]) {
      const { status, stdout, output } = runTool(command, "add_missing");
      expect(status).toBe(2);
      expect(String(output["stop"])).toContain("is not valid JSON");
      expect(stdout).not.toContain("secret-token-123");
    }
    expect(fs.readFileSync(userFile, "utf-8")).toBe(brokenText);
    expect(backupsOf(userFile)).toEqual([]);
  });

  it("stops when env is not an object", () => {
    const text = JSON.stringify({ env: "OTEL_LOGS_EXPORTER=otlp" });
    fs.writeFileSync(userFile, text);
    const { status, output } = runTool("user-write", "add_missing");
    expect(status).toBe(2);
    expect(String(output["stop"])).toContain('"env"');
    expect(fs.readFileSync(userFile, "utf-8")).toBe(text);
    expect(backupsOf(userFile)).toEqual([]);
  });

  it("keeps a BOM and CRLF line endings", () => {
    fs.writeFileSync(
      userFile,
      '\uFEFF{\r\n  "model": "opus",\r\n  "env": {\r\n    "MY_VAR": "1"\r\n  }\r\n}\r\n',
    );
    const { status } = runTool("user-write", "add_missing");
    expect(status).toBe(0);
    const text = fs.readFileSync(userFile, "utf-8");
    expect(text.startsWith("\uFEFF")).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(text.endsWith("\r\n")).toBe(true);
    expect(readJson(userFile)["model"]).toBe("opus");
  });

  it("prints only the values of the 13 OTel keys", () => {
    fs.writeFileSync(
      userFile,
      JSON.stringify({
        env: {
          ANTHROPIC_API_KEY: "secret-token-123",
          OTEL_LOGS_EXPORTER: "none",
        },
        apiKeyHelper: "secret-helper",
      }),
    );
    const { stdout, output } = runTool("user-status");
    expect(stdout).not.toContain("secret-token-123");
    expect(stdout).not.toContain("secret-helper");
    expect(output["state"]).toBe("some_different");
  });

  it("puts the backup back when the read-back doesn't match", async () => {
    const tool = (await import(
      SETTINGS_TOOL.replace(/\\/g, "/")
    )) as SettingsToolModule;
    const originalText = JSON.stringify({ model: "sonnet", env: {} }, null, 2);
    fs.writeFileSync(userFile, originalText);
    const current = tool.readSettings(userFile);
    const tamperedReadBack = () =>
      JSON.stringify({ model: "changed-by-someone", env: { A: "1" } });
    expect(() =>
      tool.writeSafely(
        userFile,
        current,
        { model: "sonnet", env: { A: "1" } },
        ["env"],
        tamperedReadBack,
      ),
    ).toThrow(/did not match \(model\)/);
    expect(fs.readFileSync(userFile, "utf-8")).toBe(originalText);
  });
});

describe("settings-tool project file", () => {
  const oldProjectSettings = {
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4317",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=secret-header",
      OTEL_LOG_RAW_API_BODIES: "1",
      OTEL_METRIC_EXPORT_INTERVAL: "10000",
      OTEL_RESOURCE_ATTRIBUTES: "project.name=my_project,team.name=core",
      MY_PROJECT_VAR: "keep-me",
    },
    permissions: { allow: ["Bash(npm test)"] },
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "http",
              url: "http://localhost:4319/hook?projectName=my_project",
            },
          ],
        },
      ],
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "true" }] },
      ],
    },
  };

  it("migrates a 1.1.0 file, removes old scripts after the write, and is a no-op the second time", () => {
    fs.writeFileSync(projectFile, JSON.stringify(oldProjectSettings, null, 2));
    fs.mkdirSync(path.join(projectDir, ".claude", "hooks"));
    fs.writeFileSync(
      path.join(projectDir, ".claude", "hooks", "forward-hook.sh"),
      "old",
    );
    const status = runTool("project-status");
    expect(status.stdout).not.toContain("secret-header");
    expect(status.output["legacyHookEntries"]).toBe(1);

    const { output } = runTool("project-write", "my_project", "otel-only");
    expect(output["status"]).toBe("written");
    expect(output["rawApiBodiesRemoved"]).toBe(true);
    expect(output["removedScripts"]).toEqual([".claude/hooks/forward-hook.sh"]);
    const written = readJson(projectFile);
    expect(written.env).toEqual({
      OTEL_RESOURCE_ATTRIBUTES: "project.name=my_project,team.name=core",
      MY_PROJECT_VAR: "keep-me",
    });
    expect(written["permissions"]).toEqual(oldProjectSettings.permissions);
    expect(written["hooks"]).toEqual({
      PreToolUse: oldProjectSettings.hooks.PreToolUse,
    });
    expect(written["enabledPlugins"]).toEqual({
      "claudalytics-hook-capture@claudalytics": false,
    });
    expect(backupsOf(projectFile)).toHaveLength(1);

    const rerun = runTool("project-write", "my_project", "otel-only");
    expect(rerun.output["status"]).toBe("unchanged");
    expect(backupsOf(projectFile)).toHaveLength(1);
  });

  it("keeps a repo's opt-out values", () => {
    fs.writeFileSync(
      projectFile,
      JSON.stringify({
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: "0",
          OTEL_LOGS_EXPORTER: "none",
          OTEL_METRICS_EXPORTER: "otlp",
          OTEL_LOG_USER_PROMPTS: "false",
          OTEL_LOG_TOOL_DETAILS: "1",
        },
      }),
    );
    runTool("project-write", "repo", "otel+hooks");
    expect(readJson(projectFile).env).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: "0",
      OTEL_LOGS_EXPORTER: "none",
      OTEL_LOG_USER_PROMPTS: "false",
      OTEL_RESOURCE_ATTRIBUTES: "project.name=repo",
    });
  });
});

describe("settings-tool CwdChanged hook", () => {
  const ourHook = {
    type: "command",
    command:
      "exit 0 # claudalytics: lets the hook-capture plugin receive CwdChanged",
    async: true,
  };
  const usersCwdGroup = {
    hooks: [{ type: "command", command: "direnv export bash" }],
  };
  const usersOtherHooks = {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "true" }] },
    ],
  };
  const hooksOf = () =>
    readJson(projectFile)["hooks"] as Record<string, unknown> | undefined;

  it("adds one do-nothing CwdChanged hook in otel+hooks mode", () => {
    const { output } = runTool("project-write", "repo", "otel+hooks");
    expect(output["status"]).toBe("created");
    expect(output["cwdChangedHook"]).toBe("added");
    expect(hooksOf()).toEqual({ CwdChanged: [{ hooks: [ourHook] }] });
  });

  it("writes nothing when the hook is already there", () => {
    runTool("project-write", "repo", "otel+hooks");
    const rerun = runTool("project-write", "repo", "otel+hooks");
    expect(rerun.output["status"]).toBe("unchanged");
    expect(rerun.output["cwdChangedHook"]).toBe("already_there");
    expect(hooksOf()).toEqual({ CwdChanged: [{ hooks: [ourHook] }] });
    expect(backupsOf(projectFile)).toHaveLength(0);
  });

  it("removes the hook, and the hooks key it made, in otel-only mode", () => {
    runTool("project-write", "repo", "otel+hooks");
    const { output } = runTool("project-write", "repo", "otel-only");
    expect(output["cwdChangedHook"]).toBe("removed");
    expect(readJson(projectFile)).toEqual({
      env: { OTEL_RESOURCE_ATTRIBUTES: "project.name=repo" },
      enabledPlugins: { "claudalytics-hook-capture@claudalytics": false },
    });
  });

  it("keeps a user's own CwdChanged hook when ours is added and when it is removed", () => {
    fs.writeFileSync(
      projectFile,
      JSON.stringify({ hooks: { CwdChanged: [usersCwdGroup] } }),
    );
    runTool("project-write", "repo", "otel+hooks");
    expect(hooksOf()).toEqual({
      CwdChanged: [usersCwdGroup, { hooks: [ourHook] }],
    });
    const { output } = runTool("project-write", "repo", "otel-only");
    expect(output["cwdChangedHook"]).toBe("removed");
    expect(hooksOf()).toEqual({ CwdChanged: [usersCwdGroup] });
  });

  it("takes only our hook out of a group that a user put theirs into", () => {
    const mixedGroup = { hooks: [usersCwdGroup.hooks[0], ourHook] };
    fs.writeFileSync(
      projectFile,
      JSON.stringify({ hooks: { CwdChanged: [mixedGroup] } }),
    );
    const kept = runTool("project-write", "repo", "otel+hooks");
    expect(kept.output["cwdChangedHook"]).toBe("already_there");
    expect(hooksOf()).toEqual({ CwdChanged: [mixedGroup] });
    runTool("project-write", "repo", "otel-only");
    expect(hooksOf()).toEqual({ CwdChanged: [usersCwdGroup] });
  });

  it("leaves a user's do-nothing hook with another command alone", () => {
    const usersNoOp = { hooks: [{ type: "command", command: "exit 0" }] };
    fs.writeFileSync(
      projectFile,
      JSON.stringify({ hooks: { CwdChanged: [usersNoOp] } }),
    );
    const { output } = runTool("project-write", "repo", "otel-only");
    expect(output["cwdChangedHook"]).toBe("none");
    expect(hooksOf()).toEqual({ CwdChanged: [usersNoOp] });
  });

  it("does not touch hooks of other events, in both modes", () => {
    fs.writeFileSync(projectFile, JSON.stringify({ hooks: usersOtherHooks }));
    runTool("project-write", "repo", "otel+hooks");
    expect(hooksOf()).toEqual({
      ...usersOtherHooks,
      CwdChanged: [{ hooks: [ourHook] }],
    });
    runTool("project-write", "repo", "otel-only");
    expect(hooksOf()).toEqual(usersOtherHooks);
  });

  it("adds no hooks key in otel-only mode", () => {
    const { output } = runTool("project-write", "repo", "otel-only");
    expect(output["cwdChangedHook"]).toBe("none");
    expect(hooksOf()).toBeUndefined();
  });

  it("stops when hooks.CwdChanged is not a list, and writes nothing", () => {
    const brokenSettings = JSON.stringify({ hooks: { CwdChanged: "x" } });
    fs.writeFileSync(projectFile, brokenSettings);
    const { status, output } = runTool("project-write", "repo", "otel+hooks");
    expect(status).toBe(2);
    expect(String(output["stop"])).toContain("hooks.CwdChanged");
    expect(fs.readFileSync(projectFile, "utf-8")).toBe(brokenSettings);
  });

  it.each(["sh", "bash", "powershell"])(
    "the do-nothing command prints nothing and exits 0 in %s",
    (shell) => {
      const shellArgs =
        shell === "powershell"
          ? ["-NoProfile", "-Command", ourHook.command]
          : ["-c", ourHook.command];
      const result = spawnSync(shell, shellArgs, { encoding: "utf-8" });
      if (result.error) return; // this shell is not on the machine
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    },
  );
});

describe("settings-tool project folder", () => {
  it("works on the --project-dir folder, wherever it runs from", () => {
    fs.writeFileSync(
      projectFile,
      JSON.stringify({
        env: { OTEL_RESOURCE_ATTRIBUTES: "project.name=my_project" },
      }),
    );
    const { status, output } = runToolIn(workDir, [
      "--project-dir",
      projectDir,
      "detect-name",
    ]);
    expect(status).toBe(0);
    expect(output["existing"]).toMatchObject({ value: "my_project" });
  });

  it("stops when it would work in the plugin folder", () => {
    const skillFolder = path.dirname(SETTINGS_TOOL);
    const { status, output } = runToolIn(skillFolder, [
      "--project-dir",
      skillFolder,
      "detect-name",
    ]);
    expect(status).toBe(2);
    expect(String(output["stop"])).toContain("plugin folder");
  });

  it("uses the git root, not the current subfolder, when --project-dir is empty", () => {
    const repoDir = path.join(workDir, "repo");
    const subfolder = path.join(repoDir, "src", "deep");
    fs.mkdirSync(subfolder, { recursive: true });
    spawnSync("git", ["init", "-q", repoDir]);
    const { status, output } = runToolIn(
      subfolder,
      ["--project-dir", "", "project-write", "repo", "otel-only"],
      { GIT_CEILING_DIRECTORIES: workDir },
    );
    expect(status).toBe(0);
    expect(output["status"]).toBe("created");
    expect(
      fs.existsSync(path.join(repoDir, ".claude", "settings.local.json")),
    ).toBe(true);
    expect(fs.existsSync(path.join(subfolder, ".claude"))).toBe(false);
  });

  it("stops when --project-dir is empty outside any git repo", () => {
    const plainFolder = path.join(workDir, "plain");
    fs.mkdirSync(plainFolder);
    const { status, output } = runToolIn(
      plainFolder,
      ["--project-dir", "", "project-write", "plain", "otel-only"],
      { GIT_CEILING_DIRECTORIES: workDir },
    );
    expect(status).toBe(2);
    expect(String(output["stop"])).toContain("project folder is unknown");
    expect(fs.existsSync(path.join(plainFolder, ".claude"))).toBe(false);
  });
});

describe("settings-tool error paths", () => {
  it("stops with one JSON line on a read-only file, before any backup", () => {
    const originalText = JSON.stringify({ env: { MY_VAR: "1" } });
    fs.writeFileSync(userFile, originalText);
    fs.chmodSync(userFile, 0o444);
    try {
      const { status, stdout, output } = runTool("user-write", "add_missing");
      expect(status).toBe(2);
      expect(stdout.trim().split("\n")).toHaveLength(1);
      expect(String(output["stop"])).toMatch(
        /^(EPERM|EACCES) on .*settings\.json$/,
      );
      expect(fs.readFileSync(userFile, "utf-8")).toBe(originalText);
      expect(fs.readdirSync(configDir)).toEqual(["settings.json"]);
    } finally {
      fs.chmodSync(userFile, 0o644);
    }
  });

  it("puts the backup back when the write fails half way", async () => {
    const tool = (await import(
      SETTINGS_TOOL.replace(/\\/g, "/")
    )) as SettingsToolModule;
    const originalText = JSON.stringify({ model: "sonnet", env: {} }, null, 2);
    fs.writeFileSync(userFile, originalText);
    const halfWrite = (file: string) => {
      fs.writeFileSync(file, '{ "model": "son');
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    };
    expect(() =>
      tool.writeSafely(
        userFile,
        tool.readSettings(userFile),
        { model: "sonnet", env: { A: "1" } },
        ["env"],
        undefined,
        halfWrite,
      ),
    ).toThrow("disk full");
    expect(fs.readFileSync(userFile, "utf-8")).toBe(originalText);
    expect(
      fs.readdirSync(configDir).filter((name) => name.includes("-tmp-")),
    ).toEqual([]);
  });

  it("stops on a number with 16 or more digits, which JSON.parse would round", () => {
    const originalText =
      '{ "env": {}, "tipsHistory": { "lastShown": 17321431230001234 } }';
    fs.writeFileSync(userFile, originalText);
    const { status, output } = runTool("user-write", "add_missing");
    expect(status).toBe(2);
    expect(String(output["stop"])).toContain("16 or more digits");
    expect(fs.readFileSync(userFile, "utf-8")).toBe(originalText);
    expect(backupsOf(userFile)).toEqual([]);
  });

  it("hides the user and password of a differing endpoint", () => {
    fs.writeFileSync(
      userFile,
      JSON.stringify({
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT:
            "https://team:s3cret-token@otel.example:4317",
        },
      }),
    );
    const { stdout } = runTool("user-status");
    expect(stdout).not.toContain("s3cret-token");
    expect(stdout).toContain("https://***@otel.example:4317");
  });
});

describe("settings-tool project name", () => {
  it("keeps an existing name with an underscore exactly as it is", () => {
    fs.writeFileSync(
      projectFile,
      JSON.stringify({
        env: { OTEL_RESOURCE_ATTRIBUTES: "project.name=my_project" },
      }),
    );
    const { output } = runTool("detect-name");
    expect(output["existing"]).toMatchObject({
      source: path.join(".claude", "settings.local.json"),
      value: "my_project",
      keep: true,
      suggested: "my_project",
    });
  });

  it("takes the name from an old analytics.json when the settings file has none", () => {
    fs.writeFileSync(
      analyticsFile,
      JSON.stringify({ project_name: "old_name", capture_mode: "otel-only" }),
    );
    const { output } = runTool("detect-name");
    expect(output).toEqual({
      existing: {
        source: path.join(".claude", "analytics.json"),
        value: "old_name",
        keep: true,
        suggested: "old_name",
      },
    });
  });

  it("lets the name in the settings file win over an old analytics.json", () => {
    fs.writeFileSync(
      projectFile,
      JSON.stringify({
        env: { OTEL_RESOURCE_ATTRIBUTES: "project.name=settings-name" },
      }),
    );
    fs.writeFileSync(
      analyticsFile,
      JSON.stringify({ project_name: "old_name" }),
    );
    const { output } = runTool("detect-name");
    expect(output["existing"]).toMatchObject({ value: "settings-name" });
  });

  it("deletes an old analytics.json after the project settings are written", () => {
    fs.writeFileSync(
      analyticsFile,
      JSON.stringify({ project_name: "old_name" }),
    );
    const { status, output } = runTool(
      "project-write",
      "old_name",
      "otel-only",
    );
    expect(status).toBe(0);
    expect(output["removedAnalyticsFile"]).toBe(true);
    expect(fs.existsSync(analyticsFile)).toBe(false);
    expect(readJson(projectFile).env).toEqual({
      OTEL_RESOURCE_ATTRIBUTES: "project.name=old_name",
    });
    const secondRun = runTool("project-write", "old_name", "otel-only");
    expect(secondRun.output["status"]).toBe("unchanged");
    expect(secondRun.output["removedAnalyticsFile"]).toBe(false);
  });

  it("keeps an old analytics.json when the project write stops", () => {
    fs.writeFileSync(
      analyticsFile,
      JSON.stringify({ project_name: "old_name" }),
    );
    fs.writeFileSync(projectFile, "{ not json");
    const { status } = runTool("project-write", "old_name", "otel-only");
    expect(status).toBe(2);
    expect(fs.existsSync(analyticsFile)).toBe(true);
  });

  it("suggests a clean name when an existing name has a space", () => {
    fs.writeFileSync(
      projectFile,
      JSON.stringify({
        env: { OTEL_RESOURCE_ATTRIBUTES: "project.name=my app" },
      }),
    );
    const { output } = runTool("detect-name");
    expect(output["existing"]).toMatchObject({
      value: "my app",
      keep: false,
      suggested: "my-app",
    });
  });

  it("falls back to the folder name when there is no package.json and no git remote", () => {
    const { output } = runTool("detect-name");
    expect(output["detected"]).toMatchObject({
      source: "folder name",
      raw: "my_project",
      suggested: "my-project",
    });
  });
});
