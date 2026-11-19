/**
 * Herdr resolution.
 *
 * Herdr is a terminal session manager in tmux's family: a Claude Code session
 * runs in a terminal owned by a Herdr server, and what shows that terminal is
 * either the Herdr desktop app or an `hc attach` client in an ordinary terminal
 * app. So this is a multiplexer path, like ./tmux.js, and **not** an entry in
 * ./terminals.js - Herdr is not a terminal app, it sits between the session and
 * one, and the one-entry rule for terminals does not fit it.
 *
 * **Nothing the session itself recorded can name its window.** Herdr sets
 * `TERM_PROGRAM=ghostty` in every terminal it creates, whatever app shows it,
 * and the session's tty is Herdr's own pseudo-terminal rather than the tab of
 * any app. Handed to the terminal adapters, that tty matched nothing and the
 * click said *"Could not find that tab in Ghostty"* about a session that was
 * not in Ghostty at all. What the session can say is `HC_TERMINAL_ID` (its
 * address, `t5`) and `HC_TERMINAL_SOCKET` (its server), and everything here is
 * resolved from those at click time, because which app shows a terminal
 * changes all day.
 *
 * **An `hc` client shows one terminal for its whole life, and only a typed
 * address says which.** `hc attach t6` names its terminal in argv. The picker
 * (`hc`, or `hc attach` with no address) leaves no trace: its argv stays bare,
 * it holds only a socket to the server, and Herdr has no way to list clients.
 * Choosing between two picker clients - or trusting "the only picker client" -
 * would be a guess, so the picker is not supported and the README says so.
 *
 * **A typed attach does not name its server either, measured on hc 0.1.21.**
 * `hc attach` takes no server option; the server comes from `HC_SESSION` or
 * `HC_SOCKET` in the client's environment, and macOS `ps` will not show
 * another process's environment. So the address alone could belong to a second
 * server's `t6`. A running server is visible in the process table only through
 * its holder (`herdr-core hold --socket <dir>/<name>.holder.*.sock`), whose socket
 * sits beside its server's - measured for the default server and for one started
 * on its own `HC_SOCKET`. So a holder in any other directory than the session's
 * socket disproves the address: two servers are running and `t6` could be
 * either. That check can only ever disprove - finding no holders asserts
 * nothing, and the typed address is still the evidence.
 *
 * **The desktop app speaks to one server, and it is the default one.**
 * `herdr-app` takes no socket, so a session on any other server must never
 * reach it: `pane.focus --terminal t5` there would focus the default server's
 * `t5`, which is a different terminal. The default server's socket is
 * `<state>/default/default.sock`, so a server's name is read off that shape and
 * anything that does not have it is not the default.
 *
 * Herdr is at 0.1.x. Every command goes through the injected `exec`
 * asynchronously, and a failed command, output we cannot parse or a field we do
 * not recognise all mean "not available there" - never an error - so the caller
 * moves on to the next way of showing the session.
 */

import { appRunningByIdScript, activateAppByIdScript } from './applescript.js';
import { shellQuote } from './tmux.js';

/** The Herdr desktop app, named the one way that cannot match another app. */
export const HERDR_BUNDLE_ID = 'dev.herdr.app';

/** The desktop app's command-line front end. */
const HERDR_APP = 'herdr-app';

/** The server a bare `hc` and the desktop app both reach. */
const DEFAULT_SERVER = 'default';

/** Addresses are `t<number>`, per herdr-core's own error text. */
const ADDRESS = /^t\d+$/;

/**
 * An executable that is the Herdr client: `hc`, `herdr-core`, or either by path.
 * A path may hold spaces only inside an app bundle (`Herdr Core.app`), which is
 * what stops `vim notes/hc attach t6` reading as a client.
 */
const CLIENT_ATTACH =
  /^(?:\S*\/|\/.*\.app\/Contents\/MacOS\/)?(?:hc|herdr-core)\s+attach(?:\s+(.*))?$/;

/** A server's holder process, and its socket, which sits beside the server's own. */
const HOLDER = /(?:^|\/)herdr-core\s+hold\s(?:.*\s)?--socket[=\s](\S+)/;

/** Flags `hc attach` takes that carry no value. Anything else is not understood. */
const ATTACH_FLAGS = new Set(['--json', '--observe']);

/** The one `hc attach` flag that takes a value. */
const HISTORY_FLAG = '--history';

