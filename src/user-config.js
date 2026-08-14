/**
 * `~/.raise/config.json` - reading it, refusing it when it is unsafe, and the
 * one narrow way Raise is allowed to write it.
 *
 * This is the file the user writes. Everything in it is an opt-in to something
 * that reaches the network - the forge lookup, the update check - because those
 * are the only two things that need the user's permission rather than their
 * setup. Each feature owns the meaning of its own block; what lives here is the
 * part that is a property of the *file*, and that is the mode rule.
 *
 * **The writer lives here, beside the reader, and that is the whole reason it is
 * in this module rather than beside the commands that call it.** `0600` is a
 * property of the file, which is the argument the mode rule below already makes;
 * a writer anywhere else could produce a file the reader in this module then
 * refuses, which is precisely the split the rule exists to prevent. It did, in
 * the obvious first draft - see `writeUserConfig`.
 *
 * **A mode that lets anyone else on the machine read the file means the whole
 * file is refused.** The reason is the Bitbucket credential in `forge`: honouring
 * the safe half of a file we have just called unsafe teaches nobody to fix it,
 * and the credential that is already exposed is exposed either way. This is
 * ssh's rule, and it is what makes a documented `0600` more than a comment,
 * since a file can be written correctly and chmodded later.
 *
 * **It applies to blocks holding no credential too, and that is deliberate.**
 * The update check's opt-in is a boolean and nothing about it is secret, so
 * honouring it in an unsafe file would cost nothing today. It is refused anyway,
 * because a safety rule with an exception is one nobody can state in a sentence,
 * and an exception nobody can state is the one the next person deletes while
 * tidying. One file, one rule, one sentence in `raise doctor`.
 *
 * This was `forge-config.js`'s, whose own header described it in exactly these
 * terms - which was always a fact about the file rather than about the forge. It
 * moved the moment a second feature needed the same read, so that the rule could
 * not come to be enforced in one place and not the other.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { userConfigPath } from './config.js';

/**
 * @typedef {object} ConfigFileAccess
 * @property {(path: string) => {mode: number, mtimeMs: number, size: number}} stat
 * @property {(path: string) => string} readText
 */

/** @type {ConfigFileAccess} */
export const defaultConfigAccess = {
  stat(path) {
    const info = statSync(path);
    return { mode: info.mode, mtimeMs: info.mtimeMs, size: info.size };
  },
  readText(path) {
    return readFileSync(path, 'utf8');
  },
};

/**
 * The file, as far as anything is allowed to read it.
 *
 * `data` is null whenever nothing in the file may be used - no file at all, an
 * unsafe mode, unparseable JSON - so a caller cannot accidentally act on half of
 * a refusal.
 *
 * `problem` is for `raise doctor` and for nowhere else. It is set only when the
 * user has evidently tried to configure something and it is not working. Never
 * for the ordinary case of no file at all, which is the default and must be
 * silent: a user who has not configured any of this may not be able to tell it
 * exists.
 *
 * `data` is `any` rather than a shape, and honestly so: it is whatever JSON a
 * user typed, and every block reader below it has to check its own fields for
 * that exact reason. Naming a shape here would be a claim about somebody else's
 * text file.
 *
 * @typedef {object} UserConfig
 * @property {any} data the parsed object, or null when nothing may be used
 * @property {string|null} problem
 */

/** The mode bits that would let another user on this machine read the file. */
const GROUP_OR_OTHER_READABLE = 0o077;

/** What the file must be, and what `writeUserConfig` leaves it at. */
const SAFE_MODE = 0o600;

/** @type {UserConfig} */
const NOTHING = { data: null, problem: null };

/**
 * Read `~/.raise/config.json`.
 *
 * Fails closed in every direction: anything unexpected yields no data rather
 * than partial data, because what the file turns on is an outbound request the
 * user did not otherwise ask for.
 *
 * @param {{path?: string, files?: ConfigFileAccess}} [deps]
 * @returns {UserConfig}
 */
export function readUserConfig({ path = userConfigPath(), files = defaultConfigAccess } = {}) {
  let mode;
  try {
    mode = files.stat(path).mode;
  } catch {
    // No file is the default, and the default says nothing. Anything else that
    // stops us reaching it - a permission error on the directory, say - is
    // indistinguishable from that here and is treated the same way.
    return NOTHING;
  }
  if (isUnsafeMode(mode)) {
    const octal = formatMode(mode);
    return {
      data: null,
      // "can hold" rather than "holds": this same sentence is now printed by
      // every feature the file turns on, including ones with no secret in them,
      // and a file carrying only an opt-in does not hold a credential yet. What
      // makes the mode wrong is what the file is *for*.
      problem:
        `${path} is mode ${octal}, which lets other users on this machine read it - ` +
        `it can hold a credential, so nothing in it is used until you run chmod 600 on it ` +
        `(raise enable and raise disable repair it too)`,
    };
  }

  let raw;
  try {
    raw = JSON.parse(files.readText(path));
  } catch (err) {
    return { data: null, problem: `${path} is not valid JSON (${err.message})` };
  }
  // A file holding `null`, a number or an array parses fine and has no blocks in
  // it. Treated as nothing rather than handed on, so no caller has to ask.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NOTHING;
  return { data: raw, problem: null };
}

