import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  matchRunForCwd,
  attentionFor,
  buildRows,
  summarise,
  sortRows,
  disambiguateTitles,
  shortestUniqueTitles,
} from '../src/dashboard.js';

const run = (over = {}) => ({
  runId: 'r1',
  repoPath: '/Users/x/work/repo',
  repoName: 'repo',
  branch: 'main',
  status: 'running',
  active: true,
  parked: false,
  parkedSince: null,
  updatedAt: 1000,
  step: null,
  ...over,
});

const session = (over = {}) => ({
  sessionId: 's1',
  cwd: '/Users/x/work/repo',
  state: 'working',
  host: { tty: '/dev/ttys004' },
  updatedAt: 1000,
  ...over,
});

test('matchRunForCwd matches a session running inside the repo', () => {
  const runs = [run()];
  assert.equal(matchRunForCwd('/Users/x/work/repo/src', runs)?.runId, 'r1');
  assert.equal(matchRunForCwd('/Users/x/work/repo', runs)?.runId, 'r1');
});

test('matchRunForCwd does not match a sibling directory with a shared prefix', () => {
  const runs = [run({ repoPath: '/Users/x/work/repo' })];
  assert.equal(matchRunForCwd('/Users/x/work/repo-other', runs), null);
});

test('matchRunForCwd prefers the most specific repo for nested worktrees', () => {
  // no-mistakes registers worktrees as their own repos, so the outer repo and
  // the worktree can both be candidates. The worktree must win.
  const runs = [
    run({ runId: 'outer', repoPath: '/Users/x/work/repo' }),
    run({ runId: 'worktree', repoPath: '/Users/x/work/repo/projects/thing' }),
  ];
  assert.equal(matchRunForCwd('/Users/x/work/repo/projects/thing/src', runs)?.runId, 'worktree');
});

test('matchRunForCwd prefers a parked run over a finished one in the same repo', () => {
  const runs = [
    run({ runId: 'old', active: false, status: 'completed', updatedAt: 500 }),
    run({ runId: 'parked', parked: true, updatedAt: 400 }),
  ];
  assert.equal(matchRunForCwd('/Users/x/work/repo', runs)?.runId, 'parked');
});

test('a blocked session outranks everything, including a parked pipeline', () => {
  // This is the whole point of the tool: "Claude wants a human" beats
  // "the pipeline paused and will probably answer itself".
  assert.equal(attentionFor({ session: { state: 'blocked' }, run: run({ parked: true }) }), 'blocked');
});

test('attentionFor covers the remaining states', () => {
  assert.equal(attentionFor({ session: { state: 'idle' }, run: run({ parked: true }) }), 'parked');
  assert.equal(
    attentionFor({ session: null, run: run({ active: false, status: 'failed' }) }),
    'failed',
  );
  assert.equal(attentionFor({ session: { state: 'idle' }, run: run() }), 'working');
  assert.equal(attentionFor({ session: { state: 'idle' }, run: null }), 'idle');
  assert.equal(
    attentionFor({ session: null, run: run({ active: false, status: 'completed' }) }),
    'done',
  );
});

