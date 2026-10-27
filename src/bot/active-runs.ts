import type { AgentAdditionalContext, AgentAdapter, AgentRun, AgentUiResponse } from '../agent/types';
import { log } from '../core/logger';

export interface RunHandle {
  run: AgentRun;
  interrupted: boolean;
  pendingUiRequests: Set<string>;
  onUiSettled?: () => void;
}

export class ActiveRuns {
  private readonly handles = new Map<string, RunHandle>();

  register(chatId: string, run: AgentRun): RunHandle {
    const handle: RunHandle = { run, interrupted: false, pendingUiRequests: new Set() };
    this.handles.set(chatId, handle);
    return handle;
  }

  unregister(chatId: string, run: AgentRun): void {
    const existing = this.handles.get(chatId);
    if (existing?.run === run) this.handles.delete(chatId);
  }

  has(chatId: string): boolean {
    return this.handles.has(chatId);
  }

  /** True when no scope has an active run, approval, or pending input. */
  allIdle(): boolean {
    return this.handles.size === 0;
  }

  /**
   * Interrupt the current run for this chat, if any. Returns true if an
   * interrupt was issued. Fires stop() fire-and-forget — the old run's
   * generator exits on its own as the subprocess dies.
   */
  interrupt(chatId: string): boolean {
    const h = this.handles.get(chatId);
    if (!h) return false;
    h.interrupted = true;
    this.handles.delete(chatId);
    void h.run.stop().catch(() => {
      /* stop errors are non-fatal */
    });
    return true;
  }

  respondToUi(chatId: string, requestId: string, response: AgentUiResponse): boolean {
    const h = this.handles.get(chatId);
    const ok = h?.run.respondToUi?.(requestId, response) === true;
    if (ok) h?.pendingUiRequests.delete(requestId);
    if (ok) h?.onUiSettled?.();
    return ok;
  }

  submitPrompt(
    chatId: string,
    kind: 'steer' | 'follow_up',
    message: string,
    imagePaths?: string[],
    additionalContext?: AgentAdditionalContext,
  ): Promise<boolean> {
    const h = this.handles.get(chatId);
    return h?.run.submitPrompt?.(kind, message, imagePaths, additionalContext) ?? Promise.resolve(false);
  }

  async stopAll(): Promise<void> {
    const all = [...this.handles.values()];
    this.handles.clear();
    for (const h of all) h.interrupted = true;
    await Promise.allSettled(all.map((h) => h.run.stop()));
  }
}

/**
 * Release the shared Codex writer only once every scope is idle. Runs share one
 * app-server, so releasing while another topic is still executing would pull
 * the process out from under it.
 */
export async function releaseWriterIfAllIdle(
  activeRuns: ActiveRuns,
  agent: Pick<AgentAdapter, 'releaseWriterIfIdle'>,
): Promise<void> {
  if (!activeRuns.allIdle()) return;
  try {
    await agent.releaseWriterIfIdle?.();
  } catch (err) {
    log.warn('agent', 'writer-release-failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
