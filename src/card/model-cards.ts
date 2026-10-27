import type { ModelOption } from '../agent/types';
import { effortLabel } from './templates';

/** Sentinel value for the "follow the model default" option. */
export const MODEL_DEFAULT_EFFORT = '__model_default__';

export interface ModelSwitchSuccessInfo {
  previousModel: string;
  previousEffort?: string | null;
  nextModel: string;
  nextEffort: string;
  operatorName: string;
  at: Date;
  fallbackFrom?: string;
}

export function modelSelectCard(
  models: ModelOption[],
  currentModel: string | null | undefined,
  notice?: string,
): object {
  const current = currentModel ? models.find((model) => model.model === currentModel) : undefined;
  const ordered = current
    ? [current, ...models.filter((model) => model !== current)]
    : models;
  return shell2('选择模型', [
    ...(notice ? [markdown(notice)] : []),
    markdown(current
      ? `当前模型：**${escapeMd(current.displayName)}**。选择新模型后，再选择推理强度。`
      : '选择要用于本话题的模型，然后选择推理强度。'),
    {
      tag: 'form',
      name: 'model_select',
      elements: [
        {
          tag: 'select_static',
          name: 'model_id',
          placeholder: { tag: 'plain_text', content: '选择模型' },
          options: ordered.map((model) => ({
            text: {
              tag: 'plain_text',
              content: `${model.displayName}${model.model === currentModel ? '（当前）' : ''}`,
            },
            value: model.model,
          })),
        },
        columns(submitButton('下一步', { cmd: 'model', arg: 'choose-model' }), cancelButton()),
      ],
    },
  ]);
}

export function effortSelectCard(
  model: ModelOption,
  currentEffort: string | null | undefined,
): object {
  const efforts = model.supportedReasoningEfforts;
  const preferred = currentEffort && efforts.includes(currentEffort)
    ? currentEffort
    : model.defaultReasoningEffort ?? efforts[0];
  const options = efforts.map((effort) => ({
    text: { tag: 'plain_text', content: effortLabel(effort) },
    value: effort,
  }));
  if (model.defaultReasoningEffort) {
    options.push({
      text: {
        tag: 'plain_text',
        content: `跟随模型默认（${effortLabel(model.defaultReasoningEffort)}）`,
      },
      value: MODEL_DEFAULT_EFFORT,
    });
  }
  return shell2(`选择强度：${model.displayName}`, [
    markdown(`模型：**${escapeMd(model.displayName)}**。选择推理强度；只换模型时，建议保留当前强度。`),
    {
      tag: 'form',
      name: 'effort_select',
      elements: [
        {
          tag: 'select_static',
          name: 'effort',
          ...(preferred ? { initial_option: preferred } : {}),
          placeholder: { tag: 'plain_text', content: '选择推理强度' },
          options,
        },
        columns(
          submitButton('确认切换', { cmd: 'model', arg: 'apply', model_id: model.model }),
          backButton(),
        ),
      ],
    },
    cancelButton(),
  ]);
}

export function modelSwitchSuccessCard(info: ModelSwitchSuccessInfo): object {
  const elements: object[] = [
    markdown(
      `**模型已切换：${escapeMd(info.previousModel)} → ${escapeMd(info.nextModel)}（强度 ${effortLabel(info.nextEffort)}）**`,
    ),
  ];
  if (info.fallbackFrom) {
    elements.push(markdown(
      `新模型不支持 ${escapeMd(effortLabel(info.fallbackFrom))}，已改为 ${effortLabel(info.nextEffort)}`,
    ));
  }
  elements.push(markdown(`操作者：${escapeMd(info.operatorName)} · ${formatTime(info.at)}`));
  elements.push(button('查看状态', 'primary', { cmd: 'status' }));
  return shell2('模型已切换', elements);
}

export function modelErrorCard(
  title: string,
  detail: string,
  opts: { retry?: boolean; cancelText?: string } = {},
): object {
  const elements: object[] = [markdown(detail)];
  const buttons: object[] = [];
  if (opts.retry !== false) buttons.push(button('重新选择', 'primary', { cmd: 'model', arg: 'reload' }));
  buttons.push(button(opts.cancelText ?? '取消', 'default', { cmd: 'status' }));
  elements.push(...buttons);
  return shell2(title, elements);
}

export function modelNoticeCard(title: string, detail: string): object {
  return shell2(title, [markdown(detail), button('查看状态', 'default', { cmd: 'status' })]);
}

export function formatTime(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function shell2(summary: string, elements: object[]): object {
  return {
    schema: '2.0',
    config: { summary: { content: summary } },
    body: { elements },
  };
}

function markdown(content: string): object {
  return { tag: 'markdown', content };
}

function button(text: string, type: 'primary' | 'default' | 'danger', value: Record<string, unknown>): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    behaviors: [{ type: 'callback', value }],
  };
}

function submitButton(text: string, value: Record<string, unknown>): object {
  return { ...button(text, 'primary', value), form_action_type: 'submit' };
}

function backButton(): object {
  return button('返回', 'default', { cmd: 'model', arg: 'back' });
}

function cancelButton(): object {
  return button('取消', 'default', { cmd: 'status' });
}

function columns(first: object, second: object): object {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: 'small',
    columns: [
      { tag: 'column', width: 'auto', elements: [first] },
      { tag: 'column', width: 'auto', elements: [second] },
    ],
  };
}

function escapeMd(value: string): string {
  return value.replace(/([*_`\\])/g, '\\$1');
}
