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
  matchPullRequest,
  transcriptPullRequest,
  matchRunForAgentCwd,
  isIdleNudge,
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

test('a block is cleared once the transcript has carried on past it', () => {
  // Notification fires and then nothing does until Stop, so granting a
  // permission prompt leaves "Waiting for you" showing for the rest of the
  // turn. Observed live: blocked for 185s while the transcript was 3s old.
  assert.equal(
    attentionFor({
      session: { state: 'blocked', stateSince: 1000 },
      run: null,
      summary: { lastActivityAt: 60000 },
    }),
    'working',
  );
});

test('a genuine permission prompt is not cleared by its own arrival', () => {
  // The Notification hook and the tool call that triggered it are written at
  // almost the same moment, in no guaranteed order.
  for (const lastActivityAt of [999, 1000, 1001, 3999]) {
    assert.equal(
      attentionFor({
        session: { state: 'blocked', stateSince: 1000 },
        run: null,
        summary: { lastActivityAt },
      }),
      'blocked',
      `lastActivityAt ${lastActivityAt}`,
    );
  }
});

test('an unreadable transcript leaves the hooks answer standing', () => {
  // The transcript may only ever clear a block, never assert one. A session
  // with no readable transcript keeps whatever the hooks last said.
  assert.equal(
    attentionFor({ session: { state: 'blocked', stateSince: 1000 }, run: null, summary: null }),
    'blocked',
  );
  assert.equal(
    attentionFor({
      session: { state: 'blocked', stateSince: 1000 },
      run: null,
      summary: { lastActivityAt: null },
    }),
    'blocked',
  );
});

test('a disproved block still yields to a live review', () => {
  assert.equal(
    attentionFor({
      session: { state: 'blocked', stateSince: 1000 },
      run: null,
      summary: { lastActivityAt: 60000, lavishFile: '/p.html' },
    }),
    'review',
  );
});

test('a disproved block drops the stale permission message and timer', () => {
  const rows = buildRows({
    sessions: [session({ state: 'blocked', stateSince: 1000, message: 'Claude needs your permission' })],
    runs: [],
    now: 90000,
    summaries: new Map([['s1', { lastActivityAt: 60000 }]]),
  });
  assert.equal(rows[0].attention, 'working');
  assert.equal(rows[0].message, null, 'a granted prompt must not keep asking');
  assert.equal(rows[0].sessionState, 'working');
  assert.equal(rows[0].waitingForMs, null);
});

test('a session waiting on a Lavish review outranks a parked pipeline', () => {
  // The hooks see a busy session, because the waiting happens inside a
  // subprocess. It is really a human gate, so it has to outrank one that the
  // agent will usually answer for itself.
  assert.equal(
    attentionFor({
      session: { state: 'working' },
      run: run({ parked: true }),
      summary: { lavishFile: '/repo/.lavish/plan.html' },
    }),
    'review',
  );
});

test('an outright permission prompt still beats a pending review', () => {
  assert.equal(
    attentionFor({
      session: { state: 'blocked' },
      run: null,
      summary: { lavishFile: '/repo/.lavish/plan.html' },
    }),
    'blocked',
  );
});

test('a run with no session is never a review, whatever the summary says', () => {
  // Reviews belong to sessions. A run-only row has no transcript behind it.
  assert.equal(
    attentionFor({ session: null, run: run(), summary: { lavishFile: '/x.html' } }),
    'working',
  );
});

test('buildRows carries the transcript summary onto a working row', () => {
  const rows = buildRows({
    sessions: [session({ state: 'working' })],
    runs: [],
    now: 5000,
    summaries: new Map([
      ['s1', { title: 'favicon-and-summaries', mode: 'plan', activity: 'Running npm', lavishFile: null }],
    ]),
  });
  assert.equal(rows[0].summary, 'favicon-and-summaries');
  assert.equal(rows[0].activity, 'Running npm');
  assert.equal(rows[0].mode, 'plan');
  assert.equal(rows[0].attention, 'working');
});

