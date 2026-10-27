import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import {
  accountCurrentCard,
  accountFailureCard,
  accountFormCard,
  accountSuccessCard,
} from '../card/account-cards';
import { configCancelledCard, configFormCard, configSavedCard } from '../card/config-card';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../card/managed';
import {
  helpCard,
  projectFeedbackCard,
  projectWelcomeCard,
  projectsCard,
  sessionProgressCard,
  sessionDetailCard,
  sessionSearchCard,
  sessionsCard,
  taskDetailCard,
  tasksCard,
  presetsCard,
  statusCard,
  topicWelcomeCard,
  welcomeCard,
  workspacesCard,
} from '../card/templates';
import type { StatusModelInfo } from '../card/templates';
import type { AppConfig, MessageReplyMode, TenantBrand } from '../config/schema';
import {
  getAgentStopGraceMs,
  getEnforceProjectRootSandbox,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getProjectRoots,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  isAdmin,
  secretKeyForApp,
} from '../config/schema';
import { setSecret } from '../config/keystore';
import { buildEncryptedAccountConfig, saveConfig } from '../config/store';
import { log, readRecentLogs, sanitizeLogsForDoctor } from '../core/logger';
import { renderCard } from '../card/run-renderer';
import {
  finalizeIfRunning,
  initialState,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import { isAlive, readAndPrune, resolveTarget } from '../runtime/registry';
import type { SessionStore } from '../session/store';
import { validateAppCredentials } from '../utils/feishu-auth';
import type { WorkspaceStore } from '../workspace/store';
import { createBoundChat, defaultChatName } from '../bot/group';
import { lookupMessageThreadId } from '../bot/thread';
import type { ProjectCatalog } from '../project/catalog';
import type { Project, ProjectBindingStore } from '../project/types';
import type { SessionSyncManager } from '../session/sync';
import { JsonTaskStore } from '../task/store';
import type { TaskRecord } from '../task/types';
import { showProjectWorkbench } from '../project/workbench';
import { isWithinProjectRoots } from '../config/path-policy';
import type { PendingQueue } from '../bot/pending-queue';

export interface Controls {
  /** Restart the bridge in-process: disconnect WS, kill OMP runs, reload
   * config, reconnect with the new credentials. */
  restart(): Promise<void>;
  /** Stop this whole process gracefully (disconnect + exit). Used by /exit
   * when the user targets the receiving process itself. */
  exit(): Promise<void>;
  /** Path to the config file the bridge was started with. */
  configPath: string;
  /** The current app config (snapshot at startChannel time). */
  cfg: AppConfig;
  /** This process's short id in the registry. Used by /ps to highlight the
   * receiving process and by /exit to detect self-target. */
  processId: string;
}

export interface CommandContext {
  channel: LarkChannel;
  msg: NormalizedMessage;
  /**
   * Session scope string. For p2p / regular group it equals `msg.chatId`;
   * for topic groups it's `${chatId}:${threadId}` (so each topic gets its
   * own session / cwd / active-run). All handlers should read/write
   * session / workspace / activeRuns through this — never through
   * `msg.chatId` directly.
   */
  scope: string;
  /** Resolved chat mode for `msg.chatId`. Used by /status to surface the
   * scope semantic to the user (`topic` shows "话题独立 session"). */
  chatMode: 'p2p' | 'group' | 'topic';
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  agent: AgentAdapter;
  activeRuns: ActiveRuns;
  controls: Controls;
  /** Set when invoked from a CardKit 2.0 form submit. Keys are input `name`s. */
  formValue?: Record<string, unknown>;
  /** True when this invocation came from a card button click rather than a
   * text command. Determines whether to update the existing card vs send a
   * new one. */
  fromCardAction?: boolean;
  projectCatalog?: ProjectCatalog;
  projectBindings?: ProjectBindingStore;
  sessionSync?: SessionSyncManager;
  taskStore?: JsonTaskStore;
  pending?: PendingQueue;
}

type Handler = (args: string, ctx: CommandContext) => Promise<void>;

const handlers: Record<string, Handler> = {
  '/projects': handleProjects,
  '/sessions': handleSessions,
  '/tasks': handleTasks,
  '/task': handleTask,
  '/preset': handlePreset,
  '/project': handleProject,
  '/session': handleSession,
  '/welcome': handleWelcome,
  '/new': handleNew,
  '/reset': handleNew,
  '/cd': handleCd,
  '/ws': handleWs,
  '/status': handleStatus,
  '/sync': handleSync,
  '/help': handleHelp,
  '/account': handleAccount,
  '/config': handleConfig,
  '/stop': handleStop,
  '/timeout': handleTimeout,
  '/ps': handlePs,
  '/exit': handleExit,
  '/doctor': handleDoctor,
  '/reconnect': handleReconnect,
};

/**
 * Commands that can mutate credentials, lifecycle, filesystem reach, or
 * surface sensitive runtime state. Gated on the configured admin allowlist;
 * empty list = no restriction (every allowed user can run them — see
 * `isAdmin` in config/schema).
 */
const ADMIN_COMMANDS = new Set([
  '/account',
  '/config',
  '/exit',
  '/reconnect',
  '/doctor',
  '/cd',
  '/ws',
]);

function isAdminCommand(cmd: string): boolean {
  return ADMIN_COMMANDS.has(cmd.startsWith('/') ? cmd : `/${cmd}`);
}

export async function tryHandleCommand(ctx: CommandContext): Promise<boolean> {
  const trimmed = ctx.msg.content.trim();
  const aliases: Record<string, string> = {
    '项目': '/projects', '我的项目': '/projects', '选择项目': '/projects', '项目群': '/projects', '开始': '/projects',
    '会话': '/sessions', '查看会话': '/sessions', '新建': '/session new', '新建会话': '/session new',
    '任务': '/tasks', '查看任务': '/tasks', '任务模板': '/preset',
    '状态': '/status', '当前状态': '/status', '停止': '/stop', '停止任务': '/stop',
    '帮助': '/help', '怎么用': '/help',
    '同步': '/sync', '刷新进度': '/sync', '刷新 Codex 进度': '/sync',
  };
  // Inside a project topic every natural-language message belongs to Codex.
  // Keep slash commands available for advanced users, but do not interpret
  // words such as “状态” or “新建” as Bridge commands inside the conversation.
  const inProjectTopic = Boolean(
    ctx.msg.threadId && ctx.projectBindings?.findProjectByChat(ctx.msg.chatId),
  );
  const normalized = inProjectTopic ? trimmed : (aliases[trimmed] ?? trimmed);
  if (!normalized.startsWith('/')) return false;
  const parts = normalized.split(/\s+/);
  const cmd = parts[0] ?? '';
  const args = parts.slice(1).join(' ');
  const h = handlers[cmd];
  if (!h) return false;
  if (isAdminCommand(cmd) && !isAdmin(ctx.controls.cfg, ctx.msg.senderId)) {
    log.info('command', 'admin-deny', {
      cmd,
      sender: ctx.msg.senderId.slice(-6),
    });
    await reply(ctx, '❌ 此命令仅管理员可用。');
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd });
  }
  return true;
}

/** Invoke a named command handler (e.g. from a card button click). */
export async function runCommandHandler(
  name: string,
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  const h = handlers[`/${name}`];
  if (!h) return false;
  if (isAdminCommand(name) && !isAdmin(ctx.controls.cfg, ctx.msg.senderId)) {
    log.info('command', 'admin-deny', {
      cmd: name,
      sender: ctx.msg.senderId.slice(-6),
      via: 'card',
    });
    // Card actions can't reply naturally (the `msg` is synthesized); the
    // click is silently denied. The button only renders for users who got
    // the original admin card in the first place, so this is an edge case.
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd: name });
  }
  return true;
}

/**
 * Send a plain markdown reply, swallowing any send error. Used by command
 * handlers where a failed reply shouldn't bubble up and crash the bot —
 * losing the message is better than dying.
 */
async function reply(ctx: CommandContext, markdown: string): Promise<void> {
  try {
    await ctx.channel.send(ctx.msg.chatId, { markdown }, { replyTo: ctx.msg.messageId });
  } catch (err) {
    log.fail('command', err, { step: 'reply' });
  }
}