/**
 * Is this a Herdr address Raise will put into argv and into a hint?
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isHerdrAddress(value) {
  return typeof value === 'string' && ADDRESS.test(value);
}

/**
 * The server a socket path belongs to, by the `<name>/<name>.sock` shape
 * herdr-core gives every server's state directory. Null for anything else - a
 * custom `HC_SOCKET`, or a layout a later Herdr changed - because naming a
 * server we cannot identify would be a guess.
 *
 * @param {string|null|undefined} socket
 * @returns {string|null}
 */
export function herdrServerName(socket) {
  const match = String(socket || '').match(/\/([^/]+)\/\1\.sock$/);
  return match ? match[1] : null;
}

/** @param {string} path */
function dirname(path) {
  const at = path.lastIndexOf('/');
  return at > 0 ? path.slice(0, at) : '';
}

/**
 * The address an `hc attach` command line names, or null when it names none or
 * carries something we do not understand.
 *
 * Failing closed on an unknown flag is deliberate: a flag that takes a value
 * would make the value look like the address, and a wrong address raises
 * somebody else's tab.
 *
 * @param {string} args the whole command line
 * @returns {string|null}
 */
export function typedAttachAddress(args) {
  const match = String(args || '').trim().match(CLIENT_ATTACH);
  if (!match) return null;
  const tokens = (match[1] || '').split(/\s+/).filter(Boolean);
  const positional = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (ATTACH_FLAGS.has(token) || token.startsWith(`${HISTORY_FLAG}=`)) continue;
    if (token === HISTORY_FLAG) {
      i += 1;
      continue;
    }
    if (token.startsWith('-')) return null;
    positional.push(token);
  }
  // `machine/t7` is a terminal on another machine and fails the address test,
  // which is right: it is not this machine's `t7`.
  return positional.length === 1 && isHerdrAddress(positional[0]) ? positional[0] : null;
}

/**
 * One line of `ps -A -ww -o tty=,args=`.
 *
 * @param {string} line
 * @returns {{tty: string|null, args: string}|null}
 */
function parseLine(line) {
  const match = String(line || '').match(/^\s*(\S+)\s+(.*)$/);
  if (!match) return null;
  const field = match[1];
  const tty = field === '??' || field === '?' || field === '-' ? null : field;
  return {
    tty: tty && !tty.startsWith('/dev/') ? `/dev/${tty}` : tty,
    args: match[2].trim(),
  };
}

/**
 * What the process table says about one Herdr terminal.
 *
 * @typedef {object} HerdrSighting
 * @property {string[]} attachTtys the tabs holding a typed `hc attach <address>`
 *   for this address, one per tty
 * @property {string[]} serverDirs the socket directory of every running server
 */

/**
 * Read the typed attaches of one address, and the servers running, from a
 * process table.
 *
 * @param {string} text `ps -A -ww -o tty=,args=`
 * @param {string} address
 * @returns {HerdrSighting}
 */
export function parseHerdrProcesses(text, address) {
  const ttys = new Set();
  const dirs = new Set();
  for (const line of String(text || '').split('\n')) {
    const proc = parseLine(line);
    if (!proc) continue;
    const holder = proc.args.match(HOLDER);
    if (holder) {
      const dir = dirname(holder[1]);
      if (dir) dirs.add(dir);
      continue;
    }
    // A client with no terminal has no tab for an adapter to raise.
    if (proc.tty && typedAttachAddress(proc.args) === address) ttys.add(proc.tty);
  }
  return { attachTtys: [...ttys], serverDirs: [...dirs] };
}

/**
 * Where a typed attach shows this terminal, if exactly one does.
 *
 * @typedef {object} TypedAttach
 * @property {string|null} tty the one tab to hand to the terminal adapters
 * @property {boolean} ambiguous more than one tab holds a typed attach of it
 * @property {boolean} unattributed a typed attach of this address exists, but
 *   another server is running, so it may be showing this terminal or that
 *   server's - which is not the same as nothing showing it
 */

/**
 * Find the typed `hc attach <address>` client showing this terminal on this
 * server.
 *
 * @param {Function} exec asynchronous
 * @param {{address: string, socket: string|null}} target
 * @returns {Promise<TypedAttach>}
 */
export async function findTypedAttach(exec, { address, socket }) {
  // Without the server there is nothing to hold the address against.
  if (!socket) return { tty: null, ambiguous: false, unattributed: false };
  let text;
  try {
    text = await exec('ps', ['-A', '-ww', '-o', 'tty=,args='], { timeoutMs: 5000 });
  } catch {
    return { tty: null, ambiguous: false, unattributed: false };
  }
  const { attachTtys, serverDirs } = parseHerdrProcesses(text, address);
  const ours = dirname(socket);
  if (serverDirs.some((dir) => dir !== ours)) {
    return { tty: null, ambiguous: false, unattributed: attachTtys.length > 0 };
  }
  if (attachTtys.length > 1) return { tty: null, ambiguous: true, unattributed: false };
  return { tty: attachTtys[0] ?? null, ambiguous: false, unattributed: false };
}

