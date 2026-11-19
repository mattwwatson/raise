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
 * @property {(path: string) => boolean} directoryExists
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
  directoryExists(path) {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
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

/**
 * The fixed texts Firstmate opens its supervision session's prompts with.
 *
 * That session is a headless `claude -p --safe-mode` run Firstmate starts in its
 * own home to watch its workers between the captain's turns. Safe mode loads no
 * hooks, so it never reports, and it writes an ordinary transcript - so without
 * this it is a `Not tracked` row for as long as Firstmate supervises, advising a
 * restart that changes nothing. It is an agent of Firstmate's, the same kind of
 * thing as a no-mistakes pipeline agent, and is left out for the same reason.
 *
 * **Why the prompt and not the path or the entrypoint.** `isPipelineWorktree`
 * cannot work here: the supervision session runs in the same directory as the
 * captain's own Firstmate session, which is a session a person has open and must
 * keep its row. And its records' `"entrypoint": "sdk-cli"` is written by every
 * headless or SDK run, some of which are sessions somebody does want to see. The
 * prefix is the one thing only this session carries.
 *
 * **Two prefixes, because one Firstmate function writes either.** Every wake
 * prompt comes from `branchWakePrompt` in Firstmate's
 * `.pi/extensions/lib/fm-branch-dispatch.ts`. It opens with the dialog mirror's
 * header, `MAIN_DIALOG_MIRROR_HEADER`, only when there is a mirror to carry - an
 * attended wake on which something new was said. Otherwise, on an away wake or
 * when nothing new was said, the prompt opens `FIRSTMATE SUPERVISION WAKE: `. A
 * session's first wake can be either, so matching only the first would leave
 * the row on the page for exactly the sessions that started without a mirror.
 *
 * Both are Firstmate's text, not ours, so `test/untracked.test.js` pins them. If
 * Firstmate rewords either, the row comes back; the pinned test is where to
 * look, and changing it is a deliberate act rather than a silent drift.
 */
export const FIRSTMATE_SUPERVISION_PROMPTS = Object.freeze([
  'MAIN DIALOG MIRROR',
  'FIRSTMATE SUPERVISION WAKE:',
]);

/**
 * The text of the first prompt a person (or a harness) typed into a Claude Code
 * transcript, or `null` if the records hold none.
 *
 * Skips `isMeta` records, which Claude Code writes as `user` records around
 * slash commands and caveats, and records whose content is only tool results.
 * The prompt is a string on a headless run and a list of blocks on some
 * interactive ones; the first text block is the prompt.
 *
 * @param {{type?: unknown, isMeta?: unknown,
 *          message?: {role?: unknown, content?: unknown}}[]} records raw JSONL
 *   records, straight off the head of the file
 * @returns {string|null}
 */
export function firstPrompt(records) {
  for (const record of records) {
    if (record?.type !== 'user' || record.isMeta || record.message?.role !== 'user') continue;
    const content = record.message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) continue;
    const text = content.find((block) => block?.type === 'text' && typeof block.text === 'string');
    if (text) return text.text;
  }
  return null;
}

/**
 * Whether a first prompt is one Firstmate starts its supervision session
 * with. See `FIRSTMATE_SUPERVISION_PROMPTS`.
 *
 * @param {string|null} prompt
 * @returns {boolean}
 */
export function isFirstmateSupervisionPrompt(prompt) {
  if (typeof prompt !== 'string') return false;
  return FIRSTMATE_SUPERVISION_PROMPTS.some((prefix) => prompt.startsWith(prefix));
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
   * Whether each Claude Code transcript is Firstmate's supervision session, by
   * path. A first prompt, once written, never changes, so either answer is good
   * forever - but only once there is one: see `#isFirstmateSupervision`.
   *
   * @type {Map<string, boolean>}
   */
  #supervision = new Map();

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
        // Claude Code only, because the supervision session is a `claude -p`
        // run, and pi and Codex keep their prompts in records of their own
        // shape - reading their heads for a prefix they never carry would be a
        // read for nothing.
        if (root.agent === 'claude' && this.#isFirstmateSupervision(path)) continue;
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
    for (const path of this.#supervision.keys()) {
      if (!seen.has(path)) this.#supervision.delete(path);
    }
    return found;
  }

  /**
   * Whether one Claude Code transcript is Firstmate's supervision session, from
   * its first prompt, read once and remembered.
   *
   * The head, not the tail: the first prompt is near the top of the file and the
   * tail of a session that has been supervising for an hour is somewhere else
   * entirely. Measured on a live supervision transcript it was the fourth record,
   * about 9KB in after an 8.7KB queue record repeating it, and Firstmate bounds
   * the mirror it carries at 16,000 characters, so `HEAD_BYTES` holds it.
   *
   * The answer is remembered once it cannot change: when the head held a first
   * prompt, or when the file is already longer than the head, so the head is
   * fixed and a prompt beyond it will never be read. A file shorter than that
   * with no prompt yet is still being written and is asked again on the next
   * scan. Anything unreadable is answered `false`, which keeps the row: a
   * session that cannot be placed is shown rather than hidden, the direction
   * `isDisplayable` fails in for the same reason.
   *
   * @param {string} path
   * @returns {boolean}
   */
  #isFirstmateSupervision(path) {
    const known = this.#supervision.get(path);
    if (known !== undefined) return known;
    let head;
    try {
      head = this.#files.readHead(path, HEAD_BYTES);
    } catch {
      return false;
    }
    const prompt = firstPrompt(parseTranscriptTail(head, false));
    const answer = isFirstmateSupervisionPrompt(prompt);
    if (prompt !== null || Buffer.byteLength(head) >= HEAD_BYTES) {
      this.#supervision.set(path, answer);
    }
    return answer;
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
   * A directory that is no longer there is not an answer. `GitBranch` walks up
   * from whatever it is handed until something answers to `.git`, which for a
   * deleted worktree means the branch of some ancestor repo - and on a machine
   * where `$HOME` is itself a checkout, that is every deleted path. A row is
   * allowed to know nothing; it is not allowed to name the wrong branch. This
   * cannot arise for a registered session, whose directory is a live process's
   * own, which is why the check belongs here rather than in `git-branch.js`.
   *
   * **The check covers the cached answer as well as the fresh one**, because a
   * worktree is far more likely to be removed while we are watching it than
   * before we first looked. The manual run that found this caught only the
   * already-gone case, which is the same failure reached one scan earlier: the
   * transcript outlives the worktree by up to the whole two-hour window, so a
   * cwd resolved while the directory existed would otherwise keep a confident
   * wrong branch on the page for every tick of it. It costs one `stat` per
   * untracked session per scan, and only the read - the expensive half - is
   * remembered. Only a positive answer is cached at all, the rule `nm-state.js`
   * follows for the database appearing under a running monitor: a file we could
   * not place is retried rather than written off.
   *
   * @param {string} path
   * @returns {string|null}
   */
  #cwdFor(path) {
    const cwd = this.#cwds.get(path) || this.#readTailCwd(path) || this.#readHeadCwd(path);
    if (!cwd || !this.#files.directoryExists(cwd)) return null;
    this.#cwds.set(path, cwd);
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