/** Replace the clicked card so the group keeps one visible source of truth. */
async function sendCommandCard(ctx: CommandContext, card: object): Promise<void> {
  if (ctx.fromCardAction) {
    try {
      await ctx.channel.updateCard(ctx.msg.messageId, card);
      return;
    } catch (err) {
      log.warn('command', 'card-update-failed', { err: String(err) });
    }
  }
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

async function commandFeedback(
  ctx: CommandContext,
  title: string,
  detail: string,
  buttons: Array<{ text: string; value: Record<string, unknown>; style?: 'primary' | 'danger' | 'default' }>,
): Promise<void> {
  if (!ctx.fromCardAction) {
    await reply(ctx, detail);
    return;
  }
  const inProjectChat = Boolean(ctx.projectBindings?.findProjectByChat(ctx.msg.chatId));
  const home = inProjectChat
    ? { text: '返回项目工作台', value: { cmd: 'welcome' } as Record<string, unknown> }
    : { text: '返回项目列表', value: { cmd: 'projects' } as Record<string, unknown> };
  const resultButtons = ctx.msg.threadId ? buttons : [...buttons, home];
  await sendCommandCard(ctx, projectFeedbackCard(title, detail, resultButtons));
}

async function commandProgress(ctx: CommandContext, detail: string): Promise<void> {
  if (!ctx.fromCardAction) return;
  await sendCommandCard(ctx, projectFeedbackCard('正在处理', `↻ ${detail}`));
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`;
  return p;
}

async function handleNew(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim();

  // /new chat [name]  — spin up a fresh group chat bound to a fresh session
  if (trimmed === 'chat' || trimmed.startsWith('chat ')) {
    const rawName = trimmed === 'chat' ? '' : trimmed.slice(5).trim();
    return handleNewChat(rawName, ctx);
  }

  const wasRunning = ctx.activeRuns.interrupt(ctx.scope);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, wasRunning ? '已中断当前任务并开始新会话。' : '已开始新会话。');
}

async function handleWelcome(_args: string, ctx: CommandContext): Promise<void> {
  const project = ctx.projectBindings?.findProjectByChat(ctx.msg.chatId);
  if (project && ctx.projectBindings && !ctx.fromCardAction) {
    await showProjectWorkbench(ctx.channel, ctx.projectBindings, project);
    return;
  }
  await sendCommandCard(ctx, project ? projectWelcomeCard(project) : welcomeCard());
}

async function handleProjects(args: string, ctx: CommandContext): Promise<void> {
  if (!ctx.projectCatalog || !ctx.projectBindings) {
    await reply(ctx, '当前 Bridge 尚未启用项目模式，请先在配置中将 agentBackend 设置为 codex。');
    return;
  }
  await commandProgress(ctx, '正在读取项目列表，请稍候。');
  const all = await sortProjectsByRecentSession(await ctx.projectCatalog.list(), ctx.agent);
  const onlyBound = args.trim() === 'bound';
  const projects = all
    .map((project) => ({ ...project, chatId: ctx.projectBindings?.projectFor(project.projectKey)?.chatId }))
    .filter((project) => !onlyBound || Boolean(project.chatId));
  const pageArg = args.trim().startsWith('page ') ? args.trim().slice(5) : args.trim();
  const page = pageArg ? Math.max(0, Number.parseInt(pageArg, 10) || 0) : 0;
  await sendCommandCard(ctx, projectsCard(projects, page));
}

/**
 * Project roots do not have a reliable filesystem "last used" timestamp.
 * Codex session activity is the useful recency signal, so keep projects with
 * the newest non-archived session at the top of the picker.
 */
async function sortProjectsByRecentSession(projects: Project[], agent: AgentAdapter): Promise<Project[]> {
  if (agent.listRecentSessions) {
    try {
      const latestByCwd = new Map<string, number>();
      for (const session of await agent.listRecentSessions()) {
        if (session.status === 'archived') continue;
        latestByCwd.set(session.cwd, Math.max(latestByCwd.get(session.cwd) ?? 0, session.updatedAt));
      }
      return projects
        .map((project, index) => ({ project, index, updatedAt: latestByCwd.get(project.cwd) ?? 0 }))
        .sort((a, b) => b.updatedAt - a.updatedAt || a.index - b.index)
        .map(({ project }) => project);
    } catch (err) {
      log.warn('project', 'activity-sort-failed', { err: String(err) });
    }
  }
  if (!agent.listSessions) return projects;
  const ranked = await Promise.all(projects.map(async (project, index) => {
    try {
      const sessions = await agent.listSessions!(project.cwd);
      const updatedAt = sessions
        .filter((session) => session.status !== 'archived')
        .reduce((latest, session) => Math.max(latest, session.updatedAt), 0);
      return { project, index, updatedAt };
    } catch (err) {
      log.warn('project', 'activity-sort-failed', { cwd: project.cwd, err: String(err) });
      return { project, index, updatedAt: 0 };
    }
  }));
  return ranked
    .sort((a, b) => b.updatedAt - a.updatedAt || a.index - b.index)
    .map(({ project }) => project);
}

async function handleProject(args: string, ctx: CommandContext): Promise<void> {
  const [action, ...rest] = args.trim().split(/\s+/);
  const projectKey = rest.join(' ');
  if (!ctx.projectCatalog || !ctx.projectBindings) {
    await reply(ctx, '当前 Bridge 尚未启用项目模式，请先在配置中将 agentBackend 设置为 codex。');
    return;
  }
  await commandProgress(ctx, '正在处理项目操作，请稍候。');
  if (action === 'sessions') {
    const project = await ctx.projectCatalog.get(projectKey);
    if (!project) return reply(ctx, '没有找到这个项目，请重新打开项目列表。');
    const existing = ctx.projectBindings.projectFor(project.projectKey);
    if (existing?.chatId && existing.chatId !== ctx.msg.chatId) {
      await reply(ctx, '这个项目已经绑定项目群。进入项目群后可直接新建话题开始；需要恢复历史对话时再点击“查看会话”。');
      return;
    }
    await openProject(project.projectKey, ctx);
    return;
  }
  if (action === 'status') {
    const current = ctx.projectBindings.findProjectByChat(ctx.msg.chatId);
    const project = projectKey ? await ctx.projectCatalog.get(projectKey) : current;
    if (!project) return reply(ctx, '没有找到这个项目，请刷新项目列表。');
    const binding = ctx.projectBindings.projectFor(project.projectKey);
    const topicCount = ctx.projectBindings.topicsForProject(project.projectKey).length;
    await commandFeedback(ctx, '项目状态', `项目：**${project.name}**\n项目群：${binding?.chatId ? '已创建' : '未创建'}\n已绑定话题：${topicCount} 个`, [
      { text: '查看会话', value: { cmd: 'sessions' }, style: 'primary' },
    ]);
    return;
  }
  if (action !== 'open' || !projectKey) return handleProjects('', ctx);
  await openProject(projectKey, ctx);
}

async function openProject(projectKey: string, ctx: CommandContext): Promise<void> {
  if (!ctx.projectCatalog || !ctx.projectBindings) return;
  const project = await ctx.projectCatalog.get(projectKey);
  if (!project) return reply(ctx, '没有找到这个项目，请刷新后重试。');
  const current = ctx.projectBindings.projectFor(projectKey);
  if (current?.chatId) {
    await commandFeedback(ctx, '项目群已存在', '这个项目已经绑定项目群。进入项目群后，直接新建话题并发送需求即可开始 Codex 会话。', [
      { text: '查看会话', value: { cmd: 'project.sessions', arg: projectKey }, style: 'primary' },
    ]);
    return;
  }
  try {
    const isAssistant = project.kind === 'feishu-assistant';
    const created = await createBoundChat({
      channel: ctx.channel,
      name: `Codex · ${project.name}`,
      description: isAssistant
        ? 'Codex 飞书个人助理：Bridge 负责连接与上下文，Codex 负责理解和执行。'
        : `Codex 项目：${project.name}\n路径：${project.cwd}`,
      inviteOpenId: ctx.msg.senderId,
      threadMode: true,
    });
    ctx.projectBindings.registerProjects?.([project]);
    await ctx.projectBindings.bindProject(projectKey, created.chatId);
    const boundProject = ctx.projectBindings.projectFor(projectKey);
    if (boundProject) await showProjectWorkbench(ctx.channel, ctx.projectBindings, boundProject);
    await commandFeedback(ctx, '项目群已创建', `项目：**${project.name}**\n项目群已经准备好。进入新群后，直接新建话题并发送需求即可开始；“查看会话”用于恢复历史对话。`, [
      { text: '查看会话', value: { cmd: 'project.sessions', arg: projectKey }, style: 'primary' },
    ]);
  } catch (err) {
    await reply(ctx, `创建项目群失败：${err instanceof Error ? err.message : String(err)}\n请确认应用有创建群和话题群权限。`);
  }
}

async function handleSessions(_args: string, ctx: CommandContext): Promise<void> {
  if (!ctx.projectBindings || !ctx.agent.listSessions) {
    await reply(ctx, '当前 Bridge 尚未启用 Codex 项目模式。');
    return;
  }
  const project = ctx.projectBindings.findProjectByChat(ctx.msg.chatId);
  if (!project) {
    await sendCommandCard(ctx, welcomeCard());
    return;
  }
  await commandProgress(ctx, '正在读取会话列表，请稍候。');
  const rawArgs = _args.trim();
  if (rawArgs === 'search' && !ctx.formValue) {
    await sendCommandCard(ctx, sessionSearchCard(project.name));
    return;
  }
  const searchTerm = rawArgs === 'search'
    ? normalizeFormText(ctx.formValue?.session_search)
    : rawArgs.startsWith('search ') ? rawArgs.slice(7).trim() : undefined;
  if (rawArgs === 'search' && !searchTerm) {
    await sendCommandCard(ctx, sessionSearchCard(project.name));
    return;
  }
  const cursor = rawArgs.startsWith('page ') ? rawArgs.slice(5).trim() : undefined;
  const page = ctx.agent.listSessionPage
    ? await ctx.agent.listSessionPage(project.cwd, cursor, searchTerm)
    : { sessions: await ctx.agent.listSessions(project.cwd) };
  await sendCommandCard(ctx, sessionsCard(project.name, page.sessions, page.nextCursor));
}

const TASK_PRESETS = [
  {
    id: 'review',
    name: '审查当前改动',
    description: '只检查问题，按严重性给出文件和行号，不直接修改文件。',
    prompt: '请审查当前未提交改动，按严重性列出问题，并给出文件与行号。不要直接修改文件。',
  },
  {
    id: 'test',
    name: '运行相关测试',
    description: '运行最小相关测试集，失败时先定位原因再修复。',
    prompt: '请运行与当前改动相关的最小测试集；如果失败，定位原因并修复，然后汇报测试结果。',
  },
  {
    id: 'check',
    name: '发布前检查',
    description: '检查类型、构建和关键测试，只汇报必要结论。',
    prompt: '请完成发布前检查：类型检查、构建和关键测试。只汇报必要结论；发现问题时修复并说明改动。',
  },
] as const;

async function handleTasks(_args: string, ctx: CommandContext): Promise<void> {
  if (!ctx.taskStore) {
    await reply(ctx, '任务中心尚未启用。');
    return;
  }
  await sendCommandCard(ctx, tasksCard(ctx.taskStore.list(20)));
}

async function handleTask(args: string, ctx: CommandContext): Promise<void> {
  if (!ctx.taskStore) {
    await reply(ctx, '任务中心尚未启用。');
    return;
  }
  const [action, taskId] = args.trim().split(/\s+/, 2);
  const target = taskId ? ctx.taskStore.get(taskId) : ctx.taskStore.latestForScope(ctx.scope);
  if (!target) {
    await reply(ctx, '没有找到这个任务。发送 `/tasks` 查看最近任务。');
    return;
  }
  if (action === 'stop') {
    const stopped = ctx.activeRuns.interrupt(target.scope);
    if (stopped) ctx.taskStore.finish(target.taskId, 'cancelled', { summary: '已从飞书停止任务。' });
    await commandFeedback(
      ctx,
      stopped ? '停止请求已发送' : '任务当前不在执行中',
      stopped ? '正在停止当前任务。' : `任务状态：${taskStatusLabel(target.status)}。`,
      [{ text: '返回任务', value: { cmd: 'tasks' }, style: 'primary' }],
    );
    return;
  }
  await sendCommandCard(ctx, taskDetailCard(target));
}

async function handlePreset(args: string, ctx: CommandContext): Promise<void> {
  const [action, presetId] = args.trim().split(/\s+/, 2);
  if (!action) {
    await sendCommandCard(ctx, presetsCard(TASK_PRESETS));
    return;
  }
  if (action !== 'use' || !presetId) {
    await reply(ctx, '用法：`/preset` 查看模板，或 `/preset use review` 使用模板。');
    return;
  }
  const preset = TASK_PRESETS.find((item) => item.id === presetId);
  if (!preset) {
    await reply(ctx, '没有找到这个模板，请发送 `/preset` 查看可用模板。');
    return;
  }
  if (!ctx.msg.threadId || !ctx.pending) {
    await reply(ctx, '请进入一个 Codex 话题后使用任务模板。');
    return;
  }
  if (ctx.activeRuns.has(ctx.scope)) {
    await reply(ctx, '当前任务仍在执行，请等待完成后再使用模板。');
    return;
  }
  const synthetic: NormalizedMessage = {
    // The queued message is internal, but its id is later used as the
    // reply target when the agent run publishes progress and the result.
    // Keep the real Feishu message id from the card action; a generated id
    // is not a valid open_message_id for the Feishu API.
    messageId: ctx.msg.messageId,
    chatId: ctx.msg.chatId,
    chatType: ctx.msg.chatType,
    threadId: ctx.msg.threadId,
    rootId: ctx.msg.rootId,
    senderId: ctx.msg.senderId,
    senderName: ctx.msg.senderName,
    content: preset.prompt,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
  ctx.pending.push(ctx.scope, synthetic);
  await reply(ctx, `已下发“${preset.name}”，稍后会在当前话题执行。`);
}

function taskStatusLabel(status: TaskRecord['status']): string {
  const labels: Record<TaskRecord['status'], string> = {
    queued: '排队中',
    running: '执行中',
    waiting_approval: '等待确认',
    waiting_input: '等待输入',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已停止',
    stale: '需继续',
  };
  return labels[status];
}

async function handleSession(args: string, ctx: CommandContext): Promise<void> {
  if (!ctx.projectBindings || !ctx.agent.createSession || !ctx.agent.listSessions) {
    await reply(ctx, '当前 Bridge 尚未启用 Codex 项目模式。');
    return;
  }
  const project = ctx.projectBindings.findProjectByChat(ctx.msg.chatId);
  if (!project) return reply(ctx, '当前群还没有绑定项目，请先从“选择项目”开始。');
  await commandProgress(ctx, '正在打开会话并创建话题，请稍候。');
  const action = args.trim();
  let threadId: string;
  let title: string;
  if (action === 'new' || action === '') {
    const created = await ctx.agent.createSession(project.cwd);
    threadId = created.threadId;
    title = created.name ?? '新建会话';
  } else if (action.startsWith('open ')) {
    threadId = action.slice(5).trim();
    const found = (await ctx.agent.listSessions(project.cwd)).find((session) => session.threadId === threadId);
    if (!found) return reply(ctx, '没有找到这个会话，请刷新会话列表。');
    title = found.name ?? found.preview.slice(0, 40) ?? '未命名会话';
  } else if (action.startsWith('detail ')) {
    const threadIdToShow = action.slice(7).trim();
    const found = (await ctx.agent.listSessions(project.cwd)).find((session) => session.threadId === threadIdToShow);
    if (!found) return reply(ctx, '没有找到这个会话。');
    if (!ctx.agent.readSession || !ctx.fromCardAction) {
      return reply(ctx, `会话：**${found.name ?? '未命名'}**\n最近内容：${found.preview}\n状态：${sessionStatusText(found.status, found.activeFlags)}`);
    }
    const detail = await ctx.agent.readSession(threadIdToShow);
    await sendCommandCard(ctx, sessionDetailCard(project.name, detail));
    return;
  } else if (action.startsWith('archive ')) {
    const threadIdToArchive = action.slice(8).trim();
    const found = (await ctx.agent.listSessions(project.cwd)).find((session) => session.threadId === threadIdToArchive);
    if (!found) return reply(ctx, '没有找到这个会话，请刷新会话列表。');
    if (!ctx.agent.archiveSession) return reply(ctx, '当前 Codex 版本不支持归档会话。');
    await ctx.agent.archiveSession(threadIdToArchive);
    await commandFeedback(ctx, '会话已归档', `会话：**${found.name ?? found.preview.slice(0, 40) ?? '未命名会话'}**\n已从未归档列表中移除。`, [
      { text: '撤销归档', value: { cmd: 'session.unarchive', arg: threadIdToArchive }, style: 'primary' },
      { text: '查看会话', value: { cmd: 'sessions' }, style: 'primary' },
    ]);
    return;
  } else if (action.startsWith('unarchive ')) {
    const threadIdToRestore = action.slice(10).trim();
    if (!threadIdToRestore || !ctx.agent.unarchiveSession) return reply(ctx, '当前 Codex 版本不支持撤销归档。');
    let restored: import('../project/types').SessionSummary;
    try {
      restored = await ctx.agent.unarchiveSession(threadIdToRestore);
    } catch (err) {
      await commandFeedback(ctx, '撤销归档失败', operationError(err), []);
      return;
    }
    await commandFeedback(ctx, '已撤销归档', `会话：**${restored.name ?? restored.preview.slice(0, 40) ?? '未命名会话'}**\n已恢复到会话列表。`, [
      { text: '继续此会话', value: { cmd: 'session.open', arg: restored.threadId }, style: 'primary' },
      { text: '查看会话', value: { cmd: 'sessions' } },
    ]);
    return;
  } else if (action === 'review' || action.startsWith('review ')) {
    const target = action.slice(6).trim() || currentTopicThreadId(ctx);
    if (!target) return reply(ctx, '请在已连接的 Codex 话题中发起审查。');
    if (!ctx.agent.reviewSession) return reply(ctx, '当前 Codex 版本不支持自动审查。');
    try {
      await ctx.agent.reviewSession(target);
    } catch (err) {
      await commandFeedback(ctx, '代码审查启动失败', operationError(err), []);
      return;
    }
    await commandFeedback(ctx, '代码审查已启动', 'Codex 正在审查当前未提交改动。完成后可刷新进度查看结果。', [
      { text: '刷新进度', value: { cmd: 'sync' }, style: 'primary' },
    ]);
    return;
  } else if (action === 'compact' || action.startsWith('compact ')) {
    const target = action.slice(7).trim() || currentTopicThreadId(ctx);
    if (!target) return reply(ctx, '请在已连接的 Codex 话题中压缩上下文。');
    if (!ctx.agent.compactSession) return reply(ctx, '当前 Codex 版本不支持上下文压缩。');
    try {
      await ctx.agent.compactSession(target);
    } catch (err) {
      await commandFeedback(ctx, '上下文压缩启动失败', operationError(err), []);
      return;
    }
    await commandFeedback(ctx, '上下文压缩已启动', 'Codex 正在压缩当前会话历史，完成后仍会留在本话题。', [
      { text: '刷新进度', value: { cmd: 'sync' }, style: 'primary' },
    ]);
    return;
  } else if (action === 'fork' || action.startsWith('fork ')) {
    const sourceThreadId = action.slice(4).trim() || currentTopicThreadId(ctx);
    if (!sourceThreadId) return reply(ctx, '请在已连接的 Codex 话题中创建分支会话。');
    if (!ctx.agent.forkSession) return reply(ctx, '当前 Codex 版本不支持分支会话。');
    let forked: import('../project/types').SessionSummary;
    try {
      forked = await ctx.agent.forkSession(sourceThreadId, project.cwd);
    } catch (err) {
      await commandFeedback(ctx, '分支会话创建失败', operationError(err), []);
      return;
    }
    const source = (await ctx.agent.listSessions(project.cwd)).find((session) => session.threadId === sourceThreadId);
    const forkTitle = forked.name?.trim() || `${source?.name?.trim() || '当前会话'} · 分支`;
    await createSessionTopic(ctx, project, forked.threadId, forkTitle);
    return;
  } else {
    return handleSessions('', ctx);
  }

  const existing = ctx.projectBindings.findTopicByThread(threadId);
  if (existing) {
    await commandFeedback(ctx, '会话已经打开', '这个会话已经绑定了一个话题，请继续使用原话题。', [
      { text: '查看会话', value: { cmd: 'sessions' }, style: 'primary' },
    ]);
    return;
  }
  await createSessionTopic(ctx, project, threadId, title);
}

async function createSessionTopic(
  ctx: CommandContext,
  project: Project,
  threadId: string,
  title: string,
): Promise<void> {
  if (!ctx.projectBindings) throw new Error('项目绑定存储未启用');
  const root = await ctx.channel.send(ctx.msg.chatId, { card: topicWelcomeCard(project.name, title, project.cwd) });
  // `send()` returns the root message id (`om_...`), while topic messages
  // carry the separate Feishu thread id (`omt_...`). Persist the actual
  // thread id so inbound messages and card actions resolve the same binding.
  const topicId = await lookupMessageThreadId(ctx.channel, root.messageId) ?? root.messageId;
  await ctx.projectBindings.bindTopic({
    chatId: ctx.msg.chatId,
    topicId,
    projectKey: project.projectKey,
    codexThreadId: threadId,
    createdBy: ctx.msg.senderId,
    updatedAt: Date.now(),
  });
  await commandFeedback(ctx, '话题已创建', `会话：**${title}**\n项目群中已出现以“项目名 · 会话名”命名的新话题。进入该话题后，直接发送需求即可。`, [
    { text: '查看会话', value: { cmd: 'sessions' }, style: 'primary' },
  ]);
}

function currentTopicThreadId(ctx: CommandContext): string | undefined {
  return ctx.msg.threadId
    ? ctx.projectBindings?.findTopic(ctx.msg.chatId, ctx.msg.threadId)?.codexThreadId
    : undefined;
}

function normalizeFormText(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  return text || undefined;
}

function operationError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sessionStatusText(status: string, activeFlags: string[] | undefined): string {
  if (activeFlags?.includes('waitingOnApproval')) return '等待确认';
  if (activeFlags?.includes('waitingOnUserInput')) return '等待输入';
  if (status === 'active') return '执行中';
  if (status === 'archived') return '已归档';
  return '空闲';
}

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function handleNewChat(rawName: string, ctx: CommandContext): Promise<void> {
  const sourceCwd = ctx.workspaces.cwdFor(ctx.scope);
  const name = rawName || defaultChatName();

  let created;
  try {
    created = await createBoundChat({
      channel: ctx.channel,
      name,
      inviteOpenId: ctx.msg.senderId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(ctx, `❌ 创建群失败：${msg}\n\n确认 bot 已开启 \`im:chat\` 权限。`);
    return;
  }

  // Inherit cwd from the originating chat so the new group starts in the
  // same workspace; otherwise it'll fall back to $HOME.
  if (sourceCwd) {
    ctx.workspaces.setCwd(created.chatId, sourceCwd);
  }

  // Welcome the user inside the new group with a hint about how to start.
  const welcome = sourceCwd
    ? `🎉 群已建好，cwd 继承自原群：\`${sourceCwd}\`\n\n@我 + 任意消息开始对话。`
    : '🎉 群已建好。\n\n@我 + 任意消息开始对话。';
  try {
    await ctx.channel.send(created.chatId, { markdown: welcome });
  } catch (err) {
    console.warn('[new-chat] welcome message failed:', err);
  }

  await reply(
    ctx,
    `✓ 已创建群 **${created.name}**，去新群里继续。`,
  );
}

