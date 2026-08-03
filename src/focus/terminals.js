/**
 * Terminal emulator adapters.
 *
 * Each adapter knows how to bring one specific terminal's tab to the front.
 * They are tried in order and the first one that reports a match wins, which is
 * what lets a single machine mix iTerm2 tabs and Terminal.app tabs without
 * configuring anything.
 *
 * Adding a terminal means adding an entry here and nothing else.
 *
 * `exec` is asynchronous throughout: an adapter can be reached from an HTTP
 * handler, and osascript against a busy terminal is exactly the sort of command
 * that takes seconds. See execAsync in ../exec.js.
 */

import {
  itermFocusScript,
  itermFocusByTitleScript,
  terminalAppFocusScript,
  appRunningScript,
} from './applescript.js';

/**
 * What a terminal is asked to find. Both are optional and an adapter may support
 * only one of them - Terminal.app exposes no session identifier, so it is
 * tty-only. An adapter given nothing it can use returns false rather than
 * guessing.
 *
 * @typedef {{sessionUuid?: string|null, tty?: string|null}} FocusTarget
 */

/**
 * One terminal emulator. This is the whole interface; adding a terminal means
 * adding an object of this shape to ALL_TERMINALS and nothing else.
 *
 * @typedef {object} Terminal
 * @property {string} name machine-readable, reported back as the adapter used
 * @property {string} label how to name it to a human
 * @property {string} [termProgram] the TERM_PROGRAM value that means "this one",
 *   used only to decide the order adapters are tried in
 * @property {(exec: Function) => Promise<boolean>} isAvailable
 * @property {(exec: Function, target: FocusTarget) => Promise<boolean>} focus
 * @property {(exec: Function, target: {title: string|null}) =>
 *   Promise<'ok'|'notfound'|'ambiguous'>} [focusByTitle] optional, and only
 *   iTerm2 implements it - see below
 */

const OSASCRIPT = 'osascript';

function runScript(exec, script) {
  return exec(OSASCRIPT, ['-e', script], { timeoutMs: 5000 });
}

async function isAppRunning(exec, processName) {
  try {
    return (await runScript(exec, appRunningScript(processName))).trim() === 'true';
  } catch {
    return false;
  }
}

/** @type {Terminal} */
export const iterm2 = {
  name: 'iterm2',
  label: 'iTerm2',
  /** Set by the hook as TERM_PROGRAM when Claude runs in a plain iTerm2 tab. */
  termProgram: 'iTerm.app',
  async isAvailable(exec) {
    return process.platform === 'darwin' && (await isAppRunning(exec, 'iTerm2'));
  },
  /** @returns {Promise<boolean>} whether a matching tab was found and focused */
  async focus(exec, { sessionUuid = null, tty = null }) {
    if (!sessionUuid && !tty) return false;
    // Prefer the session UUID: it survives the tab moving between windows,
    // whereas a tty can be recycled by a later process.
    if (sessionUuid) {
      if ((await runScript(exec, itermFocusScript({ sessionUuid }))) === 'ok') return true;
    }
    if (tty) {
      return (await runScript(exec, itermFocusScript({ tty }))) === 'ok';
    }
    return false;
  },
  /**
   * Only iTerm2 implements this: it is the terminal that hosts tmux in control
   * mode, and the only one where a pane has no tty to match on.
   *
   * @returns {Promise<'ok'|'notfound'|'ambiguous'>}
   */
  async focusByTitle(exec, { title }) {
    if (!title) return 'notfound';
    const result = (await runScript(exec, itermFocusByTitleScript({ title }))).trim();
    return result === 'ok' || result === 'ambiguous' ? result : 'notfound';
  },
};

/** @type {Terminal} */
export const terminalApp = {
  name: 'terminal-app',
  label: 'Terminal.app',
  termProgram: 'Apple_Terminal',
  async isAvailable(exec) {
    return process.platform === 'darwin' && (await isAppRunning(exec, 'Terminal'));
  },
  /**
   * Terminal.app exposes no session identifier we can match from the shell, so
   * this adapter is tty-only.
   *
   * @returns {Promise<boolean>}
   */
  async focus(exec, { tty = null }) {
    if (!tty) return false;
    return (await runScript(exec, terminalAppFocusScript({ tty }))) === 'ok';
  },
};

export const ALL_TERMINALS = [iterm2, terminalApp];

/**
 * Order the adapters so the terminal the session reported is tried first.
 *
 * For a plain tab that is always correct. For a tmux pane the reported
 * TERM_PROGRAM comes from whenever the tmux server started and may be stale, so
 * the other adapters are still tried afterwards rather than trusted away.
 *
 * @param {string|null} termProgram
 * @param {Terminal[]} [terminals]
 * @returns {Terminal[]}
 */
export function orderedTerminals(termProgram, terminals = ALL_TERMINALS) {
  if (!termProgram) return terminals;
  const preferred = terminals.filter((t) => t.termProgram === termProgram);
  const rest = terminals.filter((t) => t.termProgram !== termProgram);
  return [...preferred, ...rest];
}
