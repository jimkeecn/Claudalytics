#!/usr/bin/env node
// Reads and writes the Claude Code settings files for /init-claudalytics, one process per step.
// Settings files can hold tokens, so it never prints a whole file: each command prints one JSON
// line with only the values the step needs. Exit code 2 means STOP (the message is in "stop").
// detect-name and the project-* commands need --project-dir <project root>.
//
//   detect-name                          existing / detected project name
//   normalize-name <text>                a new name made safe for OTEL_RESOURCE_ATTRIBUTES
//   user-status                          the 13 user OTel keys: missing / different
//   user-write <add_missing|replace>     merge the user OTel block
//   project-status                       .claude/settings.local.json summary
//   project-write <name> <otel-only|otel+hooks>
//                                        otel+hooks adds our do-nothing CwdChanged hook, otel-only removes it
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const USER_OTEL_BLOCK = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4317",
  OTEL_LOG_USER_PROMPTS: "1",
  OTEL_LOG_TOOL_DETAILS: "1",
  OTEL_LOG_TOOL_CONTENT: "1",
  OTEL_METRIC_EXPORT_INTERVAL: "10000",
  OTEL_LOGS_EXPORT_INTERVAL: "5000",
  OTEL_RESOURCE_ATTRIBUTES: "project.name=unassigned",
};

const HOOK_CAPTURE_PLUGIN = "claudalytics-hook-capture@claudalytics";
const PROJECT_SETTINGS_FILE = path.join(".claude", "settings.local.json");
const SHARED_PROJECT_SETTINGS_FILE = path.join(".claude", "settings.json");
// Written by Claudalytics 1.x and early 2.0. The project name now lives only in the settings file.
const LEGACY_ANALYTICS_FILE = path.join(".claude", "analytics.json");
const LEGACY_HOOK_SCRIPTS = [
  ".claude/hooks/forward-hook.sh",
  ".claude/hooks/session-start-health-check.sh",
  ".claude/hooks/session-start-forward.sh",
];
const LEGACY_HOOK_URL = "http://localhost:4319/hook";
// Claude Code sends CwdChanged to a plugin only when a settings file has a CwdChanged hook too.
// In OTel + hooks mode the project file gets this one. It does nothing; the hook-capture plugin
// does the forwarding. JSON has no comments, so the note after # tells it apart from a user's own
// hook: only a hook with exactly this command is ours. "exit 0 # note" is valid in the three
// shells that can run a hook command: sh (macOS, Linux), Git Bash and PowerShell (Windows).
const CWD_CHANGED_EVENT = "CwdChanged";
export const CWD_CHANGED_HOOK = {
  type: "command",
  command:
    "exit 0 # claudalytics: lets the hook-capture plugin receive CwdChanged",
  async: true,
};
const ALWAYS_IGNORED_IN_PROJECT = [
  "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA",
  "ENABLE_ENHANCED_TELEMETRY_BETA",
  "OTEL_LOG_ASSISTANT_RESPONSES",
  "OTEL_LOG_RAW_API_BODIES",
  "OTEL_RESOURCE_INCLUDE_HOST",
];
// A project file can only turn these off, so an off value is the repo's opt-out and stays.
const KEPT_WHEN_OFF = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_TOOL_CONTENT",
];
const OFF_VALUES = new Set(["0", "false"]);
const EXPORTERS = [
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_TRACES_EXPORTER",
];
const EXPORTER_SETTING_SUFFIXES = [
  "_ENDPOINT",
  "_HEADERS",
  "_PROTOCOL",
  "_CERTIFICATE",
  "_CLIENT_KEY",
  "_INSECURE",
];
const DEFAULT_INTERVALS = {
  OTEL_METRIC_EXPORT_INTERVAL: "10000",
  OTEL_LOGS_EXPORT_INTERVAL: "5000",
};
const UNSAFE_NAME_CHARACTERS = /[\s,=%"']/;

export class StopError extends Error {}

export function userSettingsPath() {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(configDir, "settings.json");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isDeepEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => isDeepEqual(item, right[index]))
    );
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => key in right && isDeepEqual(left[key], right[key]))
  );
}

export function topLevelDifferences(before, after, ignoredKeys) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(
    (key) =>
      !ignoredKeys.includes(key) && !isDeepEqual(before[key], after[key]),
  );
}

