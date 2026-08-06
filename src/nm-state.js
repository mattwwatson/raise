/**
 * Reading no-mistakes pipeline state.
 *
 * no-mistakes runs one daemon and one SQLite database per machine, shared by
 * every repo it has been initialised in. That means the whole fleet of runs is
 * a single query - we never shell out per repo on the happy path.
 *
 * The schema is internal to no-mistakes, so we probe for the columns we depend
 * on before trusting them. If a future version renames them we degrade to
 * parsing `no-mistakes axi status` per repo rather than reporting confident
 * nonsense - and re-probe on every read, so an upgrade that restores a schema
 * we know puts us back on the fast path without a restart.
 *
 * **no-mistakes is optional, and its absence is not a degraded state.** nmmon's
 * other three sources - the hooks, the transcript and the process table - are
 * complete without it, so a machine that has never installed no-mistakes gets a
 * working monitor with no pipeline rows and, importantly, no warning: there is
 * nothing wrong to report. That is what `absent` mode is for, and it is decided
 * by the database file simply not being there.
 *
 * Distinguishing it from `cli` matters twice over. A warning saying the
 * database could not be opened describes a broken installation, and printing it
 * to somebody who does not use no-mistakes at all sends them looking for a
 * fault that does not exist. And the `cli` fallback shells out to
 * `no-mistakes axi status` once per session directory every fifteen seconds -
 * a process spawn per repo, forever, for a binary that is not installed.
 *
 * A database that is there but carries no schema yet belongs on the same side
 * of that line: the daemon creates the file on first use and applies its tables
 * a moment later, and a poll landing in between is watching no-mistakes be
 * installed, not a version of it we cannot read. So `absent` covers it too, and
 * the only thing ever remembered between reads is `sqlite`.
 */

import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * A joined row of the no-mistakes `runs` and `repos` tables, exactly as it comes
 * out of SQLite. Snake-cased and in unix *seconds*, unlike everything downstream
 * of `normaliseRun`. Every field is loosely typed because this schema belongs to
 * no-mistakes, not to us - see the probe above.
 *
 * @typedef {object} RunRow
 * @property {string} run_id
 * @property {string} repo_path
 * @property {string|null} branch
 * @property {string} status
 * @property {number|null} awaiting_agent_since
 * @property {string|null} pr_url
 * @property {string|null} pr_state
 * @property {number|null} pr_state_observed_at
 * @property {number|null} updated_at
 * @property {number|null} created_at
 */

/**
 * A pull request no-mistakes opened, outliving the run that opened it.
 *
 * Kept separate from `Run` because its lifetime is different: a run is
 * interesting for half an hour after it stops, and the pull request it opened
 * is interesting until it is merged, which may be days later.
 *
 * `current` is the load-bearing field, and it answers one question: may `state`
 * be presented as the state *now*? Two things have to hold, and they are not
 * the same thing.
 *
 * The run that owns it has to still be going. no-mistakes stops observing a
 * pull request the moment its run reaches a terminal state - so `state` is
 * frozen at whatever it was when the run ended, and every cancelled run in a
 * real database still says `open`, days after the fact.
 *
 * And the reading itself has to be recent. This half was missing, and it is the
 * bug RAI-10 reports: the field used to be called `live` and meant only "the
 * run is still going", which is a fact about the *run* being read as a fact
 * about the *reading*. The two come apart whenever the CI monitor stops
 * observing without the run stopping - a daemon restart while a run sits in the
 * `ci` step is enough, and did happen. See `PR_STATE_FRESH_MS`.
 *
 * Linking to a stale pull request is fine, and the link is kept in every case.
 * Asserting a stale *state* is the quiet staleness this tool exists to avoid.
 *
 * @typedef {object} PullRequest
 * @property {string} url
 * @property {number|null} number parsed from the URL, null if it has no tail
 * @property {string|null} state no-mistakes' word: open, merged, closed, none
 * @property {number|null} observedAt epoch ms the state was last checked
 * @property {string|null} branch the branch it was opened from
 * @property {string} repoPath
 * @property {boolean} current whether `state` may be presented as the state
 *   now: the run is still going *and* the reading is fresh
 */

