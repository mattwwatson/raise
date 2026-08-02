import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  NoMistakesState,
  normaliseRun,
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
    head_sha: 'abcdef1234567890',
    created_at: 1_699_998_000,
    updated_at: 1_699_999_500,
    error: null,
  };
  const run = normaliseRun(row, [{ step_name: 'review', status: 'running', findings_json: '[{}]' }], now);

  assert.equal(run.repoName, 'repo');
  assert.equal(run.active, true);
  assert.equal(run.parked, true, 'awaiting_agent_since is the gate marker');
  assert.equal(run.parkedSince, 1_699_999_000_000);
  assert.equal(run.parkedForMs, 1_000_000);
  assert.equal(run.headSha, 'abcdef12');
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
  for (const column of ['runs.pr_url', 'runs.head_sha', 'runs.created_at', 'repos.working_path']) {
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

test('an unreadable database degrades rather than throwing', () => {
  const { dir, cleanup } = scratch();
  try {
    const state = new NoMistakesState({ dbPath: join(dir, 'not-there.sqlite') });
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
      dbPath: join(dir, 'not-there.sqlite'),
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
      dbPath: join(dir, 'not-there.sqlite'),
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
      dbPath: join(dir, 'not-there.sqlite'),
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
      dbPath: join(dir, 'not-there.sqlite'),
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
