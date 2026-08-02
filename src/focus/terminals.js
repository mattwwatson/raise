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

import { itermFocusScript, terminalAppFocusScript, appRunningScript } from './applescript.js';

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

export const iterm2 = {
  name: 'iterm2',
  label: 'iTerm2',
  /** Set by the hook as TERM_PROGRAM when Claude runs in a plain iTerm2 tab. */
  termProgram: 'iTerm.app',
  async isAvailable(exec) {
    return process.platform === 'darwin' && (await isAppRunning(exec, 'iTerm2'));
  },
  /**
   * @param {{sessionUuid?: string|null, tty?: string|null}} target
   * @returns {Promise<boolean>} whether a matching tab was found and focused
   */
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
};

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
 */
export function orderedTerminals(termProgram, terminals = ALL_TERMINALS) {
  if (!termProgram) return terminals;
  const preferred = terminals.filter((t) => t.termProgram === termProgram);
  const rest = terminals.filter((t) => t.termProgram !== termProgram);
  return [...preferred, ...rest];
}
