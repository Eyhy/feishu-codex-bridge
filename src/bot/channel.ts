import { homedir } from 'node:os';
import type {
  LarkChannel,
  LarkChannelOptions,
  NormalizedMessage,
} from '@larksuiteoapi/node-sdk';
import { Domain, LoggerLevel, createLarkChannel } from '@larksuiteoapi/node-sdk';
import type { AgentAdapter, AgentUiRequest } from '../agent/types';
import { handleCardAction } from '../card/dispatcher';
import { sendManagedCard, updateManagedCard } from '../card/managed';
import { renderOmpUiRequestCard, renderOmpUiResultCard } from '../card/omp-ui';
import { renderCard } from '../card/run-renderer';
import {
  ReliableProgress,
  renderMarkdownProgressCard,
  renderNonStreamingCard,
} from '../card/reliable-progress';
import {
  finalizeIfRunning,
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import { renderText } from '../card/text-renderer';
import { welcomeCard } from '../card/templates';
import { tryHandleCommand, type Controls } from '../commands';
import type { AppConfig } from '../config/schema';
import {
  getAgentStopGraceMs,
  getAgentBackend,
  getIncludeRoutingIdsInPrompt,
  getOmpModel,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  isChatAllowed,
  isProjectAllowed,
  isUserAllowed,
} from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { log, withTrace } from '../core/logger';
import { MediaCache, type LocalAttachment } from '../media/cache';
import type { SessionStore } from '../session/store';
import { JsonTaskStore } from '../task/store';
import type { TaskRecord, TaskStatus } from '../task/types';
import type { WorkspaceStore } from '../workspace/store';
import type { ProjectCatalog } from '../project/catalog';
import type { Project, ProjectBindingStore } from '../project/types';
import { ActiveRuns, releaseWriterIfAllIdle, type RunHandle } from './active-runs';
import { ChatModeCache, type ChatMode } from './chat-mode-cache';
import { handleCommentMention } from './comments';
import { createFeishuHostIntegration } from './feishu-host';
import { buildFeishuTurnContext } from './feishu-context';
import { expandInteractiveCard } from './interactive-card';
import { startKeepalive } from './keepalive';
import { configureNetwork } from './network-config';
import { PendingQueue } from './pending-queue';
import { ProcessPool } from './process-pool';
import { fetchQuotedContext, renderQuotedBlock, type QuotedContext } from './quote';
import { addWorkingReaction, removeReaction } from './reaction';
import { isThreadScoped } from './scope';
import { SessionSyncManager } from '../session/sync';
import { showProjectWorkbench } from '../project/workbench';
import { bindNativeTopicSession } from '../project/topic-session';
import { fetchFeishuTopicTitle, syncBoundTopicTitles } from '../project/topic-title-sync';
import { FEISHU_ASSISTANT_PROJECT_KEY } from '../project/assistant';
import { threadTitleFromText } from './thread-title';

/** OMP keeps its configured model; Codex always follows the thread's own setting. */
export function modelOverrideForBackend(cfg: AppConfig, backend: 'omp' | 'codex'): { model?: string } {
  return backend === 'omp' ? { model: getOmpModel(cfg) } : {};
}

/** Codex applies a pending model choice on the next run; OMP never reads it. */
export function pendingOptionsForBackend(
  sessions: Pick<SessionStore, 'getPending'>,
  scope: string,
  backend: 'omp' | 'codex',
): { pendingModel?: string; pendingEffort?: string } {
  if (backend !== 'codex') return {};
  const pending = sessions.getPending(scope);
  return pending ? { pendingModel: pending.model, pendingEffort: pending.effort } : {};
}

/** A pending choice survives failures that leave the thread untouched. */
export function settlePendingForModelSwitch(
  sessions: Pick<SessionStore, 'clearPending'>,
  scope: string,
  status: 'applied' | 'failed' | 'active_writer' | 'validation_failed' | 'unconfirmed',
): void {
  if (status === 'applied' || status === 'failed') sessions.clearPending(scope);
}

const DEBOUNCE_MS = 600;

// Lark SDK logs API errors at error level even when the caller catches them.
// These specific codes are EXPECTED in our flow (wiki-node lookup that
// usually misses, fileComment.get that we deliberately let fall back to
// .list) and the surrounding noise is already covered by our own logs.
const SUPPRESSED_API_ERROR_CODES = new Set([
  131005, // wiki.space.getNode "not found" — the doc isn't a wiki node
  1069307, // drive.fileComment.get "not exist" — fall back to .list
  1069302, // drive.fileCommentReply.create — whole-doc comments don't accept replies; fall back to fileComment.create
]);

function buildQuietLogger(): {
  error: (...m: unknown[]) => void;
  warn: (...m: unknown[]) => void;
  info: (...m: unknown[]) => void;
  debug: (...m: unknown[]) => void;
  trace: (...m: unknown[]) => void;
} {
  // Match either `{ code: <feishu-code> }` (the response data SDK logs as
  // its second arg) or an AxiosError where the feishu code lives at
  // `err.response.data.code` (which the SDK logs raw).
  const codeFromObj = (m: unknown): number | undefined => {
    if (!m || typeof m !== 'object') return undefined;
    const top = (m as { code?: unknown }).code;
    if (typeof top === 'number') return top;
    const nested = (m as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
    return typeof nested === 'number' ? nested : undefined;
  };
  const isSuppressed = (msg: unknown): boolean => {
    if (Array.isArray(msg)) return msg.some(isSuppressed);
    const code = codeFromObj(msg);
    return code !== undefined && SUPPRESSED_API_ERROR_CODES.has(code);
  };
  return {
    error: (...args: unknown[]) => {
      if (args.some(isSuppressed)) return;
      log.warn('sdk', 'error', { args: stringifyArgs(args) });
    },
    warn: (...args: unknown[]) => log.warn('sdk', 'warn', { args: stringifyArgs(args) }),
    info: (...args: unknown[]) => log.info('sdk', 'info', { args: stringifyArgs(args) }),
    debug: () => {},
    trace: () => {},
  };
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export interface BridgeChannel {
  channel: LarkChannel;
  disconnect(): Promise<void>;
}

export interface StartChannelDeps {
  cfg: AppConfig;
  agent: AgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: Controls;
  projectCatalog?: ProjectCatalog;
  projectBindings?: ProjectBindingStore;
  taskStore?: JsonTaskStore;
}

export async function startChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const { cfg, agent, sessions, workspaces, controls, projectCatalog, projectBindings } = deps;
  const taskStore = deps.taskStore ?? new JsonTaskStore();
  const activeRuns = new ActiveRuns();
  const sessionSync = new SessionSyncManager();
  // ChatModeCache stays per-bridge-instance — invalidated on restart along
  // with everything else. Topic-mode chats only need one chat.get() call ever.
  const chatModeCache = new ChatModeCache();
  // Concurrency cap — reads `preferences.maxConcurrentRuns` on each acquire,
  // so /config bumps take effect for the next run.
  const pool = new ProcessPool(() => getMaxConcurrentRuns(controls.cfg));

  // Apply network-layer overrides (HTTP timeout + proxy from env). Idempotent;
  // safe to call on every startChannel (used by /account change hot-reload too).
  const netOverrides = configureNetwork();

  // Resolve the App Secret to plaintext. The config field can be a literal
  // string, a "${VAR}" template, or a {source, id} SecretRef referencing
  // the encrypted keystore / env / file / exec provider. Re-resolved on
  // every startChannel so /account change picks up new secrets.
  const appSecret = await resolveAppSecret(cfg);

  const opts: LarkChannelOptions = {
    appId: cfg.accounts.app.id,
    appSecret,
    domain: cfg.accounts.app.tenant === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'feishu-omp-bridge',
    loggerLevel: LoggerLevel.info,
    logger: buildQuietLogger(),
    policy: {
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
    },
    // Disable per-chat serialization so we can implement our own
    // debounce + run-chain policy (see pending-queue + runChain below).
    safety: {
      chatQueue: { enabled: false },
    },
    // Attach raw Feishu event body to normalized events so we can read fields
    // the normalizer drops (e.g. action.form_value on CardKit 2.0 form submits).
    includeRawEvent: true,
    outbound: {
      streamThrottleMs: 400,
    },
    // SDK 1.65.0-alpha.3+ knobs.
    wsConfig: {
      // 3s liveness watchdog: if no inbound message arrives within 3s after
      // the last ping, SDK presumes connection dead and forces a reconnect.
      pingTimeout: 3,
    },
    // 8s handshake timeout (replaces hardcoded 15s). Fast-fail + fast-retry
    // beats slow-fail in unstable networks.
    handshakeTimeoutMs: 8_000,
    // Optional WS-layer proxy agent (only when HTTPS_PROXY / HTTP_PROXY env set).
    ...(netOverrides.agent ? { agent: netOverrides.agent } : {}),
  };

  const channel = createLarkChannel(opts);
  const media = new MediaCache(channel);
  const assistantProject = getAgentBackend(cfg) === 'codex'
    ? await projectCatalog?.get(FEISHU_ASSISTANT_PROJECT_KEY)
    : undefined;

  // Pending → run handoff: while a run is active on a chat, block its pending
  // queue so messages keep accumulating without flushing. When the run ends,
  // unblock arms a fresh quiet-window timer. Net effect: at most one run per
  // chat in flight, and everything sent during a run merges into the next
  // batch (only flushed once 600ms of silence has passed *after* the run).
  const pending = new PendingQueue(DEBOUNCE_MS, (scope, batch) => {
    const firstMsg = batch[0];
    if (!firstMsg) return;
    pending.block(scope);
    void withTrace({ chatId: firstMsg.chatId }, async () => {
      log.info('flush', 'start', { scope, batchSize: batch.length });
      // Pool slot acquired here, released in finally. Across-the-bridge cap.
      const release = await pool.acquire();
      try {
        const mode = await chatModeCache.resolve(channel, firstMsg.chatId);
        await runAgentBatch({
          channel,
          agent,
          sessions,
          workspaces,
          activeRuns,
          media,
          batch,
          controls,
          scope,
          mode,
          projectCatalog,
          projectBindings,
          taskStore,
        });
      } catch (err) {
        log.fail('flush', err);
      } finally {
        release();
        pending.unblock(scope);
        log.info('flush', 'end');
      }
    });
  });

  // Counter for stdout reconnect escalation; reset on `reconnected`.
  let consecutiveReconnects = 0;

  channel.on({
    message: async (msg) => {
      await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, () =>
        intakeMessage({
          channel,
          agent,
          sessions,
          workspaces,
          activeRuns,
          media,
          pending,
          msg,
          controls,
          chatModeCache,
          projectCatalog,
          projectBindings,
          sessionSync,
          taskStore,
        }),
      ).catch((err) => log.fail('intake', err));
    },
    reject: (evt) => {
      log.info('intake', 'reject', { chatId: evt.chatId, reason: evt.reason });
    },
    cardAction: async (evt) => {
      await withTrace({ chatId: evt.chatId, msgId: evt.messageId }, async () => {
        await handleCardAction({
          channel,
          evt,
          sessions,
          workspaces,
          activeRuns,
          agent,
          controls,
          pending,
          chatModeCache,
          projectCatalog,
          projectBindings,
          sessionSync,
          taskStore,
        });
      }).catch((err) => log.fail('cardAction', err));
    },
    comment: async (evt) => {
      await withTrace({ chatId: 'comment' }, async () => {
        await handleCommentMention({
          channel,
          evt,
          agent,
          sessions,
          workspaces,
          defaultCwd: assistantProject?.cwd,
        }).catch((err) =>
          log.fail('comment', err),
        );
      }).catch((err) => log.fail('comment', err));
    },
    reconnecting: () => {
      consecutiveReconnects++;
      log.warn('ws', 'reconnecting', { consecutive: consecutiveReconnects });
      // Stdout escalation — surface jitter that's hidden in the file log.
      if (consecutiveReconnects === 3) {
        console.error('⚠️ 已连续重连 3 次,网络可能不稳。');
      } else if (consecutiveReconnects === 10) {
        console.error('❌ 已连续重连 10 次,建议在飞书发 /reconnect 或重启 bot。');
      }
    },
    reconnected: () => {
      if (consecutiveReconnects > 1) {
        log.info('ws', 'recovered', { afterAttempts: consecutiveReconnects });
      } else {
        log.info('ws', 'reconnected');
      }
      consecutiveReconnects = 0;
    },
    // Classify common WS errors into the `network` phase so /doctor and grep
    // can find them without scanning generic `ws.fail` entries.
    error: (err) => {
      const msg = err?.message ?? String(err);
      if (/ENOTFOUND|getaddrinfo/.test(msg)) {
        log.fail('network', err, { kind: 'dns', code: err.code });
      } else if (/handshake|did not complete/.test(msg)) {
        log.fail('network', err, { kind: 'handshake-timeout', code: err.code });
      } else if (/timeout/i.test(msg)) {
        log.fail('network', err, { kind: 'timeout', code: err.code });
      } else {
        log.fail('ws', err, { code: err.code });
      }
    },
  });

  await channel.connect();

  const identity = channel.botIdentity;
  log.info('ws', 'connected', {
    bot: identity?.name ?? 'unknown',
    openId: identity?.openId ?? '-',
    agent: `${agent.displayName} (${agent.id})`,
    appId: cfg.accounts.app.id,
    procId: controls.processId,
  });
  if (agent.renameSession && projectBindings?.allTopics) {
    void syncBoundTopicTitles(channel, agent, projectBindings)
      .then((result) => log.info('session', 'topic-title-reconcile-complete', result))
      .catch((err) => log.warn('session', 'topic-title-reconcile-failed', {
        err: err instanceof Error ? err.message : String(err),
      }));
  }
  console.log('正在监听消息。按 Ctrl+C 退出。\n');

  // App-level keepalive: 15s probe + wake-up detection + HTTP reachability.
  // Defense-in-depth — the SDK's pingTimeout watchdog handles half-dead WS,
  // this catches anything that the SDK misses (silent state stuck, etc.).
  const probeDomain =
    cfg.accounts.app.tenant === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';
  const keepalive = startKeepalive({
    channel,
    domain: probeDomain,
    forceReconnect: () => controls.restart(),
  });

  return {
    channel,
    disconnect: async () => {
      keepalive.stop();
      sessionSync.stopAll();
      pending.cancelAll();
      await channel.disconnect();
      taskStore.markInFlightStale();
      await activeRuns.stopAll();
      await Promise.allSettled([sessions.flush(), workspaces.flush(), projectBindings?.flush(), taskStore.flush()]);
    },
  };
}

interface IntakeDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  media: MediaCache;
  pending: PendingQueue;
  msg: NormalizedMessage;
  controls: Controls;
  chatModeCache: ChatModeCache;
  projectCatalog?: ProjectCatalog;
  projectBindings?: ProjectBindingStore;
  sessionSync?: SessionSyncManager;
  taskStore: JsonTaskStore;
}

