/**
 * Reading transcript tails without doing it over and over.
 *
 * The server polls once a second and there is a transcript per session, so the
 * naive version reads every file on every tick forever. Transcripts only change
 * when their session does something, and a session that is blocked - the one
 * you most want a summary for - changes nothing at all while it waits.
 *
 * So the tick does a `stat` and stops there unless the size or mtime moved.
 * A stat is a syscall; parsing 128KB of JSON is not.
 *
 * File access is injected, like every other outside-world dependency here, so
 * the cache logic is tested against a fake filesystem rather than by writing
 * real transcripts to disk and waiting on mtime granularity.
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';

import { TAIL_BYTES, parseTranscriptTail, summariseTranscript, EMPTY_SUMMARY } from './transcript.js';

/**
 * @typedef {object} TranscriptFile
 * @property {(path: string) => {size: number, mtimeMs: number}} stat
 * @property {(path: string, bytes: number) => {text: string, partial: boolean}} readTail
 */

/** @type {TranscriptFile} */
export const defaultFileAccess = {
  stat(path) {
    const info = statSync(path);
    return { size: info.size, mtimeMs: info.mtimeMs };
  },
  readTail(path, bytes) {
    const fd = openSync(path, 'r');
    try {
      const { size } = statSync(path);
      const start = Math.max(0, size - bytes);
      const length = size - start;
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, start);
      return { text: buffer.toString('utf8'), partial: start > 0 };
    } finally {
      closeSync(fd);
    }
  },
};

export class TranscriptReader {
  /** @type {Map<string, {size: number, mtimeMs: number, summary: import('./transcript.js').TranscriptSummary}>} */
  #cache = new Map();
  #files;

  /** @param {{files?: TranscriptFile}} [deps] */
  constructor({ files = defaultFileAccess } = {}) {
    this.#files = files;
  }

  /**
   * The summary for one transcript, re-parsed only when the file has moved.
   *
   * Never throws: a transcript can be missing, unreadable, or deleted between
   * the stat and the read. A session with no summary is still a session, and
   * the dashboard's job is to keep showing it.
   *
   * @param {string|null} path
   * @returns {import('./transcript.js').TranscriptSummary}
   */
  read(path) {
    if (!path) return EMPTY_SUMMARY;
    let info;
    try {
      info = this.#files.stat(path);
    } catch {
      // Gone, or never there. Drop any stale entry so a recreated transcript
      // is read fresh rather than answered from a cache about a dead file.
      this.#cache.delete(path);
      return EMPTY_SUMMARY;
    }

    const cached = this.#cache.get(path);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      return cached.summary;
    }

    let summary;
    try {
      const { text, partial } = this.#files.readTail(path, TAIL_BYTES);
      summary = summariseTranscript(parseTranscriptTail(text, partial));
    } catch {
      summary = EMPTY_SUMMARY;
    }
    this.#cache.set(path, { size: info.size, mtimeMs: info.mtimeMs, summary });
    return summary;
  }

  /**
   * Forget transcripts for sessions that have gone, so a long-lived server does
   * not accumulate an entry per session it has ever seen.
   *
   * @param {Set<string>} livePaths
   */
  prune(livePaths) {
    for (const path of this.#cache.keys()) {
      if (!livePaths.has(path)) this.#cache.delete(path);
    }
  }
}
