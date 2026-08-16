/**
 * Which build of the page the server is currently serving.
 *
 * The dashboard is a page you leave pinned, which is the stated product shape,
 * and that shape has a failure in it. The tab loads its HTML and JavaScript once
 * and then lives for days. When the server restarts with new code the stream
 * transparently reopens, data keeps flowing and the liveness dot stays green -
 * and the tab goes on rendering with the JavaScript it loaded before the change.
 * New fields arrive in the state frame and are silently ignored by old rendering
 * code. Nothing errors, so nothing says the page is out of date.
 *
 * `AGENTS.md` is emphatic that the page must never assert something it can no
 * longer stand behind, and applies that rigorously to *data* while leaving
 * *code* alone. This module is the other half: the server states which build it
 * is serving, the page remembers what it loaded with, and `createBuildWatch` in
 * `public/connection.js` decides whether they still agree.
 *
 * **The identity is a hash of the bytes, not a proxy for them, and that was
 * measured rather than argued.** Three cheaper candidates were rejected on
 * evidence, and each is tempting enough to be worth naming:
 *
 *   - **The package version.** `package.json` has read `0.1.0` for all 238
 *     commits in this repository's history while 24 of them changed `public/`,
 *     so a version-derived stamp would have detected exactly none of them -
 *     including the change that produced the ticket.
 *   - **Restart time**, which `server.json` already records as `startedAt` and
 *     which is therefore free. Only 24 of the last 236 commits touched
 *     `public/`, so about nine restarts in ten carry no page change at all and
 *     would have offered a reload for nothing.
 *   - **A hash taken once at startup.** `servePage` and `serveModule` re-read
 *     their files on *every request*, so editing the page under a running
 *     server changes what is served with no restart. A boot-time hash describes
 *     a file the server has since stopped handing out: two tabs opened either
 *     side of an edit run different code and both claim the same build. That is
 *     a false negative, in the same quiet-staleness direction as the bug this
 *     exists to fix.
 *
 * The cost that made those tempting is not real. Reading and hashing both files
 * in `public/` (67KB) costs 0.05ms and only happens on a tick where an mtime
 * actually moved; the steady state is two `stat` calls, at 0.0024ms. So this
 * caches exactly the way `src/transcript-reader.js` does, and for the same
 * reason - a stat is a syscall, hashing is not. The measurements are dated and
 * repeatable in `docs/tasks/1-stale-page-code.md`.
 *
 * **It never throws, and an unreadable build is `null` rather than a guess.**
 * A stamp we could not compute must not become a stamp that merely differs from
 * the page's, or a missing file would tell every open tab it is out of date.
 * Positive evidence, never absence - the server omits the field, and the page
 * says nothing.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the page lives, matching `PUBLIC_DIR` in `src/server.js`. */
export const PUBLIC_DIR = join(HERE, '..', 'public');

/**
 * The files the server actually serves, and therefore the whole of a build.
 *
 * Exactly the two `servePage` and `serveModule` read - not everything that
 * happens to sit in `public/`. A file nobody is served is not part of the code
 * a tab is running, and stamping it would offer a reload that changes nothing.
 *
 * The coupling is the obvious way for this to rot, so `build-stamp.test.js`
 * reads `src/server.js` and fails if it serves a file this list does not name.
 * Detectable rather than impossible, which is the bargain `docs-claims.test.js`
 * strikes with `CONTRIBUTING.md`'s inventory.
 */
export const SERVED_FILES = ['index.html', 'connection.js'];

/**
 * Twelve hex characters of SHA-256.
 *
 * Only ever compared for equality - nothing reads a stamp, and the page never
 * displays one - so the question is collision resistance and not length. Forty-
 * eight bits of it, against a corpus of two consecutive builds, and a collision
 * costs one missed reload rather than a wrong answer.
 */
const STAMP_CHARS = 12;

/**
 * @typedef {object} BuildFileAccess
 * @property {(path: string) => {size: number, mtimeMs: number}} stat
 * @property {(path: string) => Buffer|string} read
 */

/** @type {BuildFileAccess} */
export const defaultBuildFiles = {
  stat(path) {
    const info = statSync(path);
    return { size: info.size, mtimeMs: info.mtimeMs };
  },
  read(path) {
    return readFileSync(path);
  },
};

export class BuildStamp {
  #dir;
  #files;
  /** What the files looked like when `#stamp` was computed, or null for never. */
  #signature = null;
  /** @type {string|null} */
  #stamp = null;

  /** @param {{dir?: string, files?: BuildFileAccess}} [deps] */
  constructor({ dir = PUBLIC_DIR, files = defaultBuildFiles } = {}) {
    this.#dir = dir;
    this.#files = files;
  }

  /**
   * The stamp for the build being served right now.
   *
   * @returns {string|null} null when the page could not be read at all, which
   *   the caller must treat as "no answer" rather than as a different build
   */
  current() {
    const signature = this.#signatureNow();
    // A file that cannot be stat'd contributes a marker rather than dropping
    // out, so a file appearing or disappearing moves the signature and forces
    // a re-read. Caching a null against its own signature is correct: an
    // unreadable file that has not moved is still unreadable.
    if (signature === this.#signature) return this.#stamp;
    this.#signature = signature;
    this.#stamp = this.#hashNow();
    return this.#stamp;
  }

  /** Cheap enough to run on every poll: one `stat` per served file. */
  #signatureNow() {
    const parts = [];
    for (const name of SERVED_FILES) {
      try {
        const { size, mtimeMs } = this.#files.stat(join(this.#dir, name));
        parts.push(`${name}:${size}:${mtimeMs}`);
      } catch {
        parts.push(`${name}:-`);
      }
    }
    return parts.join('|');
  }

  /** @returns {string|null} */
  #hashNow() {
    const hash = createHash('sha256');
    for (const name of SERVED_FILES) {
      let bytes;
      try {
        bytes = this.#files.read(join(this.#dir, name));
      } catch {
        // One unreadable file makes the whole build unknowable. Hashing the
        // rest would produce a stamp that differs from the one every open tab
        // holds, which is the page announcing staleness off a failed read.
        return null;
      }
      const buffer = Buffer.from(bytes);
      // The name and the length go in with the bytes, so that swapping two
      // files' contents, or moving a byte across the boundary between them,
      // cannot hash to the build it replaced.
      hash.update(`${name}:${buffer.length}:`);
      hash.update(buffer);
    }
    return hash.digest('hex').slice(0, STAMP_CHARS);
  }
}
