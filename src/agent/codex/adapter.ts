import type { AgentAdapter, AgentAdditionalContext, AgentEvent, AgentRun, AgentRunOptions, AgentUiResponse, ListModelsOptions, ModelOption, ThreadModelState } from '../types';
import { ThreadModelReadError } from '../types';
import { log } from '../../core/logger';
import { CodexAppServerClient, type JsonRpcNotification, type JsonRpcServerRequest } from './app-server';
import type { SessionActivity, SessionDetail, SessionPage, SessionSummary } from '../../project/types';

interface QueueValue<T> { value?: T; done?: boolean }

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const value = this.values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.closed) return { value: undefined as never, done: true };
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

interface PendingUi {
  requestId: string | number;
  method: string;
  questionIds?: string[];
  requestedPermissions?: Record<string, unknown>;
}

export interface CodexAdapterOptions {
  binary?: string;
}

interface ThreadResponse {
  id?: string;
  thread?: Record<string, unknown> & { id?: string };
}

const BRIDGE_SERVICE_NAME = 'feishu_codex_bridge';
const WRITER_RELEASE_GRACE_MS = 1_000;

export const CODEX_ACTIVE_WRITER_MESSAGE = '桌面端正在使用这个会话，请在桌面端关闭该会话后重试';

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex';
  private readonly client: CodexAppServerClient;
  private modelCache?: { models: ModelOption[]; expiresAt: number };
  private modelCachePromise?: Promise<ModelOption[]>;
  private activeOperations = 0;
  private releaseTimer?: NodeJS.Timeout;
  private releaseResolve?: () => void;
  private releasePromise?: Promise<void>;
  private releaseRequested = false;

  constructor(opts: CodexAdapterOptions = {}) {
    this.client = new CodexAppServerClient(opts.binary);
  }

  async isAvailable(): Promise<boolean> {
    return this.client.isAvailable();
  }

  async close(): Promise<void> {
    this.releaseRequested = false;
    this.cancelPendingRelease();
    await this.client.close();
  }

  /**
   * Give a completed turn/model operation a short grace period, then close the
   * app-server so another Codex process can take the thread writer. A new
   * operation during the grace cancels the timer but keeps the release intent,
   * which is rescheduled once that operation finishes. The next request after
   * a release restarts the app-server through ensureStarted().
   */
  releaseWriterIfIdle(): Promise<void> {
    this.releaseRequested = true;
    return this.ensureReleaseScheduled();
  }

  private ensureReleaseScheduled(): Promise<void> {
    if (!this.releaseRequested) return Promise.resolve();
    if (this.releasePromise) return this.releasePromise;
    this.releasePromise = new Promise<void>((resolve) => {
      this.releaseResolve = resolve;
      this.releaseTimer = setTimeout(() => {
        this.releaseTimer = undefined;
        if (this.activeOperations > 0) {
          this.finishRelease();
          return;
        }
        this.releaseRequested = false;
        void this.client.close()
          .catch((err) => {
            log.warn('codex', 'writer-release-failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => this.finishRelease());
      }, WRITER_RELEASE_GRACE_MS);
    });
    return this.releasePromise;
  }

  private beginOperation(): void {
    this.activeOperations += 1;
    // A new operation takes priority over a pending release, but the release
    // intent survives so the writer is freed once this operation finishes.
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
    this.finishRelease();
  }

  private endOperation(): void {
    this.activeOperations = Math.max(0, this.activeOperations - 1);
    if (this.activeOperations === 0 && this.releaseRequested) {
      void this.ensureReleaseScheduled();
    }
  }

  private cancelPendingRelease(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
    this.finishRelease();
  }

  private finishRelease(): void {
    const resolve = this.releaseResolve;
    this.releaseResolve = undefined;
    this.releasePromise = undefined;
    resolve?.();
  }

  async listModels(opts: ListModelsOptions = {}): Promise<ModelOption[]> {
    const cacheFresh = this.modelCache !== undefined && this.modelCache.expiresAt > Date.now();
    if (!opts.forceRefresh && cacheFresh) return filterModels(this.modelCache!.models, opts.includeHidden);
    if (!this.modelCachePromise) {
      const pending = this.fetchModels().then((models) => {
        this.modelCache = { models, expiresAt: Date.now() + 60_000 };
        return models;
      }).finally(() => {
        if (this.modelCachePromise === pending) this.modelCachePromise = undefined;
      });
      this.modelCachePromise = pending;
    }
    const models = await this.modelCachePromise;
    return filterModels(models, opts.includeHidden);
  }

  private async fetchModels(): Promise<ModelOption[]> {
    this.beginOperation();
    try {
      const models: ModelOption[] = [];
      let cursor: string | undefined;
      do {
        const response = await this.client.request<{
          data?: Array<Record<string, unknown>>;
          nextCursor?: string | null;
        }>('model/list', {
          includeHidden: true,
          ...(cursor ? { cursor } : {}),
        });
        for (const entry of response.data ?? []) {
          const mapped = mapModel(entry);
          if (mapped) models.push(mapped);
        }
        cursor = response.nextCursor ?? undefined;
      } while (cursor);
      return models;
    } finally {
      this.endOperation();
    }
  }

  async readThreadModel(threadId: string): Promise<ThreadModelState> {
    this.beginOperation();
    try {
      let response: { thread?: Record<string, unknown> };
      try {
        response = await this.client.request('thread/read', { threadId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isThreadNotFoundError(err)) throw new ThreadModelReadError('not_found', message);
        throw new ThreadModelReadError('read_failed', message);
      }
      const thread = response.thread;
      if (!thread) throw new ThreadModelReadError('read_failed', 'Codex app-server did not return the thread');
      const model = typeof thread.model === 'string' && thread.model.trim() ? thread.model.trim() : null;
      const effort = typeof thread.reasoningEffort === 'string' && thread.reasoningEffort.trim() ? thread.reasoningEffort.trim() : null;
      const canAcceptDirectInput = typeof thread.canAcceptDirectInput === 'boolean' ? thread.canAcceptDirectInput : null;
      return { model, effort, canAcceptDirectInput, loaded: canAcceptDirectInput !== null };
    } finally {
      this.endOperation();
    }
  }

  async listSessions(cwd: string): Promise<SessionSummary[]> {
    return (await this.listSessionPage(cwd)).sessions;
  }

  /**
   * Fetch the recent session index once for project-level views. Calling
   * thread/list once per project makes a large project picker feel hung.
   */
  async listRecentSessions(): Promise<SessionSummary[]> {
    const sessions: SessionSummary[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.client.request<{ data?: Array<Record<string, unknown>>; nextCursor?: string | null }>('thread/list', {
        limit: 100,
        archived: false,
        sourceKinds: ['cli', 'vscode', 'appServer'],
        sortKey: 'updated_at',
        sortDirection: 'desc',
        useStateDbOnly: true,
        ...(cursor ? { cursor } : {}),
      });
      for (const thread of response.data ?? []) {
        const session = mapThread(thread, '');
        if (session?.cwd) sessions.push(session);
      }
      cursor = response.nextCursor ?? undefined;
    } while (cursor);
    return sessions;
  }

  async listSessionPage(cwd: string, cursor?: string, searchTerm?: string): Promise<SessionPage> {
    const response = await this.client.request<{ data?: Array<Record<string, unknown>>; nextCursor?: string | null }>('thread/list', {
      cwd,
      limit: 50,
      archived: false,
      sourceKinds: ['cli', 'vscode', 'appServer'],
      sortKey: 'updated_at',
      sortDirection: 'desc',
      useStateDbOnly: true,
      ...(cursor ? { cursor } : {}),
      ...(searchTerm?.trim() ? { searchTerm: searchTerm.trim() } : {}),
    });
    const sessions = (response.data ?? []).map((thread) => mapThread(thread, cwd)).filter((session): session is SessionSummary => session !== undefined);
    return { sessions, ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}) };
  }

  async readSession(threadId: string): Promise<SessionDetail> {
    let response: { thread?: Record<string, unknown> };
    try {
      response = await this.client.request('thread/read', { threadId, includeTurns: true });
    } catch (err) {
      if (!isThreadNotLoadedError(err)) throw err;
      log.info('codex', 'read-session-resume-fallback', { threadId });
      response = await this.client.request('thread/resume', { threadId });
    }
    const thread = response.thread;
    if (!thread) throw new Error('Codex app-server did not return the session');
    const summary = mapThread(thread, typeof thread.cwd === 'string' ? thread.cwd : '');
    if (!summary) throw new Error('Codex app-server returned an invalid session');
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const recentActivity = turns.flatMap((turn) => {
      const items = turn && typeof turn === 'object' && Array.isArray((turn as { items?: unknown[] }).items)
        ? (turn as { items: unknown[] }).items
        : [];
      return items.map(summarizeActivity).filter((item): item is SessionActivity => item !== undefined);
    }).slice(-8);
    return { ...summary, turnCount: turns.length, recentActivity };
  }

  async listProjectRoots(): Promise<string[]> {
    const roots = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await this.client.request<{
        data?: Array<Record<string, unknown>>;
        nextCursor?: string | null;
      }>('thread/list', {
        limit: 100,
        archived: false,
        sourceKinds: ['cli', 'vscode', 'appServer'],
        sortKey: 'updated_at',
        sortDirection: 'desc',
        useStateDbOnly: true,
        ...(cursor ? { cursor } : {}),
      });
      for (const thread of response.data ?? []) {
        if (typeof thread.cwd === 'string' && thread.cwd.trim()) roots.add(thread.cwd);
      }
      cursor = response.nextCursor ?? undefined;
    } while (cursor);
    return [...roots];
  }

  async createSession(cwd: string): Promise<SessionSummary> {
    const response = await this.startThread(cwd);
    const thread = response.thread;
    const threadId = String(thread?.id ?? '');
    if (!threadId) throw new Error('Codex app-server did not return a new session id');
    return {
      threadId,
      name: typeof thread?.name === 'string' ? thread.name : undefined,
      preview: typeof thread?.preview === 'string' ? thread.preview : '新建会话',
      cwd,
      status: 'idle',
      updatedAt: Date.now(),
    };
  }

  async archiveSession(threadId: string): Promise<void> {
    await this.client.request('thread/archive', { threadId });
  }

  async unarchiveSession(threadId: string): Promise<SessionSummary> {
    const response = await this.client.request<{ thread?: Record<string, unknown> }>('thread/unarchive', { threadId });
    const session = response.thread ? mapThread(response.thread, typeof response.thread.cwd === 'string' ? response.thread.cwd : '') : undefined;
    if (!session) throw new Error('Codex app-server did not return the restored session');
    return session;
  }

  async forkSession(threadId: string, cwd?: string): Promise<SessionSummary> {
    const response = await this.client.request<ThreadResponse>('thread/fork', {
      threadId,
      ...(cwd ? { cwd } : {}),
      persistExtendedHistory: true,
    });
    const thread = response.thread;
    const session = thread ? mapThread(thread, cwd ?? '') : undefined;
    if (!session) throw new Error('Codex app-server did not return the forked session');
    return session;
  }

  async compactSession(threadId: string): Promise<void> {
    await this.client.request('thread/compact/start', { threadId });
  }

  async reviewSession(threadId: string): Promise<void> {
    await this.client.request('review/start', {
      threadId,
      delivery: 'inline',
      target: { type: 'uncommittedChanges' },
    });
  }

  async renameSession(threadId: string, title: string): Promise<void> {
    await this.setThreadName(threadId, title);
  }

  private async startThread(cwd?: string): Promise<ThreadResponse> {
    const base = { ...(cwd ? { cwd } : {}) };
    try {
      return await this.client.request<ThreadResponse>('thread/start', {
        ...base,
        serviceName: BRIDGE_SERVICE_NAME,
        threadSource: 'user',
      });
    } catch (err) {
      if (!isDesktopMetadataCompatibilityError(err)) throw err;
      log.warn('codex', 'desktop-metadata-unsupported', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.client.request<ThreadResponse>('thread/start', base);
    }
  }

  private async setThreadName(threadId: string | undefined, title: string | undefined): Promise<void> {
    const name = title?.replace(/\s+/g, ' ').trim();
    if (!threadId || !name) return;
    try {
      await this.client.request('thread/name/set', { threadId, name });
    } catch (err) {
      // Naming is a presentation enhancement. Never fail a user turn when an
      // older app-server does not expose thread/name/set.
      log.warn('codex', 'thread-name-unavailable', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async requestTurn<T>(
    method: 'turn/start' | 'turn/steer',
    params: Record<string, unknown> & { additionalContext?: AgentAdditionalContext },
  ): Promise<T> {
    try {
      return await this.client.request<T>(method, params);
    } catch (err) {
      if (!params.additionalContext || !isAdditionalContextCompatibilityError(err)) throw err;
      log.warn('codex', 'additional-context-unsupported', {
        method,
        error: err instanceof Error ? err.message : String(err),
      });
      const { additionalContext: _ignored, ...fallback } = params;
      return this.client.request<T>(method, fallback);
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    this.beginOperation();
    const client = this.client;
    const requestTurn = this.requestTurn.bind(this);
    const queue = new AsyncQueue<AgentEvent>();
    const pendingUi = new Map<string, PendingUi>();
    let threadId: string | undefined;
    let turnId: string | undefined;
    let replacementStarted = false;
    let stopped = false;
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeRequests: (() => void) | undefined;
    let exitResolve!: () => void;
    const exited = new Promise<void>((resolve) => { exitResolve = resolve; });

    const finish = (): void => {
      if (settled) return;
      settled = true;
      this.endOperation();
      unsubscribe?.();
      unsubscribeRequests?.();
      queue.close();
      exitResolve();
    };

    const isHistoricalCompatibilityFailure = (message: string): boolean => {
      if (!opts.sessionId || replacementStarted) return false;
      return /requires a newer version of Codex|unsupported service_tier|unknown variant|remote compact task|pre-sampling compact/i.test(message);
    };

    const replaceHistoricalSession = (reason: string): boolean => {
      if (!isHistoricalCompatibilityFailure(reason)) return false;
      replacementStarted = true;
      queue.push({ type: 'ui_notice', message: '原 Codex 会话使用了当前设备不兼容的配置，已自动新建会话并重试。', level: 'warning' });
      void (async () => {
        try {
          const replacement = await this.startThread(opts.cwd);
          threadId = replacement.thread?.id ?? replacement.id;
          if (!threadId) throw new Error('Codex app-server did not return a replacement thread id');
          turnId = undefined;
          await this.setThreadName(threadId, opts.title);
          queue.push({ type: 'system', sessionId: threadId, cwd: opts.cwd });
          const turn = await requestTurn<{ id?: string; turn?: { id?: string } }>('turn/start', {
            threadId,
            input: [{ type: 'text', text: opts.prompt, text_elements: [] }],
            ...(opts.clientUserMessageId ? { clientUserMessageId: opts.clientUserMessageId } : {}),
            ...(opts.cwd ? { cwd: opts.cwd } : {}),
            ...(opts.additionalContext ? { additionalContext: opts.additionalContext } : {}),
          });
          turnId = turn.turn?.id ?? turn.id;
        } catch (err) {
          if (!stopped) queue.push({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          finish();
        }
      })();
      return true;
    };

    const handleNotification = (message: JsonRpcNotification): void => {
      const params = message.params ?? {};
      if (message.method === 'error') {
        const error = params.error as { message?: string } | undefined;
        const errorMessage = error?.message ?? 'Codex app-server 返回错误';
        if (!replaceHistoricalSession(errorMessage) && (!params.threadId || params.threadId === threadId)) {
          queue.push({ type: 'error', message: errorMessage });
        }
        return;
      }
      if (message.method === 'turn/started') {
        const turn = params.turn as { id?: string } | undefined;
        if (params.threadId === threadId && turn?.id) turnId = turn.id;
        return;
      }
      if (message.method === 'thread/name/updated' && params.threadId === threadId) {
        if (typeof params.threadName === 'string') queue.push({ type: 'ui_title', title: params.threadName });
        return;
      }
      if (params.threadId !== threadId) return;
      if (message.method === 'item/agentMessage/delta') {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (delta) queue.push({ type: 'text', delta });
      } else if (message.method === 'item/reasoning/summaryTextDelta') {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (delta) queue.push({ type: 'thinking', delta });
      } else if (message.method === 'item/reasoning/textDelta') {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (delta) queue.push({ type: 'thinking', delta });
      } else if (message.method === 'item/plan/delta') {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (delta) queue.push({ type: 'thinking', delta: `\n${delta}` });
      } else if (message.method === 'turn/plan/updated') {
        const plan = Array.isArray(params.plan) ? params.plan : [];
        const lines = plan.map((step) => {
          const value = step as { step?: unknown; status?: unknown };
          const status = value.status === 'completed' ? '✅' : value.status === 'inProgress' ? '🔄' : '⬜';
          return `${status} ${String(value.step ?? '')}`.trim();
        }).filter((line) => line.length > 2);
        queue.push({ type: 'ui_widget', widget: { key: '执行计划', lines, placement: 'aboveEditor' } });
      } else if (message.method === 'thread/status/changed') {
        const status = params.status as { type?: unknown; activeFlags?: unknown } | undefined;
        const flags = Array.isArray(status?.activeFlags) ? status.activeFlags.join('、') : '';
        const text = status?.type === 'active'
          ? flags || '执行中'
          : status?.type === 'idle' ? '空闲' : String(status?.type ?? '未知');
        queue.push({ type: 'ui_status', status: { key: '会话状态', text } });
      } else if (message.method === 'turn/diff/updated') {
        const diff = typeof params.diff === 'string' ? params.diff : '';
        queue.push({ type: 'ui_status', status: { key: '代码改动', text: diff ? `已生成改动（${diff.split('\n').length} 行）` : '暂无改动' } });
      } else if (message.method === 'thread/tokenUsage/updated') {
        const usage = params.tokenUsage as {
          total?: { totalTokens?: number; inputTokens?: number; outputTokens?: number };
          last?: { totalTokens?: number; inputTokens?: number; outputTokens?: number };
          modelContextWindow?: number | null;
        } | undefined;
        queue.push({
          type: 'usage',
          inputTokens: usage?.last?.inputTokens,
          outputTokens: usage?.last?.outputTokens,
          totalTokens: usage?.total?.totalTokens,
          contextTokens: usage?.last?.totalTokens,
          modelContextWindow: usage?.modelContextWindow ?? undefined,
        });
      } else if (message.method === 'model/rerouted') {
        const from = typeof params.fromModel === 'string' ? params.fromModel : '';
        const to = typeof params.toModel === 'string' ? params.toModel : '';
        queue.push({ type: 'ui_notice', message: `模型已切换：${from} → ${to}`, level: 'info' });
      } else if (message.method === 'thread/compacted') {
        queue.push({ type: 'ui_notice', message: 'Codex 已压缩上下文，继续保持当前会话。', level: 'info' });
      } else if (message.method === 'item/started') {
        const item = params.item as { id?: string; type?: string; command?: string; cwd?: string } | undefined;
        if (!item?.id) return;
        if (item.type === 'commandExecution' || item.type === 'fileChange' || item.type === 'mcpToolCall') {
          queue.push({
            type: 'tool_use',
            id: item.id,
            name: item.type === 'commandExecution' ? '运行命令' : item.type === 'fileChange' ? '修改文件' : '调用工具',
            input: { command: item.command, cwd: item.cwd },
          });
        }
      } else if (message.method === 'item/commandExecution/outputDelta' || message.method === 'item/fileChange/outputDelta' || message.method === 'item/mcpToolCall/progress') {
        const itemId = typeof params.itemId === 'string' ? params.itemId : '';
        const delta = typeof params.delta === 'string' ? params.delta : typeof params.message === 'string' ? params.message : '';
        if (itemId && delta) queue.push({ type: 'tool_update', id: itemId, output: delta });
      } else if (message.method === 'item/completed') {
        const item = params.item as { id?: string; type?: string; command?: string; aggregatedOutput?: string | null; exitCode?: number | null; status?: string } | undefined;
        if (!item?.id) return;
        if (item.type === 'commandExecution' || item.type === 'fileChange' || item.type === 'mcpToolCall') {
          const output = item.aggregatedOutput ?? item.status ?? '';
          queue.push({ type: 'tool_result', id: item.id, output, isError: item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0 });
        }
      } else if (message.method === 'turn/completed') {
        const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined;
        if (turn?.status === 'failed') {
          const errorMessage = turn.error?.message ?? 'Codex 执行失败';
          if (!replaceHistoricalSession(errorMessage)) queue.push({ type: 'error', message: errorMessage });
          if (replacementStarted) return;
        }
        else if (!stopped) queue.push({ type: 'done', sessionId: threadId });
        finish();
      }
    };

    const handleServerRequest = (message: JsonRpcServerRequest): void => {
      const params = message.params ?? {};
      if (params.threadId !== threadId) return;
      const supported = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput']);
      if (!supported.has(message.method)) {
        queue.push({ type: 'error', message: `Codex 发出了暂不支持的交互请求：${message.method}` });
        return;
      }
      const requestId = String(message.id);
      const questions = Array.isArray(params.questions)
        ? params.questions.map((raw) => raw as {
            id?: string;
            header?: string;
            question?: string;
            isOther?: boolean;
            isSecret?: boolean;
            options?: Array<{ label?: string; description?: string }> | null;
          }).filter((question) => typeof question.id === 'string' && question.id.length > 0)
        : [];
      pendingUi.set(requestId, {
        requestId: message.id,
        method: message.method,
        ...(questions.length > 0 ? { questionIds: questions.map((question) => question.id!) } : {}),
        ...(message.method === 'item/permissions/requestApproval' && params.permissions && typeof params.permissions === 'object'
          ? { requestedPermissions: params.permissions as Record<string, unknown> }
          : {}),
      });
      if (message.method === 'item/tool/requestUserInput' && questions.length === 0) {
        queue.push({ type: 'error', message: 'Codex 的输入请求没有可用问题。' });
        return;
      }
      const command = typeof params.command === 'string' ? `\n\n即将执行：\n\`${params.command}\`` : '';
      const reason = typeof params.reason === 'string' && params.reason ? `\n\n原因：${params.reason}` : '';
      const grantRoot = typeof params.grantRoot === 'string' && params.grantRoot
        ? `\n\n写入范围：\n\`${params.grantRoot}\``
        : '';
      const permissionSummary = message.method === 'item/permissions/requestApproval' && params.permissions
        ? `\n\n请求权限：\n\`\`\`json\n${JSON.stringify(params.permissions, null, 2).slice(0, 3000)}\n\`\`\``
        : '';
      if (message.method === 'item/tool/requestUserInput') {
        queue.push({
          type: 'ui_request',
          request: {
            id: requestId,
            method: 'form',
            title: questions.length > 1 ? 'Codex 需要补充信息' : questions[0]?.header ?? 'Codex 需要补充信息',
            questions: questions.map((question, index) => ({
              id: question.id!,
              title: question.header?.trim() || `问题 ${index + 1}`,
              prompt: question.question?.trim() || '请输入',
              ...(question.isSecret ? { secret: true } : {}),
              ...(question.isOther ? { allowOther: true } : {}),
              ...(Array.isArray(question.options) && question.options.length > 0
                ? {
                    options: question.options.map((option) => ({
                      label: String(option.label ?? ''),
                      ...(option.description ? { description: String(option.description) } : {}),
                    })).filter((option) => option.label),
                  }
                : {}),
            })),
          },
        });
        return;
      }
      const available = Array.isArray(params.availableDecisions)
        ? params.availableDecisions.filter((decision): decision is import('../types').AgentApprovalDecision =>
            decision === 'accept'
            || decision === 'acceptForSession'
            || decision === 'decline'
            || decision === 'cancel'
            || Boolean(decision && typeof decision === 'object' && (
              'acceptWithExecpolicyAmendment' in decision || 'applyNetworkPolicyAmendment' in decision
            )))
        : [];
      const fallbackDecisions: Array<'accept' | 'acceptForSession' | 'decline' | 'cancel'> =
        message.method === 'item/permissions/requestApproval'
          ? ['accept', 'acceptForSession', 'decline', 'cancel']
          : ['accept', 'acceptForSession', 'decline', 'cancel'];
      queue.push({
        type: 'ui_request',
        request: {
          id: requestId,
          method: 'approval',
          title: 'Codex 需要你的确认',
          message: `${command}${reason}${grantRoot}${permissionSummary}`.trim() || 'Codex 请求继续执行。',
          decisions: available.length > 0 ? available : fallbackDecisions,
        },
      });
    };

    const start = async (): Promise<void> => {
      try {
        await this.client.ensureStarted();
        unsubscribe = this.client.onNotification(handleNotification);
        unsubscribeRequests = this.client.onServerRequest(handleServerRequest);
        let thread: ThreadResponse;
        if (opts.sessionId) {
          try {
            thread = await client.request('thread/resume', {
              threadId: opts.sessionId,
              ...(opts.cwd ? { cwd: opts.cwd } : {}),
          });
          } catch (err) {
            if (!isMissingRolloutError(err)) throw err;
            queue.push({ type: 'ui_notice', message: '原 Codex 会话没有可恢复的执行记录，已自动新建会话。', level: 'warning' });
            thread = await this.startThread(opts.cwd);
          }
        } else {
          thread = await this.startThread(opts.cwd);
        }
        threadId = thread.thread?.id ?? thread.id ?? opts.sessionId;
        if (!threadId) throw new Error('Codex app-server did not return a thread id');
        const currentName = typeof thread.thread?.name === 'string' ? thread.thread.name : undefined;
        const requestedName = opts.title?.replace(/\s+/g, ' ').trim();
        if (requestedName && currentName !== requestedName) {
          await this.setThreadName(threadId, requestedName);
        }
        queue.push({ type: 'system', sessionId: threadId, cwd: opts.cwd });
        const turn = await requestTurn<{ id?: string; turn?: { id?: string } }>('turn/start', {
          threadId,
          input: [{ type: 'text', text: opts.prompt, text_elements: [] }],
          ...(opts.clientUserMessageId ? { clientUserMessageId: opts.clientUserMessageId } : {}),
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.additionalContext ? { additionalContext: opts.additionalContext } : {}),
        });
        turnId = turn.turn?.id ?? turn.id;
      } catch (err) {
        if (!stopped) {
          queue.push({
            type: 'error',
            message: isActiveWriterError(err)
              ? CODEX_ACTIVE_WRITER_MESSAGE
              : err instanceof Error ? err.message : String(err),
          });
        }
        finish();
      }
    };
    void start();

    return {
      events: queue,
      async stop() {
        stopped = true;
        if (threadId && turnId && !settled) {
          await client.request('turn/interrupt', { threadId, turnId }).catch(() => {});
        }
        finish();
      },
      respondToUi(requestId: string, response: AgentUiResponse): boolean {
        const pending = pendingUi.get(requestId);
        if (!pending) return false;
        pendingUi.delete(requestId);
        if (pending.method === 'item/tool/requestUserInput' && pending.questionIds) {
          const answers = response && 'answers' in response
            ? response.answers
            : Object.fromEntries(pending.questionIds.map((questionId) => [
                questionId,
                response && 'value' in response ? [response.value] : [],
              ]));
          client.respond(pending.requestId, {
            answers: Object.fromEntries(pending.questionIds.map((questionId) => [
              questionId,
              { answers: Array.isArray(answers[questionId]) ? answers[questionId] : [] },
            ])),
          });
        } else if (pending.method === 'item/permissions/requestApproval') {
          const decision = response && 'decision' in response
            ? response.decision
            : response && 'confirmed' in response && response.confirmed ? 'accept' : 'decline';
          client.respond(pending.requestId, {
            permissions: decision === 'accept' || decision === 'acceptForSession'
              ? pending.requestedPermissions ?? {}
              : {},
            scope: decision === 'acceptForSession' ? 'session' : 'turn',
          });
        } else {
          const decision = response && 'decision' in response
            ? response.decision
            : response && 'confirmed' in response && response.confirmed ? 'accept'
              : response && 'cancelled' in response ? 'cancel'
                : 'decline';
          client.respond(pending.requestId, { decision });
        }
        return true;
      },
      async submitPrompt(
        kind: 'steer' | 'follow_up',
        message: string,
        _imagePaths?: string[],
        additionalContext?: AgentAdditionalContext,
      ): Promise<boolean> {
        if (!threadId || !turnId || settled) return false;
        if (kind === 'steer') {
          await requestTurn('turn/steer', {
            threadId,
            expectedTurnId: turnId,
            input: [{ type: 'text', text: message, text_elements: [] }],
            ...(additionalContext ? { additionalContext } : {}),
          });
        } else {
          const response = await requestTurn<{ turn?: { id?: string } }>('turn/start', {
            threadId,
            input: [{ type: 'text', text: message, text_elements: [] }],
            ...(additionalContext ? { additionalContext } : {}),
          });
          if (response.turn?.id) turnId = response.turn.id;
        }
        return true;
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        return Promise.race([
          exited.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]);
      },
    };
  }
}

function isMissingRolloutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no rollout found|rollout not found|rollout.*missing/i.test(message);
}

function isAdditionalContextCompatibilityError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /additionalContext|additional_context/i.test(message)
    && /unknown|unexpected|unsupported|invalid params?/i.test(message);
}

function isActiveWriterError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already has an active writer/i.test(message);
}

function isThreadNotLoadedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /thread not loaded/i.test(message);
}

function isThreadNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /thread not found|thread .* not found|no rollout found|rollout not found/i.test(message);
}

function filterModels(models: ModelOption[], includeHidden = false): ModelOption[] {
  return includeHidden ? [...models] : models.filter((model) => !model.hidden);
}

function mapModel(entry: Record<string, unknown>): ModelOption | undefined {
  const rawModel = typeof entry.model === 'string' && entry.model.trim() ? entry.model.trim() : '';
  const rawId = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : '';
  if (!rawModel && !rawId) return undefined;
  const model = rawModel || rawId;
  const displayName = typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName.trim() : model;
  const description = typeof entry.description === 'string' ? entry.description : '';
  const supportedReasoningEfforts = Array.isArray(entry.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts
      .map((effort) => {
        if (typeof effort === 'string') return effort;
        if (effort && typeof effort === 'object' && typeof (effort as { reasoningEffort?: unknown }).reasoningEffort === 'string') {
          return (effort as { reasoningEffort: string }).reasoningEffort;
        }
        return undefined;
      })
      .filter((effort): effort is string => Boolean(effort))
    : [];
  const defaultReasoningEffort = typeof entry.defaultReasoningEffort === 'string' && entry.defaultReasoningEffort.trim()
    ? entry.defaultReasoningEffort.trim()
    : null;
  return {
    model,
    id: rawId || model,
    displayName,
    description,
    isDefault: entry.isDefault === true,
    hidden: entry.hidden === true,
    supportedReasoningEfforts,
    defaultReasoningEffort,
  };
}

function isDesktopMetadataCompatibilityError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /threadSource|serviceName|unknown field|invalid params|invalid request/i.test(message);
}

function mapThreadStatus(value: unknown): SessionSummary['status'] {
  if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'active') return 'active';
  return 'idle';
}