/**
 * A row of `step_results`, same caveats as `RunRow`.
 *
 * @typedef {object} StepRow
 * @property {string} run_id
 * @property {string} step_name
 * @property {string} status
 * @property {string|null} [findings_json]
 * @property {string|null} [last_activity]
 * @property {number|null} [last_activity_at]
 * @property {string|null} [log_path]
 */

/**
 * The step a run is currently on, or was last on.
 *
 * @typedef {object} RunStep
 * @property {string} name
 * @property {string} status
 * @property {number} findings how many the step reported, 0 when it reported none
 * @property {string|null} lastActivity
 * @property {number|null} lastActivityAt epoch ms
 * @property {string|null} logPath
 */

/**
 * One no-mistakes pipeline run, normalised out of the database (or, in degraded
 * mode, out of `no-mistakes axi status`).
 *
 * Timestamps are epoch **milliseconds** here; no-mistakes stores seconds, and
 * the conversion happens once, in `normaliseRun`.
 *
 * @typedef {object} Run
 * @property {string} runId
 * @property {string} repoPath
 * @property {string} repoName the basename of `repoPath`
 * @property {string|null} branch
 * @property {string} status the raw no-mistakes status
 * @property {boolean} active whether `status` is one of ACTIVE_STATUSES
 * @property {boolean} parked stopped at a gate, waiting to be answered
 * @property {number|null} parkedSince epoch ms
 * @property {number|null} parkedForMs
 * @property {string|null} prUrl
 * @property {string|null} prState
 * @property {number|null} prStateObservedAt epoch ms the pull request state was
 *   last checked, which is not `updatedAt` - see `PR_STATE_FRESH_MS`
 * @property {number|null} updatedAt epoch ms
 * @property {number|null} createdAt epoch ms
 * @property {RunStep|null} step
 * @property {boolean} [degraded] set only on the `axi status` fallback path
 */

/**
 * Every column the queries below touch. The probe and the queries have to stay
 * in step: a column that is selected but not probed degrades late, as a query
 * error reported as "lost the database", rather than at startup with the
 * accurate "this build of no-mistakes is not the one nmmon expects".
 *
 * The rule that keeps them in step is that nothing is selected unless it is
 * read, and everything that is read is listed here.
 */
export const REQUIRED_RUN_COLUMNS = [
  'id',
  'repo_id',
  'branch',
  'status',
  'awaiting_agent_since',
  'created_at',
  'updated_at',
  'pr_url',
  'pr_state',
  'pr_state_observed_at',
];

export const REQUIRED_REPO_COLUMNS = ['id', 'working_path'];

export const REQUIRED_STEP_COLUMNS = [
  'run_id',
  'step_name',
  'status',
  'step_order',
  'findings_json',
  'last_activity',
  'last_activity_at',
  'log_path',
];

const ACTIVE_STATUSES = ['pending', 'running'];

const RUNS_QUERY = `
  SELECT
    r.id            AS run_id,
    r.branch        AS branch,
    r.status        AS status,
    r.awaiting_agent_since AS awaiting_agent_since,
    r.pr_url        AS pr_url,
    r.pr_state      AS pr_state,
    r.pr_state_observed_at AS pr_state_observed_at,
    r.created_at    AS created_at,
    r.updated_at    AS updated_at,
    p.working_path  AS repo_path
  FROM runs r
  JOIN repos p ON p.id = r.repo_id
  WHERE r.status IN (?, ?)
     OR r.updated_at >= ?
  ORDER BY r.created_at DESC
`;

/**
 * The step a run is sitting on. We want the running step if there is one,
 * otherwise the most recently touched step, so a parked run still reports
 * which gate parked it.
 */
const STEPS_QUERY = `
  SELECT run_id, step_name, status, findings_json,
         last_activity, last_activity_at, log_path, step_order
  FROM step_results
  WHERE run_id IN (SELECT id FROM runs WHERE status IN (?, ?) OR updated_at >= ?)
  ORDER BY step_order ASC
`;

/**
 * Every pull request recent enough to still be worth linking to.
 *
 * Deliberately not filtered by run status or by the recency window the runs
 * query uses. A pull request outlives its run by design: the run finishes in
 * minutes, and the review it opened is what you are waiting on for the rest of
 * the day. Tying the link to the run meant it vanished half an hour after the
 * pipeline finished, which is roughly when it started being useful.
 *
 * Bounded by a date floor and a row cap rather than by cleverness - the newest
 * per branch is picked in JavaScript, because SQLite's bare-column-with-MAX
 * trick is subtle enough to be a liability in a query we only run once a poll.
 */
