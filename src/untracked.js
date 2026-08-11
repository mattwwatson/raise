/**
 * Sessions that were already running when the hooks went in.
 *
 * Every other source here is *pushed*: an agent runs a hook, the hook posts, and
 * a row exists. That is why a session started after `raise install-hooks`
 * appears with no activity required - and it is also why one started *before*
 * appears not at all, until its next turn. For the person who installed Raise
 * that is a footnote. For a stranger it is an empty page at the exact moment
 * they have the most sessions open and the least patience, and the obvious
 * conclusion is that the tool does not work.
 *
 * So this scans for transcripts written recently that no hook record accounts
 * for, and the page renders them as plain rows with no state and no focus
 * button. It is a blunt instrument and it is bounded on purpose - see the
 * constants below and `docs/tasks/RAI-4-first-run-shows-something.md`.
 *
 * **The one sentence the whole design follows from:** a hook record is evidence
 * that a session *exists*; a recently-modified transcript is evidence only that
 * one *existed* as recently as its mtime. Every state word, every colour, the
 * focus button and the liveness prune in `registry.list` all hang off the first.
 * So a row built from here says where it is, what it was about and when it last
 * wrote, and refuses to say what it is doing - the four states worth telling
 * apart (finished, at a permission prompt, on the idle nudge, and closed an hour
 * ago) write byte-identical transcripts, so any state word chosen from one is a
 * one-in-four guess presented as a fact.
 *
 * File access is injected, as everywhere else here, so the scan is tested
 * against a fake filesystem rather than against whatever the machine running
 * the suite happens to have open.
 */

import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

import { TAIL_BYTES, parseTranscriptTail } from './transcript.js';
import {
  claudeProjectsDir,
  codexSessionsDir,
  noMistakesHome,
  piSessionsDir,
} from './config.js';

/** @typedef {import('./registry.js').AgentKind} AgentKind */

/**
 * How recently a transcript must have been written to count as a session
 * somebody might still have open.
 *
 * Measured on a heavily used machine: 16 unregistered transcripts inside eight
 * hours, of which 14 were no-mistakes pipeline agents (excluded below), one was
 * a genuine session nine minutes old and two were closed sessions two and three
 * hours back. An hour would have covered that machine and is too tight in
 * general, because a session parked at a prompt goes quiet the moment it asks.
 *
 * It errs long deliberately. Being over-inclusive costs a grey row that says
 * "2h ago" and sorts below everything; being under-inclusive costs the empty
 * page this whole module exists to prevent.
 */
export const UNTRACKED_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * How often the directory walk is repeated.
 *
 * Not on the one second poll: the walk measured 9.3ms across 1,396 transcripts
 * in 261 project directories, which is cheap enough to need no cap on how many
 * files it visits and too expensive to do every tick for nothing.
 *
 * The first scan runs on the first snapshot, so a page opened straight after
 * `raise serve` is populated at once; this interval only delays *discovering* a
 * session that becomes untracked while the monitor is already running. That is a
 * real case rather than a theoretical one - Codex's hooks are trust-gated, so
 * every Codex session is untracked until the user approves the hook in Codex's
 * own TUI - but it is not one that needs answering inside a second.
 *
 * Dedupe against the registry is *not* on this interval. It is redone every tick
 * from the live session list, so a session that restarts loses its untracked row
 * on the next poll rather than up to half a minute later.
 */
export const SCAN_INTERVAL_MS = 30000;

/**
 * How much of the head of a transcript to read when the tail did not name a
 * working directory.
 *
 * Codex writes its `cwd` once, in the `session_meta` on line 1, and that line
 * measured 18.6KB because it carries the base instructions. 64KB is three and a
 * half times that. pi's equivalent line is about 160 bytes.
 */
export const HEAD_BYTES = 64 * 1024;

/**
 * Where each agent keeps its transcripts, and how deep the files sit.
 *
 * Claude Code and pi use one directory per project; Codex partitions by date,
 * `YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, hence the depth. Resolved on each call
 * rather than at import, because every root honours the agent's own environment
 * variable and the suite moves all three.
 *
 * @returns {{dir: string, agent: AgentKind, depth: number}[]}
 */
export function untrackedRoots() {
  return [
    { dir: claudeProjectsDir(), agent: /** @type {AgentKind} */ ('claude'), depth: 1 },
    { dir: piSessionsDir(), agent: /** @type {AgentKind} */ ('pi'), depth: 1 },
    { dir: codexSessionsDir(), agent: /** @type {AgentKind} */ ('codex'), depth: 3 },
  ];
}