/**
 * The same read, kept current under a running monitor.
 *
 * This file changes under a running server in two ways now - the user editing it
 * by hand, which the README still asks for, and `raise enable` in another
 * terminal, which is the common one. Either way an answer captured when the
 * server started is one the server and `raise doctor` disagree about for as long
 * as it runs, the doctor reporting an opt-in that never reached the poll loop.
 * That is the confident-wrong shape this codebase is built against, so the file
 * is re-read as it changes instead - and it is what lets `raise enable` need no
 * restart to take effect.
 *
 * The cost is a `stat` per poll and nothing else, because the parse is cached on
 * what that `stat` says. **Only the positive case is remembered**, the same rule
 * `nm-state.js` follows for the database appearing under a running monitor: no
 * file at all is the overwhelmingly common case, and caching that absence would
 * mean a file written later was never noticed. The mode is part of the key as
 * well as of the answer, so a file chmodded to `0644` after the server started
 * stops being used on the next poll.
 *
 * **The returned object keeps its identity until the file changes**, which is
 * what lets a caller notice a change by comparing references rather than by
 * diffing - see `ForgeState#observe`.
 *
 * @param {{path?: string, files?: ConfigFileAccess}} [deps]
 * @returns {() => UserConfig} cheap enough to call on every poll
 */
export function watchUserConfig({ path = userConfigPath(), files = defaultConfigAccess } = {}) {
  /** @type {{key: string, config: UserConfig}|null} */
  let cached = null;
  return () => {
    let info;
    try {
      info = files.stat(path);
    } catch {
      cached = null;
      return NOTHING;
    }
    const key = `${info.mode}:${info.mtimeMs}:${info.size}`;
    if (cached?.key === key) return cached.config;
    cached = { key, config: readUserConfig({ path, files }) };
    return cached.config;
  };
}

// ------------------------------------------------------------------- writing

/**
 * The features `raise enable` and `raise disable` can switch, and nothing else.
 *
 * **A closed set of two, deliberately, rather than a general `raise config
 * set`.** A path-addressed JSON writer aimed at a file holding a credential is a
 * machine for making typos succeed: `raise config set forge.enable true` would
 * report success, write a key nothing reads, and leave the user with Raise's own
 * word that the feature is on. Here an unknown name is refused and both valid
 * ones are printed.
 *
 * **`name` is `raise doctor`'s label, kebab-cased, and that is load-bearing.**
 * The diagnostic that tells you a feature is off names the command that turns it
 * on, with no mapping table in between and nothing to keep in step. `label` is
 * here so the two cannot drift.
 *
 * The registry lives in this module because it describes the shape of this file.
 * What each block *means* still belongs to the feature that owns it -
 * `forge-config.js` and `update-check.js` - and neither of them needs to know
 * that a command can write it.
 *
 * @typedef {{name: string, block: string, label: string}} ConfigFeature
 * @type {ConfigFeature[]}
 */
export const CONFIG_FEATURES = [
  { name: 'pull-request-state', block: 'forge', label: 'Pull request state' },
  { name: 'update-check', block: 'updates', label: 'Update check' },
];

/** @param {string} name @returns {ConfigFeature|null} */
export function configFeature(name) {
  return CONFIG_FEATURES.find((feature) => feature.name === name) ?? null;
}

/**
 * True when this mode would let another user on the machine read the file.
 *
 * @param {number} mode as `statSync` reports it, high bits and all
 */
export function isUnsafeMode(mode) {
  return Boolean(mode & GROUP_OR_OTHER_READABLE);
}

/**
 * `0644`, for a message.
 *
 * @param {number} mode
 * @returns {string}
 */
export function formatMode(mode) {
  return (mode & 0o777).toString(8).padStart(4, '0');
}

/**
 * The file as something we are about to rewrite, rather than as something we are
 * allowed to act on.
 *
 * Two things separate this from `readUserConfig`, and both are the point.
 *
 * **An unsafe mode is not a refusal here.** `readUserConfig` refuses the whole
 * file, because acting on an opt-in in a world-readable file teaches nobody to
 * fix it. Repairing that mode is exactly what the command exists to do, so it
 * has to be able to read past it - and the credential in there was already
 * exposed, so declining to fix the mode protects nothing.
 *
 * **Unparseable JSON throws instead of being swallowed.** `readUserConfig` fails
 * closed to nothing, which is right for a reader; here it would mean overwriting
 * whatever half-typed file the user was in the middle of - including a
 * credential. `readSettings` refuses `settings.json` on the same ground.
 *
 * @param {{path?: string, files?: ConfigFileAccess}} [deps]
 * @returns {{exists: boolean, mode: number|null, data: Record<string, any>}}
 */
