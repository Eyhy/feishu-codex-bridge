import type { AgentApprovalDecision, AgentUiRequest, AgentUiResponse } from '../agent/types';

export const OMP_UI_MARKER = '__omp_ui';
export const OMP_UI_VALUE_FIELD = 'omp_ui_value';
export const OMP_UI_ANSWER_PREFIX = 'omp_ui_answer_';

export function isOmpUiPayload(payload: Record<string, unknown>): boolean {
  return payload[OMP_UI_MARKER] === true;
}

export function ompUiRequestId(payload: Record<string, unknown>): string | undefined {
  return typeof payload.requestId === 'string' ? payload.requestId : undefined;
}

export function ompUiTitle(payload: Record<string, unknown>): string {
  return typeof payload.title === 'string' && payload.title.trim() ? payload.title : 'OMP 交互';
}

export function responseFromOmpUiAction(
  payload: Record<string, unknown>,
  formValue: Record<string, unknown> | undefined,
): AgentUiResponse | undefined {
  const action = typeof payload.action === 'string' ? payload.action : '';
  const method = typeof payload.method === 'string' ? payload.method : '';

  if (action === 'cancel') return { cancelled: true };
  if (method === 'approval') {
    if (action === 'decision' && isApprovalDecision(payload.decision)) {
      return { decision: payload.decision };
    }
    if (action === 'accept' || action === 'acceptForSession' || action === 'decline' || action === 'cancel') {
      return { decision: action };
    }
    return undefined;
  }
  if (method === 'confirm' && action === 'confirm') return { confirmed: true };
  if (method === 'confirm' && action === 'deny') return { confirmed: false };

  if (action === 'submit') {
    if (method === 'form') {
      const questionIds = Array.isArray(payload.questionIds)
        ? payload.questionIds.filter((id): id is string => typeof id === 'string')
        : [];
      const answers: Record<string, string[]> = {};
      questionIds.forEach((questionId, index) => {
        const other = formValue?.[`${OMP_UI_ANSWER_PREFIX}${index}_other`];
        const raw = other === undefined || other === null || String(other).trim() === ''
          ? formValue?.[`${OMP_UI_ANSWER_PREFIX}${index}`]
          : other;
        const values = Array.isArray(raw)
          ? raw.map((value) => String(value))
          : raw === undefined || raw === null ? [] : [String(raw)];
        answers[questionId] = values;
      });
      return { answers };
    }
    const raw = formValue?.[OMP_UI_VALUE_FIELD] ?? payload.value;
    return { value: normalizeFormValue(raw) };
  }
  return undefined;
}

export function renderOmpUiRequestCard(request: AgentUiRequest, scope?: string): object {
  const elements: object[] = [
    markdown(`**${escapeMd(request.title)}**`),
    markdown(introText(request)),
  ];

  const timeout = 'timeout' in request ? request.timeout : undefined;
  if (timeout !== undefined && timeout > 0) {
    elements.push(markdown(`_此请求有超时限制：${Math.ceil(timeout / 1000)} 秒_`));
  }

  if (request.method === 'approval') {
    elements.push(markdown(request.message));
    const labels: Record<string, { text: string; type: 'primary' | 'default' | 'danger' }> = {
      accept: { text: '仅本次允许', type: 'primary' },
      acceptForSession: { text: '本会话允许', type: 'default' },
      decline: { text: '拒绝', type: 'danger' },
      cancel: { text: '取消任务', type: 'default' },
    };
    // Card schema 2.0 does not support the legacy `action` container. Put
    // buttons directly in the body; the callback behavior remains the same.
    elements.push(...request.decisions.map((decision) => {
        if (typeof decision === 'string') {
          const label = labels[decision] ?? { text: decision, type: 'default' as const };
          return button(label.text, label.type, callbackValue(request, decision, scope));
        }
        const execPolicy = 'acceptWithExecpolicyAmendment' in decision;
        return button(
          execPolicy ? '允许并记住此命令规则' : '允许并记住此网络规则',
          'default',
          { ...callbackValue(request, 'decision', scope), decision },
        );
      }));
  } else if (request.method === 'confirm') {
    elements.push(markdown(request.message));
    elements.push(
      ...[
        button('确认', 'primary', callbackValue(request, 'confirm', scope)),
        button('否', 'default', callbackValue(request, 'deny', scope)),
        button('取消', 'danger', callbackValue(request, 'cancel', scope)),
      ],
    );
  } else if (request.method === 'select') {
    elements.push(form(request, [
      {
        tag: 'select_static',
        name: OMP_UI_VALUE_FIELD,
        options: request.options.map((option) => ({
          text: { tag: 'plain_text', content: option },
          value: option,
        })),
      },
    ], scope));
  } else if (request.method === 'input') {
    elements.push(form(request, [
      {
        tag: 'input',
        name: OMP_UI_VALUE_FIELD,
        placeholder: { tag: 'plain_text', content: request.placeholder ?? '请输入' },
        input_type: 'text',
      },
    ], scope));
  } else if (request.method === 'editor') {
    elements.push(form(request, [
      {
        tag: 'input',
        name: OMP_UI_VALUE_FIELD,
        default_value: request.prefill ?? '',
        placeholder: { tag: 'plain_text', content: request.promptStyle ? '输入要发送给助手的内容' : '请输入' },
        input_type: 'multiline_text',
      },
    ], scope));
  } else {
    const questionElements = request.questions.flatMap((question, index) => {
      const description = question.options?.map((option) => option.description
        ? `- **${escapeMd(option.label)}**：${escapeMd(option.description)}`
        : '').filter(Boolean).join('\n');
      const heading = markdown([
        `**${index + 1}. ${escapeMd(question.title)}**`,
        escapeMd(question.prompt),
        description,
      ].filter(Boolean).join('\n\n'));
      const field = question.options?.length
        ? {
            tag: 'select_static',
            name: `${OMP_UI_ANSWER_PREFIX}${index}`,
            placeholder: { tag: 'plain_text', content: '请选择' },
            options: question.options.map((option) => ({
              text: { tag: 'plain_text', content: option.label },
              value: option.label,
            })),
          }
        : {
            tag: 'input',
            name: `${OMP_UI_ANSWER_PREFIX}${index}`,
            placeholder: { tag: 'plain_text', content: question.prompt || '请输入' },
            input_type: question.secret ? 'password' : 'text',
          };
      const otherField = question.allowOther
        ? {
            tag: 'input',
            name: `${OMP_UI_ANSWER_PREFIX}${index}_other`,
            placeholder: { tag: 'plain_text', content: '其他答案（如不选上方选项，可在此填写）' },
            input_type: question.secret ? 'password' : 'text',
          }
        : undefined;
      return [heading, field, ...(otherField ? [otherField] : [])];
    });
    elements.push(form(request, questionElements, scope));
  }

  return shell('等待你的确认', elements);
}

