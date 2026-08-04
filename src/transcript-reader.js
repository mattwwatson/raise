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

import {
  TAIL_BYTES,
  parseTranscriptTail,
  summariseTranscript,
  recentEvents,
  EMPTY_SUMMARY,
} from './transcript.js';
import { parsePiTranscriptTail } from './pi-transcript.js';

/**
 * Which parser reads which agent's file.
 *
 * The only place the two formats differ, by design: pi's entries are normalised
 * into the same records, so everything past this line is shared. See
 * `pi-transcript.js` for why that is a normaliser and not a second summariser.
 */
const PARSERS = {
  claude: parseTranscriptTail,
  pi: parsePiTranscriptTail,
};

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

/**
 * One cached reading of a transcript tail.
 *
 * `events` is absent until something asks for it. Every session is summarised
 * on every poll, but only an expanded card is ever read back in full, so the
 * hot path must not pay for a list nobody has asked to see.
 *
 * `branch` is part of what the entry was derived from, not just what it
 * describes: it decides which pull request in the tail is this session's, so a
 * checkout that switches branch has to be re-read even though the file has not
 * moved.
 *
 * `agent` is part of it for the same reason: it chooses the parser, so an entry
 * derived by one is not an answer for the other. In practice a session file
 * belongs to one agent for its whole life and this never fires - but a cache
 * that cannot say what it was derived from is one refactor away from returning
 * a confidently parsed answer to a question nobody asked it.
 *
 * @typedef {object} CacheEntry
 * @property {number} size
 * @property {number} mtimeMs
 * @property {string|null} branch
 * @property {import('./registry.js').AgentKind} agent
 * @property {import('./transcript.js').TranscriptSummary} summary
 * @property {import('./transcript.js').TranscriptEvent[]} [events]
 */

export class TranscriptReader {
  /** @type {Map<string, CacheEntry>} */
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
   * @param {string|null} [branch] the session's branch, so a pull request in
   *   the tail can be attributed to it rather than guessed at
   * @param {import('./registry.js').AgentKind} [agent] whose format this is
   * @returns {import('./transcript.js').TranscriptSummary}
   */
  read(path, branch = null, agent = 'claude') {
    return this.#entry(path, { branch, agent })?.summary ?? EMPTY_SUMMARY;
  }

  /**
   * The last few things that happened in one transcript, oldest first.
   *
   * Only ever called for a card someone has expanded, so it may do the work
   * `read` deliberately skips. Both come out of the same parse: an expanded
   * card refreshing itself fills the summary the next poll would have needed
   * anyway.
   *
   * @param {string|null} path
   * @param {number} [limit]
   * @param {import('./registry.js').AgentKind} [agent] whose format this is
   * @returns {import('./transcript.js').TranscriptEvent[]}
   */
  events(path, limit, agent = 'claude') {
    return this.#entry(path, { withEvents: true, limit, agent })?.events ?? [];
  }

  /**
   * The cache entry for a path, refreshed if the file or the branch has moved.
   *
   * @param {string|null} path
   * @param {{withEvents?: boolean, limit?: number, branch?: string|null,
   *          agent?: import('./registry.js').AgentKind}} [want]
   * @returns {CacheEntry|null}
   */
  #entry(path, { withEvents = false, limit, branch = null, agent = 'claude' } = {}) {
    if (!path) return null;
    let info;
    try {
      info = this.#files.stat(path);
    } catch {
      // Gone, or never there. Drop any stale entry so a recreated transcript
      // is read fresh rather than answered from a cache about a dead file.
      this.#cache.delete(path);
      return null;
    }

    const cached = this.#cache.get(path);
    // `events` asks nothing of the branch, so it neither invalidates a summary
    // read against one nor discards it when re-parsing.
    const want = branch ?? cached?.branch ?? null;
    const fresh =
      cached &&
      cached.size === info.size &&
      cached.mtimeMs === info.mtimeMs &&
      cached.branch === want &&
      cached.agent === agent;
    if (fresh && (!withEvents || cached.events)) return cached;

    /** @type {CacheEntry} */
    let entry = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      branch: want,
      agent,
      summary: EMPTY_SUMMARY,
    };
    try {
      const { text, partial } = this.#files.readTail(path, TAIL_BYTES);
      const parse = PARSERS[agent] || parseTranscriptTail;
      const records = parse(text, partial);
      entry.summary = summariseTranscript(records, want);
      if (withEvents) entry.events = recentEvents(records, limit);
    } catch {
      // An unreadable transcript claims nothing rather than asserting an empty
      // history, which would render as a session that has done nothing at all.
      if (withEvents) entry.events = [];
    }
    this.#cache.set(path, entry);
    return entry;
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
