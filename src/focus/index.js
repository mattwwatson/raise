/**
 * Focusing the window that wants you.
 *
 * Both hosting styles collapse to the same final step - bring the terminal tab
 * with a given tty (or iTerm2 session UUID) to the front:
 *
 *   plain tab  ->  the session's own identifiers, captured at session start
 *   tmux pane  ->  select the pane, then resolve the attached client's tty
 *
 * Everything terminal-specific lives in ./terminals.js, so supporting another
 * terminal never touches this file.
 */

import { resolveTmuxTarget, selectPane } from './tmux.js';
import { orderedTerminals, ALL_TERMINALS } from './terminals.js';

/**
 * Terminals export their session identity as "w0t2p0:UUID". Only the UUID part
 * matches the session id exposed to AppleScript.
 */
export function itermUuid(sessionIdEnv) {
  if (!sessionIdEnv) return null;
  const match = String(sessionIdEnv).match(/([0-9A-Fa-f-]{36})/);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Find a usable terminal session UUID.
 *
 * iTerm2 sets both ITERM_SESSION_ID and TERM_SESSION_ID to the same UUID, but
 * ITERM_SESSION_ID comes from shell integration and is not always present,
 * whereas TERM_SESSION_ID is set by the terminal itself. Falling back to it
 * keeps sessions focusable that would otherwise look anonymous.
 *
 * Terminal.app also sets TERM_SESSION_ID, so the value here is not necessarily
 * an iTerm2 UUID. That is harmless: the iTerm2 adapter simply finds no match
 * and the search falls through to the next terminal.
 */
export function terminalSessionUuid(host = {}) {
  return itermUuid(host.iterm_session_id) || itermUuid(host.term_session_id);
}

/**
 * Work out what focusing this session requires, without doing any of it.
 *
 * Separated from execution so the decision is testable on its own.
 *
 * @param {object} record a session record from the registry
 * @returns {{kind: 'tmux'|'tab'|'unfocusable', pane?: string, tmuxEnv?: string,
 *            sessionUuid?: string|null, tty?: string|null, termProgram?: string|null,
 *            reason?: string}}
 */
export function planFocus(record) {
  const host = record?.host || {};
  if (host.tmux_pane) {
    return {
      kind: 'tmux',
      pane: host.tmux_pane,
      tmuxEnv: host.tmux || null,
      termProgram: host.term_program || null,
    };
  }
  const sessionUuid = terminalSessionUuid(host);
  const tty = host.tty || null;
  if (!sessionUuid && !tty) {
    return {
      kind: 'unfocusable',
      reason:
        'This session did not report a window identity. It was probably started ' +
        'before the hooks were installed - restart it and it will become focusable.',
    };
  }
  return {
    kind: 'tab',
    sessionUuid,
    tty,
    termProgram: host.term_program || null,
  };
}

/**
 * Try every terminal adapter in turn until one reports it found the tab.
 *
 * @returns {Promise<{ok: boolean, adapter?: string, reason?: string}>}
 */
async function focusTerminal(exec, { sessionUuid, tty, termProgram, terminals }) {
  const candidates = orderedTerminals(termProgram, terminals);
  const attempted = [];
  for (const terminal of candidates) {
    // Sequential on purpose: the adapters compete to raise a window, so asking
    // them all at once would race two terminals to the front.
    try {
      if (!(await terminal.isAvailable(exec))) continue;
      attempted.push(terminal.label);
      if (await terminal.focus(exec, { sessionUuid, tty })) {
        return { ok: true, adapter: terminal.name };
      }
    } catch {
      // A terminal that errors is treated as "not this one" so a single
      // misbehaving adapter cannot block the others. The availability check is
      // inside the guard too: osascript against a wedged terminal times out,
      // and that must not decide the answer for every other terminal.
    }
  }
  if (attempted.length === 0) {
    return {
      ok: false,
      reason:
        process.platform === 'darwin'
          ? 'No supported terminal is running. nmmon can focus iTerm2 and Terminal.app.'
          : `Focusing is only implemented for macOS terminals so far. On ${process.platform}, use the tmux target shown instead.`,
    };
  }
  return {
    ok: false,
    reason: `Could not find that tab in ${attempted.join(' or ')}. It may have been closed.`,
  };
}

/**
 * Focus the window hosting a session.
 *
 * @param {object} record session record
 * @param {{exec: Function, terminals?: object[]}} deps `exec` must be
 *   asynchronous; this is reachable from the server's /focus handler.
 * @returns {Promise<{ok: boolean, adapter?: string, reason?: string, hint?: string, tmuxSession?: string}>}
 */
export async function focusSession(record, { exec, terminals = ALL_TERMINALS }) {
  const plan = planFocus(record);

  if (plan.kind === 'unfocusable') {
    return { ok: false, reason: plan.reason };
  }

  if (plan.kind === 'tab') {
    return focusTerminal(exec, { ...plan, terminals });
  }

  // tmux: put the right pane in front inside tmux first, then surface the
  // terminal window that tmux client is living in.
  const target = await resolveTmuxTarget(exec, { pane: plan.pane, tmuxEnv: plan.tmuxEnv });
  if (!target.ok) {
    return {
      ok: false,
      reason:
        target.reason === 'detached'
          ? `tmux session "${target.session}" is not attached to any window.`
          : target.hint,
      hint: target.hint,
      tmuxSession: target.session || undefined,
    };
  }
  await selectPane(exec, { pane: plan.pane, tmuxEnv: plan.tmuxEnv });
  const result = await focusTerminal(exec, {
    sessionUuid: null,
    tty: target.tty,
    termProgram: plan.termProgram,
    terminals,
  });
  return { ...result, tmuxSession: target.session };
}