const PULL_REQUESTS_QUERY = `
  SELECT
    r.pr_url        AS pr_url,
    r.pr_state      AS pr_state,
    r.pr_state_observed_at AS pr_state_observed_at,
    r.branch        AS branch,
    r.status        AS status,
    r.updated_at    AS updated_at,
    p.working_path  AS repo_path
  FROM runs r
  JOIN repos p ON p.id = r.repo_id
  WHERE r.pr_url IS NOT NULL
    AND r.updated_at >= ?
  ORDER BY r.updated_at DESC
  LIMIT 200
`;

/** How far back terminal runs stay visible, so you see what just finished. */
const RECENT_WINDOW_MS = 30 * 60 * 1000;

/**
 * How long a pull request stays linkable. Long enough to cover a review that
 * has been sitting for a week, short enough that the query never walks the
 * whole history of every repo on the machine.
 */
const PR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How old a pull request state reading may be and still be shown as the state
 * *now*. Tuned against no-mistakes' observation cadence, so it is one of the
 * constants AGENTS.md asks to be flagged when changed.
 *
 * **Measured, not chosen.** no-mistakes writes `pr_state` and
 * `pr_state_observed_at` in one statement on every poll of its `ci` step, not
 * only when the state changes - across 46 runs still recorded as `open`, the
 * observation is up to 45 hours later than the `pr` step that opened the pull
 * request, so it is genuinely re-observed rather than stamped once. The cadence
 * comes from the 43 runs whose last write was a cancel or a failure, which
 * samples "time since the last observation" without bias: median 64s, and a
 * maximum of **112s**. Five minutes is 2.7x that worst case, so the chip never
 * blinks out during a healthy run.
 *
 * What it catches is observation stopping without the *run* stopping, which is
 * the case `live` alone could not see. Two runs in the same database were last
 * observed at the same second - 2026-07-22T13:45:13Z, a daemon restart - and
 * then sat in the `ci` step, status `running`, for a further **7h23m** carrying
 * a frozen `open`. That window is unbounded, and it is what put a confident
 * `OPEN` chip over a merged pull request.
 *
 * What it deliberately does *not* fix: the gap between a merge happening and
 * no-mistakes noticing it, which is the cadence itself - up to ~2 minutes of
 * honestly-fresh, honestly-wrong `open`. Closing that means asking the forge,
 * which is RAI-13 and needs credentials this does not.
 */
export const PR_STATE_FRESH_MS = 5 * 60 * 1000;

/**
 * How long a degraded-mode reading stays good for.
 *
 * Far longer than the one second database poll on purpose. Shelling out to
 * `no-mistakes axi status` costs a process start per repo, so refreshing it at
 * poll speed would spend the whole second doing it. State that is up to fifteen
 * seconds old is a fair price for a fallback that was never the fast path.
 */
const CLI_CACHE_MS = 15000;

/** Whether the file is a database carrying any schema at all - see `#tableCount`. */
const TABLE_COUNT_QUERY = `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'`;

/**
 * Which file a handle was opened against. Identity, not a path: the daemon
 * replaces the database on update or migration, and a path cannot tell you that
 * happened.
 *
 * @typedef {object} DbFile
 * @property {number} dev
 * @property {number} ino
 */

/**
 * @param {string} path
 * @returns {DbFile|null} null when there is no file there at all
 */
