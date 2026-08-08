/**
 * Focusing the window that wants you.
 *
 * Both terminal hosting styles collapse to the same final step - bring the tab
 * with a given tty (or iTerm2 session UUID) to the front:
 *
 *   plain tab  ->  the session's own identifiers, captured at session start
 *   tmux pane  ->  choose which attached client to raise, then select the pane
 *                  inside that client's session and raise its tty
 *
 * The tmux order is that way round because a pane's window can belong to more
 * than one session, so which client to raise is the question, and everything
 * after it has to be aimed at the session that client is in. See ./tmux.js.
 *
 * Everything terminal-specific lives in ./terminals.js, so supporting another
 * terminal never touches this file.
 *
 * Claude Desktop is the one host that does not collapse into that, because it
 * has no window a tty can name. It gets its own branch and ./claude-desktop.js.
 */

import { resolveTmuxTarget, selectPane } from './tmux.js';
import { orderedTerminals, ALL_TERMINALS } from './terminals.js';
import { focusClaudeDesktop } from './claude-desktop.js';

/** @typedef {import('./terminals.js').Terminal} Terminal */
/** @typedef {import('../registry.js').Session} Session */
/** @typedef {import('../registry.js').Host} Host */

/**
 * What focusing this session will take, decided without doing any of it.
 *
 * `kind` discriminates: a tmux pane needs resolving through tmux first, a tab
 * can be handed straight to the terminal adapters, and an unfocusable session
 * carries only the reason to show the user.
 *
 * @typedef {object} FocusPlan
 * @property {'tmux'|'tab'|'app'|'unfocusable'} kind
 * @property {string} [pane] tmux only
 * @property {string|null} [tmuxEnv] tmux only, the TMUX socket
 * @property {string|null} [sessionUuid] tab only
 * @property {string|null} [tty] tab only
 * @property {string|null} [termProgram] which adapter to try first
 * @property {'claude-desktop'} [app] app only, which application hosts it
 * @property {string} [reason] unfocusable only, phrased for the user
 */

/**
 * The outcome of trying to raise a window.
 *
 * @typedef {object} FocusResult
 * @property {boolean} ok
 * @property {string} [adapter] which terminal claimed it
 * @property {string} [reason] why not, phrased for the user
 * @property {string} [hint] a command the user can run instead
 * @property {string} [note] raised, but not onto the thing you asked for - say so
 * @property {string} [tmuxSession]
 * @property {boolean} [ambiguous] more than one window matched, so none was raised
 */

/**
 * The stable part of a pane title, for matching against a terminal's own name
 * for that pane.
 *
 * Claude Code prefixes its title with a status glyph and animates a braille
 * spinner through it, so the title read from tmux and the name read from the
 * terminal a moment later differ in their first character as often as not.
 * Strip any leading run of non-alphanumerics and match on the rest.
 *
 * Returns null for anything too short to identify a window: a two-character
 * title would match half the tabs open, and raising the wrong one is the exact
 * failure this is here to fix.
 *
 * @param {string|null} title
 * @returns {string|null}
 */
export function titleNeedle(title) {
  const stripped = String(title || '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim();
  return stripped.length >= 4 ? stripped : null;
}

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
 *
 * @param {Host} [host]
 * @returns {string|null}
 */
export function terminalSessionUuid(host = {}) {
  return itermUuid(host.iterm_session_id) || itermUuid(host.term_session_id);
}

/**
 * Work out what focusing this session requires, without doing any of it.
 *
 * Separated from execution so the decision is testable on its own.
 *
 * @param {Session|null} record a session record from the registry
 * @returns {FocusPlan}
 */
export function planFocus(record) {
  const host = record?.host || {};
  // First, and on its own evidence. A desktop session reports no tty and no
  // terminal UUID, so every branch below it would fall through to
  // "unfocusable" - which is exactly the dead card this branch exists to fix.
  if (host.app === 'claude-desktop') {
    return { kind: 'app', app: 'claude-desktop' };
  }
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
 * @param {Function} exec
 * @param {{sessionUuid?: string|null, tty?: string|null, termProgram?: string|null,
 *          terminals: Terminal[]}} target
 * @returns {Promise<FocusResult>}
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
          ? 'No supported terminal is running. Raise can focus iTerm2 and Terminal.app.'
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
 * @param {Session|null} record session record
 * @param {{exec: Function, terminals?: Terminal[]}} deps `exec` must be
 *   asynchronous; this is reachable from the server's /focus handler.
 * @returns {Promise<FocusResult>}
 */
export async function focusSession(record, { exec, terminals = ALL_TERMINALS }) {
  const plan = planFocus(record);

  if (plan.kind === 'unfocusable') {
    return { ok: false, reason: plan.reason };
  }

  if (plan.kind === 'app') {
    return focusClaudeDesktop(exec);
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

  // Control mode first, because for those panes the tmux client's tty is not
  // just unhelpful but actively wrong - it names the idle tab that ran
  // `tmux -CC`, so the old code raised that tab every single time.
  if (target.controlMode) {
    const byTitle = await focusByPaneTitle(exec, {
      title: titleNeedle(target.title),
      termProgram: plan.termProgram,
      terminals,
    });
    // No selectPane here on purpose: the terminal owns the pane layout in
    // control mode and does not follow tmux's selection, so selecting would
    // move tmux's active window with nothing to show for it.
    if (byTitle.ok) return { ...byTitle, tmuxSession: target.session };
    if (byTitle.ambiguous) {
      return {
        ok: false,
        reason: `More than one window is called "${titleNeedle(target.title)}", so Raise cannot tell which is this session.`,
        tmuxSession: target.session,
      };
    }
    if (!target.tty) {
      return {
        ok: false,
        reason: `Could not find the window for tmux pane ${plan.pane}. Its terminal hosts tmux in control mode, so there is no tty to fall back to.`,
        tmuxSession: target.session,
      };
    }
    // A plain client is attached as well; that tty is worth a try.
  }

  await selectPane(exec, {
    pane: plan.pane,
    tmuxEnv: plan.tmuxEnv,
    sessionId: target.sessionId,
    windowId: target.windowId,
  });
  const result = await focusTerminal(exec, {
    sessionUuid: null,
    tty: target.tty,
    termProgram: plan.termProgram,
    terminals,
  });
  return { ...result, tmuxSession: target.session };
}

/**
 * Ask each terminal that supports it to find a pane by title.
 *
 * @param {Function} exec
 * @param {{title: string|null, termProgram?: string|null, terminals: Terminal[]}} target
 * @returns {Promise<FocusResult>}
 */
async function focusByPaneTitle(exec, { title, termProgram, terminals }) {
  if (!title) return { ok: false };
  for (const terminal of orderedTerminals(termProgram, terminals)) {
    if (typeof terminal.focusByTitle !== 'function') continue;
    try {
      if (!(await terminal.isAvailable(exec))) continue;
      const result = await terminal.focusByTitle(exec, { title });
      if (result === 'ok') return { ok: true, adapter: terminal.name };
      if (result === 'ambiguous') return { ok: false, ambiguous: true };
    } catch {
      // Same rule as focusTerminal: a misbehaving adapter is "not this one".
    }
  }
  return { ok: false };
}
