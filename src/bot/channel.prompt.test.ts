import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { describe, expect, it } from 'vitest';
import type { LocalAttachment } from '../media/cache';
import { buildPrompt, deriveThreadTitle, modelOverrideForBackend } from './channel';
import type { AppConfig } from '../config/schema';
import type { QuotedContext } from './quote';

function message(content: string, resources: NormalizedMessage['resources'] = []): NormalizedMessage {
  return {
    messageId: 'message-1',
    chatId: 'chat-1',
    chatType: 'group',
    senderId: 'user-1',
    threadId: 'topic-1',
    content,
    resources,
    rawContentType: 'text',
  } as NormalizedMessage;
}

describe('Codex prompt presentation', () => {
  it('keeps the real request ahead of quote and bridge metadata', () => {
    const quote: QuotedContext = {
      messageId: 'quoted-1',
      senderId: 'user-1',
      createdAt: '2026-07-28T03:07:26.878Z',
      content: '之前的问题',
      rawContentType: 'text',
    };
    const prompt = buildPrompt([message('如何优化呢')], [], [quote]);

    expect(prompt.startsWith('如何优化呢')).toBe(true);
    expect(prompt.indexOf('<quoted_message')).toBeGreaterThan(prompt.indexOf('如何优化呢'));
    expect(prompt).not.toContain('<bridge_context>');
  });

  it('preserves the metadata-first contract for the OMP backend', () => {
    const prompt = buildPrompt([message('继续处理')], [], [], true);
    expect(prompt.startsWith('<bridge_context>')).toBe(true);
    expect(prompt.indexOf('继续处理')).toBeGreaterThan(prompt.indexOf('</bridge_context>'));
  });

  it('does not expose raw Feishu routing identifiers by default', () => {
    const prompt = buildPrompt([message('脱敏测试')], []);
    expect(prompt).not.toContain('chat-1');
    expect(prompt).not.toContain('user-1');
    expect(prompt).not.toContain('topic-1');
  });

  it('supports explicitly opting into routing identifiers for compatibility', () => {
    const prompt = buildPrompt([message('兼容测试')], [], [], true, true);
    expect(prompt).toContain('chat_id: chat-1');
    expect(prompt).toContain('sender_id: user-1');
    expect(prompt).toContain('thread_id: topic-1');
  });

  it('derives a compact user-facing title from the actual message', () => {
    expect(deriveThreadTitle([message('  如何   优化飞书 Codex 会话  ')])).toBe('如何 优化飞书 Codex 会话');
    expect(Array.from(deriveThreadTitle([message('很长的标题'.repeat(20))])).length).toBeLessThanOrEqual(48);
  });

  it('passes a model override only for the OMP backend', () => {
    const cfg = { preferences: { ompModel: 'omp-fast' } } as AppConfig;
    expect(modelOverrideForBackend(cfg, 'codex')).toEqual({});
    expect(modelOverrideForBackend(cfg, 'omp')).toEqual({ model: 'omp-fast' });
  });

  it('uses an attachment title without exposing the internal file key', () => {
    const resources = [{ type: 'image', fileKey: 'private-file-key' }] as NormalizedMessage['resources'];
    const attachment: LocalAttachment = { path: '/tmp/example.png', kind: 'image' };
    const prompt = buildPrompt([message('', resources)], [attachment]);

    expect(deriveThreadTitle([message('', resources)], true)).toBe('查看附件');
    expect(prompt.startsWith('请看下面的附件。')).toBe(true);
    expect(prompt).toContain('/tmp/example.png');
    expect(prompt).not.toContain('private-file-key');
  });
});