export function readUserConfigForWrite({ path = userConfigPath(), files = defaultConfigAccess } = {}) {
  let mode;
  try {
    mode = files.stat(path).mode;
  } catch {
    return { exists: false, mode: null, data: {} };
  }

  let raw;
  try {
    raw = JSON.parse(files.readText(path));
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON (${err.message}). Fix it first - Raise will not ` +
        'overwrite a config file it cannot parse, because it may hold a credential.',
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `${path} holds ${Array.isArray(raw) ? 'an array' : JSON.stringify(raw)} rather than a JSON ` +
        'object. Fix it first - Raise will not replace it.',
    );
  }
  return { exists: true, mode, data: raw };
}

/**
 * Merge one boolean into the parsed file, and say what changed.
 *
 * Pure, so the whole of the merge is tested by calling it - the rule AGENTS.md
 * states about `dashboard.js` and `security.js`, and it matters more here
 * because the thing being asserted is that *nothing else moved*.
 *
 * **`disable` writes `false` rather than deleting the key.** A missing block and
 * `enabled: false` read identically to `readForgeConfig` and `readUpdateConfig`,
 * both of which demand the boolean `true` - so this is a choice about the file
 * as a record rather than about behaviour. A key saying `false` is a decision
 * somebody took; an absent key is indistinguishable from never having heard of
 * the feature. It also keeps enable → disable → enable a stable cycle in the
 * diff instead of one that adds and removes structure.
 *
 * Nothing else in the block is touched, which is what keeps a `forge.bitbucket`
 * credential through a `disable`: turning the lookup off is not a request to
 * destroy a token, and re-enabling would otherwise quietly need it minted again.
 *
 * @param {Record<string, any>} data the parsed file, or `{}`
 * @param {ConfigFeature} feature
 * @param {boolean} enabled
 * @returns {{data: Record<string, any>, changes: string[]}}
 */
export function setFeature(data, feature, enabled) {
  const next = structuredClone(data ?? {});
  const existing = next[feature.block];

  // A block of the wrong type is a malformed file rather than an old opinion, so
  // it is refused for the same reason unparseable JSON is: replacing it would
  // silently discard whatever the user meant by it.
  if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing))) {
    throw new Error(
      `"${feature.block}" in the config file is ${JSON.stringify(existing)} rather than a block. ` +
        'Fix it first - Raise will not replace it.',
    );
  }

  const block = { ...existing };
  const before = block.enabled;
  if (before === enabled) return { data: next, changes: [] };

  block.enabled = enabled;
  next[feature.block] = block;
  const change =
    before === undefined
      ? `add ${feature.block}.enabled: ${enabled}`
      : `change ${feature.block}.enabled: ${JSON.stringify(before)} -> ${enabled}`;
  return { data: next, changes: [change] };
}

/**
 * Write the file, `0600` by construction and `0600` by repair.
 *
 * **Not `hooks.js`'s `writeSettings`, and the reason is one measurement rather
 * than one intuition.** That writer calls `writeFileSync` with no `mode`, so it
 * produces `0664` under an ordinary umask and `0666` under a permissive one -
 * and `readUserConfig` refuses anything with those bits. It would have written a
 * file Raise itself then declines to read: a command whose success message is
 * followed by the feature not working, which is the bug this command exists to
 * remove, reproduced inside the fix for it.
 *
 * **Two calls, because `mode` and `chmod` cover different states and neither
 * covers the other.** The `mode` option is handed to `open(2)`, which applies it
 * at *creation* and ignores it otherwise: a file already sitting at `0644` stays
 * at `0644` through any number of writes asking for `0600`. So the option covers
 * the new file and the `chmodSync` covers the repair, and dropping either one
 * leaves a real case broken silently.
 *
 * **The backup is chmodded too, and that is not belt and braces.**
 * `copyFileSync` opens the destination with the *source's* mode, including over
 * a pre-existing looser one - so a backup of a `0600` file is correctly `0600`,
 * and a backup taken during a **mode repair** is `0644`, because that is what it
 * was copying. Repairing the mode would then have left a world-readable copy of
 * the credential sitting beside the file it had just secured, under a name that
 * says the tool put it there. It is the leak the original file was refused for,
 * created by the command that fixes it.
 *
 * @param {string} path
 * @param {Record<string, any>} data
 * @param {{backup?: boolean}} [options]
 * @returns {string|null} the path the previous file was copied to, if any
 */
export function writeUserConfig(path, data, { backup = true } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  let backupPath = null;
  if (backup && existsSync(path)) {
    backupPath = `${path}.raise-backup`;
    copyFileSync(path, backupPath);
    chmodSync(backupPath, SAFE_MODE);
  }
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: SAFE_MODE });
  chmodSync(path, SAFE_MODE);
  return backupPath;
}