async function intakeMessage(deps: IntakeDeps): Promise<void> {
  const {
    channel,
    agent,
    sessions,
    workspaces,
    activeRuns,
    media,
    pending,
    msg,
    controls,
    chatModeCache,
    projectCatalog,
    projectBindings,
    sessionSync,
    taskStore,
  } = deps;
  const preview = msg.content.length > 80 ? `${msg.content.slice(0, 80)}…` : msg.content;
  // Resolve scope (and underlying chat mode) once at intake — every
  // downstream consumer keys off these.
  const chatMode = await chatModeCache.resolve(channel, msg.chatId);
  const project = projectBindings?.findProjectByChat(msg.chatId);
  const threadScoped = isThreadScoped(chatMode, msg.threadId, Boolean(project));
  const topicBinding = findTopicBinding(projectBindings, msg.chatId, msg.threadId, msg.rootId);
  const scope = threadScoped
    ? `${msg.chatId}:${msg.threadId}`
    : msg.chatId;
  log.info('intake', 'enter', {
    scope,
    chatType: msg.chatType,
    chatMode,
    threadId: msg.threadId,
    threadScoped,
    sender: msg.senderId,
    preview,
    resources: msg.resources.length,
  });

  // Access control. Silent drop — replying would reveal the bot to
  // unauthorized users and let them spam the chat with denial messages.
  // Operator-defined lists; both empty = allow all (back-compat).
  if (!isUserAllowed(controls.cfg, msg.senderId)) {
    log.info('intake', 'skip-not-allowed-user', {
      scope,
      sender: msg.senderId.slice(-6),
    });
    return;
  }
  // `allowedChats` is intentionally a group-only gate. p2p chat_ids are
  // generated per-user-pair and can't be hijacked by an unauthorized
  // sender, so the user allowlist above is already authoritative for DMs.
  // Restricting p2p by chat_id would also create a chicken-and-egg lockout
  // hazard (the operator must know the chat_id before they ever DM the bot).
  if (msg.chatType !== 'p2p' && !isChatAllowed(controls.cfg, msg.chatId)) {
    log.info('intake', 'skip-not-allowed-chat', {
      scope,
      chatId: msg.chatId.slice(-6),
    });
    return;
  }
  if (project && !isProjectAllowed(controls.cfg, project.projectKey, msg.senderId)) {
    log.info('intake', 'skip-not-allowed-project', {
      scope,
      project: project.projectKey,
      sender: msg.senderId.slice(-6),
    });
    return;
  }

  // Group-mention policy. p2p is always unrestricted; in groups (regular and
  // topic) we drop messages that don't @bot when the user has opted into the
  // quiet-by-default behavior. Slash commands are NOT exempt — the user
  // chose strict mode so the group stays uniformly quiet unless mentioned.
  // @全员 is already filtered by SDK (`respondToMentionAll: false`), so any
  // event reaching here is either targeted or undirected chatter.
  if (
    msg.chatType !== 'p2p' &&
    getRequireMentionInGroup(controls.cfg) &&
    !msg.mentionedBot &&
    !project
  ) {
    log.info('intake', 'skip-no-mention', { scope, chatType: msg.chatType });
    return;
  }

  const handled = await tryHandleCommand({
    channel,
    msg,
    scope,
    chatMode,
    sessions,
    workspaces,
    agent,
    activeRuns,
    controls,
    projectCatalog,
    projectBindings,
    taskStore,
    pending,
    sessionSync,
  });
  if (handled) {
    const dropped = pending.cancel(scope);
    log.info('intake', 'command', { scope, droppedPending: dropped.length });
    return;
  }

  let executionProject = project;
  // Unbound Feishu entry points belong to the dedicated assistant workspace.
  // A bound project always wins so Feishu requests keep the local project's
  // code and history context.
  if (getAgentBackend(controls.cfg) === 'codex') {
    if (project && !msg.threadId) {
      if (projectBindings) await showProjectWorkbench(channel, projectBindings, project);
      pending.cancel(scope);
      return;
    }
    executionProject ??= await projectCatalog?.get(FEISHU_ASSISTANT_PROJECT_KEY);
    if (!executionProject && msg.chatType === 'p2p') {
      await channel.send(msg.chatId, { card: welcomeCard() }, { replyTo: msg.messageId });
      pending.cancel(scope);
      return;
    }
    // A Feishu-native topic is the creation gesture for a Codex session.
    // Leave an unbound project topic on the normal run path: the first agent
    // system event supplies the new session id, which is persisted below.
    if (project && msg.threadId && !topicBinding) {
      log.info('session', 'native-topic-start', { scope, topicId: msg.threadId });
    }
  }

  if (await submitToActiveRun({
    channel,
    activeRuns,
    media,
    msg,
    scope,
    metadataFirst: getAgentBackend(controls.cfg) !== 'codex',
    project: executionProject,
  })) {
    log.info('intake', 'submitted-active-run', { scope });
    return;
  }

  const size = pending.push(scope, msg);
  log.info('intake', 'queued', { scope, queueSize: size, debounceMs: DEBOUNCE_MS });
}