/**
 * A session we found on disk and have never been told about.
 *
 * `key` is the transcript path, and it is the identity of the row: it is what
 * the registry is checked against, what the per-session maps in `server.js` are
 * keyed by, and what `Row.id` is built from. A session id is
 * `[A-Za-z0-9_-]{1,128}` and a path contains `/`, so the two key spaces cannot
 * collide.
 *
 * @typedef {object} UntrackedSession
 * @property {string} key
 * @property {string} transcriptPath
 * @property {AgentKind} agent
 * @property {string} cwd
 * @property {number} lastSeenAt the transcript's mtime, which is the whole of
 *   what we know about when this session last did anything
 */

/**
 * @typedef {object} UntrackedFiles
 * @property {(dir: string) => {name: string, directory: boolean}[]} list
 * @property {(path: string) => {mtimeMs: number}} stat
 * @property {(path: string, bytes: number) => {text: string, partial: boolean}} readTail
 * @property {(path: string, bytes: number) => string} readHead
 */

/** @type {UntrackedFiles} */
export const defaultUntrackedFiles = {
  list(dir) {
    return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      directory: entry.isDirectory(),
    }));
  },
  stat(path) {
    return { mtimeMs: statSync(path).mtimeMs };
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
  readHead(path, bytes) {
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const read = readSync(fd, buffer, 0, bytes, 0);
      return buffer.subarray(0, read).toString('utf8');
    } finally {
      closeSync(fd);
    }
  },
};

/**
 * The working directory a transcript claims, from raw records.
 *
 * Newest first, because a Claude Code transcript carries one on every
 * conversation record and the last is as good as any - while pi and Codex carry
 * exactly one, at the very start of the file.
 *
 * Deliberately reads **raw** lines rather than going through
 * `pi-transcript.js` or `codex-transcript.js`. `cwd` lives on precisely the
 * session-metadata records those two exist to drop, and re-admitting it there
 * would put timestamped metadata back into the stream `summariseTranscript`
 * reads - the `away_summary` trap, invited in through the front door.
 *
 * Anything that is not an absolute path is ignored, so a record that happens to
 * carry a relative or malformed `cwd` cannot produce a row anchored nowhere.
 *
 * @param {{cwd?: unknown, payload?: {cwd?: unknown}}[]} records raw JSONL
 *   records, straight off the file - `parseTranscriptTail` returns `object[]`,
 *   so the two fields this reads are declared here rather than assumed
 * @returns {string|null}
 */
export function transcriptCwd(records) {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    const cwd = record?.cwd ?? record?.payload?.cwd;
    if (typeof cwd === 'string' && cwd.startsWith('/')) return cwd;
  }
  return null;
}

/**
 * Whether a directory belongs to a no-mistakes pipeline agent rather than to a
 * person.
 *
 * These are the dominant population of unregistered recent transcripts - 14 of
 * 16 on the machine this was measured on - and every one of them would arrive as
 * a card titled with a bare run id that nobody can focus, which is exactly the
 * dead card `matchRunForAgentCwd` was written to prevent.
 *
 * It is not `matchRunForAgentCwd` that does it here, and the reason is the case
 * that function cannot cover: a run that finished half an hour ago has left the
 * runs reading while its worktree transcript is still inside our window, so
 * there is no run left to match it against. A path test needs none.
 *
 * A `startsWith` against a string from `config.js` - no database, no subprocess,
 * and on a machine with no no-mistakes nothing is ever under that path, so it
 * simply never fires. The absent integration still costs nothing and says
 * nothing.
 *
 * @param {string} cwd
 * @param {string} nmHome
 * @returns {boolean}
 */
export function isPipelineWorktree(cwd, nmHome) {
  return cwd === nmHome || cwd.startsWith(`${nmHome}/`);
}

export class UntrackedScan {
  #files;
  #roots;
  #nmHome;
  #intervalMs;
  #windowMs;
  /** @type {UntrackedSession[]} */
  #found = [];
  /** @type {number|null} */
  #scannedAt = null;
  /**
   * Working directories we have already resolved, by path.
   *
   * Only the positive answer is kept, which is the rule `nm-state.js` follows
   * for the database appearing under a running monitor and holds for the same
   * reason: a session's working directory cannot change, so a hit is good
   * forever, while caching a miss would mean never noticing a file that has
   * since written the record we were looking for.
   *
   * @type {Map<string, string>}
   */
  #cwds = new Map();

