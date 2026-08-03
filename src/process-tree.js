/**
 * Working out which window a hook is running in, and which process owns it.
 *
 * Hooks run as a grandchild of Claude Code: Claude spawns a shell, the shell
 * runs the hook. Neither the controlling terminal nor the agent process is
 * visible without walking up the process tree.
 *
 * Two things are read from that walk, and they are not the same thing:
 *
 *   - the controlling terminal, which is what focusing a window needs
 *   - the pid of the long-lived agent, which is what liveness pruning needs
 *
 * The pid is the dangerous one. Recording the wrong pid is worse than
 * recording none: the shell that runs the hook exits the moment the hook
 * returns, so a session recorded against it is pruned within a poll tick and
 * the dashboard silently goes empty. A session with no pid is kept, so when
 * the agent cannot be identified confidently we record nothing.
 *
 * `ps -o comm=` is deliberately not used. macOS truncates it to 16 characters,
 * so an npm-installed Claude Code shows as `node` and a native one shows as a
 * clipped path like `/Users/you/.lo` - neither of which can be matched. The
 * full argument vector is read instead.
 */

import { basename } from 'node:path';

/**
 * One line of `ps`, parsed.
 *
 * @typedef {object} PsRecord
 * @property {number} ppid
 * @property {string|null} tty null when the process has no controlling terminal
 * @property {string} command argv[0]
 * @property {string} args the full argument vector
 */

/**
 * A `PsRecord` with the pid it was read for. Ancestor walks carry this, because
 * `ps` reports a process's parent but not itself.
 *
 * @typedef {PsRecord & {pid: number}} ProcessRecord
 */

/**
 * Reads one process from the process table. Injected everywhere so tests never
 * depend on the machine running them.
 *
 * @callback ReadProcess
 * @param {number} pid
 * @returns {PsRecord|null} null once the process has gone
 */

/**
 * Commands that only ever wrap something else. The hook's own parent is one of
 * these, and its pid is exactly the one we must never store.
 */
const WRAPPER_COMMANDS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
  'env',
  'login',
  'sudo',
  'nice',
  'timeout',
  'xargs',
]);

/** A native or shim `claude` executable. */
const CLAUDE_COMMAND = /^claude(-code)?$/;

/**
 * The npm install runs `node .../@anthropic-ai/claude-code/cli.js`, so the
 * package path is the only reliable marker there. The trailing boundary keeps
 * an unrelated path such as `~/.claude/settings.json` from matching.
 */
const CLAUDE_ARGS = /@anthropic-ai\/claude-code|claude-code\/cli\.js|(^|\/)claude(-code)?(\s|$)/;

/**
 * Claude Desktop hosting a session, matched two independent ways.
 *
 * The app spawns its own copy of Claude Code with no controlling terminal, so
 * such a session reports no tty, no TERM_PROGRAM and no terminal UUID - and on
 * that evidence alone it is indistinguishable from a no-mistakes agent running
 * under the daemon. The difference has to be positive, because acting on it is
 * not free: the deep link that raises a desktop session *imports* one that is
 * not already open, so firing it at a terminal session would drag that
 * conversation into an app the user never asked to involve.
 *
 * Both patterns are therefore paths only the app can occupy, never the word
 * "Claude" appearing in an argument. The first is the Electron app itself,
 * which is an ancestor of every session it hosts; the second is the Claude Code
 * it bundles and runs, which is the session process. Either is sufficient, and
 * having both means a change to how the app launches its child has to break
 * two things to go unnoticed.
 */
const DESKTOP_APP = /\/Claude\.app\/Contents\/MacOS\/Claude(\s|$)/;
const DESKTOP_CLI = /\/Application Support\/Claude\/claude-code\//;

/** The application hosting a session, when it is not a terminal. */
export const CLAUDE_DESKTOP = 'claude-desktop';

/**
 * Parse one line of `ps -o ppid=,tty=,args=`.
 *
 * @param {string} line
 * @returns {PsRecord|null}
 */