async function submitToActiveRun(deps: {
  channel: LarkChannel;
  activeRuns: ActiveRuns;
  media: MediaCache;
  msg: NormalizedMessage;
  scope: string;
  metadataFirst: boolean;
  project?: Project;
}): Promise<boolean> {
  const { channel, activeRuns, media, msg, scope, metadataFirst, project } = deps;
  if (!activeRuns.has(scope)) return false;
  const resources = msg.resources.map((resource) => ({ messageId: msg.messageId, resource }));
  const attachments = await media.resolve(msg.chatId, resources);
  const imagePaths = attachments.filter((attachment) => attachment.kind === 'image').map((attachment) => attachment.path);
  const quotes: QuotedContext[] = [];
  if (msg.replyToMessageId) {
    const quote = await fetchQuotedContext(channel, msg.replyToMessageId);
    if (quote) quotes.push(quote);
  }
  const prompt = buildPrompt(
    [msg],
    attachments,
    quotes,
    metadataFirst,
  );
  const trimmed = msg.content.trimStart();
  const kind = trimmed.startsWith('!') ? 'steer' : 'follow_up';
  try {
    const submitted = await activeRuns.submitPrompt(
      scope,
      kind,
      prompt,
      imagePaths,
      metadataFirst ? undefined : buildFeishuTurnContext([msg], project),
    );
    if (kind === 'steer') {
      await channel.send(
        msg.chatId,
        { markdown: submitted ? '✓ 已把这条调整加入当前执行。' : '当前任务暂时不能接收执行中调整。' },
        { replyTo: msg.messageId, ...(msg.threadId ? { replyInThread: true } : {}) },
      );
    }
    return submitted;
  } catch (err) {
    if (kind !== 'steer') throw err;
    log.warn('agent', 'steer-failed', { scope, error: err instanceof Error ? err.message : String(err) });
    await channel.send(
      msg.chatId,
      { markdown: `未能加入当前执行：${err instanceof Error ? err.message : String(err)}` },
      { replyTo: msg.messageId, ...(msg.threadId ? { replyInThread: true } : {}) },
    );
    return true;
  }
}

