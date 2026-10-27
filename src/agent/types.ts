export interface AgentUiQuestion {
  id: string;
  title: string;
  prompt: string;
  options?: Array<{ label: string; description?: string }>;
  allowOther?: boolean;
  secret?: boolean;
}

export type AgentApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | { acceptWithExecpolicyAmendment: Record<string, unknown> }
  | { applyNetworkPolicyAmendment: Record<string, unknown> };

export type AgentUiRequest =
  | { id: string; method: 'select'; title: string; options: string[]; timeout?: number }
  | { id: string; method: 'confirm'; title: string; message: string; timeout?: number }
  | { id: string; method: 'input'; title: string; placeholder?: string; timeout?: number }
  | { id: string; method: 'editor'; title: string; prefill?: string; promptStyle?: boolean }
  | { id: string; method: 'form'; title: string; questions: AgentUiQuestion[]; timeout?: number }
  | { id: string; method: 'approval'; title: string; message: string; decisions: AgentApprovalDecision[]; timeout?: number };

export type AgentUiResponse =
  | { value: string }
  | { confirmed: boolean }
  | { answers: Record<string, string[]> }
  | { decision: AgentApprovalDecision }
  | { cancelled: true; timedOut?: boolean };

export type AgentUiNoticeType = 'info' | 'warning' | 'error';

export interface AgentUiStatus {
  key: string;
  text?: string;
}

export interface AgentUiWidget {
  key: string;
  lines?: string[];
  placement?: 'aboveEditor' | 'belowEditor';
}

export interface AgentHostToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  hidden?: boolean;
}

export interface AgentHostToolResult {
  result: unknown;
  isError?: boolean;
}

export interface AgentHostTool {
  definition: AgentHostToolDefinition;
  execute(args: Record<string, unknown>): Promise<AgentHostToolResult>;
}

export interface AgentHostUriSchemeDefinition {
  scheme: string;
  description?: string;
  writable?: boolean;
  immutable?: boolean;
}

export interface AgentHostUriResult {
  content?: string;
  contentType?: 'text/markdown' | 'application/json' | 'text/plain';
  notes?: string[];
  immutable?: boolean;
  isError?: boolean;
  error?: string;
}

export interface AgentHostUriScheme {
  definition: AgentHostUriSchemeDefinition;
  handle(req: { operation: 'read' | 'write'; url: string; content?: string }): Promise<AgentHostUriResult>;
}

export type AgentAdditionalContext = Record<string, {
  value: string;
  kind: 'application' | 'untrusted';
}>;

export type AgentEvent =
  | { type: 'system'; sessionId?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_update'; id: string; output: string }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; totalTokens?: number; contextTokens?: number; modelContextWindow?: number; costUsd?: number }
  | { type: 'ui_request'; request: AgentUiRequest }
  | { type: 'ui_cancel'; targetId: string }
  | { type: 'ui_notice'; message: string; level?: AgentUiNoticeType }
  | { type: 'ui_status'; status: AgentUiStatus }
  | { type: 'ui_widget'; widget: AgentUiWidget }
  | { type: 'ui_title'; title: string }
  | { type: 'ui_editor_text'; text: string }
  | { type: 'ui_open_url'; url: string; instructions?: string }
  | { type: 'done'; sessionId?: string }
  | { type: 'error'; message: string };

/** A thread's persisted model settings, read without loading the thread. */
export interface ThreadModelState {
  model: string | null;
  effort: string | null;
  loaded: boolean;
  canAcceptDirectInput: boolean | null;
}

/** A model advertised by the agent's model catalog. */
export interface ModelOption {
  model: string;
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  hidden: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
}

export interface ListModelsOptions {
  includeHidden?: boolean;
  forceRefresh?: boolean;
}

/** Distinguishes an unreadable thread from one that no longer exists. */
export class ThreadModelReadError extends Error {
  readonly code: 'not_found' | 'read_failed';

  constructor(code: 'not_found' | 'read_failed', message: string) {
    super(message);
    this.name = 'ThreadModelReadError';
    this.code = code;
  }
}

export interface AgentRunOptions {
  prompt: string;
  /** Stable client-side id for the user message that starts this turn. */
  clientUserMessageId?: string;
  /** User-facing name to apply when this run creates a fresh session. */
  title?: string;
  cwd?: string;
  sessionId?: string;
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  /** Local image paths to pass to agents that support native image flags. */
  imagePaths?: string[];
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when stop() is called on
   * the returned run. Lets the agent (and any subprocess it spawned, e.g.
   * lark-cli mid-OAuth) clean up before the kernel reaps the tree.
   * Adapters that don't kill via signals are free to ignore this. Defaults
   * are adapter-specific.
   */
  stopGraceMs?: number;
  hostTools?: AgentHostTool[];
  hostUriSchemes?: AgentHostUriScheme[];
  /** Structured client context passed outside the visible user prompt. */
  additionalContext?: AgentAdditionalContext;
}

export interface AgentRun {
  readonly events: AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  respondToUi?(requestId: string, response: AgentUiResponse): boolean;
  submitPrompt?(
    kind: 'steer' | 'follow_up',
    message: string,
    imagePaths?: string[],
    additionalContext?: AgentAdditionalContext,
  ): Promise<boolean>;
  /**
   * Wait up to `timeoutMs` for the agent process to exit on its own.
   * Resolves true if it exited within the window, false if the timer
   * fired first (caller usually wants to fall back to stop()).
   *
   * Use this after a terminal stream event (`done` / `error`): the
   * The terminal event may arrive before the adapter process has actually
   * closed stdout — there can be a brief telemetry/cleanup tail in between.
   * Calling stop() in that window forces termination and can turn a clean run
   * into a signal exit; waiting it out lets it exit cleanly.
   */
  waitForExit(timeoutMs: number): Promise<boolean>;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  run(opts: AgentRunOptions): AgentRun;
  listSessions?(cwd: string): Promise<import('../project/types').SessionSummary[]>;
  /** List recent non-archived sessions across all project directories. */
  listRecentSessions?(): Promise<import('../project/types').SessionSummary[]>;
  listSessionPage?(cwd: string, cursor?: string, searchTerm?: string): Promise<import('../project/types').SessionPage>;
  listProjectRoots?(): Promise<string[]>;
  readSession?(threadId: string): Promise<import('../project/types').SessionDetail>;
  /** Read a thread's persisted model settings without loading it. */
  readThreadModel?(threadId: string): Promise<ThreadModelState>;
  /** List the models this agent can use. */
  listModels?(opts?: ListModelsOptions): Promise<ModelOption[]>;
  createSession?(cwd: string): Promise<import('../project/types').SessionSummary>;
  renameSession?(threadId: string, title: string): Promise<void>;
  archiveSession?(threadId: string): Promise<void>;
  unarchiveSession?(threadId: string): Promise<import('../project/types').SessionSummary>;
  forkSession?(threadId: string, cwd?: string): Promise<import('../project/types').SessionSummary>;
  compactSession?(threadId: string): Promise<void>;
  reviewSession?(threadId: string): Promise<void>;
  /** Release a thread writer after a short idle grace, if supported. */
  releaseWriterIfIdle?(): Promise<void>;
  /** Close shared adapter resources such as a long-lived app-server child. */
  close?(): Promise<void>;
}