test('a review row carries the link and drops the tool it is blocked in', () => {
  // "Running lavish-axi" beside "Waiting on your review" reads as work in
  // progress, which is the exact impression this state exists to correct.
  const rows = buildRows({
    sessions: [session({ state: 'working' })],
    runs: [],
    now: 5000,
    summaries: new Map([
      ['s1', { title: 'terrain-sea-ramp', mode: null, activity: 'Running lavish-axi', lavishFile: '/p.html' }],
    ]),
    reviewUrls: new Map([['s1', 'http://127.0.0.1:4387/session/abc']]),
  });
  assert.equal(rows[0].attention, 'review');
  assert.equal(rows[0].summary, 'terrain-sea-ramp');
  assert.equal(rows[0].reviewUrl, 'http://127.0.0.1:4387/session/abc');
  assert.equal(rows[0].activity, null);
});

test('the pipeline step wins over the transcript title as the summary', () => {
  // The step says what is being done to the repo; the title says what the
  // conversation is about. When there is a pipeline, the step is the answer.
  const rows = buildRows({
    sessions: [session()],
    runs: [run({ step: { name: 'test' } })],
    now: 5000,
    summaries: new Map([['s1', { title: 'some-conversation', mode: null, activity: null, lavishFile: null }]]),
  });
  assert.equal(rows[0].summary, 'step test');
});

test('normal mode is not worth saying, so it is not carried', () => {
  const rows = buildRows({
    sessions: [session()],
    runs: [],
    now: 5000,
    summaries: new Map([['s1', { title: 't', mode: 'normal', activity: null, lavishFile: null }]]),
  });
  assert.equal(rows[0].mode, null);
});

