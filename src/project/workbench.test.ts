import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LarkChannel } from '@larksuiteoapi/node-sdk';
import { JsonProjectBindingStore } from './store';
import { showProjectWorkbench } from './workbench';
import type { Project } from './types';

const project: Project = {
  projectKey: 'local::/tmp/demo', name: 'demo', cwd: '/tmp/demo', hostId: 'local', chatId: 'chat-1',
};

describe('project workbench', () => {
  it('creates one home card and updates it on later requests', async () => {
    const store = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-workbench-')), 'bindings.json'));
    store.registerProjects([project]);
    await store.bindProject(project.projectKey, project.chatId!);
    const send = vi.fn().mockResolvedValue({ messageId: 'home-1' });
    const patch = vi.fn().mockResolvedValue({ code: 0 });
    const channel = { send, rawClient: { im: { v1: { message: { patch } } } } } as never;

    await showProjectWorkbench(channel, store, project);
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.findProjectByChat('chat-1')?.homeMessageId).toBe('home-1');

    await showProjectWorkbench(channel, store, store.findProjectByChat('chat-1')!);
    expect(patch).toHaveBeenCalledWith({
      path: { message_id: 'home-1' },
      data: { content: expect.stringContaining('项目工作台') },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('replaces the home card when Feishu rejects its update with a business error', async () => {
    const store = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-workbench-')), 'bindings.json'));
    store.registerProjects([project]);
    await store.bindProject(project.projectKey, project.chatId!);
    await store.bindProjectHomeMessage(project.projectKey, 'home-old');
    const channel = new LarkChannel({ appId: 'test-app', appSecret: 'test-secret' });
    const patch = vi.spyOn(channel.rawClient.im.v1.message, 'patch')
      .mockResolvedValue({ code: 230001, msg: 'mock card update failure' });
    const send = vi.spyOn(channel, 'send').mockResolvedValue({ messageId: 'home-new' });

    await showProjectWorkbench(channel, store, store.findProjectByChat('chat-1')!);

    expect(patch).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('chat-1', {
      card: expect.objectContaining({ header: { title: { tag: 'plain_text', content: '项目工作台' } } }),
    });
    expect(store.findProjectByChat('chat-1')?.homeMessageId).toBe('home-new');
  });
});
