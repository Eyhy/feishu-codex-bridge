import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../bot/active-runs';
import type { CommandContext } from './index';
import { runCommandHandler, tryHandleCommand } from './index';
import { JsonProjectBindingStore } from '../project/store';
import type { Project } from '../project/types';
import type { SessionSummary } from '../project/types';
import { SessionStore } from '../session/store';
import { WorkspaceStore } from '../workspace/store';
import { SessionSyncManager } from '../session/sync';

const project: Project = {
  projectKey: 'local::/tmp/demo',
  name: 'demo',
  cwd: '/tmp/demo',
  hostId: 'local',
};

function context(channel: unknown, bindings: JsonProjectBindingStore, content = ''): CommandContext {
  return {
    channel: channel as CommandContext['channel'],
    msg: {
      messageId: 'message-1', chatId: 'chat-dm', chatType: 'p2p', senderId: 'user-1',
      senderName: '用户', content, rawContentType: 'text', resources: [], mentions: [],
      mentionAll: false, mentionedBot: false, createTime: Date.now(),
    },
    scope: 'chat-dm',
    chatMode: 'p2p',
    sessions: new SessionStore(join('/tmp', `feishu-command-test-${Date.now()}.json`)),
    workspaces: new WorkspaceStore(join('/tmp', `feishu-workspace-test-${Date.now()}.json`)),
    agent: { id: 'codex', displayName: 'Codex', isAvailable: async () => true, run: vi.fn() } as never,
    activeRuns: new ActiveRuns(),
    controls: {
      cfg: { accounts: { app: { id: 'app-1', secret: 'secret', tenant: 'feishu' } } },
      configPath: '/tmp/config.json', processId: 'process-1',
      restart: async () => {}, exit: async () => {},
    },
    projectCatalog: { list: async () => [project], get: async (key: string) => key === project.projectKey ? project : undefined },
    projectBindings: bindings,
  };
}

