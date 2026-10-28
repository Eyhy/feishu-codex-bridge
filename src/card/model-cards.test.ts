import { describe, expect, it } from 'vitest';
import {
  MODEL_DEFAULT_EFFORT,
  effortSelectCard,
  modelErrorCard,
  modelSelectCard,
  modelSwitchSuccessCard,
} from './model-cards';
import type { ModelOption } from '../agent/types';

const sol: ModelOption = {
  model: 'gpt-5.6-sol', id: 'gpt-5.6-sol', displayName: 'Sol', description: '',
  isDefault: true, hidden: false, supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high',
};
const astra: ModelOption = {
  model: 'gpt-6-astra', id: 'gpt-6-astra', displayName: 'Astra', description: '',
  isDefault: false, hidden: false, supportedReasoningEfforts: ['medium', 'ultra'], defaultReasoningEffort: 'medium',
};

describe('model cards', () => {
  it('puts the current model first and marks it', () => {
    const card = JSON.stringify(modelSelectCard([sol, astra], 'gpt-6-astra', '列表已更新'));
    expect(card).toContain('列表已更新');
    expect(card.indexOf('Astra（当前）')).toBeLessThan(card.indexOf('Sol'));
    expect(card).toContain('"name":"model_id"');
    expect(card).toContain('"cmd":"model","arg":"choose-model"');
  });

  it('keeps the current effort when the model supports it', () => {
    const card = JSON.stringify(effortSelectCard(astra, 'ultra'));
    expect(card).toContain('"initial_option":"ultra"');
    expect(card).toContain('跟随模型默认（中）');
    expect(card).toContain('"value":"' + MODEL_DEFAULT_EFFORT + '"');
  });

  it('falls back to the model default when the current effort is unsupported', () => {
    const card = JSON.stringify(effortSelectCard(sol, 'ultra'));
    expect(card).toContain('"initial_option":"high"');
    expect(card).not.toContain('"initial_option":"ultra"');
  });

  it('shows the applied switch with operator, time, and effort fallback', () => {
    const card = JSON.stringify(modelSwitchSuccessCard({
      previousModel: 'Sol', previousEffort: 'ultra', nextModel: 'Astra', nextEffort: 'medium',
      operatorName: '用户', at: new Date(2026, 9, 27, 16, 5), fallbackFrom: 'ultra',
    }));
    expect(card).toContain('模型已切换：Sol → Astra（强度 中）');
    expect(card).toContain('新模型不支持 最高，已改为 中');
    expect(card).toContain('操作者：用户 · 2026-10-27 16:05');
    expect(card).toContain('查看状态');
  });

  it('can hide the retry button for terminal failures', () => {
    const card = JSON.stringify(modelErrorCard('失败', '原因', { retry: false }));
    expect(card).not.toContain('重新选择');
    expect(card).toContain('"cmd":"status"');
  });
});