test('buildRows works with no summaries at all', () => {
  // Transcripts are best-effort: a session started before the hooks, or one
  // whose transcript has been cleaned up, must still produce a row.
  const rows = buildRows({ sessions: [session()], runs: [], now: 5000 });
  assert.equal(rows[0].summary, null);
  assert.equal(rows[0].activity, null);
  assert.equal(rows[0].reviewUrl, null);
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
    { attention: 'review' },
    { attention: 'parked' },
    { attention: 'idle' },
  ];
  assert.deepEqual(summarise(rows), { blocked: 2, review: 1, parked: 1, failed: 0, total: 5 });
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

test('two sessions in one registered repo keep the repo name, subdirectory or not', () => {
  // Both rows are titled after the run's repo, so growing the session's own
  // directory would retitle the subpackage one "packages/api" and lose the
  // repo name entirely. The path the title came from is the repo, and it is
  // the same repo, so there is nothing to grow.
  const rows = buildRows({
    sessions: [
      session({ sessionId: 's1', cwd: '/Users/x/work/repo/packages/api' }),
      session({ sessionId: 's2', cwd: '/Users/x/work/repo' }),
    ],
    runs: [run()],
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

// ------------------------------------------------------------- pull requests

const pr = (over = {}) => ({
  url: 'https://example.com/pull/7',
  number: 7,
  state: 'open',
  observedAt: 1000,
  branch: 'feat/x',
  repoPath: '/Users/x/work/repo',
  live: false,
  ...over,
});

test('matchPullRequest finds the one open on this branch', () => {
  assert.equal(matchPullRequest('/Users/x/work/repo/src', 'feat/x', [pr()])?.number, 7);
});

test('a pull request on another branch is not this row"s', () => {
  // Sending someone to the wrong review is worse than sending them to none.
  // A repo accumulates one PR per branch, so path alone cannot be the match.
  assert.equal(matchPullRequest('/Users/x/work/repo', 'feat/other', [pr()]), null);
});

test('a row with no branch gets no pull request rather than a guess', () => {
  assert.equal(matchPullRequest('/Users/x/work/repo', null, [pr()]), null);
});

test('matchPullRequest does not match a sibling directory with a shared prefix', () => {
  assert.equal(matchPullRequest('/Users/x/work/repo-other', 'feat/x', [pr()]), null);
});

test('matchPullRequest prefers the most specific repo for nested worktrees', () => {
  const prs = [
    pr({ number: 1, repoPath: '/Users/x/work/repo' }),
    pr({ number: 2, repoPath: '/Users/x/work/repo/projects/thing' }),
  ];
  assert.equal(matchPullRequest('/Users/x/work/repo/projects/thing/src', 'feat/x', prs)?.number, 2);
});

test('a session keeps its pull request after the run that opened it has gone', () => {
  // The whole point: a run is interesting for half an hour, and the review it
  // opened is what you are waiting on for the rest of the day.
  const rows = buildRows({
    sessions: [session({ cwd: '/Users/x/work/repo' })],
    runs: [],
    branches: new Map([['s1', 'feat/x']]),
    pullRequests: [pr()],
  });
  assert.equal(rows[0].pr.number, 7);
  assert.equal(rows[0].pr.live, false, 'and it is honest that the state is a past reading');
});

test('the branch comes from the checkout, not from whichever run happened to match', () => {
  // A run's branch belongs to a pipeline that may have finished on a branch
  // since left behind. The checkout is the truth about where the session is.
  const rows = buildRows({
    sessions: [session()],
    runs: [run({ branch: 'old-branch' })],
    branches: new Map([['s1', 'feat/current']]),
  });
  assert.equal(rows[0].branch, 'feat/current');
});

test('the run"s branch is the fallback when .git could not be read', () => {
  const rows = buildRows({ sessions: [session()], runs: [run({ branch: 'from-run' })] });
  assert.equal(rows[0].branch, 'from-run');
});

test('a live run"s own pull request wins, and is reported as current', () => {
  const rows = buildRows({
    sessions: [session()],
    runs: [run({ active: true, prUrl: 'https://example.com/pull/9', prState: 'open' })],
    branches: new Map([['s1', 'main']]),
  });
  assert.equal(rows[0].pr.number, 9);
  assert.equal(rows[0].pr.live, true);
});

test('lastActivityAt reaches the row from the transcript', () => {
  const rows = buildRows({
    sessions: [session()],
    runs: [],
    summaries: new Map([['s1', { title: 't', mode: null, activity: null, lavishFile: null, lastActivityAt: 4242 }]]),
  });
  assert.equal(rows[0].lastActivityAt, 4242);
});

test('a run with no session behind it reports its own clock', () => {
  const rows = buildRows({ sessions: [], runs: [run({ updatedAt: 777 })] });
  assert.equal(rows[0].lastActivityAt, 777);
});

const seen = (over = {}) => ({
  pullRequest: {
    url: 'https://bitbucket.org/mattw_watson/repo/pull-requests/40',
    number: 40,
    slug: 'repo',
    state: 'open',
    observedAt: 5000,
    ...over,
  },
});

test('a pull request the transcript reported is attributed to its own checkout', () => {
  // The case the database cannot cover: opened by hand, or on a branch
  // no-mistakes has never run. The session printed the URL itself.
  const pr = transcriptPullRequest(seen(), '/Users/x/work/repo', 'feat/x');
  assert.equal(pr.number, 40);
  assert.equal(pr.branch, 'feat/x');
  assert.equal(pr.live, false, 'nothing is watching it, so the state is not current');
});

test("a pull request in some other project is not this row's", () => {
  // A session reviewing or reading about another repo's PR mentions URLs that
  // have nothing to do with the branch in front of it.
  assert.equal(transcriptPullRequest(seen(), '/Users/x/work/something-else', 'feat/x'), null);
  assert.equal(transcriptPullRequest(seen({ slug: null }), '/Users/x/work/repo', 'feat/x'), null);
  assert.equal(transcriptPullRequest(null, '/Users/x/work/repo', 'feat/x'), null);
});

test('the repository match ignores case but nothing else', () => {
  assert.ok(transcriptPullRequest(seen({ slug: 'REPO' }), '/Users/x/work/repo', 'main'));
  assert.equal(transcriptPullRequest(seen({ slug: 'repo-two' }), '/Users/x/work/repo', 'main'), null);
});

test('the database beats the transcript when it has a branch-matched answer', () => {
  // The database entry is verified against the branch; the transcript sighting
  // is only verified against the repo. Both being present should be rare.
  const rows = buildRows({
    sessions: [session({ cwd: '/Users/x/work/repo' })],
    runs: [],
    branches: new Map([['s1', 'feat/x']]),
    pullRequests: [pr({ number: 7 })],
    summaries: new Map([['s1', seen()]]),
  });
  assert.equal(rows[0].pr.number, 7);
});

test('the transcript fills the gap when the database has nothing for this branch', () => {
  const rows = buildRows({
    sessions: [session({ cwd: '/Users/x/work/repo' })],
    runs: [],
    branches: new Map([['s1', 'feat/unrun']]),
    pullRequests: [],
    summaries: new Map([['s1', seen()]]),
  });
  assert.equal(rows[0].pr.number, 40);
});

// ------------------------------------------------- the pipeline's own agent

/** Where no-mistakes actually puts a run's worktree, verbatim in shape. */
const AGENT_CWD = '/Users/mattw/.no-mistakes/worktrees/aa033f35a573/01KZ31SSP3F8GV2AH86S135JFW';
const agentRun = (over = {}) =>
  run({ runId: '01KZ31SSP3F8GV2AH86S135JFW', repoPath: '/Users/x/work/repo', ...over });

test('matchRunForAgentCwd ties an agent worktree back to its run', () => {
  assert.equal(matchRunForAgentCwd(AGENT_CWD, [agentRun()])?.runId, '01KZ31SSP3F8GV2AH86S135JFW');
  assert.equal(matchRunForAgentCwd(`${AGENT_CWD}/src/game`, [agentRun()])?.runId, '01KZ31SSP3F8GV2AH86S135JFW');
});

test('the run id has to be a whole path segment, not a substring of one', () => {
  // Matching loosely would eventually claim a real directory of someone's.
  assert.equal(matchRunForAgentCwd('/Users/x/work/01KZ31SSP3F8GV2AH86S135JFW-notes', [agentRun()]), null);
  assert.equal(matchRunForAgentCwd('/Users/x/work/repo', [agentRun()]), null);
  assert.equal(matchRunForAgentCwd(null, [agentRun()]), null);
});

test("the pipeline's agent does not get a row of its own", () => {
  // It used to arrive as a card titled with the bare run id, looking like an
  // unrelated repo nobody had heard of - and one you could never act on.
  const rows = buildRows({
    sessions: [
      session({ sessionId: 'human', cwd: '/Users/x/work/repo' }),
      session({ sessionId: 'agent', cwd: AGENT_CWD }),
    ],
    runs: [agentRun()],
    summaries: new Map([
      ['agent', { title: 'Review the terrain change', activity: 'Reading terrain.ts', mode: null, lavishFile: null, lastActivityAt: 9000, pullRequest: null }],
    ]),
  });
  assert.equal(rows.length, 1, 'one row per repo, never two');
  assert.equal(rows[0].sessionId, 'human');
  assert.equal(rows[0].agent.activity, 'Reading terrain.ts');
});

test('a blocked pipeline agent still reaches you, on the repo row', () => {
  // Folding the agent in must not swallow the one signal the tool exists for:
  // an agent on a permission prompt has stalled the pipeline, and only a human
  // can free it.
  const rows = buildRows({
    sessions: [
      session({ sessionId: 'human', cwd: '/Users/x/work/repo', state: 'working' }),
      session({ sessionId: 'agent', cwd: AGENT_CWD, state: 'blocked', message: 'Needs permission to push' }),
    ],
    runs: [agentRun()],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attention, 'blocked');
  assert.equal(rows[0].message, 'Needs permission to push');
});

test('the agent lands on the run row when nobody else is in that repo', () => {
  const rows = buildRows({
    sessions: [session({ sessionId: 'agent', cwd: AGENT_CWD })],
    runs: [agentRun()],
    summaries: new Map([
      ['agent', { title: null, activity: 'Running npm', mode: null, lavishFile: null, lastActivityAt: 9000, pullRequest: null }],
    ]),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'run');
  assert.equal(rows[0].agent.activity, 'Running npm');
  assert.equal(rows[0].lastActivityAt, 9000, "the agent's transcript beats the run's own clock");
});

test('an ordinary session is never mistaken for a pipeline agent', () => {
  const rows = buildRows({
    sessions: [session({ sessionId: 'human', cwd: '/Users/x/work/repo' })],
    runs: [agentRun()],
  });
  assert.equal(rows[0].sessionId, 'human');
  assert.equal(rows[0].agent, null);
});

test('the agent marker does not blink out between two tool calls', () => {
  // `activity` is the tool with no result yet, so it is null every time one
  // call finishes before the next begins - most seconds, on a busy agent.
  // Rendering on it made the marker flash in and out several times a minute,
  // which on a pinned page reads as the pipeline starting and stopping.
  const between = new Map([
    ['agent', { title: null, activity: null, mode: null, lavishFile: null, lastActivityAt: 9000, pullRequest: null }],
  ]);
  const rows = buildRows({
    sessions: [
      session({ sessionId: 'human', cwd: '/Users/x/work/repo' }),
      session({ sessionId: 'agent', cwd: AGENT_CWD }),
    ],
    runs: [agentRun()],
    summaries: between,
  });
  assert.ok(rows[0].agent, 'the agent is still there between tools');
  assert.equal(rows[0].agent.what, 'working', 'and still has something to say');
});

test('the agent marker prefers the live tool, then the title', () => {
  const build = (summary) =>
    buildRows({
      sessions: [session({ sessionId: 'agent', cwd: AGENT_CWD })],
      runs: [agentRun()],
      summaries: new Map([['agent', summary]]),
    })[0].agent.what;

  const base = { mode: null, lavishFile: null, lastActivityAt: 1, pullRequest: null };
  assert.equal(build({ ...base, activity: 'Reading terrain.ts', title: 'Review the change' }), 'Reading terrain.ts');
  assert.equal(build({ ...base, activity: null, title: 'Review the change' }), 'Review the change');
  assert.equal(build({ ...base, activity: null, title: null }), 'working');
});

// -------------------------------------------- a running pipeline is not idle

test('isIdleNudge tells the sixty-second nudge from a permission prompt', () => {
  assert.equal(isIdleNudge('Claude is waiting for your input'), true);
  assert.equal(isIdleNudge('Claude needs your permission to use Bash'), false);
  // Fails closed: anything unrecognised stays a hard block, so a reworded
  // notification costs a stale row rather than a swallowed permission prompt.
  assert.equal(isIdleNudge(null), false);
  assert.equal(isIdleNudge(''), false);
});

test('a running pipeline disproves "Claude is waiting for your input"', () => {
  // Claude Code backgrounds the command past its ten minute timeout, the turn
  // ends, and sixty seconds later it fires the idle notification - so the page
  // summoned you to a session whose work was very much still going. Observed
  // live for two minutes while `no-mistakes axi respond` was running.
  const blocked = session({
    state: 'blocked',
    stateSince: 5000,
    message: 'Claude is waiting for your input',
  });
  const [row] = buildRows({
    sessions: [blocked],
    runs: [],
    now: 6000,
    pipelines: new Set(['s1']),
  });
  assert.equal(row.attention, 'working');
  assert.equal(row.message, null, 'and it stops asking for you');
  assert.equal(row.waitingForMs, null, 'and the waiting timer stops');
});

test('a running pipeline does NOT clear a real permission prompt', () => {
  // A permission prompt stops everything until a human answers, whether or not
  // something else is churning in the background. Clearing it would swallow
  // the one signal this tool exists to give.
  const [row] = buildRows({
    sessions: [
      session({ state: 'blocked', stateSince: 5000, message: 'Claude needs your permission to use Bash' }),
    ],
    runs: [],
    now: 6000,
    pipelines: new Set(['s1']),
  });
  assert.equal(row.attention, 'blocked');
  assert.equal(row.message, 'Claude needs your permission to use Bash');
});

test('with no pipeline running, the idle nudge still means you', () => {
  // The escalation from a quiet Stop to a loud "waiting for you" is deliberate:
  // it is how a finished session asks for its next instruction.
  const [row] = buildRows({
    sessions: [
      session({ state: 'blocked', stateSince: 5000, message: 'Claude is waiting for your input' }),
    ],
    runs: [],
    now: 6000,
  });
  assert.equal(row.attention, 'blocked');
});
