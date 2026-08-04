/**
 * Paths, ports and the shared secret.
 *
 * Everything here is overridable by environment variable so the test suite can
 * run against a scratch directory and never touch a real installation.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';

/** Where nmmon keeps its own state (session records, token, server info). */
export function monitorHome() {
  return process.env.NMMON_HOME || join(homedir(), '.nmmon');
}

/** Where no-mistakes keeps its state. Shared by every repo on the machine. */
export function noMistakesHome() {
  return process.env.NM_HOME || join(homedir(), '.no-mistakes');
}

/**
 * Claude Desktop's own record of the sessions it hosts.
 *
 * Someone else's directory, in someone else's shape - read only to answer one
 * question, and overridable so the suite never reads the real app.
 */
export function claudeDesktopSessionsDir() {
  return (
    process.env.CLAUDE_DESKTOP_HOME ||
    join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
  );
}

export function statePath() {
  return join(noMistakesHome(), 'state.sqlite');
}

export function sessionsDir() {
  return join(monitorHome(), 'sessions');
}

export function serverInfoPath() {
  return join(monitorHome(), 'server.json');
}

export function tokenPath() {
  return join(monitorHome(), 'token');
}

export const DEFAULT_PORT = 7717;

/**
 * The one place a port is validated.
 *
 * Anything that reaches `server.listen` unvalidated fails silently rather than
 * loudly: NaN binds a random ephemeral port, the printed URL reads `:NaN`, and
 * the port written to server.json serialises as null, so every hook decides the
 * server is not running and session tracking quietly stops working.
 *
 * @param {unknown} raw
 * @param {string} source how to name the offender in the error
 * @returns {number}
 */
export function parsePort(raw, source = 'port') {
  const text = String(raw ?? '').trim();
  const port = Number.parseInt(text, 10);
  if (!/^\d+$/.test(text) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${source} must be a whole number between 1 and 65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

/** A `--port` flag with no value parses as `true`, which is a typo, not a port. */
export function portFromFlag(value) {
  if (value === true) {
    throw new Error('--port needs a port number, for example --port 7717');
  }
  return parsePort(value, '--port');
}

export function defaultPort() {
  const raw = process.env.NMMON_PORT;
  if (!raw) return DEFAULT_PORT;
  return parsePort(raw, 'NMMON_PORT');
}

export function ensureDirs() {
  mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
}

/**
 * Read the shared secret, creating it on first use.
 *
 * Hooks and the browser page both present this token. It is not protecting
 * against a local user who can read the file - it is protecting against any
 * random web page in the browser reaching a server bound to localhost.
 */
export function readOrCreateToken() {
  ensureDirs();
  const path = tokenPath();
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return existing;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const token = randomBytes(24).toString('hex');
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}
