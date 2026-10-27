import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../bot/active-runs';
import type { CommandContext } from './index';
import { runCommandHandler, tryHandleCommand } from './index';
import { JsonProjectBindingStore } from '../project/store';
import type { Project } from '../project/types';
import { SessionStore } from '../session/store';
import { WorkspaceStore } from '../workspace/store';

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

describe('Codex model commands', () => {
  it('denies /model to a text user outside the admin allowlist', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    const ctx = context({ send }, bindings, '/model');
    ctx.controls.cfg = {
      accounts: { app: { id: 'app-1', secret: 'secret', tenant: 'feishu' } },
      preferences: { agentBackend: 'codex', access: { admins: ['someone-else'] } },
    } as never;

    await expect(tryHandleCommand(ctx)).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith('chat-dm', { markdown: '❌ 此命令仅管理员可用。' }, { replyTo: 'message-1' });
  });

  it('denies the model card callback to a non-admin with a visible reply', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const patch = vi.fn();
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    const ctx = context({ send, rawClient: { im: { v1: { message: { patch } } } } }, bindings);
    ctx.fromCardAction = true;
    ctx.controls.cfg = {
      accounts: { app: { id: 'app-1', secret: 'secret', tenant: 'feishu' } },
      preferences: { agentBackend: 'codex', access: { admins: ['someone-else'] } },
    } as never;

    await runCommandHandler('model', '', ctx);

    expect(send).toHaveBeenCalledWith('chat-dm', { markdown: '仅管理员可切换模型' }, { replyTo: 'message-1' });
    expect(patch).not.toHaveBeenCalled();
  });

  it('refuses model switching on the OMP backend', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    const ctx = context({ send }, bindings);

    await runCommandHandler('model', '', ctx);

    expect(send).toHaveBeenCalledWith('chat-dm', { markdown: '当前是 OMP 会话，模型切换仅支持 Codex' }, { replyTo: 'message-1' });
  });

  it('opens model selection before a thread exists', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    const listModels = vi.fn().mockResolvedValue([
      {
        model: 'gpt-5.6-sol', id: 'gpt-5.6-sol', displayName: 'Sol', description: '',
        isDefault: true, hidden: false, supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high',
      },
      {
        model: 'gpt-6-astra', id: 'gpt-6-astra', displayName: 'Astra', description: '',
        isDefault: false, hidden: false, supportedReasoningEfforts: ['medium', 'ultra'], defaultReasoningEffort: 'medium',
      },
    ]);
    const ctx = context({ send }, bindings);
    ctx.controls.cfg = {
      accounts: { app: { id: 'app-1', secret: 'secret', tenant: 'feishu' } },
      preferences: { agentBackend: 'codex' },
    } as never;
    ctx.agent = { ...ctx.agent, listModels };

    await runCommandHandler('model', '', ctx);

    const card = JSON.stringify(send.mock.lastCall![1].card);
    expect(card).toContain('Sol');
    expect(card).toContain('Astra');
    expect(card).not.toContain('尚未开始');
  });

  it('walks a project topic through model and effort selection and applies the switch', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const patch = vi.fn().mockResolvedValue({ code: 0 });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    bindings.registerProjects([project]);
    await bindings.bindProject(project.projectKey, 'chat-project');
    await bindings.bindTopic({
      chatId: 'chat-project', topicId: 'topic-native', projectKey: project.projectKey,
      codexThreadId: 'thread-1', createdBy: 'user-1', updatedAt: 1,
    });
    const readThreadModel = vi.fn().mockResolvedValue({
      model: 'gpt-5.6-sol', effort: 'high', loaded: true, canAcceptDirectInput: true,
    });
    const listModels = vi.fn().mockResolvedValue([
      {
        model: 'gpt-5.6-sol', id: 'gpt-5.6-sol', displayName: 'Sol', description: '',
        isDefault: true, hidden: false, supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high',
      },
      {
        model: 'gpt-6-astra', id: 'gpt-6-astra', displayName: 'Astra', description: '',
        isDefault: false, hidden: false, supportedReasoningEfforts: ['medium', 'ultra'], defaultReasoningEffort: 'medium',
      },
    ]);
    const switchThreadModel = vi.fn().mockResolvedValue({
      status: 'applied',
      previous: { model: 'gpt-5.6-sol', effort: 'high' },
      next: { model: 'gpt-6-astra', effort: 'ultra' },
    });
    const releaseWriterIfIdle = vi.fn().mockResolvedValue(undefined);
    const updateCard = vi.fn(async (messageId: string, card: object) => patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    }));
    const ctx = context({ send, updateCard, rawClient: { im: { v1: { message: { patch } } } } }, bindings);
    ctx.msg.chatId = 'chat-project';
    ctx.msg.chatType = 'group';
    ctx.msg.threadId = 'topic-native';
    ctx.fromCardAction = true;
    ctx.controls.cfg = {
      accounts: { app: { id: 'app-1', secret: 'secret', tenant: 'feishu' } },
      preferences: { agentBackend: 'codex' },
    } as never;
    ctx.agent = { ...ctx.agent, readThreadModel, listModels, switchThreadModel, releaseWriterIfIdle };

    await runCommandHandler('model', '', ctx);
    const step1 = JSON.stringify(patch.mock.lastCall![0].data.content);
    expect(step1).toContain('Sol（当前）');
    expect(step1).toContain('Astra');

    ctx.formValue = { model_id: 'gpt-6-astra' };
    ctx.cardPayload = { cmd: 'model', arg: 'choose-model' };
    await runCommandHandler('model', 'choose-model', ctx);
    const step2 = patch.mock.lastCall![0].data.content as string;
    expect(step2).toContain('跟随模型默认（中）');
    expect(step2).toContain('"value":"ultra"');

    ctx.formValue = { effort: 'ultra' };
    ctx.cardPayload = { cmd: 'model', arg: 'apply', model_id: 'gpt-6-astra' };
    await runCommandHandler('model', 'apply', ctx);

    expect(switchThreadModel).toHaveBeenCalledWith('thread-1', { model: 'gpt-6-astra', effort: 'ultra' });
    expect(releaseWriterIfIdle).toHaveBeenCalled();
    const resultCard = JSON.stringify(patch.mock.lastCall![0].data.content);
    expect(resultCard).toContain('模型已切换：Sol → Astra（强度 最高）');
    expect(resultCard).toContain('操作者：用户');
    expect(resultCard).toContain('查看状态');
  });

  it('reports desktop ownership with a manual retry', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const patch = vi.fn().mockResolvedValue({ code: 0 });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    bindings.registerProjects([project]);
    await bindings.bindProject(project.projectKey, 'chat-project');
    await bindings.bindTopic({
      chatId: 'chat-project', topicId: 'topic-native', projectKey: project.projectKey,
      codexThreadId: 'thread-1', createdBy: 'user-1', updatedAt: 1,
    });
    const updateCard = vi.fn(async (messageId: string, card: object) => patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    }));
    const ctx = context({ send, updateCard, rawClient: { im: { v1: { message: { patch } } } } }, bindings);
    ctx.msg.chatId = 'chat-project';
    ctx.msg.chatType = 'group';
    ctx.msg.threadId = 'topic-native';
    ctx.fromCardAction = true;
    ctx.controls.cfg = {
      accounts: { app: { id: 'app-1', secret: 'secret', tenant: 'feishu' } },
      preferences: { agentBackend: 'codex' },
    } as never;
    ctx.agent = {
      ...ctx.agent,
      readThreadModel: vi.fn().mockResolvedValue({
        model: 'gpt-5.6-sol', effort: 'high', loaded: true, canAcceptDirectInput: true,
      }),
      listModels: vi.fn().mockResolvedValue([{
        model: 'gpt-6-astra', id: 'gpt-6-astra', displayName: 'Astra', description: '',
        isDefault: false, hidden: false, supportedReasoningEfforts: ['ultra'], defaultReasoningEffort: 'ultra',
      }]),
      switchThreadModel: vi.fn().mockResolvedValue({
        status: 'active_writer',
        previous: { model: 'gpt-5.6-sol', effort: 'high' },
        message: '桌面端正在使用这个会话，请在桌面端关闭该会话后重试',
      }),
      releaseWriterIfIdle: vi.fn().mockResolvedValue(undefined),
    };
    ctx.formValue = { effort: 'ultra' };
    ctx.cardPayload = { cmd: 'model', arg: 'apply', model_id: 'gpt-6-astra' };

    await runCommandHandler('model', 'apply', ctx);

    const card = JSON.stringify(patch.mock.lastCall![0].data.content);
    expect(card).toContain('桌面端正在使用这个会话，请在桌面端关闭该会话后重试');
    expect(card).toContain('重新选择');
  });

  it('returns to model selection when the refreshed list no longer has the choice', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const patch = vi.fn().mockResolvedValue({ code: 0 });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    bindings.registerProjects([project]);
    await bindings.bindProject(project.projectKey, 'chat-project');
    await bindings.bindTopic({
      chatId: 'chat-project', topicId: 'topic-native', projectKey: project.projectKey,
      codexThreadId: 'thread-1', createdBy: 'user-1', updatedAt: 1,
    });
    const switchThreadModel = vi.fn();
    const updateCard = vi.fn(async (messageId: string, card: object) => patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    }));
    const ctx = context({ send, updateCard, rawClient: { im: { v1: { message: { patch } } } } }, bindings);
    ctx.msg.chatId = 'chat-project';
    ctx.msg.chatType = 'group';
    ctx.msg.threadId = 'topic-native';
    ctx.fromCardAction = true;
    ctx.controls.cfg = {
      accounts: { app: { id: 'app-1', secret: 'secret', tenant: 'feishu' } },
      preferences: { agentBackend: 'codex' },
    } as never;
    ctx.agent = {
      ...ctx.agent,
      readThreadModel: vi.fn().mockResolvedValue({
        model: 'gpt-5.6-sol', effort: 'high', loaded: true, canAcceptDirectInput: true,
      }),
      listModels: vi.fn().mockResolvedValue([{
        model: 'gpt-5.6-sol', id: 'gpt-5.6-sol', displayName: 'Sol', description: '',
        isDefault: true, hidden: false, supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high',
      }]),
      switchThreadModel,
    };
    ctx.formValue = { effort: 'ultra' };
    ctx.cardPayload = { cmd: 'model', arg: 'apply', model_id: 'gpt-6-astra' };

    await runCommandHandler('model', 'apply', ctx);

    expect(switchThreadModel).not.toHaveBeenCalled();
    const card = JSON.stringify(patch.mock.lastCall![0].data.content);
    expect(card).toContain('模型列表已更新，请重新选择');
  });

  it('stores a pending choice before a session exists', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    const listModels = vi.fn().mockResolvedValue([
      {
        model: 'gpt-5.6-sol', id: 'gpt-5.6-sol', displayName: 'Sol', description: '',
        isDefault: true, hidden: false, supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high',
      },
      {
        model: 'gpt-6-astra', id: 'gpt-6-astra', displayName: 'Astra', description: '',
        isDefault: false, hidden: false, supportedReasoningEfforts: ['medium', 'ultra'], defaultReasoningEffort: 'medium',
      },
    ]);
    const switchThreadModel = vi.fn();
    const ctx = context({ send }, bindings);
    ctx.controls.cfg = {
      accounts: { app: { id: 'app-1', secret: 'secret', tenant: 'feishu' } },
      preferences: { agentBackend: 'codex' },
    } as never;
    ctx.agent = { ...ctx.agent, listModels, switchThreadModel };

    await runCommandHandler('model', '', ctx);
    ctx.formValue = { model_id: 'gpt-6-astra' };
    ctx.cardPayload = { cmd: 'model', arg: 'choose-model' };
    await runCommandHandler('model', 'choose-model', ctx);
    ctx.formValue = { effort: 'ultra' };
    ctx.cardPayload = { cmd: 'model', arg: 'apply', model_id: 'gpt-6-astra' };
    await runCommandHandler('model', 'apply', ctx);

    expect(ctx.sessions.getPending('chat-dm')).toEqual({ model: 'gpt-6-astra', effort: 'ultra' });
    expect(switchThreadModel).not.toHaveBeenCalled();
    const card = JSON.stringify(send.mock.lastCall![1].card);
    expect(card).toContain('已选择 Astra；会话创建后生效');
    expect(card).toContain('推理强度：最高');
  });

  it('shows a pending choice on the status card before a session exists', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    const listModels = vi.fn().mockResolvedValue([{
      model: 'gpt-6-astra', id: 'gpt-6-astra', displayName: 'Astra', description: '',
      isDefault: false, hidden: false, supportedReasoningEfforts: ['medium', 'ultra'], defaultReasoningEffort: 'medium',
    }]);
    const ctx = context({ send }, bindings);
    ctx.controls.cfg = {
      accounts: { app: { id: 'app-1', secret: 'secret', tenant: 'feishu' } },
      preferences: { agentBackend: 'codex' },
    } as never;
    ctx.agent = { ...ctx.agent, listModels };
    ctx.sessions.setPending('chat-dm', { model: 'gpt-6-astra', effort: 'ultra' });

    await runCommandHandler('status', '', ctx);

    const card = JSON.stringify(send.mock.lastCall![1].card);
    expect(card).toContain('模型：Astra（待生效）');
  });

  it('keeps the pending choice when starting a new session', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    const listModels = vi.fn().mockResolvedValue([{
      model: 'gpt-6-astra', id: 'gpt-6-astra', displayName: 'Astra', description: '',
      isDefault: false, hidden: false, supportedReasoningEfforts: ['medium', 'ultra'], defaultReasoningEffort: 'medium',
    }]);
    const ctx = context({ send }, bindings);
    ctx.controls.cfg = {
      accounts: { app: { id: 'app-1', secret: 'secret', tenant: 'feishu' } },
      preferences: { agentBackend: 'codex' },
    } as never;
    ctx.agent = { ...ctx.agent, listModels };
    ctx.sessions.set('chat-dm', 'thread-old', '/tmp/demo');
    ctx.sessions.setPending('chat-dm', { model: 'gpt-6-astra', effort: 'ultra' });

    await runCommandHandler('new', '', ctx);

    expect(ctx.sessions.getRaw('chat-dm')?.sessionId).toBeUndefined();
    expect(ctx.sessions.getPending('chat-dm')).toEqual({ model: 'gpt-6-astra', effort: 'ultra' });
    expect(send).toHaveBeenCalledWith('chat-dm', {
      markdown: '已开始新会话；模型选择保留：Astra（待生效）。',
    }, { replyTo: 'message-1' });
  });

  it('refuses /model default on the OMP backend', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    const ctx = context({ send }, bindings);

    await runCommandHandler('model', 'default', ctx);

    expect(send).toHaveBeenCalledWith('chat-dm', { markdown: '当前是 OMP 会话，模型切换仅支持 Codex' }, { replyTo: 'message-1' });
  });

  it('refuses to switch while this topic has an active run', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    const ctx = context({ send }, bindings);
    ctx.controls.cfg = {
      accounts: { app: { id: 'app-1', secret: 'secret', tenant: 'feishu' } },
      preferences: { agentBackend: 'codex' },
    } as never;
    ctx.activeRuns.register('chat-dm', { stop: vi.fn() } as never);

    await runCommandHandler('model', '', ctx);

    expect(send).toHaveBeenCalledWith('chat-dm', { markdown: '任务执行中，结束后再切换' }, { replyTo: 'message-1' });
  });
});
