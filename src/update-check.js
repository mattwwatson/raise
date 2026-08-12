/**
 * Telling somebody that the version they are running has been superseded.
 *
 * npm has no push mechanism. A published version sits in the registry and an
 * install stays on whatever it has until its owner reinstalls or happens to
 * notice. For a monitor that is worse than the usual case: the fixes that matter
 * most here are the ones that stop a row asserting something untrue, and the
 * people running the version that does it are exactly the people who will never
 * hear. So this exists - and everything about its shape is an argument with that
 * fact rather than a design.
 *
 * **It is the second outbound request in the product's history, and the second
 * one that is off by default.** The first is the forge lookup, and this follows
 * the shape that settled: off unless `~/.raise/config.json` says otherwise,
 * silent in every failure, exactly one host contacted, and the README stating
 * precisely what leaves the machine. That last one is not paperwork. The README
 * claims, of the default configuration, that Raise makes no outbound network
 * request of any kind - the strongest sentence in the section aimed at somebody
 * deciding whether to let this program merge hooks into their agent's settings.
 * The claim survives *because* this is off by default, and for no other reason.
 *
 * **What the registry can see, stated plainly because it is not nothing.** One
 * HTTPS GET to `registry.npmjs.org` for this package's own name, and nothing
 * else ever: no query string, no version number, no identifier of any kind.
 * From it the registry learns an IP address, a timestamp, and that somebody
 * asked about `raise-cli` - which, since nobody else has a reason to ask about
 * that package, is as good as saying a machine at that address has Raise
 * installed. It does not learn which version: the comparison happens here.
 *
 * **Asking and telling are two different cadences, and conflating them is the
 * mistake this module exists to avoid.** How often we *ask* is a property of how
 * fast npm's answer changes, and a release cycle is weeks - so it is once a day,
 * remembered on disk, whether `raise serve` starts once or fifty times. How
 * often we *tell* you is a property of the banner, which is read at every start
 * - so the notice prints every time, off the remembered answer, until you
 * upgrade. Tying the request to a process start instead would tie it to
 * something with no relationship to the answer at all: a page left pinned for a
 * week is one request, and a wrapper script restarting `serve` is one a minute.
 *
 * Every failure is silent and none is retried early. Offline, a timeout, a 404,
 * a rate limit, a body that is not JSON, a version neither side can parse: each
 * of them prints nothing and leaves `serve` byte-identical to what it was
 * before this module existed. The attempt is stamped in the cache whether or not
 * it answered, so a machine with no network makes one attempt a day rather than
 * one per start. There is deliberately no shorter failure backoff of the kind
 * `forge.js` has - that one retries on a one-minute cadence and needs the
 * distinction; here a second constant would be a second thing to reason about
 * for an answer nobody is waiting on.
 *
 * **Nothing here is imported by `server.js`, by `hooks/` or by the page.** The
 * server's own suite asserts that it makes no outbound request at all, and that
 * guard is left exactly as it was; the hook and the pi extension run inside
 * somebody else's agent under stricter rules again, and a notifier in either was
 * ruled out. This runs in `raise serve`, once, and in nothing else.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { updateCachePath, userConfigPath } from './config.js';
import { defaultConfigAccess, readUserConfig } from './user-config.js';

/** @typedef {import('./user-config.js').ConfigFileAccess} ConfigFileAccess */

/**
 * How long an answer from the registry is treated as current.
 *
 * Tuned against a release cadence and against nothing in this repository, which
 * is why it is coarse: a day is far shorter than the interval between two
 * versions and far longer than the interval between two `raise serve` starts. A
 * notice up to a day late is the right trade for a problem measured in weeks.
 * Unlike `PR_STATE_FRESH_MS`, changing it needs no measurement - only the
 * argument above.
 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The one host this contacts, and the whole of the request made to it. */
export const REGISTRY_URL = 'https://registry.npmjs.org/raise-cli/latest';

