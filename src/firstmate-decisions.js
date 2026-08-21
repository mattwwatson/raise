/**
 * Which firstmate crewmates are stopped waiting for a ruling.
 *
 * A firstmate crewmate that reaches something only a human can settle stops and
 * says so, and the captain surfaces the request in its own window - where it
 * then scrolls off. The crewmate sits stopped until somebody wonders what
 * became of it. That is precisely the sentence this product exists for, and it
 * was the one kind of waiting Raise had nothing to say about: a stopped
 * crewmate looked like a quiet card, which is to say it looked fine.
 *
 * **The obvious implementation is forbidden and unnecessary.** Tailing the
 * captain's transcript and matching on the prose it prints when it wants a
 * ruling is indirect evidence *asserting* a human gate, which the invariant in
 * AGENTS.md closes off - a phrase that turns up in ordinary conversation puts a
 * red card on a healthy session, and a wording change upstream removes a signal
 * you had learned to rely on, silently. It is also not needed, because
 * firstmate declares the fact structurally: every crewmate has an append-only
 * `$FM_HOME/state/<id>.status` event log it writes about itself, and
 * `bin/fm-fleet-snapshot.sh --json` publishes the fold of it. First-party
 * declaration, with the same standing as the no-mistakes database.
 *
 * **The snapshot is consumed rather than re-implemented, and the reason is the
 * half that is easy to miss.** The keyed fold - `needs-decision` and `blocked`
 * open a decision, only `resolved` or a verified captain-held transfer closes
 * one - is about forty lines and would be tempting to write here. What cannot
 * be written here is what firstmate does *next*: it reconciles that fold
 * against live crew state, so a decision the crew has provably moved past
 * shows nothing. Observed on 19/08/2026, one crewmate's status log carried
 * seven unclosed `needs-decision` lines and its `open_decisions` was empty,
 * because the run-step underneath it was live. A Raise that folded the file
 * itself would have shown seven ruling requests that no longer existed - a
 * confident stale alarm, which on a page whose whole claim is that a coloured
 * row means something is worse than saying nothing at all.
 *
 * **A set, never a single decision.** Four rulings open on one crewmate is the
 * ordinary case rather than an edge one: run against the status log this was
 * measured on, upstream's fold returns four - three `needs-decision` and one
 * `blocked`.
 * Building for one and generalising later would have shipped a version showing
 * a quarter of what was waiting, which is this item's own failure reintroduced
 * by its fix. Nothing here or downstream may bound the set silently.
 *
 * **Cost is the one real problem, and three things answer it together.** The
 * command is bash walking a fleet: 3.5s and 223KB when the spec measured it,
 * 14s and 224KB when this was built, against a one second poll that may not
 * block. So the read is gated on a `state/*.status` mtime moving, fired and
 * never awaited, and held to a minimum `REFRESH_MS` between reads, stamped when
 * one goes out rather than when it returns - the same three rules `lavish.js`
 * and `firstmate.js` already follow, plus the mtime gate that makes a steady
 * state cost nothing at all. If that is ever still too heavy the answer is a
 * smaller mode in firstmate, not a fold in JavaScript here - `FM_SNAPSHOT_SECONDMATES=0`
 * was measured as the nearest existing knob and saves 0.9s of 14.6s, so it was
 * not taken.
 *
 * **`ASSERTION_MAX_AGE_MS` is the fourth rule, and it exists because the mtime
 * gate cannot see the reconciliation.** A decision clears when the crew resumes
 * past it, and the crew resuming is a live run-step or a busy pane - neither of
 * which touches a status file. So a gate on file mtimes alone can hold a
 * decision that has already been answered for as long as nobody writes a status
 * line. So while we are asserting something the reading is re-taken on a
 * ceiling as well as on the gate. While healthy and asserting nothing the gate
 * is enough, because opening a decision always writes a status line - and the
 * fifth rule below extends the ceiling to cover the other state where the gate
 * is not enough. Cheap where it does not matter and honest where it does.
 *
 * **`MAX_CONSECUTIVE_FAILURES` is the fifth, and it is the other half of that
 * ceiling.** Re-taking a reading only helps if a reading can arrive: a snapshot
 * that always fails re-dispatches forever and replaces nothing, so the
 * assertion stands for the life of the process while a fourteen-second bash
 * runs every thirty seconds to keep it looking fresh. An assertion may not
 * outlive its evidence, and a re-dispatch that always fails is not evidence, so
 * past a small number of consecutive non-answers the reading is dropped rather
 * than held.
 *
 * **One counter, one ceiling, one decision - and that is a rule about the shape
 * of this file, not just about its numbers.** Every way of failing to get a
 * reading increments the same `#failures`: a snapshot that rejected, a snapshot
 * that returned something we cannot read, and a captain lock the caller could
 * not read are one fact between them, which is that we did not get a reading.
 * Any successful reading resets the count. While the count is above zero the
 * ceiling keeps re-dispatching whether or not anything is currently asserted,
 * because recovery may never depend on a crewmate writing a status line - the
 * crewmate this feature exists for is *stopped* and will write nothing further,
 * so a gate that waits for one is a gate that never opens again.
 *
 * **Do not add a branch that asks which kind of failure it was.** Earlier
 * versions of this had four independent gates plus a suppression path in the
 * caller that skipped the refresh entirely, and each new rule created a state
 * in which another rule could not fire - a reading held with no ceiling on one
 * path, and a reading dropped that then never retried on another. The failure
 * kinds may differ in what they say; they must not differ in what they decide.
 *
 * **Nothing here goes looking for firstmate.** The home is the captain
 * session's own `cwd`, and the captain is identified by `src/firstmate.js` from
 * the lock holding that session's agent pid. A machine without firstmate has no
 * lock, so this is never called, no subprocess runs and nothing is said.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** @typedef {import('./registry.js').Session} Session */