function mapThread(thread: Record<string, unknown>, fallbackCwd: string): SessionSummary | undefined {
  const threadId = typeof thread.id === 'string' ? thread.id : '';
  if (!threadId) return undefined;
  const status = thread.status && typeof thread.status === 'object' ? thread.status as { type?: unknown; activeFlags?: unknown } : undefined;
  const activeFlags = Array.isArray(status?.activeFlags) ? status.activeFlags.filter((flag): flag is string => typeof flag === 'string') : undefined;
  const gitInfo = thread.gitInfo && typeof thread.gitInfo === 'object' ? thread.gitInfo as { branch?: unknown } : undefined;
  return {
    threadId,
    ...(typeof thread.sessionId === 'string' ? { sessionId: thread.sessionId } : {}),
    ...(typeof thread.forkedFromId === 'string' ? { forkedFromId: thread.forkedFromId } : {}),
    ...(typeof thread.parentThreadId === 'string' ? { parentThreadId: thread.parentThreadId } : {}),
    ...(typeof thread.name === 'string' ? { name: thread.name } : {}),
    preview: typeof thread.preview === 'string' ? thread.preview : '暂无摘要',
    cwd: typeof thread.cwd === 'string' ? thread.cwd : fallbackCwd,
    status: mapThreadStatus(thread.status),
    ...(activeFlags && activeFlags.length > 0 ? { activeFlags } : {}),
    ...(typeof thread.source === 'string' ? { source: thread.source } : {}),
    ...(typeof gitInfo?.branch === 'string' ? { gitBranch: gitInfo.branch } : {}),
    updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt * 1000 : Date.now(),
  };
}

function summarizeActivity(item: unknown): SessionActivity | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const value = item as Record<string, unknown>;
  switch (value.type) {
    case 'userMessage': {
      const content = Array.isArray(value.content) ? value.content : [];
      const text = content.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && (entry as { type?: unknown }).type === 'text')
        .map((entry) => typeof entry.text === 'string' ? entry.text : '').filter(Boolean).join('\n');
      return text ? { kind: '用户', text } : undefined;
    }
    case 'agentMessage':
      return typeof value.text === 'string' && value.text ? { kind: '助手', text: value.text } : undefined;
    case 'plan':
      return typeof value.text === 'string' && value.text ? { kind: '计划', text: value.text } : undefined;
    case 'commandExecution':
      return typeof value.command === 'string' && value.command ? { kind: '工具', text: value.command } : undefined;
    case 'fileChange':
      return { kind: '文件', text: '发生文件修改' };
    default:
      return undefined;
  }
}