async function handleCd(args: string, ctx: CommandContext): Promise<void> {
  const input = args.trim();
  if (!input) {
    await reply(ctx, '用法：`/cd <绝对路径>` 或 `/cd ~/xxx`');
    return;
  }
  if (!input.startsWith('/') && !input.startsWith('~')) {
    await reply(ctx, '请使用绝对路径，或 `~/xxx` 表示 home 下的子路径。');
    return;
  }
  const absolute = expandTilde(input);
  try {
    const st = await stat(absolute);
    if (!st.isDirectory()) {
      await reply(ctx, `路径不是目录：\`${absolute}\``);
      return;
    }
  } catch {
    await reply(ctx, `路径不存在：\`${absolute}\``);
    return;
  }
  if (getEnforceProjectRootSandbox(ctx.controls.cfg)) {
    const roots = getProjectRoots(ctx.controls.cfg);
    if (roots.length === 0 || !(await isWithinProjectRoots(absolute, roots))) {
      await reply(ctx, '安全策略不允许切换到项目根目录之外的路径，请先配置 `preferences.projectRoots`。');
      return;
    }
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, absolute);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切换 cwd 到 \`${absolute}\`\n（session 已重置）`);
}

async function handleWs(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? '';
  const name = parts.slice(1).join(' ').trim();
  switch (sub) {
    case '':
    case 'list':
      return handleWsList(ctx);
    case 'save':
      return handleWsSave(name, ctx);
    case 'use':
      return handleWsUse(name, ctx);
    case 'remove':
    case 'rm':
      return handleWsRemove(name, ctx);
    default:
      await reply(ctx, '用法：`/ws [list|save <name>|use <name>|remove <name>]`');
  }
}

