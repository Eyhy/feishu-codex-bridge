import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODEX_ACTIVE_WRITER_MESSAGE, CodexAdapter } from './adapter';
import { ThreadModelReadError } from '../types';
import type { AgentEvent } from '../types';

async function fakeCodex(options: { rejectDesktopMetadata?: boolean; rejectAdditionalContext?: boolean; interaction?: 'questions' | 'approval'; activeWriter?: boolean; ignoreSettings?: boolean; modelListFailure?: 'throw' | 'empty'; modelListMissingOnce?: boolean; modelListSecondFailure?: 'throw' | 'empty'; settingsFailure?: boolean; readFailure?: boolean; resumeSettings?: { model: string | null; effort: string | null } } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-adapter-test-'));
  const path = join(dir, 'codex-fake.mjs');
  await writeFile(path, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-cli test'); process.exit(0); }
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => console.log(JSON.stringify(value));
const requestLog = ${JSON.stringify(join(dir, 'requests.jsonl'))};
const rejectDesktopMetadata = ${JSON.stringify(Boolean(options.rejectDesktopMetadata))};
const rejectAdditionalContext = ${JSON.stringify(Boolean(options.rejectAdditionalContext))};
const interaction = ${JSON.stringify(options.interaction ?? '')};
const activeWriter = ${JSON.stringify(Boolean(options.activeWriter))};
const ignoreSettings = ${JSON.stringify(Boolean(options.ignoreSettings))};
const modelListFailure = ${JSON.stringify(options.modelListFailure ?? '')};
const modelListMissingOnce = ${JSON.stringify(Boolean(options.modelListMissingOnce))};
const modelListSecondFailure = ${JSON.stringify(options.modelListSecondFailure ?? '')};
const resumeSettings = ${JSON.stringify(options.resumeSettings ?? null)};
const settingsFailure = ${JSON.stringify(Boolean(options.settingsFailure))};
let modelListCalls = 0;
const readFailure = ${JSON.stringify(Boolean(options.readFailure))};
const threadSettings = new Map([
  ['thread-existing', { model: 'gpt-5.6-sol', effort: 'high' }],
  ['thread-cold', { model: 'gpt-5.6-sol', effort: 'high' }],
]);
const loadedThreads = new Set(['thread-existing']);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { appendFileSync(requestLog, JSON.stringify({ event: 'app-server-exit', signal }) + '\\n'); process.exit(0); });
let activeThreadId = 'thread-new';
let activeThreadName = '';
let settingsWritten = false;
for await (const line of rl) {
  const msg = JSON.parse(line);
  if (msg.method) appendFileSync(requestLog, JSON.stringify({ method: msg.method, params: msg.params }) + '\\n');
  if (msg.method === 'initialize') send({ id: msg.id, result: {} });
  if (msg.method === 'thread/list') send({ id: msg.id, result: { data: [{ id: 'thread-existing', name: msg.params.searchTerm ? '匹配会话' : activeThreadName || '旧会话', preview: '修复卡片', cwd: '/tmp/project', updatedAt: 10, status: { type: 'idle' } }], nextCursor: msg.params.cursor ? null : 'cursor-2', backwardsCursor: null } });
  if (msg.method === 'model/list') {
    modelListCalls += 1;
    if (modelListSecondFailure === 'throw' && modelListCalls > 1) send({ id: msg.id, error: { code: -32000, message: 'model list unavailable on refresh' } });
    else if (modelListSecondFailure === 'empty' && modelListCalls > 1) send({ id: msg.id, result: { data: [] } });
    else if (modelListFailure === 'throw') send({ id: msg.id, error: { code: -32000, message: 'model list unavailable' } });
    else if (modelListFailure === 'empty') send({ id: msg.id, result: { data: [] } });
    else {
      const data = [
        { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'Sol', description: '默认模型', hidden: false, isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ description: '低', reasoningEffort: 'low' }, { description: '高', reasoningEffort: 'high' }] },
        { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'Astra', description: '实验模型', hidden: false, isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ description: '中', reasoningEffort: 'medium' }, { description: '最高', reasoningEffort: 'ultra' }] },
        { id: 'hidden-model', model: 'hidden-model', displayName: 'Hidden', description: '', hidden: true, isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [] },
      ];
      send({ id: msg.id, result: { data: modelListMissingOnce && modelListCalls === 1
        ? data.filter((model) => model.model !== 'gpt-6-astra')
        : data } });
    }
  }
  if (msg.method === 'thread/start') {
    if (rejectDesktopMetadata && msg.params.threadSource) {
      send({ id: msg.id, error: { code: -32602, message: 'unknown field threadSource' } });
      continue;
    }
    if (!rejectDesktopMetadata && (msg.params.serviceName !== 'feishu_codex_bridge' || msg.params.threadSource !== 'user')) {
      send({ id: msg.id, error: { code: -32602, message: 'desktop metadata missing' } });
      continue;
    }
    activeThreadId = 'thread-new';
    activeThreadName = '';
    loadedThreads.add('thread-new');
    send({ id: msg.id, result: { thread: { id: 'thread-new', name: null, preview: '', cwd: '/tmp/project' } } });
  }
  if (msg.method === 'thread/resume') {
    if (msg.params.threadId === 'missing-rollout') send({ id: msg.id, error: { code: -32000, message: 'no rollout found for thread id missing-rollout' } });
    else if (activeWriter) send({ id: msg.id, error: { code: -32000, message: 'thread ' + msg.params.threadId + ' already has an active writer' } });
    else if (msg.params.threadId === 'unloaded') send({ id: msg.id, result: { thread: { id: 'unloaded', sessionId: 'session-2', name: '恢复会话', preview: '恢复详情', cwd: '/tmp/project', updatedAt: 30, status: { type: 'idle' }, source: 'vscode', turns: [{ items: [{ type: 'agentMessage', text: '已恢复' }] }] } } });
    else {
      activeThreadId = msg.params.threadId;
      loadedThreads.add(msg.params.threadId);
      const settings = resumeSettings ?? threadSettings.get(msg.params.threadId) ?? { model: 'gpt-5.6-sol', effort: 'high' };
      send({ id: msg.id, result: { thread: { id: msg.params.threadId, cwd: '/tmp/project' }, model: settings.model, reasoningEffort: settings.effort } });
    }
  }
  if (msg.method === 'thread/read') {
    if (readFailure && settingsWritten) send({ id: msg.id, error: { code: -32000, message: 'thread read failed after settings' } });
    else if (msg.params.threadId === 'missing-thread') send({ id: msg.id, error: { code: -32000, message: 'thread not found: missing-thread' } });
    else if (msg.params.threadId === 'unloaded') send({ id: msg.id, error: { code: -32000, message: 'thread not loaded: unloaded' } });
    else {
      const settings = threadSettings.get(msg.params.threadId) ?? { model: 'gpt-5.6-sol', effort: 'high' };
      send({ id: msg.id, result: { thread: { id: msg.params.threadId, sessionId: 'session-1', name: '详情会话', preview: '查看详情', cwd: '/tmp/project', updatedAt: 20, status: { type: 'active', activeFlags: ['waitingOnUserInput'] }, source: 'vscode', model: settings.model, reasoningEffort: settings.effort, canAcceptDirectInput: loadedThreads.has(msg.params.threadId) ? true : null, turns: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: '请查看', text_elements: [] }] }, { type: 'agentMessage', text: '正在查看' }, { type: 'commandExecution', command: 'pnpm test' }] }] } } });
    }
  }
  if (msg.method === 'thread/name/set') {
    activeThreadName = msg.params.name;
    send({ id: msg.id, result: {} });
  }
  if (msg.method === 'thread/settings/update') {
    if (settingsFailure) send({ id: msg.id, error: { code: -32000, message: 'settings update failed' } });
    else {
      settingsWritten = true;
      if (!ignoreSettings) threadSettings.set(msg.params.threadId, { model: msg.params.model, effort: msg.params.effort });
      send({ id: msg.id, result: {} });
    }
  }
  if (msg.method === 'turn/start') {
    if (rejectAdditionalContext && msg.params.additionalContext) {
      send({ id: msg.id, error: { code: -32602, message: 'unknown field additionalContext: invalid params' } });
      continue;
    }
    send({ id: msg.id, result: { turn: { id: 'turn-1' } } });
    if (interaction === 'questions') {
      send({ method: 'item/tool/requestUserInput', id: 500, params: { threadId: activeThreadId, turnId: 'turn-1', itemId: 'item-input', questions: [
        { id: 'environment', header: '环境', question: '选择环境', isOther: false, isSecret: false, options: [{ label: '测试', description: '使用测试环境' }, { label: '生产', description: '使用生产环境' }] },
        { id: 'note', header: '说明', question: '补充说明', isOther: false, isSecret: false, options: null }
      ] } });
      continue;
    }
    if (interaction === 'approval') {
      send({ method: 'item/commandExecution/requestApproval', id: 501, params: { threadId: activeThreadId, turnId: 'turn-1', itemId: 'item-command', command: 'pnpm test', reason: '运行测试', availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] } });
      continue;
    }
    if (activeThreadId === 'legacy-compact') {
      send({ method: 'error', params: { threadId: activeThreadId, error: { message: 'Error running remote compact task: model requires a newer version of Codex' } } });
      continue;
    }
    const hasInjectedContext = msg.params.additionalContext?.['feishu.bridge.turn']?.value === '{"chat":"oc_context"}';
    const delta = msg.params.clientUserMessageId === 'context-message'
      ? hasInjectedContext ? '上下文已注入' : '上下文缺失'
      : msg.params.clientUserMessageId === 'msg-1' && activeThreadName === '干净标题' ? '兼容完成' : '完成';
    send({ method: 'item/agentMessage/delta', params: { threadId: activeThreadId, turnId: 'turn-1', itemId: 'item-1', delta } });
    send({ method: 'turn/completed', params: { threadId: activeThreadId, turn: { id: 'turn-1', status: 'completed' } } });
  }
  if (msg.method === 'turn/interrupt') send({ id: msg.id, result: {} });
  if (msg.method === 'thread/archive') send({ id: msg.id, result: {} });
  if (msg.method === 'thread/unarchive') send({ id: msg.id, result: { thread: { id: msg.params.threadId, name: '已恢复', preview: '恢复成功', cwd: '/tmp/project', updatedAt: 40, status: { type: 'idle' } } } });
  if (msg.method === 'thread/fork') send({ id: msg.id, result: { thread: { id: 'thread-fork', name: '分支会话', preview: '分支', cwd: msg.params.cwd, updatedAt: 50, status: { type: 'idle' }, forkedFromId: msg.params.threadId } } });
  if (msg.method === 'thread/compact/start' || msg.method === 'review/start') send({ id: msg.id, result: {} });
  if (!msg.method && msg.id === 500) {
    const valid = msg.result?.answers?.environment?.answers?.[0] === '测试' && msg.result?.answers?.note?.answers?.[0] === '继续';
    send({ method: 'item/agentMessage/delta', params: { threadId: activeThreadId, turnId: 'turn-1', itemId: 'item-1', delta: valid ? '回答已接收' : '回答错误' } });
    send({ method: 'turn/completed', params: { threadId: activeThreadId, turn: { id: 'turn-1', status: 'completed' } } });
  }
  if (!msg.method && msg.id === 501) {
    send({ method: 'item/agentMessage/delta', params: { threadId: activeThreadId, turnId: 'turn-1', itemId: 'item-1', delta: msg.result?.decision === 'acceptForSession' ? '会话内允许' : '审批错误' } });
    send({ method: 'turn/completed', params: { threadId: activeThreadId, turn: { id: 'turn-1', status: 'completed' } } });
  }
}
`, 'utf8');
  await chmod(path, 0o700);
  return path;
}

async function readLog(binary: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(dirname(binary), 'requests.jsonl'), 'utf8');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readRequests(binary: string): Promise<Array<{ method: string; params?: Record<string, unknown> }>> {
  return (await readLog(binary)).filter(
    (entry): entry is { method: string; params?: Record<string, unknown> } => typeof entry.method === 'string',
  );
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('CodexAdapter', () => {
  it('lists sessions by project cwd', async () => {
    const adapter = new CodexAdapter({ binary: await fakeCodex() });
    await expect(adapter.isAvailable()).resolves.toBe(true);
    await expect(adapter.listSessions('/tmp/project')).resolves.toEqual([{
      threadId: 'thread-existing',
      name: '旧会话',
      preview: '修复卡片',
      cwd: '/tmp/project',
      status: 'idle',
      updatedAt: 10_000,
    }]);
    await expect(adapter.listSessionPage?.('/tmp/project')).resolves.toMatchObject({ nextCursor: 'cursor-2' });
    await expect(adapter.listProjectRoots?.()).resolves.toEqual(['/tmp/project']);
    await expect(adapter.readSession?.('thread-existing')).resolves.toMatchObject({
      sessionId: 'session-1',
      source: 'vscode',
      turnCount: 1,
      recentActivity: [
        { kind: '用户', text: '请查看' },
        { kind: '助手', text: '正在查看' },
        { kind: '工具', text: 'pnpm test' },
      ],
    });
    await expect(adapter.archiveSession?.('thread-existing')).resolves.toBeUndefined();
    await expect(adapter.listSessionPage?.('/tmp/project', undefined, '匹配')).resolves.toMatchObject({
      sessions: [expect.objectContaining({ name: '匹配会话' })],
    });
    await expect(adapter.unarchiveSession?.('thread-existing')).resolves.toMatchObject({ name: '已恢复' });
    await expect(adapter.forkSession?.('thread-existing', '/tmp/project')).resolves.toMatchObject({
      threadId: 'thread-fork',
      forkedFromId: 'thread-existing',
    });
    await expect(adapter.compactSession?.('thread-existing')).resolves.toBeUndefined();
    await expect(adapter.reviewSession?.('thread-existing')).resolves.toBeUndefined();
    await adapter.close();
  });

  it('round-trips every request_user_input question', async () => {
    const adapter = new CodexAdapter({ binary: await fakeCodex({ interaction: 'questions' }) });
    const run = adapter.run({ prompt: '请提问', cwd: '/tmp/project' });
    const iterator = run.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'system' } });
    const requestEvent = await iterator.next();
    expect(requestEvent.value).toMatchObject({
      type: 'ui_request',
      request: {
        method: 'form',
        questions: [
          { id: 'environment', options: [
            { label: '测试', description: '使用测试环境' },
            { label: '生产', description: '使用生产环境' },
          ] },
          { id: 'note' },
        ],
      },
    });
    const requestId = requestEvent.value && requestEvent.value.type === 'ui_request' ? requestEvent.value.request.id : '';
    expect(run.respondToUi?.(requestId, { answers: { environment: ['测试'], note: ['继续'] } })).toBe(true);
    const rest: AgentEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }
    expect(rest).toContainEqual({ type: 'text', delta: '回答已接收' });
    await adapter.close();
  });

  it('round-trips session-scoped approval decisions', async () => {
    const adapter = new CodexAdapter({ binary: await fakeCodex({ interaction: 'approval' }) });
    const run = adapter.run({ prompt: '请审批', cwd: '/tmp/project' });
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next();
    const requestEvent = await iterator.next();
    expect(requestEvent.value).toMatchObject({
      type: 'ui_request',
      request: { method: 'approval', decisions: ['accept', 'acceptForSession', 'decline', 'cancel'] },
    });
    const requestId = requestEvent.value && requestEvent.value.type === 'ui_request' ? requestEvent.value.request.id : '';
    expect(run.respondToUi?.(requestId, { decision: 'acceptForSession' })).toBe(true);
    const rest: AgentEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }
    expect(rest).toContainEqual({ type: 'text', delta: '会话内允许' });
    await adapter.close();
  });

  it('starts a thread and translates app-server events', async () => {
    const adapter = new CodexAdapter({ binary: await fakeCodex() });
    const run = adapter.run({ prompt: '请测试', cwd: '/tmp/project' });
    await expect(collect(run.events)).resolves.toEqual([
      { type: 'system', sessionId: 'thread-new', cwd: '/tmp/project' },
      { type: 'text', delta: '完成' },
      { type: 'done', sessionId: 'thread-new' },
    ]);
    await adapter.close();
  });

  it('renames an existing session for Feishu topic title sync', async () => {
    const adapter = new CodexAdapter({ binary: await fakeCodex() });
    await adapter.renameSession('thread-existing', ' 飞书话题标题 ');
    await expect(adapter.listSessions('/tmp/project')).resolves.toContainEqual(expect.objectContaining({
      threadId: 'thread-existing',
      name: '飞书话题标题',
    }));
    await adapter.close();
  });

  it('writes desktop-compatible metadata, a clean title and a stable user message id', async () => {
    const adapter = new CodexAdapter({ binary: await fakeCodex() });
    const run = adapter.run({
      prompt: '请测试',
      title: '干净标题',
      clientUserMessageId: 'msg-1',
      cwd: '/tmp/project',
    });
    await expect(collect(run.events)).resolves.toEqual([
      { type: 'system', sessionId: 'thread-new', cwd: '/tmp/project' },
      { type: 'text', delta: '兼容完成' },
      { type: 'done', sessionId: 'thread-new' },
    ]);
    await adapter.close();
  });

  it('passes structured Feishu context through turn/start', async () => {
    const adapter = new CodexAdapter({ binary: await fakeCodex() });
    const run = adapter.run({
      prompt: '总结群聊',
      clientUserMessageId: 'context-message',
      cwd: '/tmp/project',
      additionalContext: {
        'feishu.bridge.turn': { value: '{"chat":"oc_context"}', kind: 'application' },
      },
    });
    await expect(collect(run.events)).resolves.toContainEqual({ type: 'text', delta: '上下文已注入' });
    await adapter.close();
  });

  it('falls back when an older app-server rejects additionalContext', async () => {
    const adapter = new CodexAdapter({ binary: await fakeCodex({ rejectAdditionalContext: true }) });
    const run = adapter.run({
      prompt: '总结群聊',
      cwd: '/tmp/project',
      additionalContext: {
        'feishu.bridge.turn': { value: '{"chat":"oc_context"}', kind: 'application' },
      },
    });
    await expect(collect(run.events)).resolves.toContainEqual({ type: 'done', sessionId: 'thread-new' });
    await adapter.close();
  });

  it('falls back when an older app-server rejects desktop metadata', async () => {
    const adapter = new CodexAdapter({ binary: await fakeCodex({ rejectDesktopMetadata: true }) });
    const run = adapter.run({ prompt: '请测试', cwd: '/tmp/project' });
    await expect(collect(run.events)).resolves.toContainEqual({ type: 'done', sessionId: 'thread-new' });
    await adapter.close();
  });

  it('resumes a persisted session when thread/read reports it is not loaded', async () => {
    const adapter = new CodexAdapter({ binary: await fakeCodex() });
    await expect(adapter.readSession?.('unloaded')).resolves.toMatchObject({
      threadId: 'unloaded',
      sessionId: 'session-2',
      turnCount: 1,
      recentActivity: [{ kind: '助手', text: '已恢复' }],
    });
    await adapter.close();
  });

  it('starts a replacement thread when an empty thread has no rollout to resume', async () => {
    const adapter = new CodexAdapter({ binary: await fakeCodex() });
    const run = adapter.run({ prompt: '继续处理', sessionId: 'missing-rollout', cwd: '/tmp/project' });
    await expect(collect(run.events)).resolves.toEqual([
      { type: 'ui_notice', message: '原 Codex 会话没有可恢复的执行记录，已自动新建会话。', level: 'warning' },
      { type: 'system', sessionId: 'thread-new', cwd: '/tmp/project' },
      { type: 'text', delta: '完成' },
      { type: 'done', sessionId: 'thread-new' },
    ]);
    await adapter.close();
  });

  it('resumes historical threads without injecting a model', async () => {
    const adapter = new CodexAdapter({ binary: await fakeCodex() });
    const run = adapter.run({ prompt: '继续处理', sessionId: 'thread-existing', cwd: '/tmp/project' });
    await expect(collect(run.events)).resolves.toEqual([
      { type: 'system', sessionId: 'thread-existing', cwd: '/tmp/project' },
      { type: 'text', delta: '完成' },
      { type: 'done', sessionId: 'thread-existing' },
    ]);
    await adapter.close();
  });

  it('preflights the resumed thread model before starting the turn', async () => {
    const binary = await fakeCodex();
    const adapter = new CodexAdapter({ binary });
    await collect(adapter.run({ prompt: '继续处理', sessionId: 'thread-existing', cwd: '/tmp/project' }).events);
    const requests = await readRequests(binary);
    const methods = requests.map((request) => request.method);
    expect(methods.indexOf('thread/resume')).toBeLessThan(methods.indexOf('model/list'));
    expect(methods.indexOf('model/list')).toBeLessThan(methods.indexOf('turn/start'));
    expect(requests.find((request) => request.method === 'model/list')?.params).toMatchObject({ includeHidden: true });
    expect(requests.find((request) => request.method === 'turn/start')?.params).not.toHaveProperty('model');
    await adapter.close();
  });

  it('fails the turn when the resumed thread model is unavailable', async () => {
    const binary = await fakeCodex({ resumeSettings: { model: 'retired-model', effort: 'high' } });
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.run({ prompt: '继续处理', sessionId: 'thread-existing', cwd: '/tmp/project' }).events);
    expect(events).toEqual([{
      type: 'error',
      message: '当前会话的模型 retired-model 在这台设备上不可用。请用 /model 重新选择模型，或 /new 新建会话。',
    }]);
    const requests = await readRequests(binary);
    expect(requests.filter((request) => request.method === 'model/list')).toHaveLength(2);
    expect(requests.some((request) => request.method === 'turn/start')).toBe(false);
    expect(requests.some((request) => request.method === 'thread/start')).toBe(false);
    expect(requests.some((request) => request.method === 'thread/fork')).toBe(false);
    expect(requests.some((request) => request.method === 'thread/settings/update')).toBe(false);
    await adapter.close();
  });

  it('fails the turn when the resumed thread effort is unsupported', async () => {
    const binary = await fakeCodex({ resumeSettings: { model: 'gpt-6-astra', effort: 'high' } });
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.run({ prompt: '继续处理', sessionId: 'thread-existing', cwd: '/tmp/project' }).events);
    expect(events).toEqual([{
      type: 'error',
      message: '模型 gpt-6-astra 不支持强度 high。请用 /model 重新选择，或 /new 新建会话。',
    }]);
    const requests = await readRequests(binary);
    expect(requests.some((request) => request.method === 'turn/start')).toBe(false);
    expect(requests.some((request) => request.method === 'thread/start')).toBe(false);
    expect(requests.some((request) => request.method === 'thread/fork')).toBe(false);
    expect(requests.some((request) => request.method === 'thread/settings/update')).toBe(false);
    await adapter.close();
  });

  it('skips the resumed thread preflight when model/list fails', async () => {
    const binary = await fakeCodex({ modelListFailure: 'throw' });
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.run({ prompt: '继续处理', sessionId: 'thread-existing', cwd: '/tmp/project' }).events);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    const requests = await readRequests(binary);
    expect(requests.some((request) => request.method === 'turn/start')).toBe(true);
    await adapter.close();
  });

  it('skips the resumed thread preflight when the model list is empty', async () => {
    const binary = await fakeCodex({ modelListFailure: 'empty' });
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.run({ prompt: '继续处理', sessionId: 'thread-existing', cwd: '/tmp/project' }).events);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    const requests = await readRequests(binary);
    expect(requests.some((request) => request.method === 'turn/start')).toBe(true);
    await adapter.close();
  });

  it('refreshes the model cache once before rejecting a resumed thread', async () => {
    const binary = await fakeCodex({
      modelListMissingOnce: true,
      resumeSettings: { model: 'gpt-6-astra', effort: 'medium' },
    });
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.run({ prompt: '继续处理', sessionId: 'thread-existing', cwd: '/tmp/project' }).events);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    const requests = await readRequests(binary);
    expect(requests.filter((request) => request.method === 'model/list')).toHaveLength(2);
    expect(requests.some((request) => request.method === 'turn/start')).toBe(true);
    await adapter.close();
  });

  it('skips the preflight when the forced model list refresh fails', async () => {
    const binary = await fakeCodex({
      modelListMissingOnce: true,
      modelListSecondFailure: 'throw',
      resumeSettings: { model: 'gpt-6-astra', effort: 'medium' },
    });
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.run({ prompt: '继续处理', sessionId: 'thread-existing', cwd: '/tmp/project' }).events);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    const requests = await readRequests(binary);
    expect(requests.filter((request) => request.method === 'model/list')).toHaveLength(2);
    expect(requests.some((request) => request.method === 'turn/start')).toBe(true);
    await adapter.close();
  });

  it('preflights a pending model before replacing a thread with no rollout', async () => {
    const binary = await fakeCodex();
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.run({
      prompt: '继续处理',
      sessionId: 'missing-rollout',
      cwd: '/tmp/project',
      pendingModel: 'retired-model',
      pendingEffort: 'high',
    }).events);
    expect(events).toEqual([{
      type: 'model_switch',
      status: 'failed',
      next: { model: 'retired-model', effort: 'high' },
      message: '待生效的模型 retired-model 在这台设备上不可用。请重新选择模型。',
    }, {
      type: 'error',
      message: '待生效的模型 retired-model 在这台设备上不可用。请重新选择模型。',
    }]);
    const requests = await readRequests(binary);
    expect(requests.some((request) => request.method === 'thread/start')).toBe(false);
    expect(requests.some((request) => request.method === 'turn/start')).toBe(false);
    await adapter.close();
  });

  it('does not block a resumed thread whose model is unknown', async () => {
    const binary = await fakeCodex({ resumeSettings: { model: null, effort: null } });
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.run({ prompt: '继续处理', sessionId: 'thread-existing', cwd: '/tmp/project' }).events);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    const requests = await readRequests(binary);
    expect(requests.some((request) => request.method === 'model/list')).toBe(false);
    expect(requests.some((request) => request.method === 'turn/start')).toBe(true);
    await adapter.close();
  });

  it('replaces a historical thread when its model cannot compact', async () => {
    const adapter = new CodexAdapter({ binary: await fakeCodex() });
    const run = adapter.run({ prompt: '继续处理', sessionId: 'legacy-compact', cwd: '/tmp/project' });
    await expect(collect(run.events)).resolves.toEqual([
      { type: 'system', sessionId: 'legacy-compact', cwd: '/tmp/project' },
      { type: 'ui_notice', message: '原 Codex 会话使用了当前设备不兼容的配置，已自动新建会话并重试。', level: 'warning' },
      { type: 'system', sessionId: 'thread-new', cwd: '/tmp/project' },
      { type: 'text', delta: '完成' },
      { type: 'done', sessionId: 'thread-new' },
    ]);
    await adapter.close();
  });

  it('ignores a caller-supplied model on every turn', async () => {
    const binary = await fakeCodex();
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.run({
      prompt: '继续处理',
      sessionId: 'thread-existing',
      model: 'should-not-be-used',
      cwd: '/tmp/project',
    }).events);
    expect(events.find((event) => event.type === 'system')).not.toHaveProperty('model');
    const requests = await readRequests(binary);
    const turnStart = requests.find((request) => request.method === 'turn/start');
    expect(turnStart).toBeDefined();
    expect(turnStart?.params).not.toHaveProperty('model');
    expect(requests.some((request) => request.method === 'thread/settings/update')).toBe(false);
    await adapter.close();
  });

  it('reads thread model state without resuming the thread', async () => {
    const binary = await fakeCodex();
    const adapter = new CodexAdapter({ binary });
    await expect(adapter.readThreadModel('thread-existing')).resolves.toEqual({
      model: 'gpt-5.6-sol',
      effort: 'high',
      loaded: true,
      canAcceptDirectInput: true,
    });
    const requests = await readRequests(binary);
    expect(requests.some((request) => request.method === 'thread/resume')).toBe(false);
    expect(requests.some((request) => request.method === 'thread/read' && request.params?.includeTurns)).toBe(false);
    await expect(adapter.readThreadModel('missing-thread')).rejects.toBeInstanceOf(ThreadModelReadError);
    await adapter.close();
  });

  it('switches a loaded thread model and confirms both values by read-back', async () => {
    const binary = await fakeCodex();
    const adapter = new CodexAdapter({ binary });
    await expect(adapter.switchThreadModel('thread-existing', {
      model: 'gpt-6-astra',
      effort: 'ultra',
    })).resolves.toEqual({
      status: 'applied',
      previous: { model: 'gpt-5.6-sol', effort: 'high' },
      next: { model: 'gpt-6-astra', effort: 'ultra' },
    });
    const requests = await readRequests(binary);
    expect(requests.some((request) => request.method === 'thread/resume')).toBe(false);
    expect(requests.find((request) => request.method === 'thread/settings/update')?.params).toEqual({
      threadId: 'thread-existing',
      model: 'gpt-6-astra',
      effort: 'ultra',
    });
    await expect(adapter.readThreadModel('thread-existing')).resolves.toMatchObject({
      model: 'gpt-6-astra',
      effort: 'ultra',
    });
    await adapter.close();
  });

  it('resumes an unloaded thread before writing its model settings', async () => {
    const binary = await fakeCodex();
    const adapter = new CodexAdapter({ binary });
    await expect(adapter.readThreadModel('thread-cold')).resolves.toMatchObject({
      model: 'gpt-5.6-sol',
      effort: 'high',
      loaded: false,
    });
    await expect(adapter.switchThreadModel('thread-cold', {
      model: 'gpt-6-astra',
      effort: 'medium',
    })).resolves.toMatchObject({ status: 'applied' });
    const methods = (await readRequests(binary)).map((request) => request.method);
    expect(methods.indexOf('thread/resume')).toBeGreaterThan(methods.indexOf('thread/read'));
    expect(methods.indexOf('thread/settings/update')).toBeGreaterThan(methods.indexOf('thread/resume'));
    expect(methods.lastIndexOf('thread/read')).toBeGreaterThan(methods.indexOf('thread/settings/update'));
    await adapter.close();
  });

  it('reports an active writer while switching a thread model', async () => {
    const binary = await fakeCodex({ activeWriter: true });
    const adapter = new CodexAdapter({ binary });
    const result = await adapter.switchThreadModel('thread-cold', {
      model: 'gpt-6-astra',
      effort: 'medium',
    });
    expect(result.status).toBe('active_writer');
    expect(result.message).toBe(CODEX_ACTIVE_WRITER_MESSAGE);
    const requests = await readRequests(binary);
    expect(requests.some((request) => request.method === 'thread/settings/update')).toBe(false);
    await adapter.close();
  });

  it('fails when the settings write cannot be confirmed by read-back', async () => {
    const adapter = new CodexAdapter({ binary: await fakeCodex({ ignoreSettings: true }) });
    const result = await adapter.switchThreadModel('thread-existing', {
      model: 'gpt-6-astra',
      effort: 'ultra',
    });
    expect(result.status).toBe('failed');
    expect(result.next).toEqual({ model: 'gpt-6-astra', effort: 'ultra' });
    await adapter.close();
  });

  it('lists models with hidden filtering and normalized reasoning efforts', async () => {
    const adapter = new CodexAdapter({ binary: await fakeCodex() });
    await expect(adapter.listModels()).resolves.toEqual([
      expect.objectContaining({
        model: 'gpt-5.6-sol',
        displayName: 'Sol',
        isDefault: true,
        supportedReasoningEfforts: ['low', 'high'],
      }),
      expect.objectContaining({
        model: 'gpt-6-astra',
        displayName: 'Astra',
        supportedReasoningEfforts: ['medium', 'ultra'],
      }),
    ]);
    await expect(adapter.listModels({ includeHidden: true })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ model: 'hidden-model', hidden: true })]),
    );
    await adapter.close();
  });

  it('reports an active writer without creating or forking a thread', async () => {
    const binary = await fakeCodex({ activeWriter: true });
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.run({
      prompt: '继续处理',
      sessionId: 'thread-desktop',
      cwd: '/tmp/project',
    }).events);
    expect(events).toContainEqual({ type: 'error', message: CODEX_ACTIVE_WRITER_MESSAGE });
    const requests = await readRequests(binary);
    expect(requests.filter((request) => request.method === 'thread/resume')).toHaveLength(1);
    expect(requests.some((request) => request.method === 'thread/start')).toBe(false);
    expect(requests.some((request) => request.method === 'thread/fork')).toBe(false);
    await adapter.close();
  });

  it('applies a pending choice to a new thread before the first turn', async () => {
    const binary = await fakeCodex();
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.run({
      prompt: '第一轮',
      cwd: '/tmp/project',
      pendingModel: 'gpt-6-astra',
      pendingEffort: 'ultra',
    }).events);
    expect(events).toContainEqual({
      type: 'model_switch',
      status: 'applied',
      next: { model: 'gpt-6-astra', effort: 'ultra' },
    });
    expect(events).toContainEqual({ type: 'ui_notice', message: '模型已切换：Astra' });
    const requests = await readRequests(binary);
    const methods = requests.map((request) => request.method);
    expect(methods.indexOf('model/list')).toBeLessThan(methods.indexOf('thread/start'));
    expect(methods.indexOf('thread/start')).toBeLessThan(methods.indexOf('thread/settings/update'));
    expect(methods.indexOf('thread/settings/update')).toBeLessThan(methods.indexOf('thread/read'));
    expect(methods.indexOf('thread/read')).toBeLessThan(methods.indexOf('turn/start'));
    expect(requests.find((request) => request.method === 'thread/settings/update')?.params).toEqual({
      threadId: 'thread-new',
      model: 'gpt-6-astra',
      effort: 'ultra',
    });
    expect(requests.find((request) => request.method === 'turn/start')?.params).not.toHaveProperty('model');
    await adapter.close();
  });

  it('rejects an unavailable pending model before creating a thread', async () => {
    const binary = await fakeCodex();
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.run({
      prompt: '第一轮',
      cwd: '/tmp/project',
      pendingModel: 'missing-model',
      pendingEffort: 'medium',
    }).events);
    expect(events).toContainEqual({
      type: 'model_switch',
      status: 'failed',
      next: { model: 'missing-model', effort: 'medium' },
      message: '待生效的模型 missing-model 在这台设备上不可用。请重新选择模型。',
    });
    expect(events).toContainEqual({
      type: 'error',
      message: '待生效的模型 missing-model 在这台设备上不可用。请重新选择模型。',
    });
    const requests = await readRequests(binary);
    expect(requests.some((request) => request.method === 'thread/start')).toBe(false);
    expect(requests.some((request) => request.method === 'turn/start')).toBe(false);
    expect(requests.some((request) => request.method === 'thread/settings/update')).toBe(false);
    await adapter.close();
  });

  it('rejects an unsupported pending effort before creating a thread', async () => {
    const binary = await fakeCodex();
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.run({
      prompt: '第一轮',
      cwd: '/tmp/project',
      pendingModel: 'gpt-6-astra',
      pendingEffort: 'high',
    }).events);
    expect(events).toContainEqual({
      type: 'model_switch',
      status: 'failed',
      next: { model: 'gpt-6-astra', effort: 'high' },
      message: '待生效的模型 gpt-6-astra 不支持强度 high。请重新选择。',
    });
    const requests = await readRequests(binary);
    expect(requests.some((request) => request.method === 'thread/start')).toBe(false);
    await adapter.close();
  });

  it('reports an empty model list as a validation failure without creating a thread', async () => {
    const binary = await fakeCodex({ modelListFailure: 'empty' });
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.run({
      prompt: '第一轮',
      cwd: '/tmp/project',
      pendingModel: 'gpt-6-astra',
      pendingEffort: 'medium',
    }).events);
    expect(events).toContainEqual({
      type: 'model_switch',
      status: 'validation_failed',
      next: { model: 'gpt-6-astra', effort: 'medium' },
      message: '模型列表暂时为空，无法应用待生效模型，请稍后重试。',
    });
    const requests = await readRequests(binary);
    expect(requests.some((request) => request.method === 'thread/start')).toBe(false);
    await adapter.close();
  });

  it('skips pending validation when model/list fails and still applies the choice', async () => {
    const binary = await fakeCodex({ modelListFailure: 'throw' });
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.run({
      prompt: '第一轮',
      cwd: '/tmp/project',
      pendingModel: 'gpt-6-astra',
      pendingEffort: 'ultra',
    }).events);
    expect(events).toContainEqual({
      type: 'model_switch',
      status: 'applied',
      next: { model: 'gpt-6-astra', effort: 'ultra' },
    });
    const requests = await readRequests(binary);
    expect(requests.some((request) => request.method === 'thread/start')).toBe(true);
    expect(requests.some((request) => request.method === 'thread/settings/update')).toBe(true);
    await adapter.close();
  });

  it('stops a new thread when its pending settings write fails', async () => {
    const binary = await fakeCodex({ settingsFailure: true });
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.run({
      prompt: '第一轮',
      cwd: '/tmp/project',
      pendingModel: 'gpt-6-astra',
      pendingEffort: 'ultra',
    }).events);
    expect(events).toContainEqual({
      type: 'model_switch',
      status: 'failed',
      next: { model: 'gpt-6-astra', effort: 'ultra' },
      message: 'settings update failed',
    });
    expect(events).toContainEqual({ type: 'error', message: 'settings update failed' });
    const requests = await readRequests(binary);
    expect(requests.some((request) => request.method === 'thread/start')).toBe(true);
    expect(requests.some((request) => request.method === 'turn/start')).toBe(false);
    await adapter.close();
  });

  it('runs the turn with the thread settings when the pending read-back fails', async () => {
    const binary = await fakeCodex({ readFailure: true });
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.run({
      prompt: '第一轮',
      cwd: '/tmp/project',
      pendingModel: 'gpt-6-astra',
      pendingEffort: 'ultra',
    }).events);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'model_switch',
      status: 'unconfirmed',
      next: { model: 'gpt-6-astra', effort: 'ultra' },
    }));
    expect(events).toContainEqual({
      type: 'ui_notice',
      message: '模型设置已提交但未能确认，本轮先用线程当前设置执行；稍后重试。',
      level: 'warning',
    });
    expect(events).toContainEqual({ type: 'text', delta: '完成' });
    const requests = await readRequests(binary);
    expect(requests.some((request) => request.method === 'turn/start')).toBe(true);
    await adapter.close();
  });

  it('applies a pending choice to an existing thread after resuming it', async () => {
    const binary = await fakeCodex();
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.run({
      prompt: '继续',
      sessionId: 'thread-cold',
      cwd: '/tmp/project',
      pendingModel: 'gpt-6-astra',
      pendingEffort: 'ultra',
    }).events);
    expect(events).toContainEqual(expect.objectContaining({ type: 'model_switch', status: 'applied' }));
    const requests = await readRequests(binary);
    const methods = requests.map((request) => request.method);
    expect(methods.indexOf('thread/resume')).toBeGreaterThan(-1);
    expect(methods.indexOf('thread/resume')).toBeLessThan(methods.indexOf('model/list'));
    expect(methods.indexOf('thread/settings/update')).toBeGreaterThan(methods.indexOf('model/list'));
    expect(methods.indexOf('thread/settings/update')).toBeLessThan(methods.indexOf('turn/start'));
    await adapter.close();
  });

  it('keeps a pending choice when an active writer blocks the resume', async () => {
    const binary = await fakeCodex({ activeWriter: true });
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.run({
      prompt: '继续',
      sessionId: 'thread-desktop',
      cwd: '/tmp/project',
      pendingModel: 'gpt-6-astra',
      pendingEffort: 'ultra',
    }).events);
    expect(events).toContainEqual({
      type: 'model_switch',
      status: 'active_writer',
      next: { model: 'gpt-6-astra', effort: 'ultra' },
      message: CODEX_ACTIVE_WRITER_MESSAGE,
    });
    expect(events).toContainEqual({ type: 'error', message: CODEX_ACTIVE_WRITER_MESSAGE });
    const requests = await readRequests(binary);
    expect(requests.some((request) => request.method === 'thread/settings/update')).toBe(false);
    expect(requests.some((request) => request.method === 'turn/start')).toBe(false);
    await adapter.close();
  });

  it('runs an existing thread when the pending settings write fails', async () => {
    const binary = await fakeCodex({ settingsFailure: true });
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.run({
      prompt: '继续',
      sessionId: 'thread-existing',
      cwd: '/tmp/project',
      pendingModel: 'gpt-6-astra',
      pendingEffort: 'ultra',
    }).events);
    expect(events).toContainEqual(expect.objectContaining({ type: 'model_switch', status: 'failed' }));
    expect(events).toContainEqual({ type: 'ui_notice', message: 'settings update failed', level: 'warning' });
    expect(events).toContainEqual({ type: 'text', delta: '完成' });
    await adapter.close();
  });

  it('releases the app-server after the idle grace period', async () => {
    const binary = await fakeCodex();
    const adapter = new CodexAdapter({ binary });
    await collect(adapter.run({ prompt: '跑完', cwd: '/tmp/project' }).events);
    const startedAt = Date.now();
    await adapter.releaseWriterIfIdle();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    const log = await readLog(binary);
    expect(log.filter((entry) => entry.event === 'app-server-exit')).toHaveLength(1);
  });

  it('cancels a pending release when a new run starts', async () => {
    const binary = await fakeCodex();
    const adapter = new CodexAdapter({ binary });
    await collect(adapter.run({ prompt: '第一轮', cwd: '/tmp/project' }).events);
    const release = adapter.releaseWriterIfIdle();
    const second = adapter.run({ prompt: '第二轮', cwd: '/tmp/project' });
    await release;
    await collect(second.events);
    expect((await readLog(binary)).filter((entry) => entry.event === 'app-server-exit')).toHaveLength(0);
    await adapter.releaseWriterIfIdle();
    expect((await readLog(binary)).filter((entry) => entry.event === 'app-server-exit')).toHaveLength(1);
    await adapter.close();
  });
});
