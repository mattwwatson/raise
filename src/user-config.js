/**
 * Reading the one file a user writes, and refusing to read it when it is unsafe.
 *
 * `~/.raise/config.json` is the only file here that Raise never generates, and
 * everything in it is an opt-in to something that reaches the network - the
 * forge lookup, the update check - because those are the only two things that
 * need the user's permission rather than their setup. Each feature owns the
 * meaning of its own block; what lives here is the part that is a property of
 * the *file*, and that is the mode rule.
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

import { readFileSync, statSync } from 'node:fs';

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
  if (mode & GROUP_OR_OTHER_READABLE) {
    const octal = (mode & 0o777).toString(8).padStart(4, '0');
    return {
      data: null,
      // "can hold" rather than "holds": this same sentence is now printed by
      // every feature the file turns on, including ones with no secret in them,
      // and a file carrying only an opt-in does not hold a credential yet. What
      // makes the mode wrong is what the file is *for*.
      problem:
        `${path} is mode ${octal}, which lets other users on this machine read it - ` +
        `it can hold a credential, so nothing in it is used until you run chmod 600 on it`,
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
 * This file is the user's to write, and the README tells them to write it - so
 * an answer captured when the server started is one the server and `raise
 * doctor` disagree about for as long as it runs, the doctor reporting an opt-in
 * that never reached the poll loop. That is the confident-wrong shape this
 * codebase is built against, so the file is re-read as it changes instead.
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
