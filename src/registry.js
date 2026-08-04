/**
 * The registry of live agent sessions.
 *
 * Pipeline state tells you what no-mistakes is doing. It cannot tell you that
 * the agent itself is sitting on a permission prompt waiting for a human. That
 * only exists inside the agent, and reaches us through hooks - Claude Code's,
 * or the extension pi loads.
 *
 * Records are files rather than memory so the dashboard survives a restart of
 * the server without losing track of which window is which.
 *
 * **The two agents do not report the same states, and the difference is real
 * rather than a gap to paper over.** Claude Code asks permission before running
 * a tool, so it can say "a human is needed right now". pi ships no sandbox and
 * no approval gate - its tools simply run - so nothing inside it corresponds to
 * that, and `PI_EVENT_STATES` therefore contains no `blocked` at all. Inferring
 * one from "the turn ended a while ago" would put pi rows in competition with
 * real permission prompts on the strength of a guess, which is precisely how a
 * page stops being believed. A pi session still reaches the top of the list the
 * honest way, through its pipeline: parked, failed, or waiting on a review.
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
 * The window identity a hook captures at session start - everything needed to
 * find this session's tab again later. Every field is optional: a session
 * started before the hooks were installed reports none of them.
 *
 * @typedef {object} Host
 * @property {string|null} [term_program] TERM_PROGRAM, which names the terminal
 * @property {'claude-desktop'|null} [app] the application hosting the session
 *   when it is not a terminal, walked up from the hook. A session with this set
 *   has no tty and no terminal UUID by nature, so it is the only handle there is
 * @property {string|null} [iterm_session_id] iTerm2's per-tab UUID, the best
 *   identifier available - it survives the tab moving to another window
 * @property {string|null} [term_session_id] set by the terminal itself, so it is
 *   present when shell integration is not
 * @property {string|null} [tmux] the TMUX socket, when running under tmux
 * @property {string|null} [tmux_pane] the pane, when running under tmux
 * @property {string|null} [tty] the controlling terminal, walked up from the hook
 * @property {number|null} [pid] the agent process, used only for liveness pruning
 * @property {string|null} [hostname]
 */

/**
 * Which agent is running a session.
 *
 * @typedef {'claude'|'pi'} AgentKind
 */

/**
 * A hook payload, with the `host` the reporter adds before posting.
 *
 * Snake-cased because the field names are Claude Code's, not ours, and it
 * arrives over a socket - so nothing here can be assumed present or well
 * formed. pi's extension speaks the same shape deliberately: one wire format
 * means one parser, one privacy boundary and one set of tests.
 *
 * @typedef {object} HookPayload
 * @property {string} session_id
 * @property {string} hook_event_name
 * @property {AgentKind} [agent] which agent sent this; Claude Code cannot say,
 *   so an absent value means Claude Code
 * @property {string} [cwd]
 * @property {string} [transcript_path]
 * @property {string} [message] why Claude wants you, on a Notification
 * @property {string} [notification_type] which kind of Notification this is -
 *   `permission_prompt`, `idle_prompt` and friends. Absent on a Claude Code old
 *   enough not to send it, which is why nothing may require it
 * @property {Host} [host]
 */

/**
 * What Claude is doing, as far as the hooks can tell.
 *
 * `ended` never reaches a stored record - it is the signal to delete one.
 *
 * @typedef {'idle'|'working'|'blocked'|'ended'} SessionState
 */

/**
 * One live Claude Code session, as stored on disk.
 *
 * @typedef {object} Session
 * @property {string} sessionId
 * @property {AgentKind} agent which agent is running it, which decides how its
 *   transcript is parsed and what the page says it is
 * @property {string|null} cwd
 * @property {string|null} transcriptPath
 * @property {string} event the hook event that last touched this record
 * @property {SessionState} state
 * @property {string|null} message why Claude wants you; only set while blocked
 * @property {string|null} notificationType which kind of notification produced
 *   that message, when Claude Code said. Held on exactly the same terms as
 *   `message`, because it describes the same block and expires with it
 * @property {Host} host
 * @property {number} startedAt
 * @property {number} updatedAt
 * @property {number} stateSince when `state` last changed, for "waiting 2m"
 */

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
  // Only ever fired when a tool genuinely needs a human: a rule that approves
  // the tool, `bypassPermissions`, and the auto-mode classifier all settle it
  // before this event is reached. It carries no message, so a row shows the
  // reason once the Notification catches up a few seconds later.
  PermissionRequest: 'blocked',
  Notification: 'blocked',
  Stop: 'idle',
  SessionEnd: 'ended',
};