interface RunBatchDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  media: MediaCache;
  batch: NormalizedMessage[];
  controls: Controls;
  scope: string;
  mode: ChatMode;
  projectCatalog?: ProjectCatalog;
  projectBindings?: ProjectBindingStore;
  taskStore: JsonTaskStore;
}

interface AgentStreamHooks {
  onUiRequest(request: AgentUiRequest): Promise<void>;
  onUiCancel(targetId: string): Promise<void>;
  onSystem?(sessionId: string, cwd?: string): Promise<void>;
}

async function runAgentBatch(deps: RunBatchDeps): Promise<void> {
  const {
    channel,
    agent,
    sessions,
    workspaces,
    activeRuns,
    media,
    batch,
    controls,
    scope,
    mode,
    projectCatalog,
    projectBindings,
    taskStore,
  } = deps;
  if (batch.length === 0) return;
  const firstMsg = batch[0];
  const lastMsg = batch[batch.length - 1];
  if (!firstMsg || !lastMsg) return;

  const chatId = firstMsg.chatId;
  const threadId = firstMsg.threadId;

  const resourceItems = batch.flatMap((m) =>
    m.resources.map((r) => ({ messageId: m.messageId, resource: r })),
  );
  const attachments = await media.resolve(chatId, resourceItems);
  if (attachments.length > 0) {
    log.info('media', 'resolved', { count: attachments.length });
  }
  const imagePaths = attachments
    .filter((attachment) => attachment.kind === 'image')
    .map((attachment) => attachment.path);

  // Collect any reply-quote targets in the batch. Dedup so the same target
  // quoted by multiple messages in one batch only fetches once. Filter out
  // ids that are themselves in the batch — those are already in the prompt.
  const batchIds = new Set(batch.map((m) => m.messageId));
  const quoteTargets = [
    ...new Set(
      batch
        .map((m) => m.replyToMessageId)
        .filter((id): id is string => Boolean(id) && !batchIds.has(id!)),
    ),
  ];
  const quotes: QuotedContext[] = [];
  for (const targetId of quoteTargets) {
    const q = await fetchQuotedContext(channel, targetId);
    if (q) {
      quotes.push(q);
      log.info('quote', 'fetched', {
        messageId: targetId,
        type: q.rawContentType,
        contentChars: q.content.length,
      });
    }
  }

  const prompt = buildPrompt(
    batch,
    attachments,
    quotes,
    getAgentBackend(controls.cfg) !== 'codex',
    getIncludeRoutingIdsInPrompt(controls.cfg),
  );
  const fallbackTitle = deriveThreadTitle(batch, attachments.length > 0);
  log.info('prompt', 'built', { promptChars: prompt.length, quotes: quotes.length });

  const boundProject = projectBindings?.findProjectByChat(chatId);
  const project = boundProject ?? (getAgentBackend(controls.cfg) === 'codex'
    ? await projectCatalog?.get(FEISHU_ASSISTANT_PROJECT_KEY)
    : undefined);
  let topicBinding = findTopicBinding(projectBindings, chatId, threadId, firstMsg.rootId);
  const threadScoped = isThreadScoped(mode, threadId, Boolean(boundProject));
  const nativeTopicId = threadScoped ? (threadId ?? firstMsg.rootId) : undefined;
  const title = nativeTopicId
    ? await fetchFeishuTopicTitle(
      channel,
      nativeTopicId,
      firstMsg.rootId ?? (!topicBinding ? firstMsg.messageId : undefined),
    ) ?? fallbackTitle
    : fallbackTitle;
  const cwd = project?.cwd ?? workspaces.cwdFor(scope) ?? homedir();
  const resumeFrom = topicBinding?.codexThreadId ?? sessions.resumeFor(scope, cwd);
  if (resumeFrom) {
    log.info('session', 'resume', { sessionId: resumeFrom, cwd });
  } else {
    const stale = sessions.getRaw(scope);
    if (stale && stale.cwd !== cwd) {
      log.info('session', 'stale-cleared', { staleCwd: stale.cwd, newCwd: cwd });
      sessions.clear(scope);
    } else {
      log.info('session', 'fresh', { cwd });
    }
  }

  const task = taskStore.create({
    scope,
    chatId,
    ...(threadId ? { topicId: threadId } : {}),
    ...(project?.projectKey ? { projectKey: project.projectKey } : {}),
    ...(project?.name ? { projectName: project.name } : {}),
    cwd,
    sourceMessageId: lastMsg.messageId,
    title,
    createdBy: firstMsg.senderId,
  });
  taskStore.update(task.taskId, {
    ...(resumeFrom ? { codexThreadId: resumeFrom } : {}),
    stage: '准备执行',
  });
  log.info('task', 'created', { taskId: task.taskId, scope, cwd, title });

  const feishuHost = createFeishuHostIntegration(channel, {
    scope,
    chatId,
    threadId,
    replyToMessageId: lastMsg.messageId,
    cwd,
  });

  let run: ReturnType<AgentAdapter['run']>;
  const backend = getAgentBackend(controls.cfg);
  try {
    run = agent.run({
      prompt,
      clientUserMessageId: lastMsg.messageId,
      title,
      sessionId: resumeFrom,
      cwd,
      ...modelOverrideForBackend(controls.cfg, backend),
      ...pendingOptionsForBackend(sessions, scope, backend),
      imagePaths,
      stopGraceMs: getAgentStopGraceMs(controls.cfg),
      hostTools: feishuHost.tools,
      hostUriSchemes: feishuHost.uriSchemes,
      ...(backend === 'codex'
        ? { additionalContext: buildFeishuTurnContext(batch, project) }
        : {}),
    });
  } catch (err) {
    taskStore.finish(task.taskId, 'failed', {
      error: truncateTaskText(err instanceof Error ? err.message : String(err), 280),
    });
    throw err;
  }
  const handle = activeRuns.register(scope, run);

  // Resolve idle-timeout for this run: scope override (on SessionEntry) wins
  // over global default (preferences). 0 / undefined = no watchdog.
  const scopeOverride = sessions.getIdleTimeoutMinutes(scope);
  const idleTimeoutMs =
    scopeOverride !== undefined
      ? scopeOverride > 0
        ? scopeOverride * 60_000
        : undefined
      : getRunIdleTimeoutMs(controls.cfg);
  if (idleTimeoutMs) {
    log.info('flush', 'idle-watchdog', { idleTimeoutMs });
  }

  const replyMode = getMessageReplyMode(controls.cfg);
  log.info('flush', 'reply-mode', { mode: replyMode });

  // Re-read prefs on every flush so toggling /config mid-stream takes
  // effect immediately. Cheap object lookups, no allocation when on.
  const filterForPrefs = (state: RunState): RunState => {
    if (getShowToolCalls(controls.cfg)) return state;
    return { ...state, blocks: state.blocks.filter((b) => b.kind !== 'tool') };
  };

  // For topic groups: thread the reply so it lands in the same topic as the
  // user's message. Otherwise the SDK posts at top level and the user's
  // topic discussion breaks visually.
  const sendOpts = {
    replyTo: lastMsg.messageId,
    ...(threadScoped ? { replyInThread: true } : {}),
  };

  const uiCards = new Map<string, { messageId: string; title: string }>();
  const uiHooks: AgentStreamHooks = {
    async onSystem(sessionId) {
      taskStore.update(task.taskId, { codexThreadId: sessionId, stage: '已连接 Codex 会话' });
      if (!projectBindings) return;
      if (topicBinding) {
        if (sessionId === topicBinding.codexThreadId) return;
        await projectBindings.updateTopicSession(topicBinding.chatId, topicBinding.topicId, sessionId);
        log.info('session', 'topic-rebound', {
          topicId: topicBinding.topicId,
          previousSessionId: topicBinding.codexThreadId,
          sessionId,
        });
        topicBinding = { ...topicBinding, codexThreadId: sessionId, updatedAt: Date.now() };
        return;
      }
      if (!project || !nativeTopicId) return;
      const result = await bindNativeTopicSession(projectBindings, {
        project,
        chatId,
        topicId: nativeTopicId,
        sessionId,
        createdBy: firstMsg.senderId,
      });
      topicBinding = result.binding;
      log.info('session', result.created ? 'native-topic-bound' : 'native-topic-reused', {
        topicId: nativeTopicId,
        sessionId: result.binding.codexThreadId,
        projectKey: project.projectKey,
      });
    },
    async onUiRequest(request) {
      taskStore.update(task.taskId, {
        status: request.method === 'approval' ? 'waiting_approval' : 'waiting_input',
        stage: request.title,
      });
      try {
        const existing = uiCards.get(request.id);
        if (existing) {
          await updateManagedCard(channel, existing.messageId, renderOmpUiRequestCard(request, scope));
          existing.title = request.title;
          return;
        }
        const sent = await sendManagedCard(channel, chatId, renderOmpUiRequestCard(request, scope), lastMsg.messageId);
        uiCards.set(request.id, { messageId: sent.messageId, title: request.title });
      } catch (err) {
        log.fail('omp-ui', err, { scope, requestId: request.id, method: request.method });
      }
    },
    async onUiCancel(targetId) {
      taskStore.update(task.taskId, { status: 'running', stage: '继续执行' });
      const entry = uiCards.get(targetId);
      if (!entry) return;
      try {
        await updateManagedCard(channel, entry.messageId, renderOmpUiResultCard(entry.title, 'cancelled'));
      } catch (err) {
        log.fail('omp-ui', err, { scope, requestId: targetId, step: 'cancel-update' });
      }
    },
  };

  // For non-card modes OMP's output doesn't surface visually until either
  // a first streamed token (markdown mode) or the whole run ends (text mode).
  // Add a "Typing" reaction to the triggering message as an instant ack;
  // remove it in finally. Card mode has a visible "正在思考…" footer the
  // moment the initial card lands, so the extra reaction would be redundant.
  const reactionId =
    replyMode === 'card' ? undefined : await addWorkingReaction(channel, lastMsg.messageId);

  const persistTaskState = async (state: RunState): Promise<void> => {
    taskStore.update(task.taskId, taskPatchFromRunState(state));
  };

  const finishTask = (state: RunState): void => {
    const status = taskStatusFromRunState(state);
    if (status === 'running' || status === 'waiting_input' || status === 'waiting_approval' || status === 'queued') return;
    taskStore.finish(task.taskId, status, taskPatchFromRunState(state));
  };

  const failTask = (err: unknown): void => {
    const current = taskStore.get(task.taskId);
    if (current?.status === 'succeeded' || current?.status === 'cancelled') return;
    taskStore.finish(task.taskId, 'failed', {
      error: truncateTaskText(err instanceof Error ? err.message : String(err), 280),
    });
  };

  try {
    if (replyMode === 'card') {
      const progress = new ReliableProgress(
        channel,
        chatId,
        sendOpts,
        renderNonStreamingCard((state) => renderCard(filterForPrefs(state), {
          sessionActions: Boolean(project && threadScoped),
          taskId: task.taskId,
        })),
        initialState,
        { renderFinal: (state) => renderText(filterForPrefs(state)) },
      );
      await progress.start();
      try {
        const finalState = await processAgentStream(
          handle,
          sessions,
          scope,
          cwd,
          idleTimeoutMs,
          async (state) => {
            await persistTaskState(state);
            await progress.update(state);
          },
          uiHooks,
        );
        finishTask(finalState);
        await progress.complete(finalState);
      } catch (err) {
        failTask(err);
        await progress.fail(err);
        throw err;
      }
    } else if (replyMode === 'markdown') {
      const progress = new ReliableProgress(
        channel,
        chatId,
        sendOpts,
        (state, meta) => renderMarkdownProgressCard(filterForPrefs(state), meta, task.taskId),
        initialState,
        { renderFinal: (state) => renderText(filterForPrefs(state)) },
      );
      await progress.start();
      try {
        const finalState = await processAgentStream(
          handle,
          sessions,
          scope,
          cwd,
          idleTimeoutMs,
          async (state) => {
            await persistTaskState(state);
            await progress.update(state);
          },
          uiHooks,
        );
        finishTask(finalState);
        await progress.complete(finalState);
      } catch (err) {
        failTask(err);
        await progress.fail(err);
        throw err;
      }
    } else {
      // text mode: drain the agent stream without sending anything during
      // the run, then post the final rendered text once as a plain markdown
      // (msg_type=post) message — no card, no streaming, no typewriter.
      const finalState = await processAgentStream(handle, sessions, scope, cwd, idleTimeoutMs, async (state) => {
        await persistTaskState(state);
      }, uiHooks);
      finishTask(finalState);
      const body = renderText(filterForPrefs(finalState));
      if (body.trim()) {
        await channel.send(chatId, { markdown: body }, sendOpts);
      }
    }
  } catch (err) {
    failTask(err);
    log.fail('stream', err);
  } finally {
    activeRuns.unregister(scope, run);
    if (reactionId) {
      await removeReaction(channel, lastMsg.messageId, reactionId);
    }
    // Releasing here keeps a successful turn successful even if the writer
    // release fails; the helper logs and swallows that failure.
    await releaseWriterIfAllIdle(activeRuns, agent);
  }
}

