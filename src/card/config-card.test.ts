import { describe, expect, it } from 'vitest';
import { configFormCard } from './config-card';

describe('config form user-visible wording', () => {
  it('describes the per-topic timeout without internal scope language', () => {
    const card = JSON.stringify(configFormCard({
      messageReply: 'card',
      showToolCalls: false,
      maxConcurrentRuns: 10,
      runIdleTimeoutMinutes: 0,
      requireMentionInGroup: false,
      allowedUsers: '',
      allowedChats: '',
      admins: '',
    }));

    expect(card).toContain('本话题单独设置');
    expect(card).not.toContain('scope');
    for (const term of ['线程', '覆盖', 'Session']) expect(card).not.toContain(term);
  });
});
