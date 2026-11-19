/**
 * The one place that runs external commands.
 *
 * Every module that needs to shell out takes an exec function as a parameter
 * rather than importing this directly, so tests can assert on the commands that
 * would have run without actually stealing focus or touching tmux.
 */

import { spawnSync, spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** Nothing we run should ever produce this much output; stop reading if it does. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

export class ExecError extends Error {
  constructor(message, { command, args, status, stderr }) {
    super(message);
    this.name = 'ExecError';
    this.command = command;
    this.args = args;
    this.status = status;
    this.stderr = stderr;
  }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, timeoutMs?: number, input?: string}} [options]
 * @returns {string} stdout, trimmed
 */
export function exec(command, args = [], options = {}) {
  const { cwd, timeoutMs = 10000, input } = options;
  const result = spawnSync(command, args, {
    cwd,
    timeout: timeoutMs,
    input,
    encoding: 'utf8',
    // Never inherit a terminal; these run under a server process.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw new ExecError(`${command} failed: ${result.error.message}`, {
      command,
      args,
      status: null,
      stderr: '',
    });
  }
  if (result.status !== 0) {
    throw new ExecError(`${command} exited ${result.status}: ${(result.stderr || '').trim()}`, {
      command,
      args,
      status: result.status,
      stderr: (result.stderr || '').trim(),
    });
  }
  return (result.stdout || '').trim();
}

/**
 * The same thing without blocking the event loop.
 *
 * The server must never run a synchronous child process: it polls on a one
 * second timer, pushes an event stream, and answers hook posts that give up
 * after two seconds. One slow or hung command run synchronously stalls all
 * three at once, and the signal you actually care about - "Claude is waiting
 * for you" - is the one that gets dropped.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, timeoutMs?: number, input?: string}} [options]
 * @returns {Promise<string>} stdout, trimmed
 */
export function execAsync(command, args = [], options = {}) {
  const { cwd, timeoutMs = 10000, input } = options;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        timeout: timeoutMs,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new ExecError(`${command} failed: ${err.message}`, { command, args, status: null, stderr: '' }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES) child.kill();
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length <= MAX_OUTPUT_BYTES) stderr += chunk;
    });
    child.on('error', (err) => {
      settle(reject, new ExecError(`${command} failed: ${err.message}`, {
        command,
        args,
        status: null,
        stderr: stderr.trim(),
      }));
    });
    child.on('close', (status) => {
      if (status === 0) {
        settle(resolve, stdout.trim());
        return;
      }
      settle(reject, new ExecError(`${command} exited ${status}: ${stderr.trim()}`, {
        command,
        args,
        status,
        stderr: stderr.trim(),
      }));
    });

    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/** Run a command and return null instead of throwing. */
export function tryExec(runner, command, args, options) {
  try {
    return runner(command, args, options);
  } catch {
    return null;
  }
}

/**
 * The same for an async runner, which rejects rather than throwing - so
 * tryExec would hand back a live rejected promise and blow up at the await.
 *
 * @returns {Promise<string|null>}
 */
export async function tryExecAsync(runner, command, args, options) {
  try {
    return await runner(command, args, options);
  } catch {
    return null;
  }
}

/**
 * The absolute path `exec` would run for a bare command name, or null when the
 * `PATH` holds no such executable.
 *
 * **For a command that something other than this process will run**, and that
 * is the only reason it exists. `exec` and `execAsync` hand a bare name to the
 * operating system, which searches this process's `PATH`. A command Raise asks
 * a terminal app to run in a new tab is searched for in *that app's*
 * environment instead, and an app started from the Dock has the minimal
 * `/usr/bin:/bin:/usr/sbin:/sbin` - so a bare `tmux` from Homebrew, or an `hc`
 * in `~/.local/bin`, is not found there. Resolving it here names the same
 * binary Raise itself has just been talking to, which is positive evidence of
 * the right one, rather than whatever the app's `PATH` happens to reach.
 *
 * Synchronous file checks and no child process, so it is safe on a click path.
 *
 * @param {string} name a bare command name
 * @param {{path?: string}} [options] the search path, `PATH` by default
 * @returns {string|null}
 */
export function findExecutable(name, { path = process.env.PATH ?? '' } = {}) {
  if (!name || name.includes('/')) return null;
  for (const dir of path.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable: keep looking, as the shell would.
    }
  }
  return null;
}