/**
 * How a pi extension event maps to a session state.
 *
 * `agent_settled` rather than `agent_end` is the idle signal: it fires once
 * there is no retry, compaction or follow-up left, so a session that is about
 * to carry on by itself is never announced as finished. Measured against a real
 * failed turn, the whole sequence still arrives - `before_agent_start`,
 * `agent_start`, `turn_start`, `turn_end`, `agent_end`, `agent_settled` - so an
 * errored turn cannot strand a session reading "Working" forever.
 *
 * There is no `blocked` here, and that is the design rather than an omission.
 * See the module comment.
 */
const PI_EVENT_STATES = {
  session_start: 'idle',
  before_agent_start: 'working',
  agent_start: 'working',
  turn_start: 'working',
  agent_settled: 'idle',
  session_shutdown: 'ended',
};

/**
 * @param {string} event
 * @param {AgentKind} [agent]
 * @returns {SessionState}
 */
export function stateForEvent(event, agent = 'claude') {
  const states = agent === 'pi' ? PI_EVENT_STATES : EVENT_STATES;
  return states[event] || 'working';
}

/**
 * Events that mean the session is gone and its record should be removed.
 *
 * @param {string} event
 * @param {AgentKind} [agent]
 * @returns {boolean}
 */
export function isTerminalEvent(event, agent = 'claude') {
  return stateForEvent(event, agent) === 'ended';
}

/**
 * Session ids come from Claude Code, but they arrive over a socket, so treat
 * them as untrusted before they are ever used in a filename.
 */
export function isSafeSessionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

/** How long a record with no pid to probe may sit untouched before it is junk. */
const MAX_UNVERIFIABLE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

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
   * @param {HookPayload} payload
   * @param {number} [now]
   * @returns {Session|null} the stored record, or null if the session ended
   */
  record(payload, now = Date.now()) {
    const sessionId = payload.session_id;
    if (!isSafeSessionId(sessionId)) {
      throw new Error('invalid session id');
    }
    const event = payload.hook_event_name;
    // Claude Code's hook has no field to say which agent it is, so silence
    // means Claude Code. Only pi announces itself, and only pi needs to.
    const agent = /** @type {AgentKind} */ (payload.agent === 'pi' ? 'pi' : 'claude');
    if (isTerminalEvent(event, agent)) {
      this.remove(sessionId);
      return null;
    }

    const previous = this.get(sessionId) || /** @type {Partial<Session>} */ ({});
    const state = stateForEvent(event, agent);
    const record = {
      sessionId,
      agent,
      cwd: payload.cwd || previous.cwd || null,
      transcriptPath: payload.transcript_path || previous.transcriptPath || null,
      event,
      state,
      // A Notification carries the reason Claude is asking for you. Keep it
      // while blocked and clear it the moment the session moves on, so the
      // dashboard never shows a stale "needs permission".
      message: state === 'blocked' ? payload.message || null : null,
      // Claude Code names the kind of notification it is sending, which is what
      // tells a permission prompt from the sixty-second nudge without reading
      // the message. Kept and dropped with the message for the same reason.
      notificationType: state === 'blocked' ? payload.notification_type || null : null,
      host: { ...(previous.host || {}), ...(payload.host || {}) },
      startedAt: previous.startedAt || now,
      updatedAt: now,
      stateSince: previous.state === state ? previous.stateSince || now : now,
    };
    this.#write(sessionId, record);
    return record;
  }

  /**
   * @param {string} sessionId
   * @returns {Session|null}
   */
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
   * @param {(pid: number) => boolean} [options.isAlive] pid liveness probe,
   *   injected so tests never probe the machine running them
   * @param {number} [options.now]
   * @returns {Session[]}
   */
  list({ isAlive = defaultIsAlive, now = Date.now() } = {}) {
    let names;
    try {
      names = readdirSync(this.#dir);
    } catch {
      return [];
    }
    /** @type {Session[]} */
    const records = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const sessionId = name.slice(0, -5);
      const record = this.get(sessionId);
      if (!record) continue;
      // A session whose process is gone was killed or crashed without a
      // SessionEnd. Drop it rather than offering a row that focuses nothing.
      const pid = record.host?.pid;
      if (pid) {
        if (!isAlive(pid)) {
          this.remove(sessionId);
          continue;
        }
      } else if (now - (record.updatedAt || 0) > MAX_UNVERIFIABLE_AGE_MS) {
        // No pid means the agent could not be identified confidently, so there
        // is nothing to probe and the same crash leaves the record forever.
        // Fall back to age, generously: a session idle over a long weekend is
        // still a session, so only weeks of silence count as gone.
        this.remove(sessionId);
        continue;
      }
      records.push(record);
    }
    return records.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /** @param {string} sessionId */
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
