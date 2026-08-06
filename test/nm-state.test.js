import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  NoMistakesState,
  normaliseRun,
  normalisePullRequest,
  newestPullRequests,
  pullRequestNumber,
  currentStep,
  countFindings,
  parseAxiStatus,
  REQUIRED_RUN_COLUMNS,
  REQUIRED_REPO_COLUMNS,
  REQUIRED_STEP_COLUMNS,
} from '../src/nm-state.js';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'nmmon-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Build a database whose schema matches what the queries need, minus whatever
 * a test asks to drop. Column types do not matter to the probe.
 */
function makeDb(dir, { omit = [] } = {}) {
  const path = join(dir, 'state.sqlite');
  const db = new DatabaseSync(path);
  const columns = (table, names) =>
    names.filter((n) => !omit.includes(`${table}.${n}`)).map((n) => `${n} TEXT`).join(', ');
  db.exec(`CREATE TABLE runs (${columns('runs', REQUIRED_RUN_COLUMNS)})`);
  db.exec(`CREATE TABLE repos (${columns('repos', REQUIRED_REPO_COLUMNS)})`);
  db.exec(`CREATE TABLE step_results (${columns('step_results', REQUIRED_STEP_COLUMNS)})`);
  db.close();
  return path;
}

/**
 * A database file that is there and cannot be read.
 *
 * The degraded path is for exactly this, and it has to be built rather than
 * faked with a missing path: a file that is not there means no-mistakes is not
 * installed, which is a different mode with different behaviour.
 */
function unreadableDb(dir) {
  const path = join(dir, 'state.sqlite');
  writeFileSync(path, 'this is not a database');
  return path;
}

