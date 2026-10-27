import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import type { ChatModeCache } from '../bot/chat-mode-cache';
import type { PendingQueue } from '../bot/pending-queue';
import { runCommandHandler, type CommandContext, type Controls } from '../commands';
import { isChatAllowed, isProjectAllowed, isUserAllowed } from '../config/schema';
import { log } from '../core/logger';
import type { SessionStore } from '../session/store';
import { updateManagedCard } from './managed';
import {
  isOmpUiPayload,
  ompUiRequestId,
  ompUiTitle,
  renderOmpUiResultCard,
  responseFromOmpUiAction,
} from './omp-ui';
import type { WorkspaceStore } from '../workspace/store';
import type { ProjectCatalog } from '../project/catalog';
import type { ProjectBindingStore } from '../project/types';
import type { SessionSyncManager } from '../session/sync';
import type { JsonTaskStore } from '../task/store';
import { isThreadScoped } from '../bot/scope';
import { lookupMessageThreadId } from '../bot/thread';

/** Marker key on a button's value object that flags the cardAction as
 * a callback that should be forwarded back to the agent instead of dispatched
 * to a built-in command handler. The double-underscore sigils make it
 * virtually impossible to collide with normal payload fields the agent
 * might set.
 */
const AGENT_CALLBACK_MARKER = '__codex_cb';

export interface CardDispatchDeps {
  channel: LarkChannel;
  evt: CardActionEvent;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: AgentAdapter;
  controls: Controls;
  pending: PendingQueue;
  chatModeCache: ChatModeCache;
  projectCatalog?: ProjectCatalog;
  projectBindings?: ProjectBindingStore;
  sessionSync?: SessionSyncManager;
  taskStore?: JsonTaskStore;
}

export async function handleCardAction(deps: CardDispatchDeps): Promise<void> {
  const value = deps.evt.action.value;
  if (!value || typeof value !== 'object') return;
  const payload = value as Record<string, unknown>;

  const operatorId = deps.evt.operator.openId;
  const chatId = deps.evt.chatId;

  // CardKit 2.0 form submits drop user-input values from action.value; they
  // arrive on raw.action.form_value. The SDK forwards the raw event when
  // includeRawEvent: true is set on the channel options.
  const raw = (deps.evt as CardActionEvent & { raw?: unknown }).raw as
    | { action?: { form_value?: Record<string, unknown> } }
    | undefined;
  const formValue = raw?.action?.form_value;

  // Resolve the click's session scope. For topic groups we need to know
  // the message's thread_id so the action targets the right topic's
  // session — look up the carrier message (the card lives on it) once.
  // Done before the access check so we know the chat mode (p2p vs group)
  // and can skip the chat allowlist for DMs.
  const { scope, threadId, mode } = await resolveScope(deps);

  // Access control. Operator must be on the same allowlists as message
  // senders. Silent drop — sending a denial card to an unauthorized user
  // just confirms the bot exists.
  if (!isUserAllowed(deps.controls.cfg, operatorId)) {
    log.info('cardAction', 'skip-not-allowed-user', {
      operator: operatorId.slice(-6),
    });
    return;
  }
  // `allowedChats` is group-only — see intakeMessage in bot/channel.ts for
  // the rationale (p2p chat_ids aren't a meaningful access boundary, the
  // user check above is authoritative for DMs).
  if (mode !== 'p2p' && !isChatAllowed(deps.controls.cfg, chatId)) {
    log.info('cardAction', 'skip-not-allowed-chat', {
      chatId: chatId.slice(-6),
    });
    return;
  }
  const project = deps.projectBindings?.findProjectByChat(chatId);
  if (project && !isProjectAllowed(deps.controls.cfg, project.projectKey, operatorId)) {
    log.info('cardAction', 'skip-not-allowed-project', {
      project: project.projectKey,
      operator: operatorId.slice(-6),
    });
    return;
  }

  if (isOmpUiPayload(payload)) {
    await respondToOmpUi(deps, payload, formValue, scope);
    return;
  }

  // Agent-driven callback: the button was rendered by OMP via
  // lark-cli, with `__codex_cb` set on the value. Forward the click back
  // into the scope's pending queue so OMP resumes its session and sees
  // the click as a follow-up message, with full context of what it sent.
  if (AGENT_CALLBACK_MARKER in payload) {
    forwardToAgent(deps, payload, formValue, scope, threadId);
    return;
  }

  const cmd = typeof payload.cmd === 'string' ? payload.cmd : '';
  if (!cmd) return;
  log.info('cardAction', 'cmd', { cmd, scope });

  const ctx: CommandContext = {
    channel: deps.channel,
    msg: makeFakeMsg(deps.evt, threadId),
    scope,
    chatMode: mode,
    sessions: deps.sessions,
    workspaces: deps.workspaces,
    activeRuns: deps.activeRuns,
    agent: deps.agent,
    controls: deps.controls,
    formValue,
    cardPayload: payload,
    fromCardAction: true,
    projectCatalog: deps.projectCatalog,
    projectBindings: deps.projectBindings,
    sessionSync: deps.sessionSync,
    taskStore: deps.taskStore,
    pending: deps.pending,
  };

  const [name, ...rest] = cmd.split('.');
  const sub = rest.join(' ');
  const args = composeArgs(sub, payload);

  try {
    const ok = await runCommandHandler(name ?? '', args, ctx);
    if (!ok) log.warn('cardAction', 'unknown', { cmd });
  } catch (err) {
    log.fail('cardAction', err, { cmd });
  }
}