/**
 * Is this the server the desktop app shows?
 *
 * @param {string|null} socket
 * @returns {boolean}
 */
export function isAppServer(socket) {
  return herdrServerName(socket) === DEFAULT_SERVER;
}

/**
 * Did a `herdr-app do` command do what it was asked? It prints what it made, or
 * `{ "error": ... }` and exits 1, so a resolved exec with no `error` is
 * success. Nothing at all is success too - there is nothing to disbelieve.
 * Output that is not JSON is something this release does not promise, so it
 * counts as not done.
 *
 * @param {string} output
 * @returns {boolean}
 */
export function herdrAppSucceeded(output) {
  const text = String(output ?? '').trim();
  if (!text) return true;
  try {
    const parsed = JSON.parse(text);
    return !!parsed && typeof parsed === 'object' && !('error' in parsed);
  } catch {
    return false;
  }
}

/**
 * Run one `herdr-app do` command, true only if it reports success.
 *
 * @param {Function} exec
 * @param {string[]} args
 * @returns {Promise<boolean>}
 */
async function herdrAppDo(exec, args) {
  try {
    return herdrAppSucceeded(await exec(HERDR_APP, ['do', ...args], { timeoutMs: 5000 }));
  } catch {
    return false;
  }
}

/**
 * @param {Function} exec
 * @param {string} script
 * @returns {Promise<string|null>} null on any failure
 */
async function osascript(exec, script) {
  try {
    return (await exec('osascript', ['-e', script], { timeoutMs: 5000 })).trim();
  } catch {
    return null;
  }
}

/**
 * How the desktop app came to show the terminal, and whether it came forward.
 *
 * `via: 'pane'` is the app's own pane for it, on its own space and tab.
 * `via: 'shown'` is a pane that belongs to something else, borrowed until the
 * user switches back - which is worth saying, because the window looks like the
 * session moved. `front` is false when the app switched its pane but would not
 * come forward: the pane has still changed, so that is not "not shown".
 *
 * @typedef {{via: 'pane'|'shown', front: boolean}|null} HerdrAppOutcome
 */

/**
 * Bring the terminal up in the Herdr desktop app, if it is running.
 *
 * `pane.focus` first, because it selects the space and tab the terminal already
 * lives in and disturbs nothing. Only when the app has no pane of its own for
 * it does `terminal.show` borrow the focused one. Neither brings the app
 * forward, so both are followed by activating it. An app that will not come
 * forward has still changed its pane, and the outcome says so with `front`.
 *
 * `borrow: false` stops at `pane.focus`. The `new-tab` setting asks for that,
 * because it has somewhere better to show the terminal than over whatever the
 * user's focused pane was showing.
 *
 * @param {Function} exec
 * @param {{address: string, borrow?: boolean}} target
 * @returns {Promise<HerdrAppOutcome>}
 */
export async function showInHerdrApp(exec, { address, borrow = true }) {
  // `is running` never launches it. Starting the app to show one terminal would
  // open a window the user did not ask for.
  if ((await osascript(exec, appRunningByIdScript(HERDR_BUNDLE_ID))) !== 'true') return null;
  /** @type {'pane'|'shown'|null} */
  let via = null;
  if (await herdrAppDo(exec, ['pane.focus', '--terminal', address])) {
    via = 'pane';
  } else if (borrow && (await herdrAppDo(exec, ['terminal.show', '--terminal', address]))) {
    via = 'shown';
  }
  if (!via) return null;
  const front = (await osascript(exec, activateAppByIdScript(HERDR_BUNDLE_ID))) !== null;
  return { via, front };
}

/**
 * The command that attaches a terminal in your own terminal app.
 *
 * A server other than the default needs naming, because a bare `hc` reaches the
 * default one. `HC_SOCKET` is the one form that names any server, a custom
 * socket included; the path is quoted because it will be pasted into a shell.
 *
 * @param {{address: string, socket: string|null}} target
 * @returns {string}
 */
export function attachHint({ address, socket }) {
  if (!socket || isAppServer(socket)) return `hc attach ${address}`;
  return `HC_SOCKET=${shellQuote(socket)} hc attach ${address}`;
}