export function renderOmpUiResultCard(title: string, status: 'submitted' | 'cancelled' | 'unavailable'): object {
  const text =
    status === 'submitted'
      ? '✅ 已提交。'
      : status === 'cancelled'
        ? '已取消，助手会按取消处理。'
        : '! 当前任务已结束，无法提交这个交互。';
  return shell('交互已处理', [markdown(`**${escapeMd(title)}**`), markdown(text)]);
}

function form(request: AgentUiRequest, elements: object[], scope?: string): object {
  return {
    tag: 'form',
    name: `omp_ui_${request.id}`,
    elements: [
      ...elements,
      {
        tag: 'column_set',
        flex_mode: 'flow',
        horizontal_spacing: 'small',
        columns: [
          {
            tag: 'column',
            width: 'auto',
            elements: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '提交' },
                type: 'primary',
                form_action_type: 'submit',
                behaviors: [{ type: 'callback', value: callbackValue(request, 'submit', scope) }],
              },
            ],
          },
          {
            tag: 'column',
            width: 'auto',
            elements: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '取消' },
                type: 'danger',
                behaviors: [{ type: 'callback', value: callbackValue(request, 'cancel', scope) }],
              },
            ],
          },
        ],
      },
    ],
  };
}

function shell(summary: string, elements: object[]): object {
  return {
    schema: '2.0',
    config: { summary: { content: summary } },
    body: { elements },
  };
}

function markdown(content: string): object {
  return { tag: 'markdown', content };
}

function button(text: string, type: 'primary' | 'default' | 'danger', value: object): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    behaviors: [{ type: 'callback', value }],
  };
}

function callbackValue(request: AgentUiRequest, action: string, scope?: string): object {
  return {
    [OMP_UI_MARKER]: true,
    requestId: request.id,
    method: request.method,
    title: request.title,
    action,
    ...('questions' in request ? { questionIds: request.questions.map((question) => question.id) } : {}),
    ...(scope ? { scope } : {}),
  };
}

function introText(request: AgentUiRequest): string {
  switch (request.method) {
    case 'select':
      return '助手需要你选择一个选项。';
    case 'confirm':
      return '助手需要你确认是否继续。';
    case 'input':
      return '助手需要你输入一段文本。';
    case 'editor':
      return request.promptStyle ? '助手需要你编辑即将发送的提示词。' : '助手需要你编辑一段多行文本。';
    case 'form':
      return `助手需要你一次回答 ${request.questions.length} 个问题。`;
    case 'approval':
      return '助手需要你决定是否授权这项操作。';
  }
}

function normalizeFormValue(value: unknown): string {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0] ?? '') : '';
  if (value === undefined || value === null) return '';
  return String(value);
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function isApprovalDecision(value: unknown): value is AgentApprovalDecision {
  if (value === 'accept' || value === 'acceptForSession' || value === 'decline' || value === 'cancel') return true;
  if (!value || typeof value !== 'object') return false;
  return 'acceptWithExecpolicyAmendment' in value || 'applyNetworkPolicyAmendment' in value;
}
