/**
 * The one place the roadmap commands touch `node:fs`.
 *
 * Everything else here takes a `TaskFileAccess` and is therefore assertable
 * from an in-memory tree - which matters more than usual, because two of these
 * commands are gates. A test that reads the real `docs/tasks/` proves the tree
 * is currently consistent and proves nothing at all about the rule; the rule is
 * what has to hold on the tree somebody pushes next.
 *
 * `readDir` returns plain objects rather than `Dirent`s so a fake can produce
 * them, the same flattening `defaultGitAccess.stat` does to `isDirectory()`.
 *
 * There is deliberately no `exists`. The link checker resolves a reference by
 * membership of the set the tree walk already produced, so nothing needs to ask
 * the filesystem whether a path is there - see `checkLinks`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {object} TaskFileAccess
 * @property {(path: string) => {name: string, isDirectory: boolean}[]} readDir
 * @property {(path: string) => string} readText
 */

/** @type {TaskFileAccess} */
export const defaultTaskFiles = {
  readDir(path) {
    return readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
  },
  readText(path) {
    return readFileSync(path, 'utf8');
  },
};

/**
 * The repository root, resolved from this module's own location.
 *
 * Not from `process.cwd()`: `npm run tasks` from a subdirectory would otherwise
 * report an empty board rather than the repository's, and the gate would pass
 * by finding no specs to disagree with. Where this file sits is a fact; where
 * it was invoked from is not.
 *
 * @returns {string}
 */
export function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}