/**
 * The snapshot contract this module was written against.
 *
 * Checked exactly, and the reason is the reconciliation above rather than
 * tidiness. `hints.open_decisions` being *reconciled* is a property of this
 * schema version; a later one could keep the field and move that work
 * elsewhere, and reading it anyway would be asserting on a contract nobody has
 * read. An unrecognised schema is treated as a reading we did not get - the
 * previous answer stands rather than being replaced or cleared.
 */
export const SNAPSHOT_SCHEMA = 'fm-fleet-snapshot.v1';

/** Where the snapshot lives, relative to `$FM_HOME`. */
const SNAPSHOT_SCRIPT = ['bin', 'fm-fleet-snapshot.sh'];

/** Where the status logs live, relative to `$FM_HOME`. */
const STATE_DIR = 'state';

/** What a crewmate's own event log is called. */
const STATUS_SUFFIX = '.status';

/**
 * The floor on how often the snapshot may go out.
 *
 * Tens of seconds because the command takes tens of seconds: a shorter floor
 * would mean a failing or slow snapshot being retried while the last one is
 * still running. The mtime gate is what keeps a steady state free; this is what
 * bounds the un-steady one.
 */
export const REFRESH_MS = 30000;

/**
 * The ceiling on how stale an *assertion* may get - see the header.
 *
 * Reached while decisions are open, and while a run of failures is standing.
 * A healthy fleet with nothing open pays neither, so an idle machine still
 * costs nothing at all.
 */
export const ASSERTION_MAX_AGE_MS = 300000;

/**
 * What the caller passes when it could not tell whether the captain is still
 * there - a lock that is present and would not read.
 *
 * It is neither a home nor `null`, because it is neither "here it is" nor "the
 * captain has gone": it is a reading we did not get, and it is accounted for as
 * exactly that. Passing `null` would clear the rulings on a failed read, and
 * skipping the call altogether - which is what the caller used to do - left the
 * one path where the failure ceiling never applied and the reading was held for
 * as long as the lock stayed unreadable.
 */
export const CAPTAIN_UNREADABLE = Symbol('firstmate captain unreadable');