function findTopicBinding(
  bindings: ProjectBindingStore | undefined,
  chatId: string,
  threadId: string | undefined,
  rootId: string | undefined,
): import('../project/types').TopicBinding | undefined {
  if (!bindings) return undefined;
  // New bindings use the real `omt_...` thread id. The root-id fallback keeps
  // topics created by older bridge versions usable after this migration.
  return (threadId ? bindings.findTopic(chatId, threadId) : undefined)
    ?? (rootId ? bindings.findTopic(chatId, rootId) : undefined);
}

function taskPatchFromRunState(state: RunState): Partial<TaskRecord> {
  const tools = state.blocks
    .filter((block): block is Extract<RunState['blocks'][number], { kind: 'tool' }> => block.kind === 'tool');
  const tests = tools.filter((tool) => /\b(?:test|vitest|jest|pytest|cargo test|go test)\b/i.test(JSON.stringify(tool.tool.input)));
  const latestText = [...state.blocks]
    .reverse()
    .find((block): block is Extract<RunState['blocks'][number], { kind: 'text' }> => block.kind === 'text' && !block.streaming);
  const diffStatus = state.ui.statuses['代码改动'];
  const changedLines = diffStatus?.match(/(\d+)\s*行/)?.[1];
  const currentTool = [...tools].reverse().find((tool) => tool.tool.status === 'running')?.tool.name;
  const stage = state.ui.statuses['会话状态']
    ?? (state.footer === 'tool_running' ? currentTool ?? '调用工具' : footerText(state.footer));

  return {
    status: taskStatusFromRunState(state),
    stage,
    ...(currentTool ? { currentTool } : {}),
    toolCount: tools.length,
    failedToolCount: tools.filter((tool) => tool.tool.status === 'error').length,
    testCount: tests.length,
    failedTestCount: tests.filter((tool) => tool.tool.status === 'error').length,
    ...(changedLines ? { changedLines: Number(changedLines) } : {}),
    ...(latestText?.content ? { summary: truncateTaskText(latestText.content, 280) } : {}),
    ...(state.errorMsg ? { error: truncateTaskText(state.errorMsg, 280) } : {}),
    ...(state.usage ? {
      usage: {
        totalTokens: state.usage.totalTokens,
        contextTokens: state.usage.contextTokens,
        modelContextWindow: state.usage.modelContextWindow,
      },
    } : {}),
  };
}