export function parsePsLine(line) {
  const match = String(line || '')
    .trim()
    .match(/^(\d+)\s+(\S+)(?:\s+(.*))?$/);
  if (!match) return null;
  const [, ppid, ttyField, rawArgs] = match;
  const args = (rawArgs || '').trim();
  return {
    ppid: Number(ppid),
    tty: normaliseTty(ttyField),
    command: args.split(/\s+/)[0] || '',
    args,
  };
}

/** "??" is how ps says "no controlling terminal". */
function normaliseTty(field) {
  if (!field || field === '??' || field === '?' || field === '-') return null;
  return field.startsWith('/dev/') ? field : `/dev/${field}`;
}

/**
 * Walk up from a pid, nearest ancestor first.
 *
 * @param {number} startPid
 * @param {object} options
 * @param {ReadProcess} options.readProcess
 * @param {number} [options.maxDepth]
 * @returns {ProcessRecord[]}
 */
export function readAncestors(startPid, { readProcess, maxDepth = 8 }) {
  /** @type {ProcessRecord[]} */
  const chain = [];
  let pid = Number(startPid);
  for (let depth = 0; depth < maxDepth && Number.isInteger(pid) && pid > 1; depth += 1) {
    let proc;
    try {
      proc = readProcess(pid);
    } catch {
      break;
    }
    if (!proc) break;
    chain.push({ ...proc, pid });
    pid = Number(proc.ppid);
  }
  return chain;
}

/**
 * The terminal the session is actually attached to, or null under a daemon.
 *
 * @param {ProcessRecord[]} chain
 * @returns {string|null}
 */
export function resolveTty(chain) {
  for (const proc of chain) {
    if (proc.tty) return proc.tty;
  }
  return null;
}

/** @param {string} command */
export function isWrapper(command) {
  return WRAPPER_COMMANDS.has(basename(command || ''));
}

/** @param {PsRecord|ProcessRecord|null} proc */
export function looksLikeClaude(proc) {
  if (!proc) return false;
  if (CLAUDE_COMMAND.test(basename(proc.command || ''))) return true;
  return CLAUDE_ARGS.test(proc.args || '');
}

/**
 * The pid of the long-lived agent process, or null if we cannot tell.
 *
 * Wrappers are skipped outright. Of what remains, the agent is either something
 * recognisably Claude Code, or - when it has been renamed or repackaged - the
 * nearest ancestor that owns the controlling terminal, since the shell that ran
 * the hook has already been excluded and everything above the agent is a shell
 * too.
 *
 * @param {ProcessRecord[]} chain nearest ancestor first
 * @returns {number|null}
 */
export function pickAgentPid(chain = []) {
  for (const proc of chain) {
    if (isWrapper(proc.command)) continue;
    if (looksLikeClaude(proc)) return proc.pid;
    if (proc.tty) return proc.pid;
  }
  return null;
}

/**
 * The application hosting this session, or null for an ordinary terminal.
 *
 * Only ever answers with evidence - see DESKTOP_APP above for why a guess here
 * is worse than no answer.
 *
 * @param {ProcessRecord[]} chain
 * @returns {'claude-desktop'|null}
 */
export function hostApp(chain = []) {
  for (const proc of chain) {
    const args = proc.args || '';
    if (DESKTOP_APP.test(args) || DESKTOP_CLI.test(args)) return CLAUDE_DESKTOP;
  }
  return null;
}

/**
 * @param {number} startPid
 * @param {object} options
 * @param {ReadProcess} options.readProcess
 * @param {number} [options.maxDepth]
 * @returns {{tty: string|null, agentPid: number|null, app: 'claude-desktop'|null}}
 */
export function inspectHost(startPid, { readProcess, maxDepth = 8 }) {
  const chain = readAncestors(startPid, { readProcess, maxDepth });
  return { tty: resolveTty(chain), agentPid: pickAgentPid(chain), app: hostApp(chain) };
}
