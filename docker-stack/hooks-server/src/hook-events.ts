export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "bypassPermissions";

export interface HookCommon {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  permission_mode?: PermissionMode;
  agent_id?: string;
  agent_type?: string;
}

// ---------- Tool inputs ----------

export interface BashInput {
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
}

export interface WriteInput {
  file_path: string;
  content: string;
}

export interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

export interface GlobInput {
  pattern: string;
  path?: string;
}

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  "-i"?: boolean;
  multiline?: boolean;
}

export interface WebFetchInput {
  url: string;
  prompt: string;
}

export interface WebSearchInput {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

export interface AgentInput {
  prompt: string;
  description?: string;
  subagent_type: string;
  model?: string;
}

export interface AskUserQuestionOption {
  label: string;
  [key: string]: unknown;
}

export interface AskUserQuestionQuestion {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
  [key: string]: unknown;
}

export interface AskUserQuestionInput {
  questions: AskUserQuestionQuestion[];
  answers?: Record<string, string>;
}

export type ExitPlanModeInput = Record<string, never>;

export type ToolInput =
  | BashInput
  | WriteInput
  | EditInput
  | ReadInput
  | GlobInput
  | GrepInput
  | WebFetchInput
  | WebSearchInput
  | AgentInput
  | AskUserQuestionInput
  | ExitPlanModeInput
  | Record<string, unknown>;

// ---------- Tool responses ----------

export interface BashResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WriteResponse {
  filePath: string;
  success: boolean;
}

export interface EditResponse {
  filePath: string;
  success: boolean;
}

export interface ReadResponse {
  content: string;
}

export interface GlobResponse {
  matches: string[];
}

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

export interface GrepResponse {
  matches: GrepMatch[];
}

export type ToolResponse =
  | BashResponse
  | WriteResponse
  | EditResponse
  | ReadResponse
  | GlobResponse
  | GrepResponse
  | Record<string, unknown>;

// ---------- Permission suggestions (PermissionRequest) ----------

export interface PermissionRule {
  toolName: string;
  ruleContent?: string;
}

export interface PermissionSuggestion {
  type: string;
  rules?: PermissionRule[];
  behavior?: "allow" | "deny" | "ask";
  destination?:
    | "session"
    | "localSettings"
    | "projectSettings"
    | "userSettings";
  mode?: string;
}

// ---------- Shared tool-event fields ----------

export interface ToolRefFields {
  tool_name: string;
  tool_input: ToolInput;
}

export interface ToolInvocationFields extends ToolRefFields {
  tool_use_id: string;
}

export interface TeamBaseFields {
  teammate_name: string;
  team_name: string;
}

export interface TaskBaseFields {
  task_id: string;
  task_subject: string;
  task_description: string;
}

export interface LastAssistantMessage {
  last_assistant_message?: string;
}

export interface SubagentIdentityFields {
  agent_id: string;
  agent_type: string;
}

export interface CompactTriggerField {
  trigger: "manual" | "auto";
}

export interface McpInteractionFields {
  mcp_server_name: string;
  mode: string;
}

export interface MessageField {
  message: string;
}

export interface FilePathField {
  file_path: string;
}

// ---------- Events ----------

export interface SessionStartEvent extends HookCommon {
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact";
  model: string;
}

export interface SessionEndEvent extends HookCommon {
  hook_event_name: "SessionEnd";
  reason:
    | "clear"
    | "resume"
    | "logout"
    | "prompt_input_exit"
    | "bypass_permissions_disabled"
    | "other";
}

export interface UserPromptSubmitEvent extends HookCommon {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

export interface PreToolUseEvent extends HookCommon, ToolInvocationFields {
  hook_event_name: "PreToolUse";
}

export interface PostToolUseEvent extends HookCommon, ToolInvocationFields {
  hook_event_name: "PostToolUse";
  tool_response: ToolResponse;
}

export interface PostToolUseFailureEvent
  extends HookCommon, ToolInvocationFields {
  hook_event_name: "PostToolUseFailure";
  error: string;
  is_interrupt?: boolean;
}

export interface PermissionRequestEvent extends HookCommon, ToolRefFields {
  hook_event_name: "PermissionRequest";
  permission_suggestions?: PermissionSuggestion[];
}

export interface PermissionDeniedEvent
  extends HookCommon, ToolInvocationFields {
  hook_event_name: "PermissionDenied";
  reason: string;
}

export interface NotificationEvent extends HookCommon, MessageField {
  hook_event_name: "Notification";
  title?: string;
  notification_type:
    | "permission_prompt"
    | "idle_prompt"
    | "auth_success"
    | "elicitation_dialog";
}

export interface SubagentStartEvent
  extends Omit<HookCommon, "agent_id" | "agent_type">, SubagentIdentityFields {
  hook_event_name: "SubagentStart";
}

export interface SubagentStopEvent
  extends
    Omit<HookCommon, "agent_id" | "agent_type">,
    SubagentIdentityFields,
    LastAssistantMessage {
  hook_event_name: "SubagentStop";
  stop_hook_active: boolean;
  agent_transcript_path: string;
}

export interface TaskCreatedEvent
  extends HookCommon, TaskBaseFields, TeamBaseFields {
  hook_event_name: "TaskCreated";
}

export interface TaskCompletedEvent
  extends HookCommon, TaskBaseFields, TeamBaseFields {
  hook_event_name: "TaskCompleted";
}

export interface StopEvent extends HookCommon {
  hook_event_name: "Stop";
}

export interface StopFailureEvent extends HookCommon, LastAssistantMessage {
  hook_event_name: "StopFailure";
  error:
    | "rate_limit"
    | "authentication_failed"
    | "billing_error"
    | "invalid_request"
    | "server_error"
    | "max_output_tokens"
    | "unknown";
  error_details?: string;
}

export interface TeammateIdleEvent extends HookCommon, TeamBaseFields {
  hook_event_name: "TeammateIdle";
}

export interface InstructionsLoadedEvent extends HookCommon, FilePathField {
  hook_event_name: "InstructionsLoaded";
  memory_type: "User" | "Project" | "Local" | "Managed";
  load_reason:
    | "session_start"
    | "nested_traversal"
    | "path_glob_match"
    | "include"
    | "compact";
  globs?: string[];
  trigger_file_path?: string;
  parent_file_path?: string;
}

export interface ConfigChangeEvent extends HookCommon {
  hook_event_name: "ConfigChange";
  source:
    | "user_settings"
    | "project_settings"
    | "local_settings"
    | "policy_settings"
    | "skills";
  file_path?: string;
}

export interface CwdChangedEvent extends HookCommon {
  hook_event_name: "CwdChanged";
  old_cwd: string;
  new_cwd: string;
}

export interface FileChangedEvent extends HookCommon, FilePathField {
  hook_event_name: "FileChanged";
  event: "change" | "add" | "unlink";
}

export interface WorktreeCreateEvent extends HookCommon {
  hook_event_name: "WorktreeCreate";
}

export interface WorktreeRemoveEvent extends HookCommon {
  hook_event_name: "WorktreeRemove";
  worktree_path: string;
}

export interface PreCompactEvent extends HookCommon, CompactTriggerField {
  hook_event_name: "PreCompact";
  custom_instructions?: string;
}

export interface PostCompactEvent extends HookCommon, CompactTriggerField {
  hook_event_name: "PostCompact";
  compact_summary: string;
}

export interface ElicitationEvent
  extends HookCommon,
    McpInteractionFields,
    MessageField {
  hook_event_name: "Elicitation";
  requested_schema: unknown;
}

export interface ElicitationResultEvent
  extends HookCommon,
    McpInteractionFields {
  hook_event_name: "ElicitationResult";
  action: string;
  content: Record<string, unknown>;
  elicitation_id: string;
}

export type KnownHookEvent =
  | SessionStartEvent
  | SessionEndEvent
  | UserPromptSubmitEvent
  | PreToolUseEvent
  | PostToolUseEvent
  | PostToolUseFailureEvent
  | PermissionRequestEvent
  | PermissionDeniedEvent
  | NotificationEvent
  | SubagentStartEvent
  | SubagentStopEvent
  | TaskCreatedEvent
  | TaskCompletedEvent
  | StopEvent
  | StopFailureEvent
  | TeammateIdleEvent
  | InstructionsLoadedEvent
  | ConfigChangeEvent
  | CwdChangedEvent
  | FileChangedEvent
  | WorktreeCreateEvent
  | WorktreeRemoveEvent
  | PreCompactEvent
  | PostCompactEvent
  | ElicitationEvent
  | ElicitationResultEvent;

export type UnknownHookEvent = HookCommon & {
  hook_event_name: string;
  [key: string]: unknown;
};

export type HookEvent = KnownHookEvent | UnknownHookEvent;

// ---------- Hook output ----------

export interface HookOutputCommon {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    [key: string]: unknown;
  };
}

export interface BlockingDecisionOutput extends HookOutputCommon {
  decision?: "block";
  reason?: string;
  additionalContext?: string;
}

export interface PreToolUseOutput extends HookOutputCommon {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision?: "allow" | "deny" | "ask" | "defer";
    permissionDecisionReason?: string;
    updatedInput?: ToolInput;
    additionalContext?: string;
  };
}

export interface PermissionRequestOutput extends HookOutputCommon {
  hookSpecificOutput: {
    hookEventName: "PermissionRequest";
    decision?: {
      behavior: "allow" | "deny";
      updatedInput?: ToolInput;
      updatedPermissions?: unknown[];
    };
  };
}

export interface PermissionDeniedOutput extends HookOutputCommon {
  hookSpecificOutput: {
    hookEventName: "PermissionDenied";
    retry?: boolean;
  };
}

export interface WorktreeCreateOutput extends HookOutputCommon {
  hookSpecificOutput: {
    hookEventName: "WorktreeCreate";
    worktreePath: string;
  };
}

export interface ElicitationOutput extends HookOutputCommon {
  hookSpecificOutput: {
    hookEventName: "Elicitation" | "ElicitationResult";
    action?: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
  };
}