async function handleWsList(ctx: CommandContext): Promise<void> {
  const named = ctx.workspaces.listNamed();
  const currentCwd = ctx.workspaces.cwdFor(ctx.scope);
  const card = workspacesCard(currentCwd, named);
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

async function handleWsSave(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws save <name>`');
    return;
  }
  const cwd = ctx.workspaces.cwdFor(ctx.scope);
  if (!cwd) {
    await reply(ctx, '当前 chat 未设置 cwd，先用 `/cd` 设置再保存。');
    return;
  }
  ctx.workspaces.saveNamed(name, cwd);
  await reply(ctx, `✓ 工作空间已保存：\`${name}\` → ${cwd}`);
}

async function handleWsUse(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws use <name>`');
    return;
  }
  const cwd = ctx.workspaces.getNamed(name);
  if (!cwd) {
    await reply(ctx, `未找到工作空间：\`${name}\``);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, cwd);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切换到 \`${name}\` (${cwd})\n（session 已重置）`);
}

async function handleWsRemove(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws remove <name>`');
    return;
  }
  if (!ctx.workspaces.removeNamed(name)) {
    await reply(ctx, `未找到工作空间：\`${name}\``);
    return;
  }
  await reply(ctx, `✓ 已删除工作空间：\`${name}\``);
}

