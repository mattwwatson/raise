/**
 * Opening a session that nothing is showing in a new tab - the `new-tab`
 * setting.
 *
 * Every other path in ./index.js raises a window that already shows the
 * session. When none does - a detached tmux session, a Herdr terminal no tab
 * and no app pane shows - Raise already knows the exact command that would
 * show it, because it puts that command in the hint. The click asks to see the
 * session, so with this setting on Raise runs the command itself, in a new tab
 * of the terminal the user named, and that tab is what the next click raises:
 * it is an attached tmux client, or a typed `hc attach`, which the existing
 * paths already find.
 *
 * **The terminal is named in config and never detected.** Nothing the session
 * recorded can say which terminal to open: a Herdr session's `TERM_PROGRAM` is
 * always Herdr's own `ghostty`, and a tmux session's is whatever terminal
 * started the tmux server, which may be long gone. Choosing from either would be
 * a guess presented as a fact. `raise enable new-tab` writes the name once, from
 * the one supported terminal that is running or from the user, and this module
 * only reads it.
 *
 * **It is a fallback, after every way of showing the session that exists.** It
 * never runs while a window already shows the session, never where two typed
 * attaches make the session ambiguous (two tabs already show it, so a third is
 * not the answer), and when it fails the caller gives the refusal it would have
 * given with the setting off, hint and all. Nobody is worse off for turning it
 * on.
 *
 * **Commands are argv arrays until the last moment.** Each terminal adapter
 * quotes the array once, for the way its own terminal runs a command - see
 * `openTab` in ./terminals.js and the scripts in ./applescript.js. Nothing here
 * builds a command string, and every executable is an absolute path: a terminal
 * started from the Dock searches a minimal `PATH`, where Homebrew's `tmux` and
 * `~/.local/bin/hc` are not found. See `findExecutable` in ../exec.js.
 *
 * Pure apart from the injected `exec`: the setting arrives as a parameter, read
 * at click time by the caller, so this directory stays free of file access.
 */

import { ALL_TERMINALS } from './terminals.js';
import { socketArgs } from './tmux.js';

/** @typedef {import('./terminals.js').Terminal} Terminal */
/** @typedef {import('../user-config.js').UserConfig} UserConfig */

/** The block of `~/.raise/config.json` this setting lives in. */
export const NEW_TAB_BLOCK = 'newTab';

/**
 * The `new-tab` setting as focusing reads it.
 *
 * `terminal` is null whenever the setting cannot be acted on - off, or on but
 * naming a terminal Raise cannot open a tab in - so a caller checks one field.
 * `problem` is for `raise doctor`, set only when the user evidently tried to
 * turn it on and it is not working.
 *
 * @typedef {object} NewTabSetting
 * @property {boolean} enabled
 * @property {string|null} terminal the `name` of an adapter that implements `openTab`
 * @property {string|null} problem
 */

/** @type {NewTabSetting} */
const OFF = { enabled: false, terminal: null, problem: null };

/**
 * The terminals the setting may name: every adapter that can open a tab, read
 * off the adapter list so there is no second list to keep in step.
 *
 * @param {Terminal[]} [terminals]
 * @returns {Terminal[]}
 */
export function newTabTerminals(terminals = ALL_TERMINALS) {
  return terminals.filter((terminal) => typeof terminal.openTab === 'function');
}

/**
 * Read the setting from the config file, as `readUserConfig` returned it.
 *
 * `enabled` has to be the boolean `true`, as for the other two blocks: a
 * missing block, `"true"` or a block with only a terminal in it is off. A
 * terminal name nothing recognises is a problem rather than a fallback to some
 * other terminal, because opening a tab in a terminal the user did not name is
 * the guess this setting exists to avoid.
 *
 * @param {UserConfig} file
 * @param {{terminals?: Terminal[]}} [options]
 * @returns {NewTabSetting}
 */
export function newTabFrom(file, { terminals = ALL_TERMINALS } = {}) {
  if (file.problem) return { ...OFF, problem: file.problem };
  const block = file.data?.[NEW_TAB_BLOCK];
  if (block?.enabled !== true) return OFF;
  const known = newTabTerminals(terminals);
  const terminal = known.find((candidate) => candidate.name === block.terminal);
  if (terminal) return { enabled: true, terminal: terminal.name, problem: null };
  const names = known.map((candidate) => candidate.name).join(', ');
  return {
    enabled: true,
    terminal: null,
    problem:
      block.terminal === undefined
        ? `on, but no terminal is named - run raise enable new-tab <terminal> (${names})`
        : `on, but ${JSON.stringify(block.terminal)} is not a terminal Raise can open a tab in ` +
          `(${names}) - run raise enable new-tab <terminal>`,
  };
}

