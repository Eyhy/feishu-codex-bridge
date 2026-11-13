import { describe, expect, it } from 'vitest';
import {
  OMP_UI_MARKER,
  OMP_UI_ANSWER_PREFIX,
  OMP_UI_VALUE_FIELD,
  renderOmpUiRequestCard,
  responseFromOmpUiAction,
} from './omp-ui';

describe('OMP UI cards', () => {
  it('renders select requests with callback marker and options', () => {
    const card = renderOmpUiRequestCard({
      id: 'ui-1',
      method: 'select',
      title: 'Pick one',
      options: ['alpha', 'beta'],
      timeout: 1200,
    });

    const json = JSON.stringify(card);
    expect(json).toContain('select_static');
    expect(json).toContain('alpha');
    expect(json).toContain('beta');
    expect(json).toContain(OMP_UI_MARKER);
    expect(json).toContain('ui-1');
  });

  it('turns confirm actions into OMP UI responses', () => {
    expect(responseFromOmpUiAction({ [OMP_UI_MARKER]: true, method: 'confirm', action: 'confirm' }, undefined)).toEqual({
      confirmed: true,
    });
    expect(responseFromOmpUiAction({ [OMP_UI_MARKER]: true, method: 'confirm', action: 'deny' }, undefined)).toEqual({
      confirmed: false,
    });
    expect(responseFromOmpUiAction({ [OMP_UI_MARKER]: true, method: 'input', action: 'cancel' }, undefined)).toEqual({
      cancelled: true,
    });
  });

  it('turns form submissions into string value responses', () => {
    expect(responseFromOmpUiAction(
      { [OMP_UI_MARKER]: true, method: 'input', action: 'submit' },
      { [OMP_UI_VALUE_FIELD]: 'hello' },
    )).toEqual({ value: 'hello' });

    expect(responseFromOmpUiAction(
      { [OMP_UI_MARKER]: true, method: 'select', action: 'submit' },
      { [OMP_UI_VALUE_FIELD]: ['first', 'ignored'] },
    )).toEqual({ value: 'first' });
  });

  it('renders and submits all questions in a structured form', () => {
    const card = renderOmpUiRequestCard({
      id: 'ui-form',
      method: 'form',
      title: '补充信息',
      questions: [
        { id: 'env', title: '环境', prompt: '选择环境', options: [{ label: '测试', description: '安全验证' }] },
        { id: 'note', title: '说明', prompt: '补充说明' },
      ],
    });
    const json = JSON.stringify(card);
    expect(json).toContain(`${OMP_UI_ANSWER_PREFIX}0`);
    expect(json).toContain(`${OMP_UI_ANSWER_PREFIX}1`);
    expect(json).toContain('安全验证');
    expect(responseFromOmpUiAction(
      { [OMP_UI_MARKER]: true, method: 'form', action: 'submit', questionIds: ['env', 'note'] },
      { [`${OMP_UI_ANSWER_PREFIX}0`]: '测试', [`${OMP_UI_ANSWER_PREFIX}1`]: '继续' },
    )).toEqual({ answers: { env: ['测试'], note: ['继续'] } });
  });

  it('renders complete approval choices', () => {
    const card = JSON.stringify(renderOmpUiRequestCard({
      id: 'approval-1',
      method: 'approval',
      title: '需要确认',
      message: '运行 pnpm test',
      decisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    }));
    expect(card).toContain('仅本次允许');
    expect(card).toContain('本会话允许');
    expect(card).toContain('拒绝');
    expect(card).toContain('取消任务');
    expect(card).not.toContain('"tag":"action"');
    expect(card.match(/"tag":"button"/g)?.length).toBe(4);
    expect(responseFromOmpUiAction(
      { [OMP_UI_MARKER]: true, method: 'approval', action: 'acceptForSession' },
      undefined,
    )).toEqual({ decision: 'acceptForSession' });
  });

  it('renders confirm buttons as schema 2.0 body elements', () => {
    const card = JSON.stringify(renderOmpUiRequestCard({
      id: 'confirm-1',
      method: 'confirm',
      title: '需要确认',
      message: '继续执行吗？',
    }));
    expect(card).not.toContain('"tag":"action"');
    expect(card.match(/"tag":"button"/g)?.length).toBe(3);
  });

  it('preserves policy-amendment decisions from Codex', () => {
    const decision = {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: [{ command: 'pnpm test' }],
      },
    };
    const card = JSON.stringify(renderOmpUiRequestCard({
      id: 'approval-policy',
      method: 'approval',
      title: '需要确认',
      message: '运行测试',
      decisions: [decision, 'decline'],
    }));
    expect(card).toContain('允许并记住此命令规则');
    expect(responseFromOmpUiAction(
      { [OMP_UI_MARKER]: true, method: 'approval', action: 'decision', decision },
      undefined,
    )).toEqual({ decision });
  });
});
