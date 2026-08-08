/**
 * Reading the one file a user writes, and refusing to read it when it is unsafe.
 *
 * The forge lookup is the only outbound network request nmmon makes, so it is
 * off until this file says otherwise. Everything about the shape here follows
 * from two decisions.
 *
 * **The credential lives in a file, never in the environment.** That is the
 * opposite of the intuitive answer, and the reason is `src/exec.js`: it spawns
 * with no `env` option, so every child inherits nmmon's whole environment - `ps`
 * and `tmux` and `osascript` and `gh` and `lavish-axi` and `no-mistakes`, most
 * of them on the one-second poll loop. A token in the environment is a token
 * handed to all of them for as long as the monitor runs. Read out of a `0600`
 * file into a variable and put in a header, it is in one process and in no
 * environment at all. The only fix for the other way round would be to make the
 * one place that runs commands filter what it passes, which is the problem
 * inverted to protect a secret we chose to put there.
 *
 * **GitHub has no credential here at all**, deliberately. `gh` authenticates
 * itself, so nmmon never sees a GitHub token - and `gh` already reads `GH_TOKEN`
 * and `GITHUB_TOKEN` out of the environment we hand it, so there is nothing a
 * token path of our own could add.
 *
 * A mode that lets anyone else on the machine read the file means the whole file
 * is refused, Bitbucket half and opt-in together. Honouring the safe half of a
 * file we have just called unsafe teaches nobody to fix it, and the credential
 * that is already exposed is exposed either way. This is ssh's rule, and it is
 * what makes a documented `0600` more than a comment: a file can be written
 * correctly and chmodded later.
 */

import { readFileSync, statSync } from 'node:fs';

import { forgeConfigPath } from './config.js';

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
 * What the forge lookup is allowed to do, and why not, when it is not.
 *
 * `problem` is for `nmmon doctor` and for nowhere else. It is set only when the
 * user has evidently tried to configure this and it is not working - a
 * malformed file, an unsafe mode, half a Bitbucket credential. Never for the
 * ordinary case of no file at all, which is the default and must be silent: a
 * user who has not configured this may not be able to tell it exists.
 *
 * @typedef {object} ForgeConfig
 * @property {boolean} enabled whether any forge may be asked anything
 * @property {{email: string, token: string}|null} bitbucket
 * @property {string|null} problem something to fix, in words `doctor` can print
 */

/** The mode bits that would let another user on this machine read the file. */
const GROUP_OR_OTHER_READABLE = 0o077;

/** @type {ForgeConfig} */
const DISABLED = { enabled: false, bitbucket: null, problem: null };

/**
 * Read `~/.nmmon/config.json`.
 *
 * Fails closed in every direction: anything unexpected disables the lookup
 * rather than half-enabling it, because the failure this guards is an outbound
 * request the user did not ask for.
 *
 * @param {{path?: string, files?: ConfigFileAccess}} [deps]
 * @returns {ForgeConfig}
 */
export function readForgeConfig({ path = forgeConfigPath(), files = defaultConfigAccess } = {}) {
  let mode;
  try {
    mode = files.stat(path).mode;
  } catch {
    // No file is the default, and the default says nothing. Anything else that
    // stops us reaching it - a permission error on the directory, say - is
    // indistinguishable from that here and is treated the same way.
    return DISABLED;
  }
  if (mode & GROUP_OR_OTHER_READABLE) {
    const octal = (mode & 0o777).toString(8).padStart(4, '0');
    return {
      ...DISABLED,
      problem:
        `${path} is mode ${octal}, which lets other users on this machine read it - ` +
        `it holds a credential, so nothing in it is used until you run chmod 600 on it`,
    };
  }

  let raw;
  try {
    raw = JSON.parse(files.readText(path));
  } catch (err) {
    return { ...DISABLED, problem: `${path} is not valid JSON (${err.message})` };
  }
  const forge = raw?.forge;
  // `enabled` has to be the boolean true. A missing block, a string "false", or
  // a file holding only a Bitbucket credential are all "not turned on" - opting
  // in is a deliberate act, so it is not inferred from a credential being there.
  if (forge?.enabled !== true) return DISABLED;

  const bitbucket = forge.bitbucket ?? null;
  if (!bitbucket) return { enabled: true, bitbucket: null, problem: null };

  const email = typeof bitbucket.email === 'string' ? bitbucket.email.trim() : '';
  const token = typeof bitbucket.token === 'string' ? bitbucket.token.trim() : '';
  if (!email || !token) {
    // Named because half a credential is a configuration mistake rather than a
    // choice, and the missing half is the whole of the fix. Bitbucket
    // authenticates with Basic auth over the Atlassian account email *and* the
    // API token, so neither is optional - app passwords, which needed only the
    // one, were removed on 28/07/2026.
    const missing = [!email && 'email', !token && 'token'].filter(Boolean).join(' and ');
    return {
      enabled: true,
      bitbucket: null,
      problem: `${path} has forge.bitbucket but no ${missing} - Bitbucket needs both, so it is skipped`,
    };
  }
  return { enabled: true, bitbucket: { email, token }, problem: null };
}

/**
 * The same read, kept current under a running monitor.
 *
 * This file is the user's to write, and the README tells them to write it - so
 * an answer captured when the server started is one the server and `nmmon
 * doctor` disagree about for as long as it runs, the doctor reporting an opt-in
 * that never reached the poll loop. That is the confident-wrong shape this
 * codebase is built against, so the file is re-read as it changes instead.
 *
 * The cost is a `stat` per poll and nothing else, because the parse is cached
 * on what that `stat` says. **Only the positive case is remembered**, the same
 * rule `nm-state.js` follows for the database appearing under a running
 * monitor: no file at all is the overwhelmingly common case, and caching that
 * absence would mean a file written later was never noticed. The mode is part
 * of the key as well as of the answer, so a file chmodded to `0644` after the
 * server started stops being used on the next poll.
 *
 * @param {{path?: string, files?: ConfigFileAccess}} [deps]
 * @returns {() => ForgeConfig} cheap enough to call on every poll
 */
export function watchForgeConfig({ path = forgeConfigPath(), files = defaultConfigAccess } = {}) {
  /** @type {{key: string, config: ForgeConfig}|null} */
  let cached = null;
  return () => {
    let info;
    try {
      info = files.stat(path);
    } catch {
      cached = null;
      return DISABLED;
    }
    const key = `${info.mode}:${info.mtimeMs}:${info.size}`;
    if (cached?.key === key) return cached.config;
    cached = { key, config: readForgeConfig({ path, files }) };
    return cached.config;
  };
}
