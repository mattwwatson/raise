/**
 * Reading no-mistakes pipeline state.
 *
 * no-mistakes runs one daemon and one SQLite database per machine, shared by
 * every repo it has been initialised in. That means the whole fleet of runs is
 * a single query - we never shell out per repo on the happy path.
 *
 * The schema is internal to no-mistakes, so we probe for the columns we depend
 * on at startup. If a future version renames them we degrade to parsing
 * `no-mistakes axi status` per repo rather than reporting confident nonsense.
 */

import { DatabaseSync } from 'node:sqlite';
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
 * @property {string|null} head_sha
 * @property {string|null} error
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
 * `live` is the load-bearing field. no-mistakes stops observing a pull request
 * the moment its run reaches a terminal state - `pr_state_observed_at` never
 * advances past `updated_at` - so `state` is frozen at whatever it was when the
 * run ended. Every cancelled run in a real database still says `open`, days
 * after the fact. The state may therefore only be presented as current while
 * `live` is true; otherwise it is a historical reading and has to be shown as
 * one, or not at all. Linking to a stale PR is fine. Asserting a stale *state*
 * is the quiet staleness this tool exists to avoid.
 *
 * @typedef {object} PullRequest
 * @property {string} url
 * @property {number|null} number parsed from the URL, null if it has no tail
 * @property {string|null} state no-mistakes' word: open, merged, closed, none
 * @property {number|null} observedAt epoch ms the state was last checked
 * @property {string|null} branch the branch it was opened from
 * @property {string} repoPath
 * @property {boolean} live whether the run that owns it is still going, which
 *   is the only condition under which `state` can be trusted as current
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
 * @property {string|null} headSha abbreviated to 8 characters
 * @property {string|null} error
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
  'head_sha',
  'error',
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
    r.head_sha      AS head_sha,
    r.error         AS error,
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
 * How long a degraded-mode reading stays good for.
 *
 * Far longer than the one second database poll on purpose. Shelling out to
 * `no-mistakes axi status` costs a process start per repo, so refreshing it at
 * poll speed would spend the whole second doing it. State that is up to fifteen
 * seconds old is a fair price for a fallback that was never the fast path.
 */
const CLI_CACHE_MS = 15000;

export class NoMistakesState {
  #dbPath;
  #db = null;
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
   * Decide once, at startup, whether the fast path is usable.
   * @returns {{mode: string, warning: string|null}}
   */
  probe() {
    try {
      this.#open();
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
    if (this.#mode === 'unknown') this.probe();
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
    return newestPullRequests(this.#open().prepare(PULL_REQUESTS_QUERY).all(floorSeconds));
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
    headSha: row.head_sha ? String(row.head_sha).slice(0, 8) : null,
    error: row.error || null,
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
 * Shape one row of the pull request query.
 *
 * @param {PullRequestRow} row
 * @returns {PullRequest}
 */
export function normalisePullRequest(row) {
  return {
    url: row.pr_url,
    number: pullRequestNumber(row.pr_url),
    state: row.pr_state || null,
    observedAt: row.pr_state_observed_at ? Number(row.pr_state_observed_at) * 1000 : null,
    branch: row.branch || null,
    repoPath: row.repo_path,
    live: ACTIVE_STATUSES.includes(row.status),
  };
}

/**
 * One pull request per repo and branch: the most recent.
 *
 * A branch can be run through the pipeline many times, and every run after the
 * first carries the same pull request URL. Rows arrive newest first, so the
 * first sighting of a branch is the one to keep - and it is the one whose
 * `live` and `state` are least out of date.
 *
 * @param {PullRequestRow[]} rows newest first, as `PULL_REQUESTS_QUERY` returns
 * @returns {PullRequest[]}
 */
export function newestPullRequests(rows) {
  /** @type {Map<string, PullRequest>} */
  const byBranch = new Map();
  for (const row of rows) {
    if (!row?.pr_url || !row.repo_path) continue;
    const key = `${row.repo_path}\n${row.branch || ''}`;
    if (byBranch.has(key)) continue;
    byBranch.set(key, normalisePullRequest(row));
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
    headSha: field('head'),
    error: field('error'),
    updatedAt: null,
    createdAt: null,
    step: null,
    degraded: true,
  };
}