/** One run in one repo, enough to tell two databases apart by what they hold. */
function seedRun(path, runId, repoPath) {
  const db = new DatabaseSync(path);
  db.exec(`INSERT INTO repos (id, working_path) VALUES ('p1', '${repoPath}')`);
  db.exec(`INSERT INTO runs (id, repo_id, branch, status) VALUES ('${runId}', 'p1', 'main', 'running')`);
  db.close();
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test('currentStep prefers the running step', () => {
  const steps = [
    { step_name: 'review', status: 'completed' },
    { step_name: 'test', status: 'running' },
    { step_name: 'lint', status: 'pending' },
  ];
  assert.equal(currentStep(steps).step_name, 'test');
});

test('currentStep falls back to the last step that did anything', () => {
  const steps = [
    { step_name: 'review', status: 'completed' },
    { step_name: 'test', status: 'failed' },
    { step_name: 'lint', status: 'pending' },
  ];
  assert.equal(currentStep(steps).step_name, 'test');
});

test('currentStep handles an empty pipeline', () => {
  assert.equal(currentStep([]), null);
  assert.equal(currentStep(undefined), null);
});

test('countFindings copes with both shapes and with rubbish', () => {
  assert.equal(countFindings('[{"id":1},{"id":2}]'), 2);
  assert.equal(countFindings('{"findings":[{"id":1}]}'), 1);
  assert.equal(countFindings('not json'), 0);
  assert.equal(countFindings(null), 0);
});

test('normaliseRun converts unix seconds and flags a parked run', () => {
  const now = 1_700_000_000_000;
  const row = {
    run_id: 'r1',
    repo_path: '/Users/x/work/repo',
    branch: 'feature/x',
    status: 'running',
    awaiting_agent_since: 1_699_999_000,
    pr_url: 'https://example.com/pr/1',
    created_at: 1_699_998_000,
    updated_at: 1_699_999_500,
  };
  const run = normaliseRun(row, [{ step_name: 'review', status: 'running', findings_json: '[{}]' }], now);

  assert.equal(run.repoName, 'repo');
  assert.equal(run.active, true);
  assert.equal(run.parked, true, 'awaiting_agent_since is the gate marker');
  assert.equal(run.parkedSince, 1_699_999_000_000);
  assert.equal(run.parkedForMs, 1_000_000);
  assert.equal(run.step.name, 'review');
  assert.equal(run.step.findings, 1);
});

test('a finished run is never reported as parked', () => {
  // parked_ms and a leftover timestamp can outlive the run itself; only an
  // active run can actually be waiting on a gate.
  const run = normaliseRun(
    {
      run_id: 'r1',
      repo_path: '/repo',
      branch: 'main',
      status: 'completed',
      awaiting_agent_since: 1_699_999_000,
      updated_at: 1_699_999_500,
    },
    [],
  );
  assert.equal(run.active, false);
  assert.equal(run.parked, false);
});

test('normaliseRun tolerates null timestamps', () => {
  const run = normaliseRun(
    { run_id: 'r1', repo_path: '/repo', branch: 'main', status: 'pending', awaiting_agent_since: null },
    [],
  );
  assert.equal(run.parked, false);
  assert.equal(run.parkedSince, null);
  assert.equal(run.updatedAt, null);
});

test('the degraded parser reads a parked run from axi status output', () => {
  const output = `run:
  id: "01KYS6PPHSGRZHBCTZX2F2YZDJ"
  branch: fm/some-branch
  status: running
  awaiting_agent: parked 3m12s
  head: a7a5d70c
  pr: "https://github.com/o/r/pull/22"
`;
  const run = parseAxiStatus(output, '/Users/x/work/repo');
  assert.equal(run.status, 'running');
  assert.equal(run.branch, 'fm/some-branch');
  assert.equal(run.parked, true);
  assert.equal(run.prUrl, 'https://github.com/o/r/pull/22');
  assert.equal(run.degraded, true);
});

test('the degraded parser does not call a finished run parked', () => {
  const output = `run:
  id: "x"
  branch: main
  status: completed
`;
  const run = parseAxiStatus(output, '/repo');
  assert.equal(run.active, false);
  assert.equal(run.parked, false);
});

test('the degraded parser returns null for output it does not understand', () => {
  assert.equal(parseAxiStatus('', '/repo'), null);
  assert.equal(parseAxiStatus('error: not a repo', '/repo'), null);
});

test('pullRequestNumber reads the number off both hosts', () => {
  assert.equal(
    pullRequestNumber('https://bitbucket.org/mattw_watson/hexbattle/pull-requests/39'),
    39,
  );
  assert.equal(pullRequestNumber('https://github.com/mattwwatson/firstmate/pull/22'), 22);
  assert.equal(pullRequestNumber('https://example.com/pr/7/'), 7);
});

test('a URL with no number is still linkable, just unnumbered', () => {
  assert.equal(pullRequestNumber('https://example.com/pulls'), null);
  assert.equal(pullRequestNumber(null), null);
});

test('a pull request is only "live" while the run that owns it is', () => {
  // no-mistakes stops observing a pull request when its run ends, so the state
  // freezes at that moment - every cancelled run in a real database still says
  // "open" days later. `live` is what stops the page presenting that as now.
  const row = {
    pr_url: 'https://example.com/pull/3',
    pr_state: 'open',
    pr_state_observed_at: 1700,
    branch: 'feat/x',
    repo_path: '/repo',
  };
  assert.equal(normalisePullRequest({ ...row, status: 'running' }).live, true);
  assert.equal(normalisePullRequest({ ...row, status: 'cancelled' }).live, false);
  assert.equal(normalisePullRequest({ ...row, status: 'completed' }).live, false);
  // The state itself is reported either way - it is the caller's job to say
  // whether it is current, and the observation time is what lets it.
  assert.equal(normalisePullRequest({ ...row, status: 'cancelled' }).state, 'open');
  assert.equal(normalisePullRequest({ ...row, status: 'cancelled' }).observedAt, 1_700_000);
});

test('newestPullRequests keeps one per branch, the most recent', () => {
  // A branch run through the pipeline repeatedly carries the same PR on every
  // run after the first. The newest sighting has the least stale state.
  const rows = [
    { pr_url: 'https://e.com/pull/9', pr_state: 'open', branch: 'b', repo_path: '/repo', status: 'running' },
    { pr_url: 'https://e.com/pull/9', pr_state: 'none', branch: 'b', repo_path: '/repo', status: 'failed' },
    { pr_url: 'https://e.com/pull/4', pr_state: 'merged', branch: 'a', repo_path: '/repo', status: 'completed' },
  ];
  const prs = newestPullRequests(rows);
  assert.equal(prs.length, 2);
  assert.equal(prs[0].branch, 'b');
  assert.equal(prs[0].state, 'open', 'the newest row won');
  assert.equal(prs[0].live, true);
  assert.equal(prs[1].number, 4);
});

test('newestPullRequests separates branches that share a repo, and repos that share a branch', () => {
  const prs = newestPullRequests([
    { pr_url: 'https://e.com/pull/1', branch: 'main', repo_path: '/one', status: 'completed' },
    { pr_url: 'https://e.com/pull/2', branch: 'main', repo_path: '/two', status: 'completed' },
  ]);
  assert.equal(prs.length, 2);
});

test('newestPullRequests skips rows with nothing to link to', () => {
  assert.deepEqual(newestPullRequests([{ pr_url: null, repo_path: '/r' }, { pr_url: 'u' }]), []);
});

test('a schema with every column the queries read takes the fast path', () => {
  const { dir, cleanup } = scratch();
  try {
    const state = new NoMistakesState({ dbPath: makeDb(dir) });
    assert.deepEqual(state.probe(), { mode: 'sqlite', warning: null });
    state.close();
  } finally {
    cleanup();
  }
});

test('the probe covers every column the queries select, not just the obvious ones', () => {
  // A column that is selected but not probed degrades late and misleadingly,
  // as "Lost the no-mistakes database (no such column: pr_url)" rather than the
  // startup warning that says which build of no-mistakes you are running.
  for (const column of [
    'runs.pr_url',
    'runs.pr_state_observed_at',
    'runs.created_at',
    'repos.working_path',
  ]) {
    const { dir, cleanup } = scratch();
    try {
      const state = new NoMistakesState({ dbPath: makeDb(dir, { omit: [column] }) });
      const probe = state.probe();
      assert.equal(probe.mode, 'cli', column);
      assert.match(probe.warning, new RegExp(column.replace('.', '\\.')));
      state.close();
    } finally {
      cleanup();
    }
  }
});

test('the step_results columns are probed too', () => {
  const { dir, cleanup } = scratch();
  try {
    const state = new NoMistakesState({ dbPath: makeDb(dir, { omit: ['step_results.log_path'] }) });
    const probe = state.probe();
    assert.equal(probe.mode, 'cli');
    assert.match(probe.warning, /step_results\.log_path/);
    state.close();
  } finally {
    cleanup();
  }
});

test('a machine without no-mistakes reports absence, not a broken database', () => {
  // no-mistakes is optional. Reporting its absence as a database that could not
  // be opened sends somebody who never installed it looking for a fault, and
  // `node:sqlite` says only ERR_SQLITE_ERROR for a missing file, so the warning
  // could not even name the real reason.
  const { dir, cleanup } = scratch();
  try {
    const state = new NoMistakesState({ dbPath: join(dir, 'not-there.sqlite') });
    const probe = state.probe();
    assert.equal(probe.mode, 'absent');
    assert.equal(probe.warning, null, 'nothing is wrong, so there is nothing to warn about');

    const read = state.read({ candidateDirs: ['/repo-a'] });
    assert.deepEqual(read.runs, []);
    assert.deepEqual(read.pullRequests, []);
    assert.equal(read.source, 'absent');
    assert.equal(read.warning, null);
    state.close();
  } finally {
    cleanup();
  }
});

test('an absent database never shells out, however often it is read', async () => {
  // The degraded path spawns `no-mistakes axi status` per session directory
  // every fifteen seconds. Doing that forever, for a binary that is not
  // installed, is the cost of confusing "not installed" with "unreadable".
  const { dir, cleanup } = scratch();
  try {
    const state = new NoMistakesState({
      dbPath: join(dir, 'not-there.sqlite'),
      exec: () => assert.fail('no-mistakes is not installed; nothing may run it'),
      execAsync: async () => assert.fail('no-mistakes is not installed; nothing may run it'),
    });
    state.probe();
    for (let i = 0; i < 5; i += 1) state.read({ candidateDirs: ['/repo-a', '/repo-b'] });
    // The blocking one-shot path is the other caller, and is held to the same rule.
    state.read({ candidateDirs: ['/repo-a'], blocking: true });
    await nextTick();
    await nextTick();
    state.close();
  } finally {
    cleanup();
  }
});

test('installing no-mistakes later is picked up without restarting the monitor', () => {
  // The daemon creates the database on first use, which will usually be long
  // after a monitor left running. Deciding "absent" once and for good would
  // leave the page quietly blind to every pipeline until somebody restarted it.
  const { dir, cleanup } = scratch();
  try {
    const state = new NoMistakesState({ dbPath: join(dir, 'state.sqlite') });
    assert.equal(state.probe().mode, 'absent');

    makeDb(dir);
    assert.equal(state.read().source, 'sqlite');
    assert.equal(state.mode, 'sqlite');
    state.close();
  } finally {
    cleanup();
  }
});

test('no-mistakes uninstalled under a running monitor goes quiet, not degraded', () => {
  // Deleting the database is an ordinary thing to do to an optional dependency.
  // Reporting it as a loss - and then shelling out per repo for a CLI that went
  // with it - describes a fault where there is only a choice.
  const { dir, cleanup } = scratch();
  try {
    const path = makeDb(dir);
    const state = new NoMistakesState({
      dbPath: path,
      execAsync: async () => assert.fail('the CLI went with the database'),
    });
    assert.equal(state.probe().mode, 'sqlite');
    assert.equal(state.read().source, 'sqlite');

    unlinkSync(path);
    const read = state.read({ candidateDirs: ['/repo-a'] });
    assert.equal(read.source, 'absent');
    assert.equal(read.warning, null);
    assert.equal(state.warning, null);
    state.close();
  } finally {
    cleanup();
  }
});

test('a half-created database is not mistaken for a version mismatch', () => {
  // The daemon creates state.sqlite and applies its schema a moment later, so a
  // poll landing in between is watching no-mistakes be installed. `PRAGMA
  // table_info` on a table that is not there returns no rows rather than
  // throwing, so every column read as missing and the window rendered as "this
  // build of no-mistakes is newer or older than nmmon expects" - a warning
  // banner, and a spawn per repo every fifteen seconds, both of them forever.
  const { dir, cleanup } = scratch();
  try {
    const path = join(dir, 'state.sqlite');
    writeFileSync(path, '');
    const state = new NoMistakesState({
      dbPath: path,
      exec: () => assert.fail('a database being created is not a reason to shell out'),
      execAsync: async () => assert.fail('a database being created is not a reason to shell out'),
    });
    assert.equal(state.probe().mode, 'absent');
    assert.equal(state.warning, null, 'an installation in progress is not a fault to report');

    const read = state.read({ candidateDirs: ['/repo-a'] });
    assert.equal(read.source, 'absent');
    assert.equal(read.warning, null);

    makeDb(dir);
    assert.equal(state.read({ candidateDirs: ['/repo-a'] }).source, 'sqlite');
    state.close();
  } finally {
    cleanup();
  }
});

test('the per-repo fallback is left again once the schema is one we know', () => {
  // A version mismatch is real and the fallback is right for it, but it must
  // not be a one-way latch: the same reading is what a half-applied schema
  // gives, and upgrading or downgrading no-mistakes is how either one ends.
  const { dir, cleanup } = scratch();
  try {
    const path = makeDb(dir, { omit: ['runs.pr_url'] });
    const state = new NoMistakesState({ dbPath: path, execAsync: async () => '' });
    assert.equal(state.probe().mode, 'cli');
    assert.match(state.warning, /missing runs\.pr_url/);

    const db = new DatabaseSync(path);
    db.exec('ALTER TABLE runs ADD COLUMN pr_url TEXT');
    db.close();

    const read = state.read({ candidateDirs: ['/repo-a'] });
    assert.equal(read.source, 'sqlite');
    assert.equal(read.warning, null, 'the warning goes when the thing it described does');
    state.close();
  } finally {
    cleanup();
  }
});

test('a database replaced at the same path is re-read, not served from the old handle', () => {
  // The daemon replaces the file on update, migration or a restore. Our
  // read-only handle goes on answering from the unlinked inode, and every query
  // succeeds, so nothing further down would ever notice - the page would serve
  // the previous database's runs as current indefinitely.
  const { dir, cleanup } = scratch();
  try {
    const path = makeDb(dir);
    seedRun(path, 'r-old', '/repo-old');
    const state = new NoMistakesState({ dbPath: path });
    assert.equal(state.probe().mode, 'sqlite');
    assert.deepEqual(
      state.read().runs.map((r) => r.runId),
      ['r-old'],
    );

    unlinkSync(path);
    seedRun(makeDb(dir), 'r-new', '/repo-new');

    const read = state.read();
    assert.equal(read.source, 'sqlite');
    assert.deepEqual(
      read.runs.map((r) => r.runId),
      ['r-new'],
    );
    state.close();
  } finally {
    cleanup();
  }
});

test('an unreadable database degrades rather than throwing', () => {
  const { dir, cleanup } = scratch();
  try {
    const state = new NoMistakesState({ dbPath: unreadableDb(dir) });
    assert.equal(state.probe().mode, 'cli');
    state.close();
  } finally {
    cleanup();
  }
});

test('the degraded path never shells out on a server read', async () => {
  // The server reads on a one second timer, on every hook post and on every
  // /state request. A synchronous `no-mistakes axi status` per repo there stalls
  // the poll loop and the event stream, and hook posts give up after two
  // seconds - losing exactly the "waiting for you" signal that matters most.
  const { dir, cleanup } = scratch();
  try {
    const asyncCalls = [];
    const state = new NoMistakesState({
      dbPath: unreadableDb(dir),
      exec: () => assert.fail('the server path must never use the blocking runner'),
      execAsync: async (command, args, options) => {
        asyncCalls.push(options.cwd);
        return `run:\n  id: "r1"\n  branch: main\n  status: running\n`;
      },
    });
    state.probe();

    const first = state.read({ candidateDirs: ['/repo-a'] });
    assert.deepEqual(first.runs, [], 'nothing cached yet, and nothing blocked on');
    assert.equal(first.source, 'cli');

    await nextTick();
    await nextTick();
    assert.deepEqual(asyncCalls, ['/repo-a']);

    const second = state.read({ candidateDirs: ['/repo-a'] });
    assert.equal(second.runs.length, 1);
    assert.equal(second.runs[0].repoPath, '/repo-a');
    state.close();
  } finally {
    cleanup();
  }
});

test('a degraded reading is cached well past the poll interval', async () => {
  const { dir, cleanup } = scratch();
  try {
    let calls = 0;
    const state = new NoMistakesState({
      dbPath: unreadableDb(dir),
      execAsync: async () => {
        calls += 1;
        return `run:\n  id: "r1"\n  branch: main\n  status: running\n`;
      },
    });
    state.probe();
    state.read({ candidateDirs: ['/repo-a'] });
    await nextTick();
    await nextTick();
    assert.equal(calls, 1);

    // A second of poll ticks must not turn into a second of process starts.
    for (let i = 0; i < 5; i += 1) state.read({ candidateDirs: ['/repo-a'] });
    await nextTick();
    assert.equal(calls, 1);

    // Once it is stale, one refresh - and the caller still does not wait.
    state.read({ candidateDirs: ['/repo-a'], now: Date.now() + 60_000 });
    await nextTick();
    await nextTick();
    assert.equal(calls, 2);
    state.close();
  } finally {
    cleanup();
  }
});

test('a one-shot command may still block for the degraded reading', () => {
  const { dir, cleanup } = scratch();
  try {
    const calls = [];
    const state = new NoMistakesState({
      dbPath: unreadableDb(dir),
      exec: (command, args, options) => {
        calls.push(options.cwd);
        return `run:\n  id: "r1"\n  branch: main\n  status: running\n`;
      },
      execAsync: async () => assert.fail('blocking reads should not also refresh'),
    });
    state.probe();
    const { runs } = state.read({ candidateDirs: ['/repo-a'], blocking: true });
    assert.deepEqual(calls, ['/repo-a']);
    assert.equal(runs.length, 1);
    state.close();
  } finally {
    cleanup();
  }
});

test('a repo whose CLI call fails is skipped, not fatal', async () => {
  const { dir, cleanup } = scratch();
  try {
    const state = new NoMistakesState({
      dbPath: unreadableDb(dir),
      execAsync: async (command, args, options) => {
        if (options.cwd === '/broken') throw new Error('no-mistakes: not a repo');
        return `run:\n  id: "r1"\n  branch: main\n  status: running\n`;
      },
    });
    state.probe();
    state.read({ candidateDirs: ['/broken', '/repo-a'] });
    await nextTick();
    await nextTick();
    await nextTick();
    const { runs } = state.read({ candidateDirs: ['/broken', '/repo-a'] });
    assert.deepEqual(
      runs.map((r) => r.repoPath),
      ['/repo-a'],
    );
    state.close();
  } finally {
    cleanup();
  }
});