test('buildRows joins sessions to runs and marks focusability', () => {
  const rows = buildRows({
    sessions: [session()],
    runs: [run({ branch: 'feature/x' })],
    now: 5000,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'session');
  assert.equal(rows[0].branch, 'feature/x');
  assert.equal(rows[0].focusable, true);
  assert.equal(rows[0].hostKind, 'tab');
});

test('buildRows marks a session with no window identity as not focusable', () => {
  const rows = buildRows({ sessions: [session({ host: {} })], runs: [], now: 5000 });
  assert.equal(rows[0].focusable, false);
});

test('buildRows tags a tmux-hosted session', () => {
  const rows = buildRows({
    sessions: [session({ host: { tmux_pane: '%2' } })],
    runs: [],
    now: 5000,
  });
  assert.equal(rows[0].hostKind, 'tmux');
});

test('buildRows shows an unattached run but never offers to focus it', () => {
  const rows = buildRows({ sessions: [], runs: [run({ repoPath: '/elsewhere' })], now: 5000 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'run');
  assert.equal(rows[0].focusable, false);
});

test('buildRows hides old finished runs but keeps active ones', () => {
  const now = 10_000_000_000;
  const rows = buildRows({
    sessions: [],
    runs: [
      run({ runId: 'stale', active: false, status: 'completed', updatedAt: now - 60 * 60 * 1000 }),
      run({ runId: 'live', active: true, updatedAt: now - 1000 }),
    ],
    now,
  });
  assert.deepEqual(
    rows.map((r) => r.run.runId),
    ['live'],
  );
});

test('buildRows does not duplicate a run that a session already claimed', () => {
  const rows = buildRows({ sessions: [session()], runs: [run()], now: 5000 });
  assert.equal(rows.length, 1);
});

test('rows sort by urgency, then by recency', () => {
  const rows = sortRows([
    { attention: 'idle', updatedAt: 100 },
    { attention: 'blocked', updatedAt: 1 },
    { attention: 'parked', updatedAt: 50 },
    { attention: 'idle', updatedAt: 300 },
  ]);
  assert.deepEqual(
    rows.map((r) => r.attention),
    ['blocked', 'parked', 'idle', 'idle'],
  );
  assert.equal(rows[2].updatedAt, 300);
});

test('summarise counts what the tab title and alerts need', () => {
  const rows = [
    { attention: 'blocked' },
    { attention: 'blocked' },
    { attention: 'parked' },
    { attention: 'idle' },
  ];
  assert.deepEqual(summarise(rows), { blocked: 2, parked: 1, failed: 0, total: 4 });
});

test('a lone repo keeps its bare name', () => {
  const rows = buildRows({ sessions: [session()], runs: [], now: 5000 });
  assert.equal(rows[0].title, 'repo');
});

test('two checkouts of the same repo are told apart by their parent directory', () => {
  // The real case this exists for: a repo and a worktree copy of it both
  // render as one word, and the page becomes a guessing game.
  const rows = buildRows({
    sessions: [
      session({ sessionId: 's1', cwd: '/Users/x/work/hexbattle' }),
      session({ sessionId: 's2', cwd: '/Users/x/.treehouse/hexbattle-04b649/2/hexbattle' }),
    ],
    runs: [],
    now: 5000,
  });
  assert.deepEqual(
    rows.map((r) => r.title).sort(),
    ['2/hexbattle', 'work/hexbattle'],
  );
});

test('sessions sharing a directory keep one name - a longer path cannot separate them', () => {
  const rows = buildRows({
    sessions: [
      session({ sessionId: 's1', cwd: '/Users/x/work/repo' }),
      session({ sessionId: 's2', cwd: '/Users/x/work/repo', state: 'blocked' }),
    ],
    runs: [],
    now: 5000,
  });
  assert.deepEqual(
    rows.map((r) => r.title),
    ['repo', 'repo'],
  );
});

test('a run row is disambiguated against a session row in a different checkout', () => {
  const rows = buildRows({
    sessions: [session({ cwd: '/Users/x/work/repo' })],
    runs: [
      run({ runId: 'r1', repoPath: '/Users/x/work/repo' }),
      run({ runId: 'r2', repoPath: '/Users/x/scratch/repo', repoName: 'repo' }),
    ],
    now: 5000,
  });
  assert.deepEqual(
    rows.map((r) => r.title).sort(),
    ['scratch/repo', 'work/repo'],
  );
});

test('each path gets only the depth it needs, not the deepest any of them needed', () => {
  // "a/thing" is unique with one parent, so it must not be dragged out to three
  // segments just because the other two collide until then.
  const titles = shortestUniqueTitles([
    '/root/a/thing',
    '/root/one/shared/thing',
    '/root/two/shared/thing',
  ]);
  assert.equal(titles.get('/root/a/thing'), 'a/thing');
  assert.equal(titles.get('/root/one/shared/thing'), 'one/shared/thing');
  assert.equal(titles.get('/root/two/shared/thing'), 'two/shared/thing');
});

test('a path with nothing left to add is taken as final rather than looping', () => {
  const titles = shortestUniqueTitles(['/shared/thing', '/root/shared/thing']);
  assert.equal(titles.get('/shared/thing'), 'shared/thing');
  assert.equal(titles.get('/root/shared/thing'), 'root/shared/thing');
});

test('disambiguateTitles leaves rows alone when nothing collides', () => {
  const rows = [
    { id: 'a', cwd: '/Users/x/work/one', title: 'one' },
    { id: 'b', cwd: '/Users/x/work/two', title: 'two' },
  ];
  assert.equal(disambiguateTitles(rows), rows, 'the same array, not a rebuilt copy');
});

test('disambiguateTitles ignores rows with no directory to extend', () => {
  const rows = disambiguateTitles([
    { id: 'a', cwd: null, title: 'unknown' },
    { id: 'b', cwd: null, title: 'unknown' },
  ]);
  assert.deepEqual(
    rows.map((r) => r.title),
    ['unknown', 'unknown'],
  );
});

test('waiting time is measured from when the session became blocked', () => {
  const rows = buildRows({
    sessions: [session({ state: 'blocked', stateSince: 4000 })],
    runs: [],
    now: 10_000,
  });
  assert.equal(rows[0].waitingForMs, 6000);
});
