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

/** How far back terminal runs stay visible, so you see what just finished. */
const RECENT_WINDOW_MS = 30 * 60 * 1000;

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
   * @returns {{runs: Run[], source: string, warning: string|null}}
   */
  read({ candidateDirs = [], now = Date.now(), blocking = false } = {}) {
    if (this.#mode === 'unknown') this.probe();
    if (this.#mode === 'sqlite') {
      try {
        return { runs: this.#readFromDb(now), source: 'sqlite', warning: this.#warning };
      } catch (err) {
        // The daemon may have replaced the file underneath us (update,
        // migration). Reopen once before giving up on the fast path.
        this.#close();
        try {
          return { runs: this.#readFromDb(now), source: 'sqlite', warning: this.#warning };
        } catch {
          this.#mode = 'cli';
          this.#warning = `Lost the no-mistakes database (${err.code || err.message}); reading repos individually.`;
        }
      }
    }
    return {
      runs: this.#cliRuns(candidateDirs, now, blocking),
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
