import { readFile } from 'node:fs/promises';
import { paths } from '../config/paths';
import { writeAtomicFile } from '../config/atomic-file';
import { log } from '../core/logger';

export interface PendingModel {
  model: string;
  effort: string;
}

export interface SessionEntry {
  /** May be absent if the entry was created by /timeout before any run
   * recorded a session id. Treat absence as "no resumable session". */
  sessionId?: string;
  /** Pinned cwd for the resumable session. Absent for the same reason. */
  cwd?: string;
  updatedAt: number;
  /** Per-scope idle-timeout override (minutes). 0 = explicitly off for this
   * scope, undefined = follow global default. /new clears the session binding
   * (keeping a pending model), so this resets to "follow global" when the
   * user starts a new session. */
  idleTimeoutMinutes?: number;
  /** Model selected before this scope has a Codex thread. The pair is
   * persisted together and survives /new so the next thread created in this
   * topic starts with the user's choice. */
  pendingModel?: string;
  pendingEffort?: string;
}

type SessionMap = Record<string, SessionEntry>;

export class SessionStore {
  private data: SessionMap = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = paths.sessionsFile) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const raw = JSON.parse(text) as Record<string, Partial<SessionEntry>>;
      this.data = {};
      for (const [chatId, entry] of Object.entries(raw)) {
        if (!entry || typeof entry.updatedAt !== 'number') continue;
        // Drop entries without a `cwd`/`sessionId` pair *unless* there's
        // some other persisted state worth keeping (e.g. an idle-timeout
        // override or a model selected before the first run). Resuming a
        // session whose cwd we don't know about would make OMP resume fail,
        // so resume keys still need the full pair; but a bare timeout
        // override or pending model is fine on its own.
        const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : undefined;
        const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined;
        const idleTimeoutMinutes =
          typeof entry.idleTimeoutMinutes === 'number' ? entry.idleTimeoutMinutes : undefined;
        const pendingModel = typeof entry.pendingModel === 'string' ? entry.pendingModel : undefined;
        const pendingEffort =
          typeof entry.pendingEffort === 'string' ? entry.pendingEffort : undefined;
        const hasPending = pendingModel !== undefined && pendingEffort !== undefined;
        const hasSession = sessionId !== undefined && cwd !== undefined;
        if (!hasSession && idleTimeoutMinutes === undefined && !hasPending) continue;
        this.data[chatId] = {
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          updatedAt: entry.updatedAt,
          ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}),
          ...(hasPending ? { pendingModel, pendingEffort } : {}),
        };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  /**
   * Return the session id for this chat if it was created in the given cwd.
   * Sessions recorded in a different cwd are stale — OMP can't resume
   * them from a different working directory.
   */
  resumeFor(chatId: string, cwd: string): string | undefined {
    const entry = this.data[chatId];
    if (!entry) return undefined;
    if (entry.cwd !== cwd) return undefined;
    return entry.sessionId;
  }

  getRaw(chatId: string): SessionEntry | undefined {
    return this.data[chatId];
  }

  set(chatId: string, sessionId: string, cwd: string): void {
    // Preserve per-scope preferences across run starts: the idle-timeout
    // override is not per-run state, and a pending model must survive the
    // system event that binds the new thread to this scope.
    const prev = this.data[chatId];
    this.data[chatId] = {
      sessionId,
      cwd,
      updatedAt: Date.now(),
      ...(prev?.idleTimeoutMinutes !== undefined
        ? { idleTimeoutMinutes: prev.idleTimeoutMinutes }
        : {}),
      ...(prev?.pendingModel !== undefined && prev.pendingEffort !== undefined
        ? { pendingModel: prev.pendingModel, pendingEffort: prev.pendingEffort }
        : {}),
    };
    this.schedulePersist();
  }

  clear(chatId: string): void {
    if (!(chatId in this.data)) return;
    delete this.data[chatId];
    this.schedulePersist();
  }

  /** Start a new session in this scope but keep the model selected before
   * the previous session existed. /new uses this; clear() still removes the
   * whole entry. */
  clearSession(chatId: string): void {
    const prev = this.data[chatId];
    if (!prev) return;
    if (prev.pendingModel !== undefined && prev.pendingEffort !== undefined) {
      this.data[chatId] = {
        updatedAt: Date.now(),
        pendingModel: prev.pendingModel,
        pendingEffort: prev.pendingEffort,
      };
      this.schedulePersist();
      return;
    }
    this.clear(chatId);
  }

  /** Pending model selection for this scope. Undefined unless both fields
   * were persisted together. */
  getPending(chatId: string): PendingModel | undefined {
    const entry = this.data[chatId];
    if (!entry || entry.pendingModel === undefined || entry.pendingEffort === undefined) {
      return undefined;
    }
    return { model: entry.pendingModel, effort: entry.pendingEffort };
  }

  setPending(chatId: string, pending: PendingModel): void {
    const prev = this.data[chatId];
    this.data[chatId] = {
      ...(prev ?? { updatedAt: Date.now() }),
      pendingModel: pending.model,
      pendingEffort: pending.effort,
      updatedAt: Date.now(),
    };
    this.schedulePersist();
  }

  /** Remove the pending selection, keeping the session binding and timeout. */
  clearPending(chatId: string): void {
    const prev = this.data[chatId];
    if (!prev) return;
    if (prev.pendingModel === undefined && prev.pendingEffort === undefined) return;
    const { pendingModel: _model, pendingEffort: _effort, ...rest } = prev;
    this.data[chatId] = { ...rest, updatedAt: Date.now() };
    this.schedulePersist();
  }

  /** Per-scope idle-timeout override. `undefined` means no override set. */
  getIdleTimeoutMinutes(chatId: string): number | undefined {
    return this.data[chatId]?.idleTimeoutMinutes;
  }

  setIdleTimeoutMinutes(chatId: string, minutes: number): void {
    const clamped = Math.min(Math.max(Math.floor(minutes), 0), 120);
    const prev = this.data[chatId];
    this.data[chatId] = {
      ...(prev ?? { updatedAt: Date.now() }),
      idleTimeoutMinutes: clamped,
      updatedAt: Date.now(),
    };
    this.schedulePersist();
  }

  /** Remove the override so this scope falls back to the global default.
   * Returns true if something was actually removed. */
  clearIdleTimeoutOverride(chatId: string): boolean {
    const prev = this.data[chatId];
    if (!prev || prev.idleTimeoutMinutes === undefined) return false;
    const { idleTimeoutMinutes: _, ...rest } = prev;
    this.data[chatId] = { ...rest, updatedAt: Date.now() };
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await writeAtomicFile(this.path, `${JSON.stringify(this.data, null, 2)}\n`);
      })
      .catch((err: unknown) => {
        log.fail('session', err, { step: 'persist' });
      });
  }
}
