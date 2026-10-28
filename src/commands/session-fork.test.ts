import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FORK_MODEL_COPY_FAILED_MESSAGE } from '../agent/types';
import { ActiveRuns } from '../bot/active-runs';
import type { CommandContext } from './index';
import { runCommandHandler } from './index';
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

async function forkContext(send: ReturnType<typeof vi.fn>, bindings: JsonProjectBindingStore): Promise<CommandContext> {
  return {
    channel: { send } as unknown as CommandContext['channel'],
    msg: {
      messageId: 'message-1', chatId: 'chat-group', chatType: 'group', senderId: 'user-1',
      senderName: '用户', content: '/session fork thread-source', rawContentType: 'text',
      resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: Date.now(),
    },
    scope: 'chat-group',
    chatMode: 'group',
    sessions: new SessionStore(join(await mkdtemp(join(tmpdir(), 'feishu-fork-test-')), 'sessions.json')),
    workspaces: new WorkspaceStore(join(await mkdtemp(join(tmpdir(), 'feishu-fork-test-')), 'workspaces.json')),
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

async function boundContext(send: ReturnType<typeof vi.fn>): Promise<CommandContext> {
  const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-fork-test-')), 'bindings.json'));
  bindings.registerProjects([project]);
  await bindings.bindProject(project.projectKey, 'chat-group');
  return forkContext(send, bindings);
}

describe('session fork model copy', () => {
  it('forks once and copies the source model onto the fork', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const ctx = await boundContext(send);
    const forkSession = vi.fn().mockResolvedValue({ threadId: 'thread-fork', name: '分支会话', cwd: '/tmp/demo' });
    const copyThreadModel = vi.fn().mockResolvedValue({ status: 'applied' });
    ctx.agent = {
      ...ctx.agent,
      createSession: vi.fn(),
      forkSession,
      listSessions: vi.fn().mockResolvedValue([{ threadId: 'thread-source', name: '源会话' }]),
      copyThreadModel,
      releaseWriterIfIdle: vi.fn().mockResolvedValue(undefined),
    };

    await runCommandHandler('session', 'fork thread-source', ctx);

    expect(forkSession).toHaveBeenCalledTimes(1);
    expect(forkSession).toHaveBeenCalledWith('thread-source', '/tmp/demo');
    expect(copyThreadModel).toHaveBeenCalledWith('thread-source', 'thread-fork');
  });

  it('does not carry the source scope pending selection onto the fork', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const ctx = await boundContext(send);
    const bindings = ctx.projectBindings!;
    ctx.sessions.setPending(ctx.scope, { model: 'gpt-6-astra', effort: 'low' });
    ctx.agent = {
      ...ctx.agent,
      createSession: vi.fn(),
      forkSession: vi.fn().mockResolvedValue({ threadId: 'thread-fork', name: '分支会话', cwd: '/tmp/demo' }),
      listSessions: vi.fn().mockResolvedValue([{ threadId: 'thread-source', name: '源会话' }]),
      copyThreadModel: vi.fn().mockResolvedValue({ status: 'applied' }),
      releaseWriterIfIdle: vi.fn().mockResolvedValue(undefined),
    };

    await runCommandHandler('session', 'fork thread-source', ctx);

    const topic = bindings.findTopicByThread('thread-fork');
    expect(topic).toBeDefined();
    expect(ctx.sessions.getPending(`${topic!.chatId}:${topic!.topicId}`)).toBeUndefined();
    expect(ctx.sessions.getPending(ctx.scope)).toEqual({ model: 'gpt-6-astra', effort: 'low' });
  });

  it('keeps the fork and tells the user to reselect when copying fails', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const ctx = await boundContext(send);
    const bindings = ctx.projectBindings!;
    const releaseWriterIfIdle = vi.fn().mockResolvedValue(undefined);
    ctx.agent = {
      ...ctx.agent,
      createSession: vi.fn(),
      forkSession: vi.fn().mockResolvedValue({ threadId: 'thread-fork', name: '分支会话', cwd: '/tmp/demo' }),
      listSessions: vi.fn().mockResolvedValue([{ threadId: 'thread-source', name: '源会话' }]),
      copyThreadModel: vi.fn().mockResolvedValue({ status: 'failed', message: FORK_MODEL_COPY_FAILED_MESSAGE }),
      releaseWriterIfIdle,
    };

    await runCommandHandler('session', 'fork thread-source', ctx);

    const texts = send.mock.calls.map((call) => JSON.stringify(call[1]));
    expect(texts.some((text) => text.includes(FORK_MODEL_COPY_FAILED_MESSAGE))).toBe(true);
    expect(bindings.findTopicByThread('thread-fork')).toBeDefined();
    expect(releaseWriterIfIdle).toHaveBeenCalledTimes(1);
  });

  it('releases the writer even when model copying throws', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const ctx = await boundContext(send);
    const releaseWriterIfIdle = vi.fn().mockResolvedValue(undefined);
    ctx.agent = {
      ...ctx.agent,
      createSession: vi.fn(),
      forkSession: vi.fn().mockResolvedValue({ threadId: 'thread-fork', name: '分支会话', cwd: '/tmp/demo' }),
      listSessions: vi.fn().mockResolvedValue([{ threadId: 'thread-source', name: '源会话' }]),
      copyThreadModel: vi.fn().mockRejectedValue(new Error('read failed')),
      releaseWriterIfIdle,
    };

    await runCommandHandler('session', 'fork thread-source', ctx);

    expect(releaseWriterIfIdle).toHaveBeenCalledTimes(1);
    const texts = send.mock.calls.map((call) => JSON.stringify(call[1]));
    expect(texts.some((text) => text.includes(FORK_MODEL_COPY_FAILED_MESSAGE))).toBe(true);
  });
});