/**
 * How long the lookup may take before it is abandoned.
 *
 * Short, because nothing waits on it: `serve` has already printed its banner and
 * is already serving. This only bounds how long a hung socket sits around.
 */
export const LOOKUP_TIMEOUT_MS = 3000;

/**
 * Whether Raise may ask the registry anything, and why not, when it may not.
 *
 * `problem` is for `raise doctor` and nowhere else, on the same terms as
 * `ForgeConfig`'s: set only when somebody has evidently tried to configure this
 * and it is not working, never for the ordinary case of no file at all.
 *
 * @typedef {object} UpdateConfig
 * @property {boolean} enabled
 * @property {string|null} problem
 */

/**
 * What the registry last said, and when we last asked.
 *
 * `latest` is null when the attempt did not answer, which is a different fact
 * from never having asked - `doctor` tells them apart, because a check that has
 * not answered is something Raise does not know and reporting it as `ok` would
 * be the confident-wrong shape this page is built against.
 *
 * There is deliberately no record of which version the check was made *for*.
 * `latest` is a property of the registry rather than of this install, so it
 * stays true across an upgrade, a downgrade and a checkout whose version is
 * ahead of anything published.
 *
 * @typedef {object} UpdateCache
 * @property {number} checkedAt epoch ms
 * @property {string|null} latest
 */

/**
 * Reading and writing our own cache file, injected so the suite never touches a
 * real one. Separate from `ConfigFileAccess` because that one is deliberately
 * read-only: the config file is the user's to write and Raise never writes it.
 *
 * @typedef {object} CacheAccess
 * @property {(path: string) => string} readText
 * @property {(path: string, text: string) => void} writeText
 */

/** @type {CacheAccess} */
export const defaultCacheAccess = {
  readText(path) {
    return readFileSync(path, 'utf8');
  },
  writeText(path, text) {
    writeFileSync(path, text, { mode: 0o600 });
  },
};

/** @type {UpdateConfig} */
const DISABLED = { enabled: false, problem: null };

/**
 * Read the update block of `~/.raise/config.json`.
 *
 * The whole file is refused when its mode would let another user read it, this
 * block included - see `user-config.js` for why a rule with an exception is
 * worse than the exception is worth.
 *
 * @param {{path?: string, files?: ConfigFileAccess}} [deps]
 * @returns {UpdateConfig}
 */
export function readUpdateConfig({ path = userConfigPath(), files = defaultConfigAccess } = {}) {
  const file = readUserConfig({ path, files });
  if (file.problem) return { enabled: false, problem: file.problem };
  // The boolean true and nothing else, exactly as the forge block requires:
  // reaching the network is a deliberate act, so it is never inferred.
  return file.data?.updates?.enabled === true ? { enabled: true, problem: null } : DISABLED;
}

/**
 * What the last check found, or null if there has not been one we can use.
 *
 * A record stamped in the future is discarded rather than trusted - the clock
 * has moved backwards, and a cache that cannot expire is one that would sit on
 * a version number forever.
 *
 * @param {{path?: string, cache?: CacheAccess}} [deps]
 * @returns {UpdateCache|null}
 */
export function readUpdateCache({ path = updateCachePath(), cache = defaultCacheAccess } = {}) {
  let raw;
  try {
    raw = JSON.parse(cache.readText(path));
  } catch {
    // No cache, an unreadable one, or one somebody has edited into nonsense.
    // All three mean the same thing: ask again.
    return null;
  }
  const checkedAt = Number(raw?.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) return null;
  const latest = typeof raw?.latest === 'string' && raw.latest ? raw.latest : null;
  return { checkedAt, latest };
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * @param {unknown} version
 * @returns {{core: number[], pre: string|null}|null}
 */
function parseVersion(version) {
  const match = SEMVER.exec(String(version ?? '').trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] || null };
}

