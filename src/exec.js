/**
 * The one place that runs external commands.
 *
 * Every module that needs to shell out takes an exec function as a parameter
 * rather than importing this directly, so tests can assert on the commands that
 * would have run without actually stealing focus or touching tmux.
 */

import { spawnSync, spawn } from 'node:child_process';

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
