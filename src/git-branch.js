/**
 * Which branch a directory is on, read from `.git` rather than asked of git.
 *
 * The branch used to be borrowed from whichever no-mistakes run matched the
 * session's directory, which meant a session had a branch only while its
 * pipeline run was recent - and none at all if it had never run the pipeline.
 * That is backwards: the branch is a property of the checkout, not of a run
 * that happened to touch it.
 *
 * It is load-bearing for the pull request link. A PR found in the no-mistakes
 * database belongs to a branch, and attaching another branch's PR to a session
 * is worse than attaching none - it is a confident link to the wrong review.
 * So the branch has to be knowable independently of any run.
 *
 * `git rev-parse` would cost a process per session per poll, and the server may
 * not run one at all. `.git/HEAD` is one small file that says the same thing,
 * so it is read directly and cached on mtime, exactly like the transcript tail.
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * @typedef {object} GitFileAccess
 * @property {(path: string) => {size: number, mtimeMs: number, isDirectory: boolean}} stat
 * @property {(path: string) => string} readText
 */

/** @type {GitFileAccess} */
export const defaultGitAccess = {
  stat(path) {
    const info = statSync(path);
    return { size: info.size, mtimeMs: info.mtimeMs, isDirectory: info.isDirectory() };
  },
  readText(path) {
    return readFileSync(path, 'utf8');
  },
};

/**
 * How far up the tree to look for a `.git`. Deep enough for any real checkout,
 * and a bound on how many stats a directory that is not in a repo at all can
 * cost before we stop.
 */
const MAX_DEPTH = 24;

/**
 * The branch named by the contents of a `.git/HEAD`.
 *
 * A detached HEAD holds a bare sha, which is not a branch. Returning it anyway
 * would put `a1b2c3d4` where the card shows a branch name, and - worse - would
 * be compared against the branch on a pull request, where it can only ever
 * fail to match or match something it should not.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function branchFromHead(text) {
  const match = String(text || '')
    .trim()
    .match(/^ref:\s*refs\/heads\/(.+)$/);
  return match ? match[1].trim() || null : null;
}

/**
 * The real git directory that a `.git` *file* points at.
 *
 * A worktree's `.git` is a file rather than a directory, and its HEAD lives
 * wherever that file says - usually `<main repo>/.git/worktrees/<name>`.
 * Worktrees are the normal case here, not an edge one: no-mistakes and
 * Treehouse both work in them, and they are exactly the checkouts most likely
 * to be on a branch of their own.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function gitDirFromLink(text) {
  const match = String(text || '').match(/^gitdir:\s*(.+)$/m);
  return match ? match[1].trim() || null : null;
}

export class GitBranch {
  /**
   * `headPath` is null for a directory that is not in a repo, which is cached
   * like any other answer - see `branchFor`.
   *
   * @type {Map<string, {headPath: string|null, size: number, mtimeMs: number, branch: string|null}>}
   */
  #cache = new Map();
  #files;

  /** @param {{files?: GitFileAccess}} [deps] */
  constructor({ files = defaultGitAccess } = {}) {
    this.#files = files;
  }

  /**
   * The branch a directory is checked out on, or null.
   *
   * One stat on the happy path: a HEAD that has not moved cannot have changed
   * branch. A directory that turned out not to be in a repo is remembered as
   * such rather than re-walked every second - so a `git init` inside a live
   * session's directory is not picked up until the session restarts. That is
   * worth the twenty-odd stats a second it saves, since a session's checkout
   * does not usually come into existence underneath it.
   *
   * Never throws. A directory that has been deleted, or a HEAD that cannot be
   * read, is a session with no branch, which is still a session.
   *
   * @param {string|null} dir
   * @returns {string|null}
   */
  branchFor(dir) {
    if (!dir) return null;
    const cached = this.#cache.get(dir);
    if (cached) {
      if (!cached.headPath) return null;
      try {
        const info = this.#files.stat(cached.headPath);
        if (info.size === cached.size && info.mtimeMs === cached.mtimeMs) return cached.branch;
      } catch {
        // The worktree was removed, or the repo re-created underneath us.
        this.#cache.delete(dir);
      }
    }

    const headPath = this.#findHead(dir);
    if (!headPath) {
      this.#cache.set(dir, { headPath: null, size: 0, mtimeMs: 0, branch: null });
      return null;
    }
    try {
      const info = this.#files.stat(headPath);
      const branch = branchFromHead(this.#files.readText(headPath));
      this.#cache.set(dir, { headPath, size: info.size, mtimeMs: info.mtimeMs, branch });
      return branch;
    } catch {
      return null;
    }
  }

  /**
   * Walk up until something answers to `.git`, and turn it into a path to HEAD.
   *
   * @param {string} dir
   * @returns {string|null}
   */
  #findHead(dir) {
    let current = dir;
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      const dotGit = join(current, '.git');
      let info;
      try {
        info = this.#files.stat(dotGit);
      } catch {
        const parent = dirname(current);
        if (parent === current) return null;
        current = parent;
        continue;
      }
      if (info.isDirectory) return join(dotGit, 'HEAD');
      try {
        const gitDir = gitDirFromLink(this.#files.readText(dotGit));
        return gitDir ? join(gitDir, 'HEAD') : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Forget directories whose sessions have gone, so a long-lived server does
   * not keep an entry per directory it has ever seen.
   *
   * @param {Set<string>} liveDirs
   */
  prune(liveDirs) {
    for (const dir of this.#cache.keys()) {
      if (!liveDirs.has(dir)) this.#cache.delete(dir);
    }
  }
}