function dbFile(path) {
  try {
    const stat = statSync(path);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

/**
 * @param {DbFile|null} a
 * @param {DbFile|null} b
 * @returns {boolean} true only when both are the same file on the same device
 */
function sameFile(a, b) {
  return Boolean(a && b) && a.dev === b.dev && a.ino === b.ino;
}

export class NoMistakesState {
  #dbPath;
  #db = null;
  #file = null;
  #mode = 'unknown';
  #warning = null;
  #exec;
  #execAsync;
  #closed = false;
  #cliCache = { runs: [], key: null, at: 0 };
  #refreshing = false;

  /**
   * @param {object} options
   * @param {string} options.dbPath  path to no-mistakes state.sqlite
   * @param {Function} [options.exec] injected command runner for the degraded
   *   path, so tests never shell out. Signature: (cmd, args, opts) => string
   * @param {Function} [options.execAsync] the same, without blocking. Required
   *   for non-blocking reads; the server always passes it.
   */
  constructor({ dbPath, exec, execAsync }) {
    this.#dbPath = dbPath;
    this.#exec = exec;
    this.#execAsync = execAsync;
  }

  get mode() {
    return this.#mode;
  }

  get warning() {
    return this.#warning;
  }

  /**
   * Decide whether the fast path is usable, against the file that is there
   * right now. Always opens a fresh handle, so a probe is also how the reader
   * moves onto a replaced database.
   *
   * The file-not-there check comes first and deliberately does not open
   * anything. `node:sqlite` reports a missing file as a generic
   * `ERR_SQLITE_ERROR`, so the error the fallback path would report says
   * nothing about the one thing worth knowing - that no-mistakes is simply not
   * installed here.
   *
   * @returns {{mode: string, warning: string|null}}
   */
  probe() {
    this.#close();
    this.#file = dbFile(this.#dbPath);
    if (!this.#file) {
      this.#mode = 'absent';
      this.#warning = null;
      return { mode: this.#mode, warning: this.#warning };
    }
    try {
      this.#open();
      if (this.#tableCount() === 0) {
        this.#mode = 'absent';
        this.#warning = null;
        this.#close();
        return { mode: this.#mode, warning: this.#warning };
      }
      const runCols = this.#columns('runs');
      const repoCols = this.#columns('repos');
      const stepCols = this.#columns('step_results');
      const missing = [
        ...REQUIRED_RUN_COLUMNS.filter((c) => !runCols.includes(c)).map((c) => `runs.${c}`),
        ...REQUIRED_REPO_COLUMNS.filter((c) => !repoCols.includes(c)).map((c) => `repos.${c}`),
        ...REQUIRED_STEP_COLUMNS.filter((c) => !stepCols.includes(c)).map((c) => `step_results.${c}`),
      ];
      if (missing.length > 0) {
        this.#mode = 'cli';
        this.#warning =
          `no-mistakes database is missing ${missing.join(', ')}. ` +
          'This build of no-mistakes is newer or older than nmmon expects, so pipeline ' +
          'state is being read the slow way instead. Everything still works, but only ' +
          'repos with a live Claude session are covered.';
        this.#close();
      } else {
        this.#mode = 'sqlite';
        this.#warning = null;
      }
    } catch (err) {
      this.#mode = 'cli';
      this.#warning =
        `Could not open the no-mistakes database (${err.code || err.message}). ` +
        'Falling back to reading each repo individually.';
      this.#close();
    }
    return { mode: this.#mode, warning: this.#warning };
  }

  /**
   * @param {object} options
   * @param {string[]} [options.candidateDirs] directories to inspect when the
   *   database is unavailable. Ignored on the fast path.
   * @param {number} [options.now]
   * @param {boolean} [options.blocking] allow the degraded path to shell out
   *   inline. Only ever true for one-shot commands; a long-lived server must
   *   leave this alone so a hung CLI cannot stall the poll loop.
   * @returns {{runs: Run[], pullRequests: PullRequest[], source: string,
   *            warning: string|null}}
   */
  read({ candidateDirs = [], now = Date.now(), blocking = false } = {}) {
    // Only `sqlite` is ever remembered, and only for as long as the handle
    // still points at the file it was decided about. One `stat` per read buys
    // all of that.
    //
    // A read-only handle keeps answering happily from an unlinked inode, so
    // nothing else can tell us the database was deleted (an uninstall) or
    // swapped for another one (an update, a migration, a restore) - and in both
    // cases we would go on serving a dead file's frozen runs as current, which
    // is precisely the quiet staleness this tool exists to avoid. Identity, not
    // existence, is what closes the second of those.
    //
    // Every other mode is re-decided from scratch, because none of them may
    // latch. `absent` must not, or a monitor left running would stay blind to a
    // no-mistakes installed under it - the daemon creates the database on first
    // use. `cli` must not either: a half-applied schema and a genuine version
    // mismatch are indistinguishable at the moment of probing, and only the
    // first one fixes itself a moment later. Re-probing costs an open and three
    // PRAGMAs against a path we are already spawning a process per repo for.
    if (this.#mode !== 'sqlite' || !sameFile(dbFile(this.#dbPath), this.#file)) {
      this.probe();
    }
    if (this.#mode === 'absent') {
      return { runs: [], pullRequests: [], source: 'absent', warning: null };
    }
    if (this.#mode === 'sqlite') {
      const fromDb = () => ({
        runs: this.#readFromDb(now),
        pullRequests: this.#readPullRequestsFromDb(now),
        source: 'sqlite',
        warning: this.#warning,
      });
      try {
        return fromDb();
      } catch (err) {
        // The daemon may have replaced the file underneath us (update,
        // migration). Reopen once before giving up on the fast path.
        this.#close();
        try {
          return fromDb();
        } catch {
          this.#mode = 'cli';
          this.#warning = `Lost the no-mistakes database (${err.code || err.message}); reading repos individually.`;
        }
      }
    }
    // The degraded path has no history to draw on - `axi status` reports the
    // current run and nothing else - so a run it finds still carries its own
    // `prUrl`, but there are no older pull requests to outlive it.
    return {
      runs: this.#cliRuns(candidateDirs, now, blocking),
      pullRequests: [],
      source: 'cli',
      warning: this.#warning,
    };
  }

  close() {
    this.#closed = true;
    this.#close();
  }

  // ---------------------------------------------------------------- internals

  #open() {
    if (this.#db) return this.#db;
    // Read-only so we can never corrupt or lock the daemon's database.
    this.#db = new DatabaseSync(this.#dbPath, { readOnly: true });
    return this.#db;
  }

  #close() {
    try {
      this.#db?.close();
    } catch {
      // Already gone; nothing to do.
    }
    this.#db = null;
  }

  /**
   * How many tables the database has at all.
   *
   * `PRAGMA table_info` on a table that is not there returns no rows rather
   * than throwing, so a file the daemon has created and not yet applied its
   * schema to reads as one whose every column has been renamed - reported as a
   * version mismatch, with the warning banner and the per-repo spawns that go
   * with it. Nothing distinguishes the two at the moment of probing, so the
   * empty case is treated as not-yet-installed and settled by the next read.
   */
  #tableCount() {
    const row = this.#open().prepare(TABLE_COUNT_QUERY).get();
    return Number(row?.n ?? 0);
  }

  #columns(table) {
    return this.#open()
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name);
  }

  #readFromDb(now) {
    const db = this.#open();
    const cutoffSeconds = Math.floor((now - RECENT_WINDOW_MS) / 1000);
    const rows = db.prepare(RUNS_QUERY).all(...ACTIVE_STATUSES, cutoffSeconds);
    const steps = db.prepare(STEPS_QUERY).all(...ACTIVE_STATUSES, cutoffSeconds);
    const stepsByRun = groupSteps(steps);
    return rows.map((row) => normaliseRun(row, stepsByRun.get(row.run_id), now));
  }

  #readPullRequestsFromDb(now) {
    const floorSeconds = Math.floor((now - PR_WINDOW_MS) / 1000);
    return newestPullRequests(this.#open().prepare(PULL_REQUESTS_QUERY).all(floorSeconds), now);
  }

  /**
   * The degraded path, served from cache.
   *
   * A caller that can afford to wait (the one-shot CLI) fills the cache inline.
   * A caller that cannot (the server) gets whatever is cached and triggers a
   * background refresh, so no amount of slowness in `no-mistakes axi status`
   * can delay a poll tick, a broadcast, or a hook post.
   */
  #cliRuns(candidateDirs, now, blocking) {
    const key = candidateDirs.join('\n');
    if (candidateDirs.length === 0) return [];
    if (this.#cliCache.key === key && now - this.#cliCache.at < CLI_CACHE_MS) {
      return this.#cliCache.runs;
    }
    if (blocking) {
      const runs = this.#readFromCli(candidateDirs);
      this.#cliCache = { runs, key, at: now };
      return runs;
    }
    this.#refreshCli(candidateDirs, key);
    return this.#cliCache.runs;
  }

  #refreshCli(candidateDirs, key) {
    if (this.#refreshing || this.#closed || !this.#execAsync) return;
    this.#refreshing = true;
    (async () => {
      const runs = [];
      for (const dir of candidateDirs) {
        if (this.#closed) return;
        let out;
        try {
          out = await this.#execAsync('no-mistakes', ['axi', 'status'], { cwd: dir, timeoutMs: 5000 });
        } catch {
          continue; // Not a no-mistakes repo, or the CLI is unavailable here.
        }
        const parsed = parseAxiStatus(out, dir);
        if (parsed) runs.push(parsed);
      }
      this.#cliCache = { runs, key, at: Date.now() };
    })()
      .catch(() => {
        // A degraded reading we could not take is not worth reporting; the
        // warning already says state is being read the slow way.
      })
      .finally(() => {
        this.#refreshing = false;
      });
  }

  #readFromCli(candidateDirs) {
    if (!this.#exec) return [];
    const runs = [];
    for (const dir of candidateDirs) {
      let out;
      try {
        out = this.#exec('no-mistakes', ['axi', 'status'], { cwd: dir, timeoutMs: 5000 });
      } catch {
        continue; // Not a no-mistakes repo, or the CLI is unavailable here.
      }
      const parsed = parseAxiStatus(out, dir);
      if (parsed) runs.push(parsed);
    }
    return runs;
  }
}