/**
 * How many refreshes in a row may come back as non-answers before the reading
 * is dropped rather than held.
 *
 * `ASSERTION_MAX_AGE_MS` bounds how stale a *successful* reading may get, and
 * on its own that is only half the rule: it re-dispatches, and a re-dispatch
 * that can never succeed replaces nothing, so the assertion stands for the life
 * of the process while paying a fourteen-second bash to do it. That is the
 * appearance of freshness rather than freshness, which is the quiet staleness
 * this whole product is written against.
 *
 * Three routes get there with the captain still present and all of them are
 * reachable: firstmate bumping `schema`, which `SNAPSHOT_SCHEMA` refuses by
 * design; `bin/fm-fleet-snapshot.sh` renamed or removed by an upgrade; and
 * stdout past `exec.js`'s 1MB cap, which a fleet four to five times the
 * measured 223-224KB reaches.
 *
 * A fourth route reaches it from the caller rather than from the command: a
 * captain lock that is there and will not read. It is the same fact and is
 * counted by the same counter - see `CAPTAIN_UNREADABLE`.
 *
 * Three, because one or two failures must never clear anything - a timeout
 * while the machine is busy is ordinary. Three is at soonest three `REFRESH_MS`
 * apart, so a minute and a half, and at latest three `ASSERTION_MAX_AGE_MS`
 * apart on a fleet writing no status lines, so a quarter of an hour. Any
 * successful read resets it.
 *
 * Dropping the reading does not stop the retry. The count stays where it is, so
 * the ceiling goes on re-dispatching at its own cadence until a reading arrives
 * - a fourteen-second bash every five minutes on a firstmate that is broken for
 * good, which is the price of a stopped crewmate reappearing the moment it can
 * rather than never.
 */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Generous, and deliberately so. The measurements either side of this module
 * being written were 3.5s and 14s, and a snapshot killed halfway is a reading
 * we did not get - which costs the whole cycle rather than failing fast.
 */
const SNAPSHOT_TIMEOUT_MS = 60000;

/**
 * One open decision, exactly as firstmate's fold states it.
 *
 * @typedef {object} Decision
 * @property {string} key the slug the crewmate wrote, which is what a later
 *   `resolved` line closes. Several decisions on one task differ only by this
 * @property {string} verb `needs-decision` or `blocked` - the two that open one
 * @property {string} summary the crewmate's own words, at whatever length it
 *   wrote them
 */

/**
 * One task, in our words - firstmate's `tasks[]` row reduced to the three
 * things a row needs.
 *
 * @typedef {object} DecisionTask
 * @property {string} id firstmate's own id for the task
 * @property {string|null} window the tmux window name behind `endpoint.target`,
 *   which is the name `firstmate.js` already keys crewmates on
 * @property {string|null} worktree the crewmate's checkout, joinable against
 *   `Session.cwd`
 * @property {Decision[]} decisions open decisions, in the order the fold
 *   returns them - most recently opened last
 */

/**
 * firstmate's own schema, kept distinct from ours so the normalising boundary
 * stays visible. Only the fields this module reads are named.
 *
 * @typedef {object} SnapshotTask
 * @property {string} [id]
 * @property {{target?: string}} [endpoint]
 * @property {{worktree?: {path?: string|null}}} [paths]
 * @property {{open_decisions?: unknown[]}} [hints]
 */

/**
 * @typedef {object} DecisionFileAccess
 * @property {(path: string) => string[]} readdir
 * @property {(path: string) => {size: number, mtimeMs: number}} stat
 */

/** @type {DecisionFileAccess} */
export const defaultDecisionAccess = {
  readdir(path) {
    return readdirSync(path);
  },
  stat(path) {
    const info = statSync(path);
    return { size: info.size, mtimeMs: info.mtimeMs };
  },
};

/**
 * The tmux window name inside an `endpoint.target`.
 *
 * The target is tmux's own `<session>:<window>`, and the window half is what
 * `firstmate.js` reads off the pane table. Split on the *first* colon, so a
 * window name containing one survives whole.
 *
 * @param {unknown} target
 * @returns {string|null}
 */
export function windowFromTarget(target) {
  const text = typeof target === 'string' ? target.trim() : '';
  if (!text) return null;
  const colon = text.indexOf(':');
  const window = (colon === -1 ? text : text.slice(colon + 1)).trim();
  return window || null;
}

