/**
 * The Node version Raise needs, and the one sentence that says so.
 *
 * **This module imports nothing, and that is its entire reason for existing.**
 * `bin/raise.js` is the only thing that may run before the CLI's module graph is
 * linked, and it can only stay ahead of that graph by depending on a module with
 * no graph of its own. Adding an import here - even a Node builtin - moves the
 * guard back behind the thing it guards, silently, on exactly the versions where
 * nobody testing the change will notice. See `bin/raise.js` for what goes wrong.
 *
 * **22.13 is exact, not cautious.** `node:sqlite` landed in 22.5, but behind
 * `--experimental-sqlite`, and nothing here passes flags; the flag came off in
 * 22.13.0. So every version from 22.5 to 22.12 can neither import
 * `src/nm-state.js` nor be told why. Keep this in step with `engines` in
 * `package.json`, which says the same number to npm.
 */

/** The oldest Node that can run Raise: the first without the SQLite flag. */
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 13;

/**
 * Whether a Node version string can run Raise.
 *
 * Takes the version rather than reading `process.versions` so the boundary can
 * be tested at the versions that matter, none of which the suite will ever run
 * on - `engines` sees to that.
 *
 * Anything unparseable is treated as supported. A version string we cannot read
 * is not evidence of an old Node, and refusing to start over one would turn a
 * guard against a known-broken range into a guess that can strand a working
 * installation.
 *
 * @param {string} version e.g. `process.versions.node`
 * @returns {boolean}
 */
export function supportsNode(version) {
  const [major, minor] = String(version).split('.').map(Number);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return true;
  return major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
}

/**
 * What to tell somebody whose Node is too old, or null if it is not.
 *
 * One sentence, in one place, because the entry point and `raise doctor` both
 * say it and two copies of a version number is how a doctor comes to report a
 * threshold the code does not hold to - which is the shape of the bug this
 * whole module exists to close.
 *
 * @param {string} version
 * @returns {string|null}
 */
export function nodeVersionProblem(version) {
  if (supportsNode(version)) return null;
  return (
    `v${version} - Raise needs ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer, ` +
    'where the built-in SQLite support stopped needing a command-line flag'
  );
}
