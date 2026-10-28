import { describe, expect, it } from 'vitest';
import type { AgentAdditionalContext, AgentRun, AgentUiResponse } from '../agent/types';
import { ActiveRuns, releaseWriterIfAllIdle } from './active-runs';

async function* emptyEvents() {
  return;
}

describe('ActiveRuns OMP UI routing', () => {
  it('routes UI responses to the active run and clears pending request state', () => {
    const activeRuns = new ActiveRuns();
    const responses: Array<{ id: string; response: AgentUiResponse }> = [];
    const run: AgentRun = {
      events: emptyEvents(),
      stop: async () => {},
      waitForExit: async () => true,
      respondToUi(id, response) {
        responses.push({ id, response });
        return true;
      },
    };

    const handle = activeRuns.register('scope-1', run);
    handle.pendingUiRequests.add('ui-1');
    let settled = 0;
    handle.onUiSettled = () => {
      settled += 1;
    };

    expect(activeRuns.respondToUi('scope-1', 'ui-1', { confirmed: true })).toBe(true);
    expect(responses).toEqual([{ id: 'ui-1', response: { confirmed: true } }]);
    expect(handle.pendingUiRequests.has('ui-1')).toBe(false);
    expect(settled).toBe(1);
  });

  it('returns false when no active run can accept the response', () => {
    expect(new ActiveRuns().respondToUi('missing', 'ui-1', { cancelled: true })).toBe(false);
  });

  it('is idle only when no scope has an active run', () => {
    const activeRuns = new ActiveRuns();
    const run: AgentRun = {
      events: emptyEvents(),
      stop: async () => {},
      waitForExit: async () => true,
    };
    expect(activeRuns.allIdle()).toBe(true);
    activeRuns.register('scope-1', run);
    expect(activeRuns.allIdle()).toBe(false);
    activeRuns.unregister('scope-1', run);
    expect(activeRuns.allIdle()).toBe(true);
  });

  it('releases only when all scopes are idle and swallows release failures', async () => {
    const activeRuns = new ActiveRuns();
    let releases = 0;
    const agent = {
      async releaseWriterIfIdle() {
        releases += 1;
        throw new Error('release failed');
      },
    };
    const run: AgentRun = {
      events: emptyEvents(),
      stop: async () => {},
      waitForExit: async () => true,
    };
    activeRuns.register('scope-1', run);
    await releaseWriterIfAllIdle(activeRuns, agent);
    expect(releases).toBe(0);
    activeRuns.unregister('scope-1', run);
    await expect(releaseWriterIfAllIdle(activeRuns, agent)).resolves.toBeUndefined();
    expect(releases).toBe(1);
  });

  it('routes mid-run prompts to the active run', async () => {
    const activeRuns = new ActiveRuns();
    const prompts: Array<{ kind: string; message: string; imagePaths?: string[]; additionalContext?: AgentAdditionalContext }> = [];
    const run: AgentRun = {
      events: emptyEvents(),
      stop: async () => {},
      waitForExit: async () => true,
      async submitPrompt(kind, message, imagePaths, additionalContext) {
        prompts.push({ kind, message, imagePaths, additionalContext });
        return true;
      },
    };

    activeRuns.register('scope-1', run);

    const additionalContext = { source: { value: 'context', kind: 'application' as const } };
    await expect(activeRuns.submitPrompt('scope-1', 'follow_up', 'next', ['a.png'], additionalContext)).resolves.toBe(true);
    expect(activeRuns.has('scope-1')).toBe(true);
    expect(prompts).toEqual([{ kind: 'follow_up', message: 'next', imagePaths: ['a.png'], additionalContext }]);
  });
});