/**
 * Parse `fm-fleet-snapshot.sh --json`.
 *
 * **`null` and `[]` are different answers and the difference is the whole
 * point.** `null` is a reading we did not get - empty output, JSON that will
 * not parse, a schema we have not read, no `tasks` array - and the caller keeps
 * whatever it had. `[]` is a reading of nothing: firstmate answered and has no
 * tasks, so the decisions genuinely went away and holding the old ones would be
 * the stale alarm this module exists to avoid.
 *
 * A row that does not fit is skipped rather than guessed at, the same
 * deliberately narrow read `lavish.js` gives its own CLI's output.
 *
 * @param {string|null|undefined} out
 * @returns {DecisionTask[]|null}
 */
export function parseSnapshot(out) {
  const text = String(out || '').trim();
  if (!text) return null;
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  if (doc.schema !== SNAPSHOT_SCHEMA) return null;
  if (!Array.isArray(doc.tasks)) return null;

  /** @type {DecisionTask[]} */
  const tasks = [];
  for (const task of /** @type {SnapshotTask[]} */ (doc.tasks)) {
    if (!task || typeof task !== 'object') continue;
    const id = typeof task.id === 'string' ? task.id.trim() : '';
    if (!id) continue;
    const worktree = task.paths?.worktree?.path;
    tasks.push({
      id,
      window: windowFromTarget(task.endpoint?.target),
      worktree: typeof worktree === 'string' && worktree.trim() ? worktree.trim() : null,
      decisions: parseDecisions(task.hints?.open_decisions),
    });
  }
  return tasks;
}

/**
 * @param {unknown} entries
 * @returns {Decision[]}
 */
function parseDecisions(entries) {
  if (!Array.isArray(entries)) return [];
  /** @type {Decision[]} */
  const decisions = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const { key, verb, summary } = /** @type {Record<string, unknown>} */ (entry);
    // The verb is what an entry *is* - the two that open a decision - so an
    // entry without one is not a decision we can name, whatever else it holds.
    if (typeof verb !== 'string' || !verb.trim()) continue;
    decisions.push({
      // A fold with no key still folded something; `default` is the key its own
      // grammar gives an untagged line, so it is the honest stand-in rather
      // than a reason to drop the decision.
      key: typeof key === 'string' && key.trim() ? key.trim() : 'default',
      verb: verb.trim(),
      summary: typeof summary === 'string' ? summary.trim() : '',
    });
  }
  return decisions;
}

export class FirstmateDecisions {
  #execAsync;
  #files;
  /** @type {DecisionTask[]} */
  #tasks = [];
  /** The home the current reading belongs to. */
  #home = null;
  /**
   * The status-file signature the last read went out against, or null when no
   * signature has ever been taken. Compared rather than remembered as a time,
   * because what matters is that a crewmate wrote something, not when.
   */
  #signature = null;
  /** null means never asked, which is not the same as asked long ago. */
  #at = null;
  #reading = false;
  /**
   * How many reads in a row have come back as non-answers, counted only while
   * the home has not moved - a read against a home that has gone was already
   * discarded by `refresh`, and counting it would blame this fleet for the last
   * one's answer.
   */
  #failures = 0;

  /**
   * @param {{execAsync?: Function, files?: DecisionFileAccess}} [deps] the
   *   runner must be asynchronous - this is reachable from the server's poll
   *   loop, and the command takes tens of seconds.
   */
  constructor({ execAsync, files = defaultDecisionAccess } = {}) {
    this.#execAsync = execAsync;
    this.#files = files;
  }

  /** @returns {DecisionTask[]} the last reading, which is what the rows join against */
  get tasks() {
    return this.#tasks;
  }

  /**
   * The `$FM_HOME` the standing reading was taken from, or null.
   *
   * Exposed for exactly one caller and one question. When no captain is found,
   * the monitor has to tell "firstmate has gone" from "we could not read the
   * lock", and the only lock that can settle that is the one at this home - see
   * `FirstmateWatch.lockUnreadableAt`.
   *
   * @returns {string|null}
   */
  get home() {
    return this.#home;
  }

