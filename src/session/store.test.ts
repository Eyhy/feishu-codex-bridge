import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from './store';

const dirs: string[] = [];
const stores: SessionStore[] = [];

async function tempStore(): Promise<{ store: SessionStore; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'session-store-'));
  dirs.push(dir);
  const file = join(dir, 'sessions.json');
  const store = new SessionStore(file);
  stores.push(store);
  await store.load();
  return { store, file };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.flush()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SessionStore pending model', () => {
  it('S1 keeps entries without a pending selection undefined', async () => {
    const { store } = await tempStore();
    store.set('chat-1', 'thread-1', '/repo');
    expect(store.getPending('chat-1')).toBeUndefined();
  });

  it('S2 set() preserves the session binding and idle timeout when pending is written', async () => {
    const { store } = await tempStore();
    store.setIdleTimeoutMinutes('chat-1', 15);
    store.set('chat-1', 'thread-1', '/repo');
    store.setPending('chat-1', { model: 'gpt-6-astra', effort: 'medium' });

    expect(store.getRaw('chat-1')).toMatchObject({
      sessionId: 'thread-1',
      cwd: '/repo',
      idleTimeoutMinutes: 15,
      pendingModel: 'gpt-6-astra',
      pendingEffort: 'medium',
    });
  });

  it('S3 loads a pending-only scope instead of dropping it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'session-store-'));
    dirs.push(dir);
    const file = join(dir, 'sessions.json');
    await writeFile(
      file,
      JSON.stringify({
        'chat-1': {
          updatedAt: 1,
          pendingModel: 'gpt-6-astra',
          pendingEffort: 'medium',
        },
      }),
    );

    const store = new SessionStore(file);
    await store.load();
    expect(store.getPending('chat-1')).toEqual({ model: 'gpt-6-astra', effort: 'medium' });
  });

  it('S4 clearPending keeps the session binding and idle timeout', async () => {
    const { store } = await tempStore();
    store.setIdleTimeoutMinutes('chat-1', 5);
    store.set('chat-1', 'thread-1', '/repo');
    store.setPending('chat-1', { model: 'gpt-6-astra', effort: 'medium' });
    store.clearPending('chat-1');

    expect(store.getPending('chat-1')).toBeUndefined();
    expect(store.getRaw('chat-1')).toMatchObject({
      sessionId: 'thread-1',
      cwd: '/repo',
      idleTimeoutMinutes: 5,
    });
  });

  it('S5 clear() removes the whole entry including pending', async () => {
    const { store, file } = await tempStore();
    store.setPending('chat-1', { model: 'gpt-6-astra', effort: 'medium' });
    store.clear('chat-1');
    await store.flush();

    expect(store.getRaw('chat-1')).toBeUndefined();
    const reloaded = new SessionStore(file);
    await reloaded.load();
    expect(reloaded.getPending('chat-1')).toBeUndefined();
  });

  it('S6 keeps old entries compatible and ignores half a pending pair', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'session-store-'));
    dirs.push(dir);
    const file = join(dir, 'sessions.json');
    await writeFile(
      file,
      JSON.stringify({
        timeout: { updatedAt: 1, idleTimeoutMinutes: 30 },
        half: { updatedAt: 2, sessionId: 'thread-1', cwd: '/repo', pendingModel: 'gpt-6-astra' },
      }),
    );

    const store = new SessionStore(file);
    await store.load();
    expect(store.getIdleTimeoutMinutes('timeout')).toBe(30);
    expect(store.getPending('half')).toBeUndefined();
    expect(store.getRaw('half')?.sessionId).toBe('thread-1');
  });

  it('S7 persists pending across a reload without a display name', async () => {
    const { store, file } = await tempStore();
    store.setPending('chat-1', { model: 'gpt-6-astra', effort: 'medium' });
    await store.flush();

    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(raw['chat-1']).toEqual({
      updatedAt: expect.any(Number),
      pendingModel: 'gpt-6-astra',
      pendingEffort: 'medium',
    });

    const reloaded = new SessionStore(file);
    await reloaded.load();
    expect(reloaded.getPending('chat-1')).toEqual({ model: 'gpt-6-astra', effort: 'medium' });
  });

  it('S8 clearSession drops the session but keeps the pending choice', async () => {
    const { store, file } = await tempStore();
    store.setIdleTimeoutMinutes('chat-1', 15);
    store.set('chat-1', 'thread-1', '/repo');
    store.setPending('chat-1', { model: 'gpt-6-astra', effort: 'medium' });
    store.clearSession('chat-1');

    expect(store.getRaw('chat-1')).toEqual({
      updatedAt: expect.any(Number),
      pendingModel: 'gpt-6-astra',
      pendingEffort: 'medium',
    });
    await store.flush();
    const reloaded = new SessionStore(file);
    await reloaded.load();
    expect(reloaded.getPending('chat-1')).toEqual({ model: 'gpt-6-astra', effort: 'medium' });
  });
});
