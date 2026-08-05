/**
 * What `.git` says about a checkout: which branch it is on, and - when it is a
 * linked worktree - which checkout it belongs to.
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
 *
 * The second answer, the linked checkout, exists because a run started in a
 * worktree is registered by no-mistakes against the *main* checkout - that is
 * the path a worktree's repo resolves to - while the session reporting itself
 * to us is sitting in the worktree. `matchRunForCwd` places a run by cwd
 * prefix, which no worktree path can ever satisfy, so the session driving the
 * pipeline showed no pipeline and the run fell through to whichever idle
 * session happened to be open on the main checkout. Only this file knows the
 * two are the same repo, and it already reads the one thing that says so.
 *
 * Both answers come back from one call, because two accessors over one cache
 * are still two stats of the same HEAD per session per poll - and callers need
 * them together anyway, the branch being what picks which of a checkout's runs
 * a worktree session is the one driving.
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

/**
 * The checkout a linked worktree's git directory belongs to, or null.
 *
 * git always puts a linked worktree's admin directory at
 * `<common dir>/worktrees/<name>`, so the common directory is what precedes it.
 * That directory is only called `.git` when the repository has a working tree
 * of its own, and requiring the name is the whole guard: a common dir named
 * anything else is a bare repository, which has no checkout to name.
 *
 * That case is not hypothetical here. no-mistakes keeps its gate repositories
 * at `~/.no-mistakes/repos/<hash>.git` and runs each pipeline step in a
 * worktree of one, so those agents would otherwise be translated to
 * `~/.no-mistakes/repos` - a directory no session is ever in. They are placed
 * by their run id instead, in `matchRunForAgentCwd`. A submodule points into
 * `modules/` rather than `worktrees/` and is refused for the same reason.
 *
 * @param {string|null} gitDir
 * @returns {string|null}
 */
export function mainCheckoutFromGitDir(gitDir) {
  const match = String(gitDir || '').match(/^(.*)\/\.git\/worktrees\/[^/]+\/?$/);
  return match ? match[1] || null : null;
}

export class GitBranch {
  /**
   * `headPath` is null for a directory that is not in a repo, which is cached
   * like any other answer - see `checkoutFor`. `mainCheckout` is null for every
   * directory that is not in a linked worktree, which is most of them.
   *
   * @typedef {object} Resolved
   * @property {string|null} headPath
   * @property {string|null} mainCheckout
   * @property {number} size
   * @property {number} mtimeMs
   * @property {string|null} branch
   */
  /** @type {Map<string, Resolved>} */
  #cache = new Map();
  #files;

  /** @param {{files?: GitFileAccess}} [deps] */
  constructor({ files = defaultGitAccess } = {}) {
    this.#files = files;
  }

  /**
   * What a directory is checked out on, and what it is linked to.
   *
   * `branch` is null for a detached HEAD, for a directory that is not in a repo
   * at all, and for a HEAD that could not be read. `mainCheckout` is null for
   * every directory that is not in a linked worktree, which is most of them.
   *
   * One stat on the happy path, for both answers together: a HEAD that has not
   * moved cannot have changed branch, and cannot have changed which repository
   * it belongs to either. Asking for the two separately would stat it twice per
   * session per poll, which is why there is one accessor rather than two.
   *
   * A directory that turned out not to be in a repo is remembered as such
   * rather than re-walked every second - so a `git init` inside a live
   * session's directory is not picked up until the session restarts. That is
   * worth the twenty-odd stats a second it saves, since a session's checkout
   * does not usually come into existence underneath it.
   *
   * The link is deliberately *only* the link: a worktree no-mistakes registered
   * in its own right is still the more specific answer, so callers try the
   * session's own directory first and fall back to this.
   *
   * Never throws. A directory that has been deleted, or a HEAD that cannot be
   * read, is a session with no branch, which is still a session.
   *
   * @param {string|null} dir
   * @returns {{branch: string|null, mainCheckout: string|null}}
   */
  checkoutFor(dir) {
    const { branch, mainCheckout } = this.#resolve(dir);
    return { branch, mainCheckout };
  }

  /**
   * Everything `.git` has to say about a directory, cached on HEAD's mtime.
   *
   * @param {string|null} dir
   * @returns {Resolved}
   */
  #resolve(dir) {
    /** @type {Resolved} */
    const nothing = { headPath: null, mainCheckout: null, size: 0, mtimeMs: 0, branch: null };
    if (!dir) return nothing;
    const cached = this.#cache.get(dir);
    if (cached) {
      if (!cached.headPath) return cached;
      try {
        const info = this.#files.stat(cached.headPath);
        if (info.size === cached.size && info.mtimeMs === cached.mtimeMs) return cached;
      } catch {
        // The worktree was removed, or the repo re-created underneath us.
        this.#cache.delete(dir);
      }
    }

    const found = this.#findGit(dir);
    if (!found) {
      this.#cache.set(dir, nothing);
      return nothing;
    }
    try {
      const info = this.#files.stat(found.headPath);
      const branch = branchFromHead(this.#files.readText(found.headPath));
      /** @type {Resolved} */
      const entry = { ...found, size: info.size, mtimeMs: info.mtimeMs, branch };
      this.#cache.set(dir, entry);
      return entry;
    } catch {
      // A HEAD that could not be read this once is not cached, so the next ask
      // tries again - but the link is still what it was, and saying so costs
      // nothing.
      return { ...found, size: 0, mtimeMs: 0, branch: null };
    }
  }

  /**
   * Walk up until something answers to `.git`, and read what it points at.
   *
   * @param {string} dir
   * @returns {{headPath: string, mainCheckout: string|null}|null}
   */
  #findGit(dir) {
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
      if (info.isDirectory) return { headPath: join(dotGit, 'HEAD'), mainCheckout: null };
      try {
        const gitDir = gitDirFromLink(this.#files.readText(dotGit));
        if (!gitDir) return null;
        return { headPath: join(gitDir, 'HEAD'), mainCheckout: mainCheckoutFromGitDir(gitDir) };
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