/**
 * Whether `latest` is a version worth telling somebody on `current` about.
 *
 * Semver comparison, without a dependency and without pretending to be one. It
 * ranks `major.minor.patch` numerically and puts a pre-release below its own
 * release, which is the whole of what the `dist-tags.latest` this reads can
 * produce.
 *
 * **Everything else fails closed.** Two pre-releases of the same version are not
 * ranked against each other, and anything either side cannot parse - a `latest`
 * the registry has changed the shape of, a `version` a checkout has invented -
 * returns false. The two errors are not comparable: saying nothing costs
 * somebody an upgrade a week later, and guessing puts a monitor on the page
 * asserting something untrue about itself.
 *
 * @param {unknown} current
 * @param {unknown} latest
 * @returns {boolean}
 */
export function isNewerVersion(current, latest) {
  const mine = parseVersion(current);
  const theirs = parseVersion(latest);
  if (!mine || !theirs) return false;
  for (let i = 0; i < 3; i += 1) {
    if (theirs.core[i] !== mine.core[i]) return theirs.core[i] > mine.core[i];
  }
  return Boolean(mine.pre) && !theirs.pre;
}

/**
 * Ask the registry, and say nothing about anything that goes wrong.
 *
 * @param {Function|undefined} fetchImpl
 * @returns {Promise<string|null>}
 */
async function askRegistry(fetchImpl) {
  if (!fetchImpl) return null;
  const response = await fetchImpl(REGISTRY_URL, {
    // The only header of ours, and it says nothing about the machine it came
    // from. Everything that would - a version, an install id, a package list -
    // is absent because there is nothing here to put it in.
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = await response.json();
  return typeof body?.version === 'string' && body.version ? body.version : null;
}

/**
 * The version worth telling this installation about, or null if there is none.
 *
 * Never rejects and never throws - a caller may fire it and forget it, which is
 * exactly what `raise serve` does. Off, up to date, offline, and a cache that
 * cannot be read all return the same null, so no caller can tell the feature
 * being disabled from it having nothing to say.
 *
 * Asking is what writes the cache, so a machine that never runs `raise serve`
 * never makes a request no matter how often anything else is run.
 *
 * @param {{current: string, config?: UpdateConfig, now?: number, fetch?: Function,
 *          cache?: CacheAccess, cachePath?: string, configPath?: string,
 *          files?: ConfigFileAccess}} deps `fetch` is injected and defaulted at
 *   the edge, so the suite asserts on the request that *would* have gone out
 *   without one going out.
 * @returns {Promise<string|null>}
 */
export async function newerVersion({
  current,
  config,
  now = Date.now(),
  fetch,
  cache = defaultCacheAccess,
  cachePath = updateCachePath(),
  configPath = userConfigPath(),
  files = defaultConfigAccess,
}) {
  try {
    const settings = config ?? readUpdateConfig({ path: configPath, files });
    if (settings.enabled !== true) return null;

    const known = readUpdateCache({ path: cachePath, cache });
    const age = known ? now - known.checkedAt : Infinity;
    let latest;
    if (known && age >= 0 && age < UPDATE_CHECK_INTERVAL_MS) {
      latest = known.latest;
    } else {
      latest = await askRegistry(fetch).catch(() => null);
      // Stamped whether or not it answered. A failed attempt that left no trace
      // would be re-made on every `serve` start, which is the one way a feature
      // capped at a request a day turns into a request a restart.
      try {
        cache.writeText(cachePath, `${JSON.stringify({ checkedAt: now, latest })}\n`);
      } catch {
        // An unwritable cache costs a request next time and nothing else. It is
        // not worth a word to a user who did not ask for any of this.
      }
    }
    return latest && isNewerVersion(current, latest) ? latest : null;
  } catch {
    // Belt and braces on a promise nobody awaits: the caller has already printed
    // its banner and started serving, and there is no failure here worth
    // reaching them.
    return null;
  }
}
