import { describe, expect, it } from 'vitest';
import { helpCard, projectWelcomeCard, projectsCard, sessionDetailCard, sessionProgressCard, sessionSearchCard, sessionsCard, statusCard, taskDetailCard, tasksCard, presetsCard, topicTitle, topicWelcomeCard, welcomeCard } from './templates';
import type { SessionDetail } from '../project/types';
import type { TaskRecord } from '../task/types';

function text(card: object): string {
  return JSON.stringify(card);
}

describe('project-first Feishu cards', () => {
  it('renders a Chinese welcome card with action buttons', () => {
    const rendered = text(welcomeCard());
    expect(rendered).toContain('选择项目');
    expect(rendered).toContain('使用帮助');
    expect(rendered).toContain('"type":"callback"');
    expect(rendered).not.toContain('chat_id');
  });

  it('renders empty and populated project/session states', () => {
    expect(text(projectsCard([]))).toContain('暂时没有可用项目');
    const unboundProject = text(projectsCard([{ projectKey: 'p1', name: '示例项目', cwd: '/tmp/demo', hostId: '本机' }]));
    expect(unboundProject).toContain('创建项目群');
    expect(unboundProject).not.toContain('查看会话');
    expect(text(projectsCard([{ projectKey: 'p1', name: '示例项目', cwd: '/tmp/demo', hostId: '本机', chatId: 'chat-1' }]))).toContain('查看会话');
    const emptySessions = text(sessionsCard('示例项目', []));
    expect(emptySessions).toContain('新建话题');
    expect(emptySessions).not.toContain('session.new');
    const sessions = text(sessionsCard('示例项目', [{ threadId: 'thread-1', preview: '修复卡片', status: 'idle', updatedAt: Date.now() }], 'cursor-2'));
    expect(sessions).toContain('继续此会话');
    expect(sessions).toContain('加载更多');
    expect(sessions).toContain('搜索会话');
    expect(sessions).not.toContain('"content":"归档"');
    const metadata = text(sessionsCard('示例项目', [{ threadId: 'thread-2', preview: '等待输入', status: 'active', activeFlags: ['waitingOnUserInput'], source: 'vscode', forkedFromId: 'thread-0', updatedAt: Date.now() }]));
    expect(metadata).toContain('等待输入');
    expect(metadata).not.toContain('VS Code');
    expect(metadata).not.toContain('分支会话');
    const assistant = text(projectsCard([{ projectKey: 'assistant::feishu', name: 'Feishu Assistant', cwd: '/tmp/assistant', kind: 'feishu-assistant' }]));
    expect(assistant).toContain('飞书聊天、文档与本地项目协作');
  });

  it('renders a CardKit form for session title search', () => {
    const card = text(sessionSearchCard('示例项目'));
    expect(card).toContain('session_search');
    expect(card).toContain('sessions.search');
    expect(card).toContain('form_action_type');
  });

  it('renders project and topic context without exposing internal ids', () => {
    const project = text(projectWelcomeCard({ name: '示例项目', cwd: '/tmp/demo' }));
    const topic = text(topicWelcomeCard('示例项目', '修复卡片', '/tmp/demo'));
    expect(project).toContain('项目工作台');
    expect(project).toContain('新建话题');
    expect(project).not.toContain('session.new');
    const assistant = text(projectWelcomeCard({ name: 'Feishu Assistant', cwd: '/tmp/assistant', kind: 'feishu-assistant' }));
    expect(assistant).toContain('飞书 Skills / CLI');
    expect(topic).toContain('示例项目 · 修复卡片');
    expect(topic).toContain('当前位置：Codex 工作话题');
    expect(topic).toContain('会话会保存到本机 Codex');
    expect(topic).toContain('按时间排序');
    expect(topic).not.toContain('session.new');
    for (const emoji of ['👋', '📁', '📚', '📊', '🔄', '⏹', '💡']) {
      expect(project).not.toContain(emoji);
      expect(topic).not.toContain(emoji);
    }
    expect(topic).not.toContain('thread_id');
  });

  it('builds useful topic titles for unnamed, generic and long sessions', () => {
    expect(topicTitle('示例项目', '')).toBe('示例项目 · 新会话');
    expect(topicTitle('示例项目', 'omp 会话已连接')).toBe('示例项目 · 新会话');
    expect(topicTitle('示例项目', '  修复   飞书  ')).toBe('示例项目 · 修复 飞书');
    expect(Array.from(topicTitle('项目', '很长的会话名称'.repeat(20))).length).toBeLessThanOrEqual(80);
    expect(topicTitle('项目', '很长的会话名称'.repeat(20)).endsWith('…')).toBe(true);
  });

  it('renders manual and automatic session sync actions', () => {
    const detail: SessionDetail = {
      threadId: 'thread-1', preview: '最新进度', cwd: '/tmp/project', status: 'active', updatedAt: Date.now(),
      turnCount: 2, recentActivity: [{ kind: '助手', text: '正在执行测试' }],
    };
    const card = text(sessionProgressCard('示例项目', detail));
    expect(card).toContain('刷新进度');
    expect(card).toContain('开启自动刷新');
    expect(card).toContain('停止任务');
    expect(text(sessionProgressCard('示例项目', detail, true))).toContain('关闭自动刷新');
    const idle = { ...detail, status: 'idle' as const };
    expect(text(sessionProgressCard('示例项目', idle))).not.toContain('"content":"停止任务"');
  });

  it('moves archive into session details instead of the main list', () => {
    const detail: SessionDetail = {
      threadId: 'thread-1', name: '修复卡片', preview: '最新进度', cwd: '/tmp/project', status: 'idle', updatedAt: Date.now(),
      turnCount: 2, recentActivity: [{ kind: '助手', text: '已完成' }],
    };
    const card = text(sessionDetailCard('示例项目', detail));
    expect(card).toContain('归档会话');
    expect(card).toContain('返回会话列表');
  });

  it('keeps task cards concise while exposing acceptance evidence', () => {
    const task: TaskRecord = {
      taskId: 'task-1', scope: 'chat:topic', chatId: 'chat', topicId: 'topic',
      projectKey: 'local::/tmp/project', projectName: '示例项目', cwd: '/tmp/project',
      sourceMessageId: 'message-1',
      title: '检查发布前状态', createdBy: 'user', createdAt: Date.now(), updatedAt: Date.now(),
      status: 'succeeded', stage: '空闲', summary: '检查完成', toolCount: 3,
      failedToolCount: 0, testCount: 2, failedTestCount: 0, changedLines: 0,
    };
    const list = text(tasksCard([task]));
    expect(list).toContain('检查发布前状态');
    expect(list).toContain('查看详情');
    expect(list).toContain('进入原话题查看完整过程');
    expect(list).not.toContain('chat:topic');
    const detail = text(taskDetailCard(task));
    expect(detail).toContain('验收摘要');
    expect(detail).toContain('工具：3 次');
    expect(detail).toContain('测试：2 次');
    expect(detail).toContain('改动：约 0 行');
    const presets = text(presetsCard([{ id: 'check', name: '发布前检查', description: '检查类型和测试。' }]));
    expect(presets).toContain('发布前检查');
    expect(presets).toContain('使用模板');
  });

  it('shows the Codex thread model and Chinese reasoning strength on the status card', () => {
    const card = text(statusCard({
      cwd: '/tmp/project',
      sessionId: 'thread-1',
      sessionStale: false,
      agentName: 'Codex',
      scope: 'chat:topic',
      chatMode: 'topic',
      model: { displayName: 'Astra', effort: 'high' },
    }));
    expect(card).toContain('模型：Astra · 强度：高');
    expect(card).toContain('切换模型');
    expect(card).toContain('本话题：独立会话');
    expect(card).not.toContain('chat:topic');
    expect(card).not.toContain('范围：');
    expect(card).not.toContain('话题独立 session');
    for (const term of ['线程', '覆盖', 'Session']) expect(card).not.toContain(term);
  });

  it.each(['p2p', 'group'] as const)(
    'shows a %s scope as an independent session without the raw scope',
    (chatMode) => {
      const card = text(statusCard({
        cwd: '/tmp/project',
        sessionId: 'thread-1',
        sessionStale: false,
        agentName: 'Codex',
        scope: 'chat-dm',
        chatMode,
      }));
      expect(card).toContain('会话：独立');
      expect(card).not.toContain('chat-dm');
      expect(card).not.toContain('范围：');
      for (const term of ['线程', '覆盖', 'Session']) expect(card).not.toContain(term);
    },
  );

  it('maps every documented reasoning effort to its Chinese label', () => {
    const labels: Record<string, string> = { low: '低', medium: '中', high: '高', xhigh: '极高', ultra: '最高' };
    for (const [effort, label] of Object.entries(labels)) {
      const card = text(statusCard({
        cwd: '/tmp/project',
        sessionId: 'thread-1',
        sessionStale: false,
        agentName: 'Codex',
        scope: 'chat:topic',
        chatMode: 'topic',
        model: { displayName: 'Astra', effort },
      }));
      expect(card).toContain(`强度：${label}`);
    }
  });

  it('offers a refresh action when the model cannot be read', () => {
    const rendered = text(statusCard({
      cwd: '/tmp/project',
      sessionId: 'thread-1',
      sessionStale: false,
      agentName: 'Codex',
      scope: 'chat:topic',
      chatMode: 'topic',
      model: { readFailed: true, pendingDisplayName: 'Sol' },
    }));
    expect(rendered).toContain('模型：未知（点刷新重试）');
    expect(rendered).toContain('待生效：Sol');
    expect(rendered).toContain('刷新');
  });

  it('explains that a new topic has no session model yet and hides model lines for OMP', () => {
    const info = {
      cwd: '/tmp/project',
      sessionStale: false,
      agentName: 'Codex',
      scope: 'chat',
      chatMode: 'p2p' as const,
    };
    expect(text(statusCard({ ...info, model: {} }))).toContain('模型：尚未开始（发送第一条消息后才有会话模型）');
    expect(text(statusCard(info))).not.toContain('模型：');
    expect(text(statusCard(info))).not.toContain('切换模型');
  });

  it('marks a pending model choice on the status card', () => {
    const rendered = text(statusCard({
      cwd: '/tmp/project',
      sessionId: 'thread-1',
      sessionStale: false,
      agentName: 'Codex',
      scope: 'chat:topic',
      chatMode: 'topic',
      model: { displayName: 'Astra', effort: 'high', pendingDisplayName: 'Sol' },
    }));
    expect(rendered).toContain('模型：Astra（待生效：Sol）');
  });

  it('lists the model command in help', () => {
    const card = text(helpCard());
    expect(card).toContain('/projects');
    expect(card).toContain('/model');
    expect(card).toContain('切换本话题的模型与推理强度');
    for (const term of ['线程', '覆盖', 'Session']) expect(card).not.toContain(term);
  });
});