async function readStatusModel(ctx: CommandContext, threadId?: string): Promise<StatusModelInfo | undefined> {
  if (ctx.agent.id !== 'codex' || !ctx.agent.readThreadModel) return undefined;
  if (!threadId) return {};
  try {
    const state = await ctx.agent.readThreadModel(threadId);
    if (!state.model) return { readFailed: true };
    const modelId = state.model;
    let displayName = modelId;
    if (ctx.agent.listModels) {
      try {
        const models = await ctx.agent.listModels({ includeHidden: true });
        const match = models.find((model) => model.model === modelId || model.id === modelId);
        if (match?.displayName) displayName = match.displayName;
      } catch (err) {
        log.warn('commands', 'status-model-list-failed', {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { displayName, effort: state.effort ?? undefined };
  } catch (err) {
    log.warn('commands', 'status-model-read-failed', {
      threadId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { readFailed: true };
  }
}

async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  const project = ctx.projectBindings?.findProjectByChat(ctx.msg.chatId);
  if (project) {
    const topic = ctx.msg.threadId ? ctx.projectBindings?.findTopic(ctx.msg.chatId, ctx.msg.threadId) : undefined;
    const model = await readStatusModel(ctx, topic?.codexThreadId);
    await sendCommandCard(ctx, statusCard({
        cwd: project.cwd,
        sessionId: topic?.codexThreadId,
        sessionStale: false,
        agentName: ctx.agent.displayName,
        scope: 'project',
        chatMode: ctx.chatMode,
        projectName: project.name,
        sessionTitle: topic ? '已绑定会话' : undefined,
        hideInternalIds: true,
        model,
      }));
    return;
  }
  const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir();
  const sess = ctx.sessions.getRaw(ctx.scope);
  const model = await readStatusModel(ctx, sess?.sessionId);
  const card = statusCard({
    cwd,
    sessionId: sess?.sessionId,
    sessionStale: Boolean(sess && sess.cwd !== cwd),
    agentName: ctx.agent.displayName,
    scope: ctx.scope,
    chatMode: ctx.chatMode,
    model,
  });
  await sendCommandCard(ctx, card);
}

async function handleSync(args: string, ctx: CommandContext): Promise<void> {
  const binding = ctx.msg.threadId ? ctx.projectBindings?.findTopic(ctx.msg.chatId, ctx.msg.threadId) : undefined;
  if (!binding || !ctx.agent.readSession || !ctx.projectBindings || !ctx.sessionSync) {
    await reply(ctx, '当前消息不在已连接的 Codex 话题中，请进入对应话题后再刷新。');
    return;
  }
  const project = ctx.projectBindings.projectFor(binding.projectKey);
  if (!project) {
    await reply(ctx, '没有找到这个话题绑定的项目，请重新打开项目列表。');
    return;
  }

  const autoMode = args.trim() === 'auto';
  const stopMode = args.trim() === 'stop';
  if (stopMode) ctx.sessionSync.stop(ctx.scope);

  const update = async (detail: import('../project/types').SessionDetail): Promise<void> => {
    const running = ctx.sessionSync?.isRunning(ctx.scope) ?? false;
    const card = sessionProgressCard(project.name, detail, running);
    if (ctx.fromCardAction) {
      await ctx.channel.updateCard(ctx.msg.messageId, card);
    } else {
      await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId, replyInThread: true });
    }
  };
  const read = async (): Promise<import('../project/types').SessionDetail> => {
    const current = ctx.msg.threadId ? ctx.projectBindings?.findTopic(ctx.msg.chatId, ctx.msg.threadId) : undefined;
    if (!current) throw new Error('话题绑定已不存在');
    return ctx.agent.readSession!(current.codexThreadId);
  };

  try {
    const detail = await ctx.sessionSync.refresh(read, update);
    reconcileTaskFromSession(ctx.taskStore, ctx.scope, detail);
    if (autoMode) {
      ctx.sessionSync.start(ctx.scope, read, update, {
        intervalMs: 5_000,
        onError: (error) => log.warn('session-sync', 'poll-failed', { scope: ctx.scope, error: String(error) }),
      });
      await update(detail);
    }
  } catch (error) {
    log.fail('session-sync', error, { scope: ctx.scope });
    await reply(ctx, `同步 Codex 进度失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function reconcileTaskFromSession(
  taskStore: JsonTaskStore | undefined,
  scope: string,
  detail: import('../project/types').SessionDetail,
): void {
  const task = taskStore?.latestForScope(scope);
  if (!task) return;
  if (!taskStore) return;
  const status = detail.activeFlags?.includes('waitingOnApproval')
    ? 'waiting_approval'
    : detail.activeFlags?.includes('waitingOnUserInput')
      ? 'waiting_input'
      : detail.status === 'active'
        ? 'running'
        : task.status;
  taskStore.update(task.taskId, {
    codexThreadId: detail.threadId,
    status,
    summary: detail.preview,
    stage: status === 'running' ? 'Codex 会话执行中' : undefined,
  });
}

async function handleStop(_args: string, ctx: CommandContext): Promise<void> {
  const ok = ctx.activeRuns.interrupt(ctx.scope);
  log.info('command', 'stop', { interrupted: ok });
  await commandFeedback(
    ctx,
    ok ? '停止请求已发送' : '当前没有执行中的任务',
    ok ? '正在等待 Codex 停止当前任务。' : '当前话题没有正在执行的任务，可以直接发送新的需求。',
    [{ text: '刷新进度', value: { cmd: 'sync' }, style: 'primary' }],
  );
}

async function handleTimeout(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim().toLowerCase();
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const globalMinutes = globalMs ? Math.round(globalMs / 60_000) : 0;
  const formatGlobal = (): string =>
    globalMinutes > 0 ? `${globalMinutes} 分钟` : '未启用';

  // /timeout — show effective value + source
  if (!trimmed) {
    const scopeMinutes = ctx.sessions.getIdleTimeoutMinutes(ctx.scope);
    const usage =
      '\n\n用法:\n- `/timeout 15` 当前 session 设 15 分钟\n- `/timeout off` 当前 session 关闭探活\n- `/timeout default` 清除 session 覆盖,回退全局\n\n_注:`/new` 会清掉当前 session 的覆盖,回到全局_';
    if (scopeMinutes !== undefined) {
      const effective =
        scopeMinutes > 0 ? `${scopeMinutes} 分钟` : '已关闭（当前 session）';
      await reply(ctx, `⏱ 当前 session 探活:${effective}\n全局默认:${formatGlobal()}${usage}`);
      return;
    }
    await reply(ctx, `⏱ 当前 session 探活:跟随全局(${formatGlobal()})${usage}`);
    return;
  }

  if (trimmed === 'default') {
    const cleared = ctx.sessions.clearIdleTimeoutOverride(ctx.scope);
    log.info('command', 'timeout-clear', { scope: ctx.scope, cleared });
    await reply(
      ctx,
      cleared
        ? `✅ 已清除 session 覆盖,回退到全局(${formatGlobal()})。`
        : `当前 session 本来就没设过覆盖,跟随全局(${formatGlobal()})。`,
    );
    return;
  }

  if (trimmed === 'off' || trimmed === '0') {
    ctx.sessions.setIdleTimeoutMinutes(ctx.scope, 0);
    log.info('command', 'timeout-off', { scope: ctx.scope });
    await reply(ctx, '✅ 已关闭当前 session 的探活。');
    return;
  }

  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1 || n > 120) {
    await reply(ctx, '❌ 用法:`/timeout <1-120>` / `/timeout off` / `/timeout default`');
    return;
  }
  ctx.sessions.setIdleTimeoutMinutes(ctx.scope, n);
  log.info('command', 'timeout-set', { scope: ctx.scope, minutes: n });
  await reply(ctx, `✅ 当前 session 探活已设为 ${n} 分钟。`);
}

async function handlePs(_args: string, ctx: CommandContext): Promise<void> {
  const live = readAndPrune();
  log.info('command', 'ps', { count: live.length });
  if (live.length === 0) {
    await reply(ctx, '当前没有 bot 在运行(理论上不可能,你正在跟其中之一对话…)');
    return;
  }

  const rows: string[] = [
    '| # | ID | Bot | 启动 |',
    '|---|---|---|---|',
  ];
  for (const [idx, e] of live.entries()) {
    const ago = formatAgo(Date.now() - new Date(e.startedAt).getTime());
    const me = e.id === ctx.controls.processId ? ' ← 当前正在回复' : '';
    const bot = e.botName ? `${e.botName} (\`${e.appId}\`)` : `\`${e.appId}\``;
    rows.push(`| ${idx + 1} | \`${e.id}\`${me} | ${bot} | ${ago} |`);
  }
  const body = [
    `🧭 **当前有 ${live.length} 个 bot 在运行**`,
    '',
    rows.join('\n'),
    '',
    '用 `/exit <id|#>` 关掉某一个;`/exit ' + ctx.controls.processId + '` 关掉正在回复你的这个 bot。',
  ].join('\n');
  await reply(ctx, body);
}

async function handleExit(args: string, ctx: CommandContext): Promise<void> {
  const target = args.trim();
  if (!target) {
    await reply(
      ctx,
      '用法:`/exit <id|#>` —— `id` 是 `/ps` 显示的短 id,`#` 是序号。\n' +
        `当前正在回复你的是 \`${ctx.controls.processId}\`。`,
    );
    return;
  }
  const entry = resolveTarget(target);
  if (!entry) {
    await reply(ctx, `❌ 没找到匹配的 bot:\`${target}\`。发 \`/ps\` 看可选目标。`);
    return;
  }

  // Targeting ourselves — graceful disconnect + process.exit(0) via controls.
  if (entry.id === ctx.controls.processId) {
    log.info('command', 'exit-self', { id: entry.id });
    await reply(ctx, `👋 即将关闭当前 bot \`${entry.id}\`,再见。`);
    // Detach to give the reply send a chance to complete before we tear
    // down. controls.exit() awaits disconnect then process.exit().
    void (async () => {
      await new Promise((r) => setTimeout(r, 300));
      await ctx.controls.exit().catch(() => {});
    })();
    return;
  }

  // Targeting another process — SIGTERM and report back. We can't easily
  // wait for it to die without blocking the command handler; trust the
  // target's own signal handler to unregister + exit.
  log.info('command', 'exit-other', { id: entry.id, pid: entry.pid });
  try {
    process.kill(entry.pid, 'SIGTERM');
  } catch (err) {
    await reply(ctx, `❌ 关掉 bot \`${entry.id}\` 失败:${(err as Error).message}`);
    return;
  }
  // Brief grace before reporting.
  await new Promise((r) => setTimeout(r, 500));
  const stillAlive = isAlive(entry.pid);
  if (stillAlive) {
    await reply(
      ctx,
      `📨 已请求关闭 \`${entry.id}\`,但还在收尾。再发 \`/ps\` 复查一下。`,
    );
  } else {
    await reply(ctx, `✓ 已关闭 bot \`${entry.id}\`。`);
  }
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s 前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m 前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h 前`;
  return `${Math.floor(ms / 86_400_000)}d 前`;
}

async function handleReconnect(_args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'reconnect');
  await reply(ctx, '⏳ 正在重连…');
  try {
    await ctx.controls.restart();
    log.info('command', 'reconnect-ok');
  } catch (err) {
    log.fail('command', err, { step: 'reconnect' });
    await reply(ctx, `❌ 重连失败:${err instanceof Error ? err.message : String(err)}`);
  }
}

const DOCTOR_INSTRUCTIONS = `你是 feishu-omp-bridge 的诊断助理。下面会给你两段输入:
1. 用户的故障描述
2. 最近的运行日志(JSON line 格式,旧→新)

日志字段含义:
- ts: ISO 时间戳
- level: info | warn | error
- phase: 模块阶段。常见值: ws(WebSocket), intake(消息入站), queue(去抖队列), flush(批处理), media(附件下载), prompt(prompt 组装), session(会话), agent(OMP 子进程), card(卡片渲染), comment(文档评论), cardAction(卡片回调), command(斜杠命令), sdk(飞书 SDK 内部)
- event: enter | exit | transition | fail | 各 phase 自定义事件
- traceId: 同一逻辑操作的串联 ID(同一条消息的多个日志会共享)
- chatId: 飞书聊天 ID(用 chatId 反查相关日志)

回复严格三段,markdown 标题用二级:

## 可能原因
1-3 条最有可能的原因,每条带具体日志的时间戳或 traceId 引用。

## 关键日志片段
3-5 条最重要的日志,直接贴 JSON 行原文,后跟一行说明为什么重要。

## 建议下一步
1-3 条具体可执行的动作(检查 X / 重启 Y / 等待 Z 之类)。

如果日志里没有任何相关线索,直接说"日志不足以判断,建议:"再列动作。回复要直接,不寒暄。`;

function buildDoctorPrompt(description: string, logs: string): string {
  const desc = description.trim() || '(用户没写描述,自行从日志找最显眼的异常。)';
  return `${DOCTOR_INSTRUCTIONS}

---

用户故障描述:
${desc}

最近的运行日志:
\`\`\`
${logs}
\`\`\``;
}

async function handleDoctor(args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'doctor', {
    hasDescription: args.trim().length > 0,
    chatMode: ctx.chatMode,
  });
  // Killing any in-flight run on this chat — /doctor is a "I'm stuck" call.
  ctx.activeRuns.interrupt(ctx.scope);

  const rawLogs = await readRecentLogs({ maxBytes: 60_000 });
  if (!rawLogs.trim()) {
    await ctx.channel.send(
      ctx.msg.chatId,
      { text: '没有找到日志文件 — bridge 可能刚启动或日志目录不可写。' },
      { replyTo: ctx.msg.messageId },
    );
    return;
  }
  // Scrub identifying / credential material before the logs (a) reach
  // model provider via the agent prompt, and (b) end up in any card payload
  // Lark may cache server-side.
  const logs = sanitizeLogsForDoctor(rawLogs);

  // In group / topic chats other members would see the result card. Ack
  // in-channel, deliver the actual analysis privately to the operator's
  // open_id (Lark auto-opens the p2p chat with the bot).
  const isP2p = ctx.chatMode === 'p2p';
  if (!isP2p) {
    await reply(ctx, '🔍 已收到诊断请求，分析结果将私信发给你。');
  }

  const prompt = buildDoctorPrompt(args, logs);
  const run = ctx.agent.run({
    prompt,
    cwd: homedir(),
    stopGraceMs: getAgentStopGraceMs(ctx.controls.cfg),
  });
  const handle = ctx.activeRuns.register(ctx.scope, run);

  try {
    if (isP2p) {
      // Streaming card path — operator is the only viewer in p2p.
      await ctx.channel.stream(
        ctx.msg.chatId,
        {
          card: {
            initial: renderCard(initialState),
            producer: async (ctrl) => {
              let state: RunState = initialState;
              const flush = (): Promise<void> => ctrl.update(renderCard(state));
              for await (const evt of handle.run.events) {
                if (handle.interrupted) break;
                // /doctor runs are session-less: skip 'system' so we don't
                // persist a doctor's sessionId over the user's real session.
                if (evt.type === 'system') continue;
                if (evt.type === 'usage') {
                  if (evt.costUsd !== undefined) {
                    log.info('agent', 'usage', { step: 'doctor', costUsd: Number(evt.costUsd.toFixed(4)) });
                  }
                  continue;
                }
                state = reduce(state, evt);
                await flush();
                // Don't wait for stdout to close — OMP can have a brief
                // post-terminal cleanup tail, which would leave the for-await stuck.
                if (state.terminal !== 'running') break;
              }
              state = handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
              await flush();
              await handle.run.stop();
            },
          },
        },
        { replyTo: ctx.msg.messageId },
      );
    } else {
      // Group / topic: buffer to completion, then DM the final card to the
      // operator. No live streaming — the group should see nothing past the
      // ack reply above.
      let state: RunState = initialState;
      for await (const evt of handle.run.events) {
        if (handle.interrupted) break;
        if (evt.type === 'system') continue;
        if (evt.type === 'usage') {
          if (evt.costUsd !== undefined) {
            log.info('agent', 'usage', { step: 'doctor', costUsd: Number(evt.costUsd.toFixed(4)) });
          }
          continue;
        }
        state = reduce(state, evt);
        if (state.terminal !== 'running') break;
      }
      state = handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
      await handle.run.stop();
      // Send a one-shot interactive card by open_id. Lark routes it to the
      // user's p2p chat with the bot (auto-creates it if needed); other
      // group members never see this payload.
      await ctx.channel.rawClient.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: ctx.msg.senderId,
          msg_type: 'interactive',
          content: JSON.stringify(renderCard(state)),
        },
      });
    }
  } catch (err) {
    log.fail('command', err, { step: 'doctor' });
  } finally {
    ctx.activeRuns.unregister(ctx.scope, run);
  }
}

async function handleHelp(_args: string, ctx: CommandContext): Promise<void> {
  const card = helpCard();
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

// ─── /account ─────────────────────────────────────────────────────────────

async function handleAccount(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] ?? '';
  switch (sub) {
    case '':
      return showCurrent(ctx);
    case 'change':
      return showForm(ctx);
    case 'submit':
      return submitAccount(ctx);
    case 'cancel':
      return cancelAccount(ctx);
    default:
      await reply(ctx, '用法：`/account` 或 `/account change`');
  }
}

async function showCurrent(ctx: CommandContext): Promise<void> {
  // Current-status card has only a [更换凭据] button — never updated in-place,
  // so an inline card is sufficient (and avoids creating a managed card we'd
  // never re-touch).
  const card = accountCurrentCard({
    appId: ctx.controls.cfg.accounts.app.id,
    botName: ctx.channel.botIdentity?.name,
    tenant: ctx.controls.cfg.accounts.app.tenant,
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

async function showForm(ctx: CommandContext): Promise<void> {
  const card = accountFormCard({ initialTenant: ctx.controls.cfg.accounts.app.tenant });
  if (ctx.fromCardAction) {
    await recallMessage(ctx, ctx.msg.messageId);
  }
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card);
}

async function cancelAccount(ctx: CommandContext): Promise<void> {
  // Cancel = remove the form card. No follow-up message.
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
}

// Lark's client holds a local "form just submitted" state for a short
// window after the click that overrides any cardkit.card.update we issue.
// We always wait at least this long before flipping the form card to its
// terminal (success/failure) state. Empirically ~1s is enough; less than
// that and the update gets reverted to the form's pre-submit state.
const FORM_SETTLE_MS = 1000;

async function submitAccount(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const appId = String(fv.app_id ?? '').trim();
  const appSecret = String(fv.app_secret ?? '').trim();
  const tenant = (fv.tenant === 'lark' ? 'lark' : 'feishu') as TenantBrand;

  const formMsgId = ctx.msg.messageId;
  const channel = ctx.channel;
  const configPath = ctx.controls.configPath;
  const restart = ctx.controls.restart;

  // CRITICAL: detach the work from the cardAction handler. Lark's client
  // keeps the form locked while the handler is pending — if we await the
  // 2s settle window inline, the lock holds, and the moment we return the
  // client snaps the card back to its cached form state (overwriting any
  // update we made). Returning immediately lets the lock release; the
  // delayed updateManagedCard then sticks.
  const chatId = ctx.msg.chatId;
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    // Success path: in-place update. The card never accepts another submit
    // (success card has no form), so this is fine.
    const finishSuccess = async (card: object): Promise<void> => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, card).catch((err) =>
        console.warn('[account] form update failed:', err),
      );
      forgetManagedCard(formMsgId);
    };

    // Failure path: leave the old form card as a static "❌ 校验失败" record
    // (in-place update to a non-form card so it stops responding to clicks),
    // then post a fresh managed form card below for retry. We can't reuse
    // the original card_id for the retry form because Lark's client locks
    // form interactions on it once submitted — even a re-rendered form on
    // the same card_id no longer fires cardActions.
    const finishFailure = async (errorMessage: string): Promise<void> => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, accountFailureCard(errorMessage))
        .catch((err) => console.warn('[account] mark old form failed:', err));
      forgetManagedCard(formMsgId);
      // Don't prefill the secret on retry — pre-filled secrets can get
      // echoed back into the card payload and may persist in Lark's
      // server-side card cache. Keep appId prefilled (non-sensitive).
      const retry = accountFormCard({
        initialTenant: tenant,
        prefillAppId: appId,
      });
      await sendManagedCard(channel, chatId, retry).catch((err) =>
        console.warn('[account] post retry form failed:', err),
      );
    };

    if (!appId || !appSecret) {
      await finishFailure('App ID 或 App Secret 为空');
      return;
    }

    const result = await validateAppCredentials(appId, appSecret, tenant);
    if (!result.ok) {
      await finishFailure(result.reason ?? 'unknown');
      return;
    }

    // Encrypted-at-rest path: store the plaintext secret in the AES keystore,
    // and write config.json with an exec-provider SecretRef instead of the
    // raw secret. lark-cli's `config bind --source lark-channel` reads the
    // same SecretRef and goes through the exec protocol to retrieve the
    // plaintext into its own OS keychain — no plaintext on disk.
    let newCfg: AppConfig;
    try {
      newCfg = await buildEncryptedAccountConfig(
        appId,
        tenant,
        ctx.controls.cfg.preferences,
      );
      await setSecret(secretKeyForApp(appId), appSecret);
      await saveConfig(newCfg, configPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await finishFailure(`保存凭据失败：${msg}`);
      return;
    }

    await finishSuccess(accountSuccessCard({ appId, botName: result.botName, tenant }));

    // Give the user 1.5s to read the success state before we tear down the
    // WS and reconnect with new credentials.
    setTimeout(() => {
      void restart().catch((err) => {
        console.error('[account] restart failed:', err);
        process.exit(1);
      });
    }, 1500);
  })();
}