async function resolveScope(
  deps: CardDispatchDeps,
): Promise<{ scope: string; threadId: string | undefined; mode: 'p2p' | 'group' | 'topic' }> {
  const chatId = deps.evt.chatId;
  const mode = await deps.chatModeCache.resolve(deps.channel, chatId);
  const projectChat = Boolean(deps.projectBindings?.findProjectByChat(chatId));
  // The carrier message is the reliable source of thread_id. A thread-enabled
  // private group is still returned as `group` by chat.get, so only checking
  // the cached mode loses the project/session binding on card clicks.
  const threadId = await lookupMessageThreadId(deps.channel, deps.evt.messageId);
  if (!isThreadScoped(mode, threadId, projectChat)) {
    return { scope: chatId, threadId: undefined, mode };
  }
  return { scope: `${chatId}:${threadId}`, threadId, mode };
}

function forwardToAgent(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  formValue: Record<string, unknown> | undefined,
  scope: string,
  threadId: string | undefined,
): void {
  // Strip the marker so OMP only sees the meaningful fields it set.
  const { [AGENT_CALLBACK_MARKER]: _marker, ...agentPayload } = payload;
  const merged = formValue ? { ...agentPayload, form_value: formValue } : agentPayload;
  log.info('cardAction', 'forward-agent', {
    scope,
    payload: JSON.stringify(merged).slice(0, 200),
  });
  const synthetic: NormalizedMessage = {
    messageId: deps.evt.messageId,
    chatId: deps.evt.chatId,
    chatType: 'p2p',
    threadId,
    senderId: deps.evt.operator.openId,
    senderName: deps.evt.operator.name,
    content: `[card-click] ${JSON.stringify(merged)}`,
    rawContentType: 'card_action',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
  deps.pending.push(scope, synthetic);
}

async function respondToOmpUi(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  formValue: Record<string, unknown> | undefined,
  scope: string,
): Promise<void> {
  const requestId = ompUiRequestId(payload);
  const title = ompUiTitle(payload);
  const response = responseFromOmpUiAction(payload, formValue);
  const targetScope = typeof payload.scope === 'string' ? payload.scope : scope;
  const submitted = Boolean(requestId && response && deps.activeRuns.respondToUi(targetScope, requestId, response));
  const status = submitted
    ? response && 'cancelled' in response
      ? 'cancelled'
      : 'submitted'
    : 'unavailable';

  log.info('cardAction', 'omp-ui', { scope: targetScope, requestId, submitted, status });
  try {
    await updateManagedCard(deps.channel, deps.evt.messageId, renderOmpUiResultCard(title, status));
  } catch (err) {
    log.fail('cardAction', err, { step: 'omp-ui-update', requestId });
  }
}

/** Turn a button payload like {cmd:'ws.use', name:'proj-a'} into the arg
 * string the text-command handler expects: 'use proj-a'. Accepts `arg`
 * (preferred, generic) or `name` (legacy ws cards). */
function composeArgs(sub: string, payload: Record<string, unknown>): string {
  const arg =
    (typeof payload.arg === 'string' && payload.arg) ||
    (typeof payload.name === 'string' && payload.name) ||
    '';
  if (!sub) return arg;
  return arg ? `${sub} ${arg}` : sub;
}

function makeFakeMsg(
  evt: CardActionEvent,
  threadId: string | undefined,
): NormalizedMessage {
  return {
    messageId: evt.messageId,
    chatId: evt.chatId,
    chatType: 'p2p',
    threadId,
    senderId: evt.operator.openId,
    senderName: evt.operator.name,
    content: '',
    rawContentType: 'interactive',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}