describe('Codex project command workflow', () => {
  it('maps Chinese shortcut words to the project card', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    bindings.registerProjects([project]);
    const ctx = context({ send }, bindings, '项目');
    await expect(tryHandleCommand(ctx)).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith('chat-dm', { card: expect.any(Object) }, { replyTo: 'message-1' });
  });

  it('leaves natural-language shortcuts inside project topics for Codex', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    bindings.registerProjects([project]);
    await bindings.bindProject(project.projectKey, 'chat-project');
    const ctx = context({ send }, bindings, '状态');
    ctx.msg.chatId = 'chat-project';
    ctx.msg.chatType = 'group';
    ctx.msg.threadId = 'topic-native';
    ctx.chatMode = 'group';

    await expect(tryHandleCommand(ctx)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('updates the clicked project card instead of sending a duplicate card', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const updateCard = vi.fn().mockResolvedValue(undefined);
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    bindings.registerProjects([project]);
    const ctx = context({ send, updateCard }, bindings);
    ctx.fromCardAction = true;

    await runCommandHandler('projects', '', ctx);

    expect(updateCard).toHaveBeenCalledWith('message-1', expect.objectContaining({ header: expect.any(Object) }));
    expect(send).not.toHaveBeenCalled();
  });

  it('does not create a second project group after a repeated click', async () => {
    const create = vi.fn().mockResolvedValue({ data: { chat_id: 'chat-project' } });
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    bindings.registerProjects([project]);
    const channel = { rawClient: { im: { v1: { chat: { create } } } }, send };
    const ctx = context(channel, bindings);
    await runCommandHandler('project', `open ${project.projectKey}`, ctx);
    await runCommandHandler('project', `open ${project.projectKey}`, ctx);
    expect(create).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('chat-dm', expect.objectContaining({ markdown: expect.stringContaining('已经绑定') }), expect.any(Object));
  });

  it('orders projects by their latest non-archived Codex session', async () => {
    const older: Project = { projectKey: 'local::/tmp/older', name: 'older', cwd: '/tmp/older', hostId: 'local' };
    const recent: Project = { projectKey: 'local::/tmp/recent', name: 'recent', cwd: '/tmp/recent', hostId: 'local' };
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    const ctx = context({ send }, bindings, '项目');
    ctx.projectCatalog = {
      list: async () => [older, recent],
      get: async (key: string) => [older, recent].find((item) => item.projectKey === key),
    };
    ctx.agent = {
      ...ctx.agent,
      listRecentSessions: async (): Promise<SessionSummary[]> => [
        { threadId: 'recent-thread', preview: '最近会话', cwd: recent.cwd, status: 'idle', updatedAt: 200 },
        { threadId: 'archived-thread', preview: '归档会话', cwd: older.cwd, status: 'archived', updatedAt: 300 },
        { threadId: 'old-thread', preview: '旧会话', cwd: older.cwd, status: 'idle', updatedAt: 100 },
      ],
    };

    await runCommandHandler('projects', '', ctx);

    const cardText = JSON.stringify(send.mock.calls[0]?.[1]?.card);
    expect(cardText.indexOf('recent')).toBeGreaterThanOrEqual(0);
    expect(cardText.indexOf('older')).toBeGreaterThanOrEqual(0);
    expect(cardText.indexOf('recent')).toBeLessThan(cardText.indexOf('older'));
  });

  it('refreshes the Codex session bound to the current topic', async () => {
    const updateCard = vi.fn().mockResolvedValue(undefined);
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    bindings.registerProjects([project]);
    await bindings.bindTopic({
      chatId: 'chat-dm', topicId: 'topic-1', projectKey: project.projectKey,
      codexThreadId: 'thread-1', createdBy: 'user-1', updatedAt: 1,
    });
    const ctx = context({ updateCard }, bindings);
    ctx.msg.threadId = 'topic-1';
    ctx.fromCardAction = true;
    ctx.sessionSync = new SessionSyncManager();
    ctx.agent = {
      ...ctx.agent,
      readSession: vi.fn().mockResolvedValue({
        threadId: 'thread-1', preview: '最新进度', cwd: project.cwd, status: 'active', updatedAt: 2,
        turnCount: 2, recentActivity: [{ kind: '助手', text: '正在运行测试' }],
      }),
    };

    await expect(runCommandHandler('sync', '', ctx)).resolves.toBe(true);
    expect(updateCard).toHaveBeenCalledWith('message-1', expect.objectContaining({ header: expect.any(Object) }));
  });

  it('searches sessions from a CardKit form value', async () => {
    const updateCard = vi.fn().mockResolvedValue(undefined);
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    bindings.registerProjects([project]);
    await bindings.bindProject(project.projectKey, 'chat-project');
    const listSessionPage = vi.fn().mockResolvedValue({ sessions: [] });
    const ctx = context({ updateCard }, bindings);
    ctx.msg.chatId = 'chat-project';
    ctx.fromCardAction = true;
    ctx.formValue = { session_search: '卡片修复' };
    ctx.agent = {
      ...ctx.agent,
      listSessions: vi.fn().mockResolvedValue([]),
      listSessionPage,
    };

    await runCommandHandler('sessions', 'search', ctx);

    expect(listSessionPage).toHaveBeenCalledWith(project.cwd, undefined, '卡片修复');
    expect(updateCard).toHaveBeenLastCalledWith('message-1', expect.any(Object));
  });

  it('keeps the real Feishu message id when queuing a task preset', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    const push = vi.fn();
    const ctx = context({ send }, bindings);
    ctx.msg.threadId = 'topic-1';
    ctx.scope = 'chat-dm:topic-1';
    ctx.pending = { push } as never;

    await runCommandHandler('preset', 'use review', ctx);

    expect(push).toHaveBeenCalledWith('chat-dm:topic-1', expect.objectContaining({
      messageId: 'message-1',
      threadId: 'topic-1',
      content: '请审查当前未提交改动，按严重性列出问题，并给出文件与行号。不要直接修改文件。',
    }));
    expect(send).toHaveBeenCalledWith('chat-dm', {
      markdown: '已下发“审查当前改动”，稍后会在当前话题执行。',
    }, { replyTo: 'message-1' });
  });

  it('starts review and compaction for the current topic, then forks it into a new topic', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ messageId: 'root-fork' });
    const updateCard = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn().mockResolvedValue({ data: { items: [{ thread_id: 'topic-fork' }] } });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    bindings.registerProjects([project]);
    await bindings.bindProject(project.projectKey, 'chat-project');
    await bindings.bindTopic({
      chatId: 'chat-project', topicId: 'topic-source', projectKey: project.projectKey,
      codexThreadId: 'thread-source', createdBy: 'user-1', updatedAt: 1,
    });
    const reviewSession = vi.fn().mockResolvedValue(undefined);
    const compactSession = vi.fn().mockResolvedValue(undefined);
    const forkSession = vi.fn().mockResolvedValue({
      threadId: 'thread-fork', name: '分支会话', preview: '分支', cwd: project.cwd,
      status: 'idle', updatedAt: 2,
    });
    const ctx = context({ send, updateCard, rawClient: { im: { v1: { message: { get } } } } }, bindings);
    ctx.msg.chatId = 'chat-project';
    ctx.msg.chatType = 'group';
    ctx.msg.threadId = 'topic-source';
    ctx.scope = 'chat-project:topic-source';
    ctx.fromCardAction = true;
    ctx.agent = {
      ...ctx.agent,
      createSession: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([{
        threadId: 'thread-source', name: '源会话', preview: '源', cwd: project.cwd,
        status: 'idle', updatedAt: 1,
      }]),
      reviewSession,
      compactSession,
      forkSession,
    };

    await runCommandHandler('session', 'review', ctx);
    await runCommandHandler('session', 'compact', ctx);
    await runCommandHandler('session', 'fork', ctx);

    expect(reviewSession).toHaveBeenCalledWith('thread-source');
    expect(compactSession).toHaveBeenCalledWith('thread-source');
    expect(forkSession).toHaveBeenCalledWith('thread-source', project.cwd);
    expect(bindings.findTopic('chat-project', 'topic-fork')).toMatchObject({ codexThreadId: 'thread-fork' });
  });

  it('shows the current Codex thread model on the project status card', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    bindings.registerProjects([project]);
    await bindings.bindProject(project.projectKey, 'chat-project');
    await bindings.bindTopic({
      chatId: 'chat-project', topicId: 'topic-native', projectKey: project.projectKey,
      codexThreadId: 'thread-1', createdBy: 'user-1', updatedAt: 1,
    });
    const readThreadModel = vi.fn().mockResolvedValue({
      model: 'gpt-6-astra', effort: 'high', loaded: true, canAcceptDirectInput: true,
    });
    const listModels = vi.fn().mockResolvedValue([{
      model: 'gpt-6-astra', id: 'gpt-6-astra', displayName: 'Astra', description: '',
      isDefault: false, hidden: false, supportedReasoningEfforts: ['high'], defaultReasoningEffort: 'high',
    }]);
    const ctx = context({ send }, bindings);
    ctx.msg.chatId = 'chat-project';
    ctx.msg.chatType = 'group';
    ctx.msg.threadId = 'topic-native';
    ctx.agent = { ...ctx.agent, readThreadModel, listModels };

    await runCommandHandler('status', '', ctx);

    expect(readThreadModel).toHaveBeenCalledWith('thread-1');
    const card = JSON.stringify(send.mock.lastCall![1].card);
    expect(card).toContain('模型：Astra · 强度：高');
  });

  it('marks the model as unknown when the thread read fails', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    bindings.registerProjects([project]);
    await bindings.bindProject(project.projectKey, 'chat-project');
    await bindings.bindTopic({
      chatId: 'chat-project', topicId: 'topic-native', projectKey: project.projectKey,
      codexThreadId: 'thread-1', createdBy: 'user-1', updatedAt: 1,
    });
    const ctx = context({ send }, bindings);
    ctx.msg.chatId = 'chat-project';
    ctx.msg.chatType = 'group';
    ctx.msg.threadId = 'topic-native';
    ctx.agent = { ...ctx.agent, readThreadModel: vi.fn().mockRejectedValue(new Error('boom')) };

    await runCommandHandler('status', '', ctx);

    const card = JSON.stringify(send.mock.lastCall![1].card);
    expect(card).toContain('模型：未知（点刷新重试）');
    expect(card).toContain('刷新');
  });
});
