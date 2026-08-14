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

/** Where Raise keeps its own state (session records, token, server info). */
export function monitorHome() {
  return process.env.RAISE_HOME || join(homedir(), '.raise');
}

/** Where no-mistakes keeps its state. Shared by every repo on the machine. */
export function noMistakesHome() {
  return process.env.NM_HOME || join(homedir(), '.no-mistakes');
}

/**
 * Where Claude Code keeps its config, its settings file and its transcripts.
 *
 * `CLAUDE_CONFIG_DIR` is Claude Code's own variable, exactly as
 * `PI_CODING_AGENT_DIR` is pi's and `CODEX_HOME` is Codex's, so following it is
 * correct behaviour rather than a hook for the tests.
 */
export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function claudeSettingsPath() {
  return join(claudeHome(), 'settings.json');
}

/**
 * Where Claude Code writes a transcript per session, one directory per project.
 *
 * Read only by the scan for sessions that predate the hooks - everything else
 * gets a transcript path handed to it by the agent itself.
 */
export function claudeProjectsDir() {
  return join(claudeHome(), 'projects');
}

/**
 * Where pi keeps its config, which is where its extension list lives.
 *
 * `PI_CODING_AGENT_DIR` is pi's own variable rather than one of ours, so
 * honouring it is correct behaviour and not merely a hook for the tests: a user
 * who has moved pi's config directory expects us to follow it there.
 */
export function piHome() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
}

export function piSettingsPath() {
  return join(piHome(), 'settings.json');
}

/** Where pi writes a transcript per session, one directory per project. */
export function piSessionsDir() {
  return join(piHome(), 'sessions');
}

/**
 * Where Codex keeps its config, which is where its hook list lives.
 *
 * `CODEX_HOME` is Codex's own variable, exactly as `PI_CODING_AGENT_DIR` is
 * pi's, so following it is correct behaviour rather than a hook for the tests -
 * a user who has moved Codex's home expects its hooks to be found there.
 */
export function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/**
 * Codex's hooks live in a file of their own rather than in a settings file, but
 * the structure inside it is the same `{hooks: {Event: [group]}}` Claude Code
 * uses - which is why `mergeHooks` serves both.
 */
export function codexHooksPath() {
  return join(codexHome(), 'hooks.json');
}

/**
 * Where Codex writes a rollout per session, partitioned by date.
 *
 * `YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, which is three levels deep rather
 * than the one the other two agents use - see `UNTRACKED_ROOTS`.
 */
export function codexSessionsDir() {
  return join(codexHome(), 'sessions');
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

/**
 * The file the user writes - and the only one Raise writes on their behalf
 * rather than for its own bookkeeping.
 *
 * It holds the opt-in for each of the two features that reach the network - the
 * forge lookup and the update check - and, for Bitbucket, a credential, which is
 * why it lives here beside `token` and is held to the same `0600`. See
 * `src/user-config.js` for the rule that decides whether it is read at all, for
 * the narrow write `raise enable` and `raise disable` are allowed to make, and
 * `src/forge-config.js` for why the credential may not come from the environment
 * instead.
 */
export function userConfigPath() {
  return join(monitorHome(), 'config.json');
}

/**
 * Where the update check remembers what the registry last said.
 *
 * Beside the config file rather than in it: that one is the user's to write and
 * this one is ours, and a tool that edits the file it tells you to hand-edit is
 * one that will eventually reformat your comments away. It holds nothing secret
 * - a version string and a timestamp - and exists so that restarting `raise
 * serve` ten times in an afternoon is ten notices and one request.
 *
 * **`raise enable` and `raise disable` now edit that file, and this objection is
 * what shaped how.** It rules out Raise keeping its *own* state in there, which
 * is why this cache stayed a separate file when those commands landed. What they
 * write is one boolean the user asked for by name, never anything machine-
 * generated, and the reformatting is real rather than argued away: key order
 * survives `JSON.stringify`, indentation and blank lines do not, and JSON has no
 * comments to lose. The user sees the diff and says yes first, and a
 * `.raise-backup` is left beside the file - the same bargain `install-hooks` has
 * struck with `settings.json` from the beginning, over a file with far more of
 * somebody else's content in it. See `docs/tasks/22-opt-in-commands.md`.
 */
export function updateCachePath() {
  return join(monitorHome(), 'update-check.json');
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
  const raw = process.env.RAISE_PORT;
  if (!raw) return DEFAULT_PORT;
  return parsePort(raw, 'RAISE_PORT');
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
