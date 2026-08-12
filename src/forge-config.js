/**
 * What the forge lookup is allowed to do, read out of the user's config file.
 *
 * The forge lookup was the first outbound network request Raise made, so it is
 * off until this block says otherwise. Everything about its shape follows from
 * two decisions.
 *
 * **The credential lives in a file, never in the environment.** That is the
 * opposite of the intuitive answer, and the reason is `src/exec.js`: it spawns
 * with no `env` option, so every child inherits Raise's whole environment - `ps`
 * and `tmux` and `osascript` and `gh` and `lavish-axi` and `no-mistakes`, most
 * of them on the one-second poll loop. A token in the environment is a token
 * handed to all of them for as long as the monitor runs. Read out of a `0600`
 * file into a variable and put in a header, it is in one process and in no
 * environment at all. The only fix for the other way round would be to make the
 * one place that runs commands filter what it passes, which is the problem
 * inverted to protect a secret we chose to put there.
 *
 * **GitHub has no credential here at all**, deliberately. `gh` authenticates
 * itself, so Raise never sees a GitHub token - and `gh` already reads `GH_TOKEN`
 * and `GITHUB_TOKEN` out of the environment we hand it, so there is nothing a
 * token path of our own could add.
 *
 * Reading the file, and refusing to read it when its mode would let anyone else
 * on the machine see that credential, is `src/user-config.js` - it is a property
 * of the file rather than of this feature, and there are two features in the
 * file now. This module only interprets the `forge` block of what it returns.
 */

import { userConfigPath } from './config.js';
import { defaultConfigAccess, readUserConfig, watchUserConfig } from './user-config.js';

/** @typedef {import('./user-config.js').ConfigFileAccess} ConfigFileAccess */
/** @typedef {import('./user-config.js').UserConfig} UserConfig */

/**
 * What the forge lookup is allowed to do, and why not, when it is not.
 *
 * `problem` is for `raise doctor` and for nowhere else. It is set only when the
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

/** @type {ForgeConfig} */
const DISABLED = { enabled: false, bitbucket: null, problem: null };

/**
 * The `forge` block of a file that has already been read and vetted.
 *
 * @param {UserConfig} file
 * @param {string} path only to name the offender in a `problem`
 * @returns {ForgeConfig}
 */
function forgeFrom(file, path) {
  if (file.problem) return { ...DISABLED, problem: file.problem };
  const forge = file.data?.forge;
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
 * Read the forge block of `~/.raise/config.json`.
 *
 * Fails closed in every direction: anything unexpected disables the lookup
 * rather than half-enabling it, because the failure this guards is an outbound
 * request the user did not ask for.
 *
 * @param {{path?: string, files?: ConfigFileAccess}} [deps]
 * @returns {ForgeConfig}
 */
export function readForgeConfig({ path = userConfigPath(), files = defaultConfigAccess } = {}) {
  return forgeFrom(readUserConfig({ path, files }), path);
}

/**
 * The same read, kept current under a running monitor.
 *
 * `watchUserConfig` does the watching and explains why it is worth doing; this
 * adds the one property `ForgeState` depends on, which is that **the returned
 * config keeps its identity until the file changes**. `ForgeState#observe`
 * notices a changed file by comparing references, and re-interpreting an
 * unchanged read into a fresh object every poll would make every poll look like
 * a change - dropping the failure backoff each time, which is the one thing that
 * backoff exists to prevent.
 *
 * @param {{path?: string, files?: ConfigFileAccess}} [deps]
 * @returns {() => ForgeConfig} cheap enough to call on every poll
 */
export function watchForgeConfig({ path = userConfigPath(), files = defaultConfigAccess } = {}) {
  const watch = watchUserConfig({ path, files });
  /** @type {{source: UserConfig, config: ForgeConfig}|null} */
  let cached = null;
  return () => {
    const source = watch();
    if (cached?.source === source) return cached.config;
    cached = { source, config: forgeFrom(source, path) };
    return cached.config;
  };
}
