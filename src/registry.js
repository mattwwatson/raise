/**
 * The registry of live Claude Code sessions.
 *
 * Pipeline state tells you what no-mistakes is doing. It cannot tell you that
 * Claude itself is sitting on a permission prompt waiting for a human. That
 * only exists inside Claude Code, and reaches us through hooks.
 *
 * Records are files rather than memory so the dashboard survives a restart of
 * the server without losing track of which window is which.
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * How a Claude Code hook event maps to a session state.
 *
 * - blocked: Claude wants something from the human right now (permission
 *   prompt, or it has been idle waiting for input).
 * - idle:    the turn ended. Ready for the next instruction, not urgent.
 * - working: actively running.
 */
const EVENT_STATES = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  Notification: 'blocked',
  Stop: 'idle',
  SessionEnd: 'ended',
};

export function stateForEvent(event) {
  return EVENT_STATES[event] || 'working';
}

/** Events that mean the session is gone and its record should be removed. */
export function isTerminalEvent(event) {
  return stateForEvent(event) === 'ended';
}

/**
 * Session ids come from Claude Code, but they arrive over a socket, so treat
 * them as untrusted before they are ever used in a filename.
 */
export function isSafeSessionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

export class SessionRegistry {
  #dir;

  constructor({ dir }) {
    this.#dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /**
   * Record a hook event.
   *
   * Host details only arrive on SessionStart in practice, so they are merged
   * rather than replaced. Losing the window identity on a later Stop event
   * would silently break focusing.
   *
   * @returns {object|null} the stored record, or null if the session ended
   */
  record(payload, now = Date.now()) {
    const sessionId = payload.session_id;
    if (!isSafeSessionId(sessionId)) {
      throw new Error('invalid session id');
    }
    const event = payload.hook_event_name;
    if (isTerminalEvent(event)) {
      this.remove(sessionId);
      return null;
    }

    const previous = this.get(sessionId) || {};
    const record = {
      sessionId,
      cwd: payload.cwd || previous.cwd || null,
      transcriptPath: payload.transcript_path || previous.transcriptPath || null,
      event,
      state: stateForEvent(event),
      // A Notification carries the reason Claude is asking for you. Keep it
      // while blocked and clear it the moment the session moves on, so the
      // dashboard never shows a stale "needs permission".
      message: stateForEvent(event) === 'blocked' ? payload.message || null : null,
      host: { ...(previous.host || {}), ...(payload.host || {}) },
      startedAt: previous.startedAt || now,
      updatedAt: now,
      stateSince: previous.state === stateForEvent(event) ? previous.stateSince || now : now,
    };
    this.#write(sessionId, record);
    return record;
  }

  get(sessionId) {
    if (!isSafeSessionId(sessionId)) return null;
    try {
      return JSON.parse(readFileSync(this.#path(sessionId), 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * @param {object} [options]
   * @param {Function} [options.isAlive] pid liveness probe, injected for tests
   * @returns {object[]}
   */
  list({ isAlive = defaultIsAlive } = {}) {
    let names;
    try {
      names = readdirSync(this.#dir);
    } catch {
      return [];
    }
    const records = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const sessionId = name.slice(0, -5);
      const record = this.get(sessionId);
      if (!record) continue;
      // A session whose process is gone was killed or crashed without a
      // SessionEnd. Drop it rather than offering a row that focuses nothing.
      const pid = record.host?.pid;
      if (pid && !isAlive(pid)) {
        this.remove(sessionId);
        continue;
      }
      records.push(record);
    }
    return records.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  remove(sessionId) {
    if (!isSafeSessionId(sessionId)) return;
    try {
      unlinkSync(this.#path(sessionId));
    } catch {
      // Already gone.
    }
  }

  #path(sessionId) {
    return join(this.#dir, `${sessionId}.json`);
  }

  #write(sessionId, record) {
    // Write-then-rename so a reader never sees a half-written record.
    const target = this.#path(sessionId);
    const temp = `${target}.tmp`;
    writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
    renameSync(temp, target);
  }
}

export function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else - still alive.
    return err.code === 'EPERM';
  }
}