function taskStatusFromRunState(state: RunState): TaskStatus {
  if (state.terminal === 'done') return 'succeeded';
  if (state.terminal === 'error' || state.terminal === 'idle_timeout') return 'failed';
  if (state.terminal === 'interrupted') return 'cancelled';
  if (state.footer === 'waiting_input') return 'waiting_input';
  return 'running';
}

function footerText(footer: RunState['footer']): string | undefined {
  if (footer === 'thinking') return '思考中';
  if (footer === 'tool_running') return '调用工具';
  if (footer === 'streaming') return '输出中';
  if (footer === 'waiting_input') return '等待输入';
  return undefined;
}

function truncateTaskText(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

/**
 * Drive the agent's event stream into a stateful RunState, calling `flush`
 * on every state transition. Used by both card and markdown reply modes —
 * the only difference between the two is what `flush` does with the state.
 */
async function processAgentStream(
  handle: RunHandle,
  sessions: SessionStore,
  scope: string,
  cwd: string,
  idleTimeoutMs: number | undefined,
  flush: (state: RunState) => Promise<void>,
  hooks?: AgentStreamHooks,
): Promise<RunState> {
  let state: RunState = initialState;

  // Idle watchdog: OMP going silent for `idleTimeoutMs` is treated as
  // "presumed hung", we stop() and surface a timeout marker on the card.
  //
  // BUT — OMP can legitimately be silent for a long time when it's
  // waiting on a long-running tool call (e.g. `lark-cli` printing an
  // OAuth URL and blocking until the user clicks authorize) or on an OMP
  // native UI prompt that the user must answer from a Feishu card.
  // Pause the watchdog while either a tool or UI request is in flight.
  //
  // The watchdog re-arms when:
  //  - a tool_result drains the in-flight set to zero, OR
  //  - any non-tool event arrives while the set is empty.
  let idleFired = false;
  let timer: NodeJS.Timeout | undefined;
  const inFlightTools = new Set<string>();
  const armOrPauseIdle = (): void => {
    if (!idleTimeoutMs) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (inFlightTools.size > 0 || handle.pendingUiRequests.size > 0) return;
    timer = setTimeout(() => {
      idleFired = true;
      handle.interrupted = true;
      log.warn('agent', 'idle-timeout', { scope, idleTimeoutMs });
      void handle.run.stop().catch(() => {
        /* stop errors are non-fatal */
      });
    }, idleTimeoutMs);
  };
  handle.onUiSettled = armOrPauseIdle;
  armOrPauseIdle();

  try {
    for await (const evt of handle.run.events) {
      if (handle.interrupted) break;

      // Track tool/UI flight before re-arming the idle timer so the arm step
      // sees the correct set size. tool_use/ui_request open a window;
      // tool_result/ui response/cancel closes it.
      if (evt.type === 'tool_use') {
        inFlightTools.add(evt.id);
        log.info('agent', 'tool-in-flight', {
          tool: evt.name,
          inFlight: inFlightTools.size,
        });
      } else if (evt.type === 'tool_result') {
        inFlightTools.delete(evt.id);
        log.info('agent', 'tool-done', { inFlight: inFlightTools.size });
      } else if (evt.type === 'ui_request') {
        handle.pendingUiRequests.add(evt.request.id);
        log.info('agent', 'ui-in-flight', { method: evt.request.method, inFlight: handle.pendingUiRequests.size });
      } else if (evt.type === 'ui_cancel') {
        handle.pendingUiRequests.delete(evt.targetId);
        log.info('agent', 'ui-cancelled', { inFlight: handle.pendingUiRequests.size });
      }
      armOrPauseIdle();

      if (evt.type === 'system') {
        if (evt.sessionId) {
          const effectiveCwd = evt.cwd ?? cwd;
          await hooks?.onSystem?.(evt.sessionId, effectiveCwd);
          sessions.set(scope, evt.sessionId, effectiveCwd);
          log.info('session', 'set', { sessionId: evt.sessionId });
        }
        state = reduce(state, evt);
        continue;
      }
      if (evt.type === 'model_switch') {
        settlePendingForModelSwitch(sessions, scope, evt.status);
        continue;
      }
      if (evt.type === 'usage') {
        if (evt.costUsd !== undefined) {
          log.info('agent', 'usage', { costUsd: Number(evt.costUsd.toFixed(4)) });
        }
        state = reduce(state, evt);
        await flush(state);
        continue;
      }
      if (evt.type === 'ui_request') {
        await hooks?.onUiRequest(evt.request);
      } else if (evt.type === 'ui_cancel') {
        await hooks?.onUiCancel(evt.targetId);
      }

      const prevTerminal = state.terminal;
      const prevFooter = state.footer;
      state = reduce(state, evt);
      if (state.footer !== prevFooter || state.terminal !== prevTerminal) {
        log.info('card', 'transition', { footer: state.footer, terminal: state.terminal });
      }
      await flush(state);
      // Stop iterating as soon as we have a terminal state. Some OMP
      // RPC runs may leave stdout open briefly after agent_end, which
      // would leave the for-await waiting forever otherwise.
      if (state.terminal !== 'running') break;
    }
  } finally {
    if (handle.onUiSettled === armOrPauseIdle) handle.onUiSettled = undefined;
    if (timer) clearTimeout(timer);
  }

  // If state already reached a terminal event (done/error/etc.) before the
  // watchdog or interrupt could land, don't clobber it — that real terminal
  // wins. This avoids "OMP finished but flush was slow → timer fired
  // mid-flush → user sees 'idle_timeout' on a successful run".
  if (state.terminal === 'running') {
    if (idleFired) {
      state = markIdleTimeout(state, Math.round(idleTimeoutMs! / 60_000));
    } else if (handle.interrupted) {
      state = markInterrupted(state);
    } else {
      state = finalizeIfRunning(state);
    }
  }
  log.info('card', 'final', { terminal: state.terminal, interrupted: handle.interrupted });
  await flush(state);
    // Reap the subprocess. Two regimes:
  //  - Interrupted (user /stop, idle watchdog, disconnect): stop() was already
  //    fire-and-forgotten by whoever set handle.interrupted; this awaits it.
  //  - Natural done: agent_end can arrive before OMP has fully closed stdout.
  //    Wait it out so the run exits with
  //    code 0; only SIGTERM as a hung-process safety net.
  if (handle.interrupted) {
    await handle.run.stop();
  } else {
    const exited = await handle.run.waitForExit(POST_DONE_EXIT_GRACE_MS);
    if (!exited) {
      log.warn('agent', 'post-done-timeout', { graceMs: POST_DONE_EXIT_GRACE_MS });
      await handle.run.stop();
    }
  }
  return state;
}

/**
 * How long to wait for OMP to close stdout after a terminal event before
 * forcing a SIGTERM. Empirically OMP's post-agent_end tail is well under a
 * second; 2s leaves headroom for slow flushes without making the user notice
 * a stall (the card has already rendered terminal state by this point).
 */
const POST_DONE_EXIT_GRACE_MS = 2000;

/**
 * For interactive-card messages the SDK flattens to text-bearing nodes or
 * the literal "[interactive card]" placeholder, losing v2 `user_dsl` and the
 * raw v1 JSON. Pull the raw webhook content (attached via `includeRawEvent`)
 * and feed it to `expandInteractiveCard` so direct-receive cards get the
 * same `<interactive_card>` injection that quoted cards already get.
 */
function expandedMessageContent(m: NormalizedMessage): string {
  if (m.rawContentType !== 'interactive') return m.content;
  const rawContent = (m.raw as { message?: { content?: unknown } } | undefined)
    ?.message?.content;
  if (typeof rawContent !== 'string') return m.content;
  return expandInteractiveCard(m.content, rawContent);
}

export function buildPrompt(
  batch: NormalizedMessage[],
  attachments: LocalAttachment[],
  quotes: QuotedContext[] = [],
  metadataFirst = false,
  includeRoutingIds = false,
): string {
  const fileKeys = batch.flatMap((m) => m.resources.map((r) => r.fileKey));
  const texts = messageTexts(batch, fileKeys);
  const ctxHeader = metadataFirst ? buildBridgeContextHeader(batch, includeRoutingIds) : '';
  const quoteBlock = renderQuotedBlock(quotes);
  const userPart = texts.length > 0
    ? texts.join('\n\n')
    : attachments.length > 0
      ? '请看下面的附件。'
      : '请处理这条消息。';
  const userParts = [userPart];

  if (attachments.length > 0) {
    const attachLines = attachments.map((a) => {
      const label =
        a.kind === 'image'
          ? '图片'
          : a.kind === 'audio'
            ? '音频'
            : a.kind === 'video'
              ? '视频'
              : '文件';
      const name = a.originalName ? ` (${a.originalName})` : '';
      return `- ${a.path}${name} — ${label}`;
    });
    userParts.push(`附件（本地路径）：\n${attachLines.join('\n')}`);
  }

  if (metadataFirst) {
    // Preserve OMP's established prompt contract.
    return [ctxHeader, quoteBlock, ...userParts].filter(Boolean).join('\n\n');
  }

  // Codex receives transport metadata through TurnStartParams.additionalContext.
  // Keep only user-authored content and quoted content in the visible prompt.
  return [...userParts, quoteBlock].filter(Boolean).join('\n\n');
}

export function deriveThreadTitle(
  batch: NormalizedMessage[],
  hasAttachments = false,
): string {
  const fileKeys = batch.flatMap((m) => m.resources.map((r) => r.fileKey));
  const text = messageTexts(batch, fileKeys)[0];
  return threadTitleFromText(text, hasAttachments ? '查看附件' : '飞书新会话');
}

function messageTexts(batch: NormalizedMessage[], fileKeys: string[]): string[] {
  return batch
    .map((m) => stripAttachmentRefs(expandedMessageContent(m), fileKeys).trim())
    .filter(Boolean);
}

function buildBridgeContextHeader(batch: NormalizedMessage[], includeRoutingIds: boolean): string {
  const m = batch[0];
  if (!m) return '';
  const lines = [
    '<bridge_context>',
    `chat_type: ${m.chatType}`,
  ];
  if (m.senderName) lines.push(`sender_name: ${m.senderName}`);
  if (includeRoutingIds) {
    lines.splice(1, 0, `chat_id: ${m.chatId}`, `sender_id: ${m.senderId}`);
    if (m.threadId) lines.push(`thread_id: ${m.threadId}`);
  }
  lines.push('</bridge_context>');
  return lines.join('\n');
}

function stripAttachmentRefs(text: string, fileKeys: string[]): string {
  if (!text || fileKeys.length === 0) return text;
  let out = text;
  for (const key of fileKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
  }
  return out.replace(/\n{3,}/g, '\n\n');
}
