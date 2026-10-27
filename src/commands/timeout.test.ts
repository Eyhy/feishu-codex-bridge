import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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

async function context(channel: unknown): Promise<CommandContext> {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-timeout-test-'));
  const bindings = new JsonProjectBindingStore(join(dir, 'bindings.json'));
  bindings.registerProjects([project]);
  return {
    channel: channel as CommandContext['channel'],
    msg: {
      messageId: 'message-1', chatId: 'chat-dm', chatType: 'p2p', senderId: 'user-1',
      senderName: '用户', content: '', rawContentType: 'text', resources: [], mentions: [],
      mentionAll: false, mentionedBot: false, createTime: Date.now(),
    },
    scope: 'chat-dm',
    chatMode: 'p2p',
    sessions: new SessionStore(join(dir, 'sessions.json')),
    workspaces: new WorkspaceStore(join(dir, 'workspaces.json')),
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

describe('/timeout user-visible wording', () => {
  it('describes the setting as this topic instead of a session override', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const ctx = await context({ send });
    ctx.sessions.setIdleTimeoutMinutes('chat-dm', 15);

    await runCommandHandler('timeout', '', ctx);

    const markdown = send.mock.lastCall![1].markdown as string;
    expect(markdown).toContain('本话题超时设置');
    expect(markdown).not.toContain('当前 session');
    expect(markdown).not.toContain('session 覆盖');
    for (const term of ['线程', '覆盖', 'Session']) expect(markdown).not.toContain(term);
  });

  it('clears the topic setting without saying override', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const ctx = await context({ send });
    ctx.sessions.setIdleTimeoutMinutes('chat-dm', 15);

    await runCommandHandler('timeout', 'default', ctx);

    const markdown = send.mock.lastCall![1].markdown as string;
    expect(markdown).toContain('已清除本话题的超时设置，回退到全局（');
    expect(markdown).not.toContain('覆盖');
  });

  it('confirms a new topic timeout in topic language', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const ctx = await context({ send });

    await runCommandHandler('timeout', '15', ctx);

    expect(send.mock.lastCall![1].markdown).toContain('已把本话题的超时设置为 15 分钟');
    expect(ctx.sessions.getIdleTimeoutMinutes('chat-dm')).toBe(15);
  });
});