/**
 * @param {StepRow[]} steps
 * @returns {Map<string, StepRow[]>} steps in order, keyed by run id
 */
export function groupSteps(steps) {
  /** @type {Map<string, StepRow[]>} */
  const byRun = new Map();
  for (const step of steps) {
    if (!byRun.has(step.run_id)) byRun.set(step.run_id, []);
    byRun.get(step.run_id).push(step);
  }
  return byRun;
}

/**
 * Pick the step that best describes where a run is right now: the running one,
 * else the last one that did anything.
 *
 * @param {StepRow[]} [steps]
 * @returns {StepRow|null}
 */
export function currentStep(steps = []) {
  if (steps.length === 0) return null;
  const running = steps.find((s) => s.status === 'running');
  if (running) return running;
  const touched = steps.filter((s) => s.status !== 'pending');
  return touched.length > 0 ? touched[touched.length - 1] : steps[0];
}

export function countFindings(findingsJson) {
  if (!findingsJson) return 0;
  try {
    const parsed = JSON.parse(findingsJson);
    if (Array.isArray(parsed)) return parsed.length;
    if (Array.isArray(parsed?.findings)) return parsed.findings.length;
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Shape one database row into the record the rest of the app speaks.
 *
 * @param {RunRow} row
 * @param {StepRow[]} steps that run's steps, in order
 * @param {number} [now]
 * @returns {Run}
 */
export function normaliseRun(row, steps, now = Date.now()) {
  const step = currentStep(steps);
  // no-mistakes stores unix seconds. A non-null awaiting_agent_since is the
  // authoritative "parked at a gate, waiting to be answered" marker.
  const awaitingSince = row.awaiting_agent_since ? row.awaiting_agent_since * 1000 : null;
  const isActive = ACTIVE_STATUSES.includes(row.status);
  return {
    runId: row.run_id,
    repoPath: row.repo_path,
    repoName: basename(row.repo_path || ''),
    branch: row.branch,
    status: row.status,
    active: isActive,
    parked: Boolean(awaitingSince) && isActive,
    parkedSince: awaitingSince,
    parkedForMs: awaitingSince ? now - awaitingSince : null,
    prUrl: row.pr_url || null,
    prState: row.pr_state || null,
    prStateObservedAt: row.pr_state_observed_at ? row.pr_state_observed_at * 1000 : null,
    updatedAt: row.updated_at ? row.updated_at * 1000 : null,
    createdAt: row.created_at ? row.created_at * 1000 : null,
    step: step
      ? {
          name: step.step_name,
          status: step.status,
          findings: countFindings(step.findings_json),
          lastActivity: step.last_activity || null,
          lastActivityAt: step.last_activity_at ? step.last_activity_at * 1000 : null,
          logPath: step.log_path || null,
        }
      : null,
  };
}

/**
 * The number a pull request URL ends in.
 *
 * Both hosts put it last - Bitbucket's `/pull-requests/37` and GitHub's
 * `/pull/22` - so the last path segment is the whole rule, and anything that
 * does not end in one simply has no number. A URL is still perfectly linkable
 * without it; only the label loses a detail.
 *
 * @param {string|null} url
 * @returns {number|null}
 */
export function pullRequestNumber(url) {
  const match = String(url || '').match(/\/(\d+)\/?(?:[?#].*)?$/);
  return match ? Number(match[1]) : null;
}

/**
 * A row of `PULL_REQUESTS_QUERY`, in no-mistakes' own snake case and seconds.
 * Same caveats as `RunRow`: this schema belongs to no-mistakes, not to us.
 *
 * @typedef {object} PullRequestRow
 * @property {string} pr_url
 * @property {string|null} [pr_state]
 * @property {number|null} [pr_state_observed_at]
 * @property {string|null} [branch]
 * @property {string} [status]
 * @property {string} repo_path
 */

/**
 * Whether a pull request state reading may be presented as the state now.
 *
 * Both halves are required and they fail closed together: a run that has ended
 * is no longer observing, and a reading nobody has refreshed is not an answer
 * about now however alive the run is. A reading that never happened - the
 * degraded `axi status` path has none to offer, and an older no-mistakes may
 * leave the column null - is not current either. Showing the state word is a
 * claim, so the absence of evidence has to read as no.
 *
 * @param {string|null|undefined} status the run's raw no-mistakes status
 * @param {number|null} observedAt epoch ms the state was last checked
 * @param {number} now
 * @returns {boolean}
 */
export function prStateIsCurrent(status, observedAt, now) {
  if (!ACTIVE_STATUSES.includes(String(status))) return false;
  if (!observedAt) return false;
  return now - observedAt <= PR_STATE_FRESH_MS;
}

/**
 * Shape one row of the pull request query.
 *
 * @param {PullRequestRow} row
 * @param {number} [now]
 * @returns {PullRequest}
 */
export function normalisePullRequest(row, now = Date.now()) {
  const observedAt = row.pr_state_observed_at ? Number(row.pr_state_observed_at) * 1000 : null;
  return {
    url: row.pr_url,
    number: pullRequestNumber(row.pr_url),
    state: row.pr_state || null,
    observedAt,
    branch: row.branch || null,
    repoPath: row.repo_path,
    current: prStateIsCurrent(row.status, observedAt, now),
  };
}

/**
 * One pull request per repo and branch: the most recent.
 *
 * A branch can be run through the pipeline many times, and every run after the
 * first carries the same pull request URL. Rows arrive newest first, so the
 * first sighting of a branch is the one to keep - and it is the one whose
 * `state` is least out of date.
 *
 * @param {PullRequestRow[]} rows newest first, as `PULL_REQUESTS_QUERY` returns
 * @param {number} [now]
 * @returns {PullRequest[]}
 */
export function newestPullRequests(rows, now = Date.now()) {
  /** @type {Map<string, PullRequest>} */
  const byBranch = new Map();
  for (const row of rows) {
    if (!row?.pr_url || !row.repo_path) continue;
    const key = `${row.repo_path}\n${row.branch || ''}`;
    if (byBranch.has(key)) continue;
    byBranch.set(key, normalisePullRequest(row, now));
  }
  return [...byBranch.values()];
}

/**
 * Degraded-mode parser for `no-mistakes axi status` TOON output.
 *
 * Deliberately narrow: it reads only the handful of fields the dashboard needs
 * and treats anything it cannot find as absent. This path exists so an
 * unexpected no-mistakes version degrades instead of breaking.
 *
 * @param {string} out
 * @param {string} repoPath
 * @returns {Run|null}
 */
export function parseAxiStatus(out, repoPath) {
  if (!out || !/^\s*run:/m.test(out)) return null;
  const field = (name) => {
    const match = out.match(new RegExp(`^\\s*${name}:\\s*"?([^"\\n]*)"?\\s*$`, 'm'));
    return match ? match[1].trim() : null;
  };
  const status = field('status');
  if (!status) return null;
  const parked = /awaiting_agent:\s*parked/.test(out) || /^\s*gate:/m.test(out);
  const active = ACTIVE_STATUSES.includes(status);
  return {
    runId: field('id') || `${repoPath}:${field('branch') || 'unknown'}`,
    repoPath,
    repoName: basename(repoPath),
    branch: field('branch'),
    status,
    active,
    parked: parked && active,
    parkedSince: null,
    parkedForMs: null,
    prUrl: field('pr'),
    prState: null,
    // `axi status` reports no state and therefore no observation of one. Both
    // stay null rather than borrowing the run's clock, which is what let a
    // proxy pass for an observation in the first place.
    prStateObservedAt: null,
    updatedAt: null,
    createdAt: null,
    step: null,
    degraded: true,
  };
}