/**
 * The command that attaches a new tmux client to one session.
 *
 * The target is the session's `$N` id and never its name, which is user data
 * and prefix-matches - see ./tmux.js. The socket is the one the session's own
 * `$TMUX` names, through the same `-S` handling every other tmux command uses.
 *
 * @param {{tmux: string, tmuxEnv: string|null, sessionId: string}} target
 * @returns {string[]}
 */
export function tmuxAttachArgv({ tmux, tmuxEnv, sessionId }) {
  return [tmux, ...socketArgs(tmuxEnv), 'attach-session', '-t', sessionId];
}

/** Where `env` lives on every macOS, so it needs no search. */
const ENV = '/usr/bin/env';

/**
 * The command that attaches one Herdr terminal, on the server it lives on.
 *
 * **The server is always named, the default one included**, by `HC_SOCKET`,
 * which is the one form that names any server - see `attachHint` in ./herdr.js,
 * which builds the human version from the same inputs. A bare `hc` reaches
 * whichever server the new tab's environment points at, and that environment
 * is the terminal app's rather than Raise's, so leaving it out would be trusting
 * an environment nobody here has read. `HC_SESSION` is cleared for the same
 * reason, so `HC_SOCKET` is the only thing that chooses.
 *
 * `env` execs `hc`, so the process the next click finds in the process table
 * is `<path>/hc attach t6` - the typed attach ./herdr.js already recognises.
 *
 * @param {{hc: string, address: string, socket: string}} target
 * @returns {string[]}
 */
export function herdrAttachArgv({ hc, address, socket }) {
  return [ENV, '-u', 'HC_SESSION', `HC_SOCKET=${socket}`, hc, 'attach', address];
}

/**
 * Run the command in a new tab of the named terminal.
 *
 * @param {Function} exec
 * @param {{argv: string[], terminal: string, terminals: Terminal[]}} target
 * @returns {Promise<{ok: true, adapter: string}|null>} null when it did not open
 */
export async function openInNewTab(exec, { argv, terminal, terminals }) {
  const adapter = newTabTerminals(terminals).find((candidate) => candidate.name === terminal);
  if (!adapter?.openTab) return null;
  try {
    if (await adapter.openTab(exec, { argv })) return { ok: true, adapter: adapter.name };
  } catch {
    // The same rule as every adapter call: a misbehaving one is "did not open".
  }
  return null;
}

/**
 * Which terminal `raise enable new-tab` should write, or why it will not write
 * one. Pure: the command finds out which terminals are running and hands the
 * answer in.
 *
 * In order: a terminal the user named, if Raise can open a tab in it - and a
 * refusal if not, rather than writing a name nothing reads; then the one
 * already in the file, which is kept; then the one supported terminal that is
 * running. Several running is a refusal that names them, and none is a refusal
 * that says how to name one. Choosing between two running terminals would be
 * the guess the setting is named in config to avoid.
 *
 * `terminal` undefined with no `error` means keep what the file has.
 *
 * @param {{named?: string, existing?: unknown, running: Terminal[],
 *   terminals?: Terminal[], platform?: string}} input
 * @returns {{terminal?: string, error?: string}}
 */
export function chooseNewTabTerminal({
  named,
  existing,
  running,
  terminals = ALL_TERMINALS,
  platform = process.platform,
}) {
  const known = newTabTerminals(terminals);
  const names = known.map((terminal) => terminal.name).join(', ');
  if (named !== undefined) {
    const match = known.find((terminal) => terminal.name === named);
    if (match) return { terminal: match.name };
    return { error: `Unknown terminal ${JSON.stringify(named)}. Raise can open a tab in: ${names}.` };
  }
  if (known.some((terminal) => terminal.name === existing)) return {};
  const candidates = known.filter((terminal) => running.includes(terminal));
  if (candidates.length === 1) return { terminal: candidates[0].name };
  if (candidates.length > 1) {
    return {
      error:
        `More than one terminal is running (${candidates.map((terminal) => terminal.label).join(', ')}), ` +
        'so Raise will not guess which to open in. Name one: raise enable new-tab <terminal> ' +
        `(${candidates.map((terminal) => terminal.name).join(', ')}).`,
    };
  }
  if (platform !== 'darwin') {
    return { error: 'Opening a session in a new tab is macOS-only so far.' };
  }
  return {
    error:
      'No terminal Raise can open a tab in is running. Start the one you want and run this ' +
      `again, or name it: raise enable new-tab <terminal> (${names}).`,
  };
}
