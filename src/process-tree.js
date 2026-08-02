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
 * Parse one line of `ps -o ppid=,tty=,args=`.
 *
 * @param {string} line
 * @returns {{ppid: number, tty: string|null, command: string, args: string}|null}
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
 * @param {Function} options.readProcess (pid) => parsed ps record, or null
 * @param {number} [options.maxDepth]
 * @returns {object[]}
 */
export function readAncestors(startPid, { readProcess, maxDepth = 8 } = {}) {
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

/** The terminal the session is actually attached to, or null under a daemon. */
export function resolveTty(chain) {
  for (const proc of chain) {
    if (proc.tty) return proc.tty;
  }
  return null;
}

export function isWrapper(command) {
  return WRAPPER_COMMANDS.has(basename(command || ''));
}

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
 * @param {object[]} chain nearest ancestor first
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
 * @param {number} startPid
 * @param {object} options
 * @param {Function} options.readProcess
 * @returns {{tty: string|null, agentPid: number|null}}
 */
export function inspectHost(startPid, { readProcess, maxDepth = 8 }) {
  const chain = readAncestors(startPid, { readProcess, maxDepth });
  return { tty: resolveTty(chain), agentPid: pickAgentPid(chain) };
}