async function recallMessage(ctx: CommandContext, messageId: string): Promise<void> {
  try {
    await ctx.channel.rawClient.im.v1.message.delete({
      path: { message_id: messageId },
    });
  } catch (err) {
    console.warn('[recall failed]', err);
  }
}

// ────────────── /config — preferences form ──────────────

async function handleConfig(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] ?? '';
  switch (sub) {
    case '':
      return showConfigForm(ctx);
    case 'submit':
      return submitConfig(ctx);
    case 'cancel':
      return cancelConfig(ctx);
    default:
      await reply(ctx, '用法:`/config`');
  }
}

async function showConfigForm(ctx: CommandContext): Promise<void> {
  const ms = getRunIdleTimeoutMs(ctx.controls.cfg);
  const access = ctx.controls.cfg.preferences?.access ?? {};
  const card = configFormCard({
    messageReply: getMessageReplyMode(ctx.controls.cfg),
    showToolCalls: getShowToolCalls(ctx.controls.cfg),
    maxConcurrentRuns: getMaxConcurrentRuns(ctx.controls.cfg),
    runIdleTimeoutMinutes: ms ? Math.round(ms / 60_000) : 0,
    requireMentionInGroup: getRequireMentionInGroup(ctx.controls.cfg),
    allowedUsers: (access.allowedUsers ?? []).join(', '),
    allowedChats: (access.allowedChats ?? []).join(', '),
    admins: (access.admins ?? []).join(', '),
  });
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card);
}