  /**
   * @param {{files?: UntrackedFiles, roots?: {dir: string, agent: AgentKind, depth: number}[],
   *          nmHome?: string, intervalMs?: number, windowMs?: number}} [deps]
   */
  constructor({
    files = defaultUntrackedFiles,
    roots = untrackedRoots(),
    nmHome = noMistakesHome(),
    intervalMs = SCAN_INTERVAL_MS,
    windowMs = UNTRACKED_WINDOW_MS,
  } = {}) {
    this.#files = files;
    this.#roots = roots;
    this.#nmHome = nmHome;
    this.#intervalMs = intervalMs;
    this.#windowMs = windowMs;
  }

  /**
   * The sessions on disk that nothing has reported, rescanned at most once per
   * `SCAN_INTERVAL_MS`.
   *
   * The registry check is applied on every call rather than at scan time, so a
   * session that restarts loses its row on the very next poll.
   *
   * @param {{registeredPaths?: Set<string>, now?: number}} [input]
   * @returns {UntrackedSession[]}
   */
  list({ registeredPaths = new Set(), now = Date.now() } = {}) {
    if (this.#scannedAt === null || now - this.#scannedAt >= this.#intervalMs) {
      this.#found = this.#scan(now);
      this.#scannedAt = now;
    }
    return this.#found.filter((session) => !registeredPaths.has(session.transcriptPath));
  }

  /**
   * @param {number} now
   * @returns {UntrackedSession[]}
   */
  #scan(now) {
    /** @type {UntrackedSession[]} */
    const found = [];
    const seen = new Set();
    for (const root of this.#roots) {
      for (const path of this.#walk(root.dir, root.depth)) {
        // A root can be nested inside another if somebody has pointed two
        // agents' homes at one directory. Placing a file twice would give one
        // session two rows, so the first root to claim it wins.
        if (seen.has(path)) continue;
        seen.add(path);
        let mtimeMs;
        try {
          mtimeMs = this.#files.stat(path).mtimeMs;
        } catch {
          // Deleted between the listing and the stat.
          continue;
        }
        if (now - mtimeMs > this.#windowMs) continue;
        const cwd = this.#cwdFor(path);
        if (!cwd) continue;
        if (isPipelineWorktree(cwd, this.#nmHome)) continue;
        found.push({
          key: path,
          transcriptPath: path,
          agent: root.agent,
          cwd,
          lastSeenAt: mtimeMs,
        });
      }
    }
    // Forget directories we no longer see, so a monitor left running for a week
    // does not hold a cwd for every session that has ever existed.
    for (const path of this.#cwds.keys()) if (!seen.has(path)) this.#cwds.delete(path);
    return found;
  }

  /**
   * Every `.jsonl` under a root, at exactly the depth that root keeps them.
   *
   * Exact depth rather than "anything below", because Claude Code writes a
   * subdirectory beside some transcripts and Codex partitions three levels
   * down: a free recursion would pick up whatever either of them puts in there
   * next.
   *
   * @param {string} dir
   * @param {number} depth
   * @returns {string[]}
   */
  #walk(dir, depth) {
    /** @type {{name: string, directory: boolean}[]} */
    let entries;
    try {
      entries = this.#files.list(dir);
    } catch {
      // A root for an agent that is not installed. Silence is the whole point.
      return [];
    }
    /** @type {string[]} */
    const paths = [];
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (depth > 0) {
        if (entry.directory) paths.push(...this.#walk(path, depth - 1));
        continue;
      }
      if (!entry.directory && entry.name.endsWith('.jsonl')) paths.push(path);
    }
    return paths;
  }

  /**
   * The working directory of one transcript, read once and remembered.
   *
   * Tail first, head second. Claude Code puts a `cwd` on every conversation
   * record, so its tail always has one and its head often does not - the first
   * record carrying one measured 172KB in on the worst file of 1,396. pi and
   * Codex put exactly one on line 1 and none in the tail at all. For a file
   * shorter than the tail window the first read is the whole file and the
   * fallback never runs.
   *
   * @param {string} path
   * @returns {string|null}
   */
  #cwdFor(path) {
    const cached = this.#cwds.get(path);
    if (cached) return cached;
    const cwd = this.#readTailCwd(path) || this.#readHeadCwd(path);
    if (cwd) this.#cwds.set(path, cwd);
    return cwd;
  }

  /** @param {string} path */
  #readTailCwd(path) {
    try {
      const { text, partial } = this.#files.readTail(path, TAIL_BYTES);
      return transcriptCwd(parseTranscriptTail(text, partial));
    } catch {
      return null;
    }
  }

  /** @param {string} path */
  #readHeadCwd(path) {
    try {
      // `partialStart: false` - the head of a file begins at a line boundary, so
      // dropping the first line would throw away the one record that has the
      // answer for two of the three agents.
      return transcriptCwd(parseTranscriptTail(this.#files.readHead(path, HEAD_BYTES), false));
    } catch {
      return null;
    }
  }
}