// JSON.parse rounds a number with 16 or more digits, so a write would change it without a word.
// Digits inside strings don't count.
export function hasLongNumber(text) {
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (character === "\\") index++;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    } else if (character === "-" || (character >= "0" && character <= "9")) {
      const number = text.slice(index).match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/);
      if (!number) continue;
      const mantissa = number[0].split(/[eE]/)[0];
      if ((mantissa.match(/\d/g) ?? []).length >= 16) return true;
      index += number[0].length - 1;
    }
  }
  return false;
}

function parseSettingsText(rawText, file) {
  const text = rawText.startsWith("\uFEFF") ? rawText.slice(1) : rawText;
  let settings;
  try {
    settings = text.trim() === "" ? {} : JSON.parse(text);
  } catch (error) {
    // Don't repeat the parser message: newer Node versions quote the file text in it.
    const place = String(error.message).match(
      /line \d+ column \d+|position \d+/,
    );
    throw new StopError(
      `${file} is not valid JSON${place ? ` (${place[0]})` : ""}. Fix the file by hand, then run /init-claudalytics again.`,
    );
  }
  if (!isPlainObject(settings))
    throw new StopError(
      `${file} does not hold a JSON object. Fix the file by hand, then run /init-claudalytics again.`,
    );
  if (hasLongNumber(text))
    throw new StopError(
      `${file} has a number with 16 or more digits, which this tool can't keep exactly. Make the change by hand, then run /init-claudalytics again.`,
    );
  if ("env" in settings && !isPlainObject(settings.env))
    throw new StopError(
      `"env" in ${file} is not an object. Fix the file by hand, then run /init-claudalytics again.`,
    );
  return { settings, text };
}

export function readSettings(file) {
  if (!fs.existsSync(file))
    return {
      exists: false,
      settings: {},
      hasBom: false,
      lineEnding: "\n",
      endsWithNewline: true,
    };
  const rawText = fs.readFileSync(file, "utf8");
  const { settings, text } = parseSettingsText(rawText, file);
  return {
    exists: true,
    settings,
    hasBom: rawText.startsWith("\uFEFF"),
    lineEnding: text.includes("\r\n") ? "\r\n" : "\n",
    endsWithNewline: /\n$/.test(text),
  };
}

export function serializeSettings(settings, format) {
  let text =
    JSON.stringify(settings, null, 2) + (format.endsWithNewline ? "\n" : "");
  if (format.lineEnding === "\r\n") text = text.replace(/\n/g, "\r\n");
  return (format.hasBom ? "\uFEFF" : "") + text;
}

