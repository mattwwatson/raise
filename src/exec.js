/**
 * The one place that runs external commands.
 *
 * Every module that needs to shell out takes an exec function as a parameter
 * rather than importing this directly, so tests can assert on the commands that
 * would have run without actually stealing focus or touching tmux.
 */

import { spawnSync } from 'node:child_process';

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

/** Run a command and return null instead of throwing. */
export function tryExec(runner, command, args, options) {
  try {
    return runner(command, args, options);
  } catch {
    return null;
  }
}
