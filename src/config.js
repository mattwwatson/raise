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

export function defaultPort() {
  const raw = process.env.NMMON_PORT;
  if (!raw) return 7717;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`NMMON_PORT must be a port number, got ${raw}`);
  }
  return port;
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