function backupTimestamp() {
  const now = new Date();
  const twoDigits = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${twoDigits(now.getMonth() + 1)}${twoDigits(now.getDate())}-${twoDigits(now.getHours())}${twoDigits(now.getMinutes())}${twoDigits(now.getSeconds())}`;
}

function makeBackup(file) {
  const base = `${file}.claudalytics-backup-${backupTimestamp()}`;
  for (let attempt = 1; ; attempt++) {
    const backup = attempt === 1 ? base : `${base}-${attempt}`;
    if (!fs.existsSync(backup)) {
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
      return backup;
    }
  }
}

// Writes a temp file in the same folder, flushes it, then renames it over the target, so a crash
// can't leave a half-written settings file. rename replaces an existing file on Windows too.
export function replaceFileAtomically(file, text, mode) {
  const temp = `${file}.claudalytics-tmp-${process.pid}`;
  try {
    const descriptor = fs.openSync(temp, "w", mode ?? 0o666);
    try {
      fs.writeFileSync(descriptor, text);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (mode !== undefined) fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function putBackOriginal(file, originalText, mode) {
  try {
    if (originalText === null) fs.rmSync(file, { force: true });
    else if (
      !fs.existsSync(file) ||
      fs.readFileSync(file, "utf8") !== originalText
    )
      replaceFileAtomically(file, originalText, mode);
  } catch {
    // The backup file stays next to the settings file, so the user can copy it back.
  }
}

// Backs up, writes, reads the file back and compares it with the backup. Only changedKeys may differ.
// If the write fails or anything else differs, it puts the backup back (or removes a file it created).
export function writeSafely(
  file,
  current,
  nextSettings,
  changedKeys,
  readBack = (target) => fs.readFileSync(target, "utf8"),
  writeFile = replaceFileAtomically,
) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A read-only file stops here, before the backup: EPERM / EACCES on <file>.
  if (current.exists) fs.accessSync(file, fs.constants.W_OK);
  const mode = current.exists ? fs.statSync(file).mode & 0o777 : undefined;
  const backup = current.exists ? makeBackup(file) : null;
  const originalText = backup ? fs.readFileSync(backup, "utf8") : null;
  const before = backup ? parseSettingsText(originalText, backup).settings : {};
  try {
    writeFile(file, serializeSettings(nextSettings, current), mode);
  } catch (error) {
    putBackOriginal(file, originalText, mode);
    throw error;
  }

  let problems;
  try {
    const written = parseSettingsText(readBack(file), file).settings;
    problems = [
      ...topLevelDifferences(before, written, changedKeys),
      ...changedKeys.filter(
        (key) => !isDeepEqual(written[key], nextSettings[key]),
      ),
    ];
  } catch {
    problems = ["the file can't be read back"];
  }
  if (problems.length > 0) {
    putBackOriginal(file, originalText, mode);
    throw new StopError(
      `The read-back of ${file} did not match (${problems.join(", ")}). ${backup ? "The backup was put back" : "The new file was removed"}, so nothing changed.`,
    );
  }
  return backup;
}

function readJsonQuietly(file) {
  try {
    return parseSettingsText(fs.readFileSync(file, "utf8"), file).settings;
  } catch {
    return null;
  }
}

function projectNameFrom(attributes) {
  const entry = String(attributes ?? "")
    .split(",")
    .find((pair) => pair.trim().startsWith("project.name="));
  return entry ? entry.trim().slice("project.name=".length) : null;
}

export function withProjectName(attributes, projectName) {
  const pairs = String(attributes ?? "")
    .split(",")
    .filter((pair) => pair.trim() !== "");
  const index = pairs.findIndex((pair) =>
    pair.trim().startsWith("project.name="),
  );
  if (index >= 0) pairs[index] = `project.name=${projectName}`;
  else pairs.unshift(`project.name=${projectName}`);
  return pairs.join(",");
}

export function isSafeExistingName(name) {
  return (
    typeof name === "string" &&
    name !== "" &&
    !UNSAFE_NAME_CHARACTERS.test(name)
  );
}

export function normalizeNewName(text) {
  return String(text)
    .trim()
    .replace(/^@[^/]+\//, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function detectNewName() {
  const packageJson = readJsonQuietly("package.json");
  if (
    packageJson &&
    typeof packageJson.name === "string" &&
    packageJson.name.trim() !== ""
  )
    return { source: "package.json", raw: packageJson.name };
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const lastPart = remote
      .replace(/\/+$/, "")
      .split(/[/:]/)
      .pop()
      ?.replace(/\.git$/, "");
    if (lastPart) return { source: "git remote", raw: lastPart };
  } catch {
    // no git, or no origin remote
  }
  return { source: "folder name", raw: path.basename(process.cwd()) };
}

function detectName() {
  const projectSettings = readJsonQuietly(PROJECT_SETTINGS_FILE);
  const settingsName = projectNameFrom(
    projectSettings?.env?.OTEL_RESOURCE_ATTRIBUTES,
  );
  const legacyName = readJsonQuietly(LEGACY_ANALYTICS_FILE)?.project_name;
  const existingValue = settingsName || legacyName;
  if (existingValue) {
    const keep = isSafeExistingName(existingValue);
    return {
      existing: {
        source: settingsName ? PROJECT_SETTINGS_FILE : LEGACY_ANALYTICS_FILE,
        value: existingValue,
        keep,
        suggested: keep ? existingValue : normalizeNewName(existingValue),
      },
    };
  }
  const detected = detectNewName();
  return {
    detected: { ...detected, suggested: normalizeNewName(detected.raw) },
  };
}

// An endpoint like https://user:token@host keeps a password in the URL: print *** instead.
export function withoutUrlUserinfo(value) {
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]*@/i, "$1***@");
}

function userStatus() {
  const file = userSettingsPath();
  const current = readSettings(file);
  const env = current.settings.env ?? {};
  const missing = [];
  const different = [];
  for (const [key, wanted] of Object.entries(USER_OTEL_BLOCK)) {
    if (!(key in env)) missing.push(key);
    else if (String(env[key]) !== wanted)
      different.push({
        key,
        yours: withoutUrlUserinfo(String(env[key])),
        claudalytics: wanted,
      });
  }
  const state =
    different.length > 0
      ? "some_different"
      : missing.length > 0
        ? "some_missing"
        : "all_present";
  return {
    file,
    exists: current.exists,
    validJson: true,
    envIsObject: true,
    state,
    missing,
    different,
  };
}

function userWrite(mode) {
  if (mode !== "add_missing" && mode !== "replace")
    throw new StopError(
      `user-write needs add_missing or replace, not "${mode}".`,
    );
  const file = userSettingsPath();
  const current = readSettings(file);
  const oldEnv = current.settings.env ?? {};
  const env = { ...oldEnv };
  const added = [];
  const replaced = [];
  for (const [key, wanted] of Object.entries(USER_OTEL_BLOCK)) {
    if (!(key in env)) added.push(key);
    else if (mode === "replace" && String(env[key]) !== wanted)
      replaced.push(key);
    else continue;
    env[key] = wanted;
  }
  if (added.length === 0 && replaced.length === 0)
    return { file, status: "unchanged", backup: null };
  const backup = writeSafely(file, current, { ...current.settings, env }, [
    "env",
  ]);
  return {
    file,
    status: current.exists ? "written" : "created",
    backup,
    added,
    replaced,
  };
}

function isLegacyHook(hook) {
  return (
    LEGACY_HOOK_SCRIPTS.some((script) =>
      String(hook?.command ?? "").includes(script),
    ) || String(hook?.url ?? "").startsWith(LEGACY_HOOK_URL)
  );
}

function isCwdChangedHook(hook) {
  return hook?.command === CWD_CHANGED_HOOK.command;
}

function withoutHooks(hooks, isRemovedHook) {
  let removed = 0;
  const kept = {};
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      kept[eventName] = groups;
      continue;
    }
    const keptGroups = [];
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        keptGroups.push(group);
        continue;
      }
      const keptHooks = group.hooks.filter((hook) => !isRemovedHook(hook));
      removed += group.hooks.length - keptHooks.length;
      if (keptHooks.length > 0)
        keptGroups.push(
          keptHooks.length === group.hooks.length
            ? group
            : { ...group, hooks: keptHooks },
        );
    }
    if (keptGroups.length > 0) kept[eventName] = keptGroups;
  }
  return { hooks: kept, removed };
}

// OTel + hooks mode needs our CwdChanged hook, OTel-only mode must not have it.
// A user's own CwdChanged hooks stay in both modes.
function withCwdChangedHook(hooks, captureMode) {
  const groups = Array.isArray(hooks[CWD_CHANGED_EVENT])
    ? hooks[CWD_CHANGED_EVENT]
    : [];
  const isThere = groups.some(
    (group) =>
      Array.isArray(group?.hooks) && group.hooks.some(isCwdChangedHook),
  );
  if (captureMode === "otel+hooks") {
    if (isThere) return { hooks, change: "already_there" };
    return {
      hooks: {
        ...hooks,
        [CWD_CHANGED_EVENT]: [...groups, { hooks: [{ ...CWD_CHANGED_HOOK }] }],
      },
      change: "added",
    };
  }
  if (!isThere) return { hooks, change: "none" };
  return {
    hooks: withoutHooks(hooks, isCwdChangedHook).hooks,
    change: "removed",
  };
}

function isIgnoredInProject(key, value) {
  const text = String(value).trim().toLowerCase();
  if (ALWAYS_IGNORED_IN_PROJECT.includes(key)) return true;
  if (KEPT_WHEN_OFF.includes(key)) return !OFF_VALUES.has(text);
  if (EXPORTERS.includes(key)) return text !== "none";
  if (
    key.startsWith("OTEL_EXPORTER_OTLP_") &&
    EXPORTER_SETTING_SUFFIXES.some((suffix) => key.endsWith(suffix))
  )
    return true;
  return key in DEFAULT_INTERVALS && String(value) === DEFAULT_INTERVALS[key];
}

function plannedProjectSettings(settings, projectName, captureMode) {
  const next = { ...settings };
  const removedEnvKeys = [];
  const keptOptOuts = [];
  const env = {};
  for (const [key, value] of Object.entries(settings.env ?? {})) {
    if (key === "OTEL_RESOURCE_ATTRIBUTES") continue;
    if (isIgnoredInProject(key, value)) removedEnvKeys.push(key);
    else {
      env[key] = value;
      if (KEPT_WHEN_OFF.includes(key) || EXPORTERS.includes(key))
        keptOptOuts.push(key);
    }
  }
  const attributes = withProjectName(
    settings.env?.OTEL_RESOURCE_ATTRIBUTES,
    projectName,
  );
  const orderedEnv = {};
  let attributesPlaced = false;
  for (const key of Object.keys(settings.env ?? {})) {
    if (key === "OTEL_RESOURCE_ATTRIBUTES") {
      orderedEnv[key] = attributes;
      attributesPlaced = true;
    } else if (key in env) orderedEnv[key] = env[key];
  }
  if (!attributesPlaced) orderedEnv.OTEL_RESOURCE_ATTRIBUTES = attributes;
  next.env = orderedEnv;

  const hadHooks = isPlainObject(settings.hooks);
  const cleaned = withoutHooks(hadHooks ? settings.hooks : {}, isLegacyHook);
  const removedHookEntries = cleaned.removed;
  const cwdChanged = withCwdChangedHook(cleaned.hooks, captureMode);
  if (cwdChanged.change === "removed" && isDeepEqual(cwdChanged.hooks, {}))
    delete next.hooks;
  else if (
    removedHookEntries > 0 ||
    cwdChanged.change === "added" ||
    cwdChanged.change === "removed"
  )
    next.hooks = cwdChanged.hooks;
  if (captureMode === "otel-only") {
    next.enabledPlugins = {
      ...(isPlainObject(settings.enabledPlugins)
        ? settings.enabledPlugins
        : {}),
      [HOOK_CAPTURE_PLUGIN]: false,
    };
  }
  return {
    next,
    removedEnvKeys,
    keptOptOuts,
    removedHookEntries,
    cwdChangedHook: cwdChanged.change,
  };
}

function projectStatus() {
  const current = readSettings(PROJECT_SETTINGS_FILE);
  const shared = readJsonQuietly(SHARED_PROJECT_SETTINGS_FILE);
  const env = current.settings.env ?? {};
  const planned = plannedProjectSettings(current.settings, "x", "otel+hooks");
  return {
    file: PROJECT_SETTINGS_FILE,
    exists: current.exists,
    validJson: true,
    envIsObject: true,
    projectName: projectNameFrom(env.OTEL_RESOURCE_ATTRIBUTES),
    hookCaptureEntry:
      current.settings.enabledPlugins?.[HOOK_CAPTURE_PLUGIN] ?? null,
    sharedHookCaptureEntry:
      shared?.enabledPlugins?.[HOOK_CAPTURE_PLUGIN] ?? null,
    legacyHookEntries: planned.removedHookEntries,
    legacyHookScripts: LEGACY_HOOK_SCRIPTS.filter((script) =>
      fs.existsSync(script),
    ),
    keysToRemove: planned.removedEnvKeys,
    optOutsKept: planned.keptOptOuts,
  };
}

function projectWrite(projectName, captureMode) {
  if (!isSafeExistingName(projectName))
    throw new StopError(
      `The project name "${projectName}" is empty or has a space, comma, "=", "%" or a quote. Pick another name.`,
    );
  if (captureMode !== "otel-only" && captureMode !== "otel+hooks")
    throw new StopError(
      `project-write needs otel-only or otel+hooks, not "${captureMode}".`,
    );
  const current = readSettings(PROJECT_SETTINGS_FILE);
  if ("hooks" in current.settings && !isPlainObject(current.settings.hooks))
    throw new StopError(
      `"hooks" in ${PROJECT_SETTINGS_FILE} is not an object. Fix the file by hand, then run /init-claudalytics again.`,
    );
  const cwdChangedGroups = current.settings.hooks?.[CWD_CHANGED_EVENT];
  if (cwdChangedGroups !== undefined && !Array.isArray(cwdChangedGroups))
    throw new StopError(
      `"hooks.${CWD_CHANGED_EVENT}" in ${PROJECT_SETTINGS_FILE} is not a list. Fix the file by hand, then run /init-claudalytics again.`,
    );
  const planned = plannedProjectSettings(
    current.settings,
    projectName,
    captureMode,
  );
  const rawApiBodiesRemoved = planned.removedEnvKeys.includes(
    "OTEL_LOG_RAW_API_BODIES",
  );
  let status = "unchanged";
  let backup = null;
  if (!current.exists || !isDeepEqual(planned.next, current.settings)) {
    backup = writeSafely(PROJECT_SETTINGS_FILE, current, planned.next, [
      "env",
      "hooks",
      "enabledPlugins",
    ]);
    status = current.exists ? "written" : "created";
  }
  // Old 1.0 script files go only after the settings no longer point at them.
  const removedScripts = LEGACY_HOOK_SCRIPTS.filter((script) =>
    fs.existsSync(script),
  );
  for (const script of removedScripts) fs.rmSync(script, { force: true });
  const removedAnalyticsFile = fs.existsSync(LEGACY_ANALYTICS_FILE);
  if (removedAnalyticsFile) fs.rmSync(LEGACY_ANALYTICS_FILE, { force: true });
  return {
    file: PROJECT_SETTINGS_FILE,
    status,
    backup,
    removedEnvKeys: planned.removedEnvKeys,
    optOutsKept: planned.keptOptOuts,
    removedHookEntries: planned.removedHookEntries,
    cwdChangedHook: planned.cwdChangedHook,
    removedScripts,
    removedAnalyticsFile,
    rawApiBodiesRemoved,
  };
}

function isInside(folder, parent) {
  const normalize = (value) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const child = normalize(fs.realpathSync(folder));
  const root = normalize(fs.realpathSync(parent));
  return child === root || child.startsWith(root + path.sep);
}

const PROJECT_COMMANDS = new Set([
  "detect-name",
  "project-status",
  "project-write",
]);

function takeProjectDir(args) {
  const flagIndex = args.indexOf("--project-dir");
  if (flagIndex < 0) return { projectDir: "", commandArgs: args };
  return {
    projectDir: args[flagIndex + 1] ?? "",
    commandArgs: [...args.slice(0, flagIndex), ...args.slice(flagIndex + 2)],
  };
}

// The project files are relative to the project root. An empty --project-dir (the variable was
// not filled in) must not mean "the current folder", which can be a subfolder: ask git, else stop.
function enterProjectDir(projectDir) {
  let folder = projectDir;
  if (folder === "") {
    try {
      folder = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      folder = "";
    }
  }
  if (folder === "")
    throw new StopError(
      "The project folder is unknown: --project-dir is empty and this folder is not in a git repo. Start Claude Code in the project's root folder and run /init-claudalytics again.",
    );
  if (!fs.existsSync(folder))
    throw new StopError(`The project folder ${folder} does not exist.`);
  process.chdir(folder);
  const pluginRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  if (isInside(process.cwd(), pluginRoot))
    throw new StopError(
      "The settings tool runs in the plugin folder. Run it from the project's root folder (don't cd), so it doesn't read or change the wrong files.",
    );
}

export function runCommand(args) {
  const { projectDir, commandArgs } = takeProjectDir(args);
  const [command, ...rest] = commandArgs;
  if (PROJECT_COMMANDS.has(command)) enterProjectDir(projectDir);
  switch (command) {
    case "detect-name":
      return detectName();
    case "normalize-name":
      return { suggested: normalizeNewName(rest.join(" ")) };
    case "user-status":
      return userStatus();
    case "user-write":
      return userWrite(rest[0]);
    case "project-status":
      return projectStatus();
    case "project-write":
      return projectWrite(rest[0], rest[1]);
    default:
      throw new StopError(`Unknown command "${command ?? ""}".`);
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const entry = fs.realpathSync(process.argv[1]);
    return process.platform === "win32"
      ? self.toLowerCase() === entry.toLowerCase()
      : self === entry;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    console.log(JSON.stringify(runCommand(process.argv.slice(2))));
  } catch (error) {
    // Every failure is one JSON line and exit 2. A system error gives only its code and the file,
    // never its message or the file text.
    const message =
      error instanceof StopError
        ? error.message
        : `${error?.code ?? error?.name ?? "Error"} on ${error?.path ?? "a settings file"}`;
    console.log(JSON.stringify({ stop: message }));
    process.exitCode = 2;
  }
}