async function cancelConfig(ctx: CommandContext): Promise<void> {
  if (ctx.fromCardAction) {
    const formMsgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await updateManagedCard(ctx.channel, formMsgId, configCancelledCard()).catch((err) =>
        log.warn('command', 'config-cancel-update-failed', { err: String(err) }),
      );
      forgetManagedCard(formMsgId);
    })();
  }
}

async function submitConfig(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const rawReply = String(fv.message_reply ?? '').trim();
  const messageReply: MessageReplyMode =
    rawReply === 'markdown' || rawReply === 'text' || rawReply === 'card'
      ? (rawReply as MessageReplyMode)
      : 'card';
  const rawTools = String(fv.show_tool_calls ?? '').trim();
  const showToolCalls = rawTools !== 'hide';
  // Parse max_concurrent_runs; invalid input falls back to current value.
  const rawMaxCC = String(fv.max_concurrent_runs ?? '').trim();
  const parsedMaxCC = Number(rawMaxCC);
  const maxConcurrentRuns =
    Number.isFinite(parsedMaxCC) && parsedMaxCC >= 1
      ? Math.min(50, Math.floor(parsedMaxCC))
      : getMaxConcurrentRuns(ctx.controls.cfg);
  // Parse run_idle_timeout_minutes. 0 disables; otherwise clamp 1-120.
  // Empty string keeps current value.
  const rawIdle = String(fv.run_idle_timeout_minutes ?? '').trim();
  const currentIdleMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const currentIdleMinutes = currentIdleMs ? Math.round(currentIdleMs / 60_000) : 0;
  let runIdleTimeoutMinutes: number;
  if (rawIdle === '') {
    runIdleTimeoutMinutes = currentIdleMinutes;
  } else {
    const parsedIdle = Number(rawIdle);
    if (!Number.isFinite(parsedIdle) || parsedIdle < 0) {
      runIdleTimeoutMinutes = currentIdleMinutes;
    } else if (parsedIdle === 0) {
      runIdleTimeoutMinutes = 0;
    } else {
      runIdleTimeoutMinutes = Math.min(120, Math.max(1, Math.floor(parsedIdle)));
    }
  }
  // Parse require_mention_in_group. Empty / unexpected keeps current.
  const rawRequireMention = String(fv.require_mention_in_group ?? '').trim();
  let requireMentionInGroup: boolean;
  if (rawRequireMention === 'yes') requireMentionInGroup = true;
  else if (rawRequireMention === 'no') requireMentionInGroup = false;
  else requireMentionInGroup = getRequireMentionInGroup(ctx.controls.cfg);

  // Parse access lists. Comma-separated; trim each, drop empties, dedupe.
  // Empty list = unrestricted (back-compat).
  const parseList = (raw: unknown): string[] => {
    return [...new Set(
      String(raw ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )];
  };
  const allowedUsers = parseList(fv.allowed_users);
  const allowedChats = parseList(fv.allowed_chats);
  const admins = parseList(fv.admins);

  // Self-lockout guard: if the submitter sets a non-empty admins list that
  // doesn't include themselves, they immediately lose the ability to reopen
  // /config. Refuse the submit and tell them what's wrong.
  if (admins.length > 0 && !admins.includes(ctx.msg.senderId)) {
    log.warn('command', 'config-lockout-refused', {
      kind: 'admins',
      sender: ctx.msg.senderId.slice(-6),
      proposedAdmins: admins.length,
    });
    await reply(
      ctx,
      `❌ 拒绝提交:你设置了非空的管理员列表,但其中不包含你自己的 open_id (\`${ctx.msg.senderId}\`)。这会立即把你自己锁出 /config。请把自己的 open_id 加进去再提交。`,
    );
    return;
  }

  // Symmetrical guard for chat allowlist: if the submitter restricts chats
  // but the chat they're currently in isn't on the list, every message
  // (including the next /config) is silently dropped at intake. Common
  // mistake: filling in *another* chat's id and forgetting the current one.
  //
  // Skipped for p2p: `allowedChats` is group-only (see intakeMessage), so
  // submitting from a DM never locks the submitter out regardless of the
  // chat list contents. Using `chatMode` not `msg.chatType` because card
  // submissions arrive with a synthesized msg that always has chatType='p2p'.
  if (
    ctx.chatMode !== 'p2p' &&
    allowedChats.length > 0 &&
    !allowedChats.includes(ctx.msg.chatId)
  ) {
    log.warn('command', 'config-lockout-refused', {
      kind: 'chats',
      currentChat: ctx.msg.chatId.slice(-6),
      proposedChats: allowedChats.length,
    });
    await reply(
      ctx,
      `❌ 拒绝提交:你设置了非空的群白名单,但其中不包含当前会话的 chat_id (\`${ctx.msg.chatId}\`)。提交后这个会话的消息会被 intake 静默丢弃,bot 不再响应。要么把当前 chat_id 加进白名单,要么清空"群白名单"留待空(=所有会话都响应)。`,
    );
    return;
  }

  const formMsgId = ctx.msg.messageId;
  const channel = ctx.channel;
  const configPath = ctx.controls.configPath;

  // Detach: same reason as account submit — Lark's client locks the form
  // while the cardAction handler is running. Wait out FORM_SETTLE_MS *after*
  // returning so the in-place card update sticks.
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    // In-place mutation — the cfg object is shared by reference with
    // runAgentBatch's reads, so this takes effect on the next message.
    ctx.controls.cfg.preferences = {
      ...(ctx.controls.cfg.preferences ?? {}),
      messageReply,
      // Mark the messageReply value as living in the new (post-0.1.27)
      // semantic — `text` now means real plain text, not the lightweight
      // markdown card. Set unconditionally on every submit so a user who
      // explicitly picks any option gets out of the legacy-coerce path.
      messageReplyMigrated: true,
      showToolCalls,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      // Empty arrays serialize fine but read identically to omitted ones
      // (isUserAllowed / isAdmin both treat length===0 as unrestricted).
      access: {
        allowedUsers,
        allowedChats,
        admins,
        ...(ctx.controls.cfg.preferences?.access?.projectUsers
          ? { projectUsers: ctx.controls.cfg.preferences.access.projectUsers }
          : {}),
      },
    };

    try {
      await saveConfig(ctx.controls.cfg, configPath);
    } catch (err) {
      log.fail('command', err, { step: 'config.save' });
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, configCancelledCard()).catch(() => {});
      forgetManagedCard(formMsgId);
      return;
    }

    log.info('command', 'config-saved', {
      messageReply,
      showToolCalls,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      allowedUsersCount: allowedUsers.length,
      allowedChatsCount: allowedChats.length,
      adminsCount: admins.length,
    });
    await waitForSettle();
    await updateManagedCard(
      channel,
      formMsgId,
      configSavedCard({
        messageReply,
        showToolCalls,
        maxConcurrentRuns,
        runIdleTimeoutMinutes,
        requireMentionInGroup,
        allowedUsers: allowedUsers.join(', '),
        allowedChats: allowedChats.join(', '),
        admins: admins.join(', '),
      }),
    ).catch((err) =>
      log.warn('command', 'config-save-update-failed', { err: String(err) }),
    );
    forgetManagedCard(formMsgId);
  })();
}