  /**
   * Kick off a snapshot if anything has moved and the minimum interval has
   * passed. Never awaited.
   *
   * The home is the captain session's own `cwd`, so a machine that has never
   * run firstmate never reaches the read at all and never spawns anything.
   *
   * **`null` means the captain is gone, and that clears the reading.** It is
   * not "we did not look": firstmate's lock naming a live session is the entire
   * basis for every decision here, so a reading may not outlive it. Left
   * standing it would go on asserting for the life of the process - the mtime
   * gate has nothing to re-open it with once nobody is writing status lines, so
   * the crewmates' rows would keep saying a ruling is waiting, in the tab title
   * and in a desktop notification, with the tool that said so no longer
   * running. That is exactly the quiet staleness this module is written
   * against. The caller owes us the difference between "no captain" and "no
   * session list to look in" - see the guard on this call in `server.js`.
   *
   * **`CAPTAIN_UNREADABLE` is the third answer**, and it keeps the home it
   * already had. It does not clear and it does not dispatch: it is a reading we
   * did not get, so it goes through the same accounting every other non-answer
   * does, on the same cadence a dispatch would have used. That is what stops it
   * being the one path with no ceiling on it.
   *
   * @param {string|null|typeof CAPTAIN_UNREADABLE} home `$FM_HOME`, null when
   *   there is no captain, or `CAPTAIN_UNREADABLE` when we could not tell
   * @param {number} [now]
   */
  refresh(home, now = Date.now()) {
    if (!this.#execAsync) return;
    const unreadable = home === CAPTAIN_UNREADABLE;
    // One value for "no captain", so an `undefined` from a caller reading an
    // absent field is not a different home from a `null` and does not clear a
    // reading that is already cleared.
    const captainHome = unreadable ? this.#home : /** @type {string|null} */ (home) || null;
    if (captainHome !== this.#home) {
      // A different firstmate, or none at all, is positive evidence that the
      // reading in hand is not ours to keep - the one thing that may clear it
      // outright. Ahead of the in-flight check on purpose: a read that is still
      // walking the old fleet must not be able to put its answer back, which
      // `#read` refuses to do once the home has moved under it.
      this.#home = captainHome;
      this.#signature = null;
      this.#at = null;
      this.#tasks = [];
      // A run of failures is a fact about one fleet's snapshot, so it goes with
      // the reading it would have cleared rather than being carried into the
      // next captain's first read.
      this.#failures = 0;
    }
    if (!captainHome) return;
    if (this.#reading) return;
    const first = this.#at === null;
    if (!first && now - this.#at < REFRESH_MS) return;
    const signature = this.#statusSignature(captainHome);
    // A signature we could not take is not evidence that a status file moved,
    // so it never triggers a read of its own - the same rule the reading itself
    // is held to. It is still recorded when a read does go out, and recording a
    // null is safe in the only direction that matters: the next signature we
    // *can* take differs from it, so the cost is one extra snapshot rather than
    // a gate that stopped opening.
    const moved = signature !== null && signature !== this.#signature;
    // Two states re-take a reading on the ceiling rather than waiting for the
    // mtime gate, and they are one condition because they are one worry: what
    // we have in hand may no longer be true and the gate cannot see it. While
    // asserting, because a decision clears when the crew resumes past it and
    // resuming writes no status line. While failing, because the reading in
    // hand is old and the only thing that could refresh it is another attempt -
    // waiting for a crewmate to write is waiting for the one thing a stopped
    // crewmate will never do.
    const asserting = this.#tasks.some((task) => task.decisions.length > 0);
    const aged =
      (asserting || this.#failures > 0) && !first && now - this.#at >= ASSERTION_MAX_AGE_MS;
    if (!first && !moved && !aged) return;
    // Stamped on every attempt, because it is what the floor and the ceiling
    // are measured from and an attempt is what they bound. The signature is
    // not, and the two part company here on purpose: it records the status
    // files a *reading* covers, so a tick that dispatched nothing has covered
    // nothing and must not consume the evidence. Consuming it swallowed the
    // write that would have opened the gate - a crewmate opening a decision
    // during a two-second lock blip then waited on the five-minute ceiling
    // instead of arriving as soon as the lock read again.
    this.#at = now;
    // The whole of the difference an unreadable captain makes, and it is in
    // what happens rather than in what is decided: there is nothing to run a
    // snapshot against, so the attempt is recorded as the non-answer it is. The
    // gate above, the cadence, the counter and the ceiling are the ones every
    // other failure goes through.
    if (unreadable) {
      this.#recordFailure();
      return;
    }
    this.#signature = signature;
    this.#read(captainHome);
  }

  /**
   * Take one snapshot and wait for it.
   *
   * Only for one-shot commands, where there is no loop to protect and printing
   * before the answer arrives would mean printing a wrong one. The server must
   * never call this - see `LavishState.load`.
   *
   * @param {string|null} home
   * @returns {Promise<void>}
   */
  async load(home) {
    if (!this.#execAsync || !home) return;
    this.#home = home;
    this.#signature = this.#statusSignature(home);
    this.#at = Date.now();
    this.#failures = 0;
    await this.#read(home);
  }

  /**
   * A value that changes when any crewmate writes to its own event log.
   *
   * Name, mtime and size together rather than a newest-mtime: a status file
   * being removed while another is appended to leaves the newest alone, and a
   * signature that misses that is a gate that stops opening.
   *
   * @param {string} home
   * @returns {string|null} null when the directory could not be read
   */
  #statusSignature(home) {
    const dir = join(home, STATE_DIR);
    try {
      const names = this.#files
        .readdir(dir)
        .filter((name) => name.endsWith(STATUS_SUFFIX))
        .sort();
      const parts = [];
      for (const name of names) {
        const info = this.#files.stat(join(dir, name));
        parts.push(`${name}:${info.mtimeMs}:${info.size}`);
      }
      return parts.join('\n');
    } catch {
      return null;
    }
  }

  /**
   * @param {string} home
   * @returns {Promise<void>}
   */
  #read(home) {
    this.#reading = true;
    const script = join(home, ...SNAPSHOT_SCRIPT);
    return Promise.resolve()
      .then(() => this.#execAsync('bash', [script, '--json'], { timeoutMs: SNAPSHOT_TIMEOUT_MS }))
      .then((out) => {
        const tasks = parseSnapshot(out);
        // A reading we did not get is not evidence. firstmate mid-upgrade, a
        // script that is not there, a timeout and output we cannot read all
        // arrive here, and treating any of them as "no decisions" would take
        // every ruling request off the page at once and put them back a minute
        // later.
        //
        // The home is checked as well, because the command takes tens of
        // seconds and the captain can leave while bash is still walking the
        // fleet. Clearing a reading has to mean it stays cleared, or the answer
        // in flight puts it straight back.
        if (home !== this.#home) return;
        if (!tasks) {
          this.#recordFailure();
          return;
        }
        this.#tasks = tasks;
        this.#failures = 0;
      })
      .catch(() => {
        // Same rule, by the other route.
        if (home === this.#home) this.#recordFailure();
      })
      .finally(() => {
        this.#reading = false;
      });
  }

  /**
   * Count one non-answer, and drop the reading once there have been enough.
   *
   * Not evidence, so it never *replaces* the reading with anything - it lets go
   * of it. Holding an assertion open behind a refresh that can never succeed is
   * the appearance of freshness, which is worse than saying nothing at all.
   * See `MAX_CONSECUTIVE_FAILURES` for the number and the routes here.
   *
   * Clamped at the ceiling rather than counting on, which is what makes it safe
   * to call for ever: the reading is dropped exactly once, and the count stays
   * above zero so `refresh` keeps re-taking on the ceiling until one arrives.
   */
  #recordFailure() {
    if (this.#failures >= MAX_CONSECUTIVE_FAILURES) return;
    this.#failures += 1;
    if (this.#failures >= MAX_CONSECUTIVE_FAILURES) this.#tasks = [];
  }
}
