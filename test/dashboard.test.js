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
import { pullRequestFromRecords } from '../src/transcript.js';

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

/**
 * `buildRows` with every session on `main`, which is `run()`'s branch too.
 *
 * A run is matched on the branch now, so a session with no branch is matched to
 * nothing - correct, and noise in the many cases here that are about something
 * else entirely. Pass `branches` explicitly to override, including with an empty
 * map when the point *is* a checkout whose branch could not be read.
 */
const build = (input) =>
  buildRows({
    branches: new Map((input.sessions || []).map((s) => [s.sessionId, 'main'])),
    ...input,
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

test('a restated block is measured from when it was last announced', () => {
  // PermissionRequest at 1000 and the Notification saying the same thing at
  // 9000. Anchoring on stateSince would give this block eight extra seconds of
  // tolerance, so anything the session wrote while the prompt sat open - a
  // sibling tool in the same batch returning, say - would read as the prompt
  // having been answered and turn the row green over a real block.
  const blocked = { state: 'blocked', stateSince: 1000, blockAnnouncedAt: 9000 };
  assert.equal(
    attentionFor({ session: blocked, run: null, summary: { lastActivityAt: 6000 } }),
    'blocked',
  );
  assert.equal(
    attentionFor({ session: blocked, run: null, summary: { lastActivityAt: 13000 } }),
    'working',
  );
});

test('a block with no announcement anchor is measured from stateSince', () => {
  // A record written by an older reporter, or before this branch. It has to go
  // on behaving exactly as it did rather than becoming un-clearable.
  const blocked = { state: 'blocked', stateSince: 1000 };
  assert.equal(
    attentionFor({ session: blocked, run: null, summary: { lastActivityAt: 3999 } }),
    'blocked',
  );
  assert.equal(
    attentionFor({ session: blocked, run: null, summary: { lastActivityAt: 4001 } }),
    'working',
  );
});

test('the waiting timer counts from when Claude asked, not from the restatement', () => {
  const rows = build({
    sessions: [session({ state: 'blocked', stateSince: 1000, blockAnnouncedAt: 9000 })],
    runs: [],
    now: 21000,
  });
  assert.equal(rows[0].attention, 'blocked');
  assert.equal(rows[0].waitingForMs, 20000);
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
  const rows = build({
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
  const rows = build({
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

test('a session keeps both the name you gave it and the title Claude guessed', () => {
  // They answer different questions - what you meant it for, and what it is
  // actually doing - and they drift apart over a long session.
  const rows = build({
    sessions: [session()],
    runs: [],
    now: 5000,
    summaries: new Map([
      ['s1', { title: 'add-pi-support', sessionName: 'Open Source Planning', mode: null, activity: null, lavishFile: null }],
    ]),
  });
  assert.equal(rows[0].sessionName, 'Open Source Planning');
  assert.equal(rows[0].summary, 'add-pi-support');
});

test('an unnamed session, and a run with no session, carry no name at all', () => {
  // Most sessions are unnamed, and a run nobody is sitting in front of cannot
  // have been named by anyone. Both must be null rather than absent, or the two
  // row shapes diverge and the page has to guard for it.
  const rows = build({
    sessions: [session()],
    runs: [run({ runId: 'r-orphan', repoPath: '/Users/x/work/other', repoName: 'other' })],
    now: 5000,
    summaries: new Map([['s1', { title: 't', mode: null, activity: null, lavishFile: null }]]),
  });
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.sessionName, null);
});

test('a review row carries the link and drops the tool it is blocked in', () => {
  // "Running lavish-axi" beside "Waiting on your review" reads as work in
  // progress, which is the exact impression this state exists to correct.
  const rows = build({
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

test('the transcript title is the summary, pipeline or no pipeline', () => {
  // This used to be the other way round: the step replaced the title, because
  // it says what is being done to the repo where the title only says what the
  // conversation is about. Both are true *at the same time* - no-mistakes runs
  // while you are still talking to the session - so the step now has `pipeline`
  // and a line of its own instead of taking this one.
  const rows = build({
    sessions: [session()],
    runs: [run({ step: { name: 'test' } })],
    now: 5000,
    summaries: new Map([['s1', { title: 'some-conversation', mode: null, activity: null, lavishFile: null }]]),
  });
  assert.equal(rows[0].summary, 'some-conversation');
  assert.equal(rows[0].pipeline?.step, 'test');
});

test('normal mode is not worth saying, so it is not carried', () => {
  const rows = build({
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
  const rows = build({ sessions: [session()], runs: [], now: 5000 });
  assert.equal(rows[0].summary, null);
  assert.equal(rows[0].activity, null);
  assert.equal(rows[0].reviewUrl, null);
});

test('buildRows joins sessions to runs and marks focusability', () => {
  const rows = build({
    sessions: [session()],
    runs: [run({ branch: 'feature/x' })],
    branches: new Map([['s1', 'feature/x']]),
    now: 5000,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'session');
  assert.equal(rows[0].branch, 'feature/x');
  assert.equal(rows[0].focusable, true);
  assert.equal(rows[0].hostKind, 'tab');
});

test('buildRows marks a session with no window identity as not focusable', () => {
  const rows = build({ sessions: [session({ host: {} })], runs: [], now: 5000 });
  assert.equal(rows[0].focusable, false);
});

test('buildRows will not call a session it cannot place a tab', () => {
  // It used to say "tab" here on the reasoning that an unplaceable session is
  // probably one. It is not: a Claude Desktop session whose host went
  // unrecognised lands here too, and then the page confidently labels a desktop
  // session as a terminal tab. Saying nothing is the only honest answer.
  const rows = build({ sessions: [session({ host: {} })], runs: [], now: 5000 });
  assert.equal(rows[0].hostKind, 'unknown');
});

test('buildRows tags a tmux-hosted session', () => {
  const rows = build({
    sessions: [session({ host: { tmux_pane: '%2' } })],
    runs: [],
    now: 5000,
  });
  assert.equal(rows[0].hostKind, 'tmux');
});

test('buildRows tags a Claude Desktop session and keeps it focusable', () => {
  // The card this exists for: no tty, no terminal, and until now not focusable
  // either - so opening an old session in the desktop app put a row on the page
  // that you could see wanting you and could not click through to.
  const rows = build({
    sessions: [
      session({
        sessionId: '2205e739-08bc-4ee6-a8d4-b15204bab998',
        host: { app: 'claude-desktop', tty: null, term_program: null },
      }),
    ],
    runs: [],
    now: 5000,
  });
  assert.equal(rows[0].hostKind, 'app');
  assert.equal(rows[0].focusable, true);
});

test('buildRows shows an unattached run but never offers to focus it', () => {
  const rows = build({ sessions: [], runs: [run({ repoPath: '/elsewhere' })], now: 5000 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'run');
  assert.equal(rows[0].focusable, false);
});

test('buildRows hides old finished runs but keeps active ones', () => {
  const now = 10_000_000_000;
  const rows = build({
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
  const rows = build({ sessions: [session()], runs: [run()], now: 5000 });
  assert.equal(rows.length, 1);
});

// Three Claude sessions open on one checkout is an ordinary day, and
// `matchRunForCwd` places a run by repo path alone - so the pipeline landed on
// all three cards, and clicking any of them focused a window with nothing to do
// with it. The process table knows which session launched the run; these pin
// what the dashboard does with that answer.
test('a run belongs to the session that started it, not to every session in the repo', () => {
  const rows = build({
    sessions: [
      session({ sessionId: 'owner', state: 'working' }),
      session({ sessionId: 'bystander', state: 'idle', host: { tty: '/dev/ttys005' } }),
    ],
    runs: [run({ runId: 'r1', parked: true })],
    runOwners: new Map([['r1', 'owner']]),
    now: 5000,
  });
  const byId = new Map(rows.map((r) => [r.sessionId, r]));
  assert.equal(byId.get('owner').run?.runId, 'r1');
  assert.equal(byId.get('owner').attention, 'parked');
  // The bystander is idle, and saying so is the whole point: a parked pipeline
  // on this row would summon someone to a window that cannot answer the gate.
  assert.equal(byId.get('bystander').run, null);
  assert.equal(byId.get('bystander').attention, 'idle');
});

test('a run nobody was seen to own still shows on every session in its repo', () => {
  // Ownership narrows and never widens. A session restarted since the pipeline
  // began, or a run started by hand, leaves no process to walk up from - and an
  // unattributed run is better on all three rows than on none.
  const rows = build({
    sessions: [session({ sessionId: 'a' }), session({ sessionId: 'b' })],
    runs: [run({ runId: 'r1' })],
    runOwners: new Map(),
    now: 5000,
  });
  assert.deepEqual(
    rows.map((r) => r.run?.runId),
    ['r1', 'r1'],
  );
});

test('a session that does not own the run is still titled after the repo it is in', () => {
  // The run says where a session *is* even when it says nothing about what the
  // pipeline is doing. Dropping it wholesale retitled a subdirectory session
  // after that subdirectory, so two cards on one repo stopped looking alike.
  const rows = build({
    sessions: [session({ sessionId: 'bystander', cwd: '/Users/x/work/repo/src' })],
    runs: [run({ runId: 'r1' })],
    runOwners: new Map([['r1', 'owner']]),
    now: 5000,
  });
  const row = rows.find((r) => r.sessionId === 'bystander');
  assert.equal(row.title, 'repo');
  assert.equal(row.titlePath, '/Users/x/work/repo');
  assert.equal(row.run, null);
});

// A session in a git worktree - Treehouse's whole working model - drives a run,
// and no-mistakes registers that run against the *main* checkout, because that
// is the path a worktree's repo resolves to. Matching on cwd prefix alone, no
// worktree session can ever be placed in its own repo. Seen live: the session
// at `~/.treehouse/.../2/no-mistakes-monitor` sat at a review gate showing no
// pipeline at all, while the idle `main` checkout next door claimed the run,
// on a branch it was not on, with a Focus button to a window that could not
// answer the gate.
test('a run started in a worktree belongs to the worktree session', () => {
  const worktree = '/Users/x/.treehouse/repo-9f/2/repo';
  const rows = build({
    sessions: [
      session({ sessionId: 'worktree', cwd: worktree, state: 'working' }),
      session({ sessionId: 'main', cwd: '/Users/x/work/repo', state: 'idle' }),
    ],
    // The run's repoPath is the main checkout even though it was started in the
    // worktree, so only the link in `.git` can tie the two together.
    runs: [run({ runId: 'r1', parked: true, branch: 'feat/thing' })],
    mainCheckouts: new Map([['worktree', '/Users/x/work/repo']]),
    branches: new Map([
      ['worktree', 'feat/thing'],
      ['main', 'main'],
    ]),
    runOwners: new Map([['r1', 'worktree']]),
    now: 5000,
  });
  const byId = new Map(rows.map((r) => [r.sessionId, r]));
  assert.equal(byId.get('worktree').run?.runId, 'r1');
  assert.equal(byId.get('worktree').attention, 'parked');
  assert.equal(byId.get('main').run, null);
  assert.equal(byId.get('main').attention, 'idle');
});

test('a session shows the run it owns, not the higher-ranked one on the same path', () => {
  // Several runs on one `repoPath` is the ordinary reading now that every
  // worktree's run registers against the main checkout. Ownership was only ever
  // consulted as a veto - it could take a wrong run off a card and never put the
  // right one on it - so the driver was handed the parked run it has nothing to
  // do with (`rankRun` puts parked above active) and its own run fell through to
  // an unfocusable row of its own.
  const rows = build({
    sessions: [session({ sessionId: 'driver' })],
    runs: [
      run({ runId: 'parked', branch: 'feat/other', parked: true, updatedAt: 2000 }),
      run({ runId: 'mine', branch: 'feat/mine' }),
    ],
    branches: new Map([['driver', 'feat/mine']]),
    runOwners: new Map([['mine', 'driver']]),
    now: 5000,
  });
  const byId = new Map(rows.map((r) => [r.sessionId, r]));
  assert.equal(byId.get('driver').run?.runId, 'mine');
  // And the run it owns is claimed, so it is not also shown as an orphan.
  assert.equal(
    rows.find((r) => r.kind === 'run' && r.run.runId === 'mine'),
    undefined,
  );
  // The run nobody owns is still on the page, just not on this card.
  assert.equal(
    rows.find((r) => r.kind === 'run')?.run.runId,
    'parked',
  );
});

test('owning a run moves the pipeline onto the card and leaves identity alone', () => {
  // Only `run` may follow ownership. `title` and `titlePath` keep coming from
  // the rank-resolved match on the session's own path - a session titled after
  // the run it owns would stop looking like the checkout it is sitting in.
  const rows = build({
    sessions: [session({ sessionId: 'driver', cwd: '/Users/x/work/repo/src' })],
    runs: [
      run({ runId: 'parked', branch: 'feat/other', parked: true, updatedAt: 2000 }),
      run({ runId: 'mine', branch: 'feat/mine' }),
    ],
    branches: new Map([['driver', 'feat/mine']]),
    runOwners: new Map([['mine', 'driver']]),
    now: 5000,
  });
  const row = rows.find((r) => r.sessionId === 'driver');
  assert.equal(row.run?.runId, 'mine');
  assert.equal(row.title, 'repo');
  assert.equal(row.titlePath, '/Users/x/work/repo');
});

test('an ownership that has finished stops outranking the live run beside it', () => {
  // An ownership outlives its run - it is held for the half hour the run stays
  // in the reading - and preferring it past that point holds a completed run on
  // the card while the parked one next to it, the one with a gate open, loses
  // the only session that could answer it. The preference is over a live run
  // because the gate is the whole reason for it.
  const rows = build({
    sessions: [session({ sessionId: 'driver' })],
    runs: [
      run({ runId: 'done', branch: 'feat/mine', status: 'completed', active: false }),
      // On the driver's own branch, since a run is matched on it now - two runs
      // for one branch is ordinary, having driven a second while the first ran.
      run({ runId: 'live', branch: 'feat/mine', parked: true, updatedAt: 2000 }),
    ],
    branches: new Map([['driver', 'feat/mine']]),
    runOwners: new Map([['done', 'driver']]),
    now: 5000,
  });
  const row = rows.find((r) => r.sessionId === 'driver');
  assert.equal(row.run?.runId, 'live');
  assert.equal(row.attention, 'parked');
  // And it is claimed, so it is not stranded as a row nobody can focus.
  assert.equal(
    rows.find((r) => r.kind === 'run' && r.run.runId === 'live'),
    undefined,
  );
});

test('a worktree session keeps its own path, so two checkouts stay tellable apart', () => {
  // Identity must not follow the run match here. Borrowing the repo's path for
  // `titlePath` would give the worktree and the checkout it is linked to the
  // same anchor, and `disambiguateTitles` would have nothing left to grow - the
  // `1/` and `2/` that name a Treehouse tree would disappear from the page.
  const rows = build({
    sessions: [
      session({ sessionId: 'worktree', cwd: '/Users/x/.treehouse/repo-9f/2/repo' }),
      session({ sessionId: 'main', cwd: '/Users/x/work/repo' }),
    ],
    runs: [run({ runId: 'r1', branch: 'feat/thing' })],
    mainCheckouts: new Map([['worktree', '/Users/x/work/repo']]),
    branches: new Map([
      ['worktree', 'feat/thing'],
      ['main', 'main'],
    ]),
    now: 5000,
  });
  const byId = new Map(rows.map((r) => [r.sessionId, r]));
  assert.equal(byId.get('worktree').titlePath, '/Users/x/.treehouse/repo-9f/2/repo');
  assert.equal(byId.get('main').titlePath, '/Users/x/work/repo');
  // `buildRows` disambiguates before it returns, so these are the titles the
  // page actually renders. Borrowing the repo's path above would have left both
  // rows anchored on it, and both cards saying nothing but "repo".
  assert.equal(byId.get('worktree').title, '2/repo');
  assert.equal(byId.get('main').title, 'work/repo');
});

test('a worktree with no branch of its own gets nothing through the link', () => {
  // Treehouse leaves trees on a detached HEAD routinely, and the branch is the
  // only thing that says which of a checkout's runs is this worktree's. With
  // none, the honest answer is no run - and the failure it fails closed against
  // was seen live: the tree fell straight through to the run's branch, naming
  // the branch of the *sibling* tree driving the pipeline, and would have taken
  // that branch's pull request with it. A worktree is on another branch by
  // definition, so a run reached this way is never a second-best answer; it is
  // a known-wrong one.
  const rows = build({
    sessions: [session({ sessionId: 'detached', cwd: '/Users/x/.treehouse/repo-9f/1/repo' })],
    runs: [run({ runId: 'r1', branch: 'feat/thing', prUrl: 'https://github.com/x/repo/pull/9' })],
    mainCheckouts: new Map([['detached', '/Users/x/work/repo']]),
    branches: new Map([['detached', null]]),
    now: 5000,
  });
  const row = rows.find((r) => r.kind === 'session');
  assert.equal(row.run, null);
  assert.equal(row.branch, null);
  assert.equal(row.pr, null);
});

test('two runs on one checkout land on the worktrees that started them', () => {
  // The live shape: two Treehouse trees of one repo, each driving its own
  // pipeline, both runs registered against the same main checkout. Resolving
  // the link by recency or parkedness alone hands the parked run to both trees
  // and leaves the other with no pipeline at all - the failure the link was
  // added to fix, reproduced through the link. Ownership is deliberately empty
  // here: `nmmon status` is one-shot and has no memory of it, so the branch has
  // to be what separates them.
  const rows = build({
    sessions: [
      session({ sessionId: 'a', cwd: '/Users/x/.treehouse/repo-9f/1/repo' }),
      session({ sessionId: 'b', cwd: '/Users/x/.treehouse/repo-9f/2/repo' }),
    ],
    runs: [
      run({ runId: 'ra', branch: 'feat/a', parked: true, parkedSince: 1000 }),
      run({ runId: 'rb', branch: 'feat/b', updatedAt: 2000 }),
    ],
    mainCheckouts: new Map([
      ['a', '/Users/x/work/repo'],
      ['b', '/Users/x/work/repo'],
    ]),
    branches: new Map([
      ['a', 'feat/a'],
      ['b', 'feat/b'],
    ]),
    runOwners: new Map(),
    now: 5000,
  });
  const byId = new Map(rows.filter((r) => r.kind === 'session').map((r) => [r.sessionId, r]));
  assert.equal(byId.get('a').run?.runId, 'ra');
  assert.equal(byId.get('b').run?.runId, 'rb');
  // Neither run is left over as a row nobody can focus.
  assert.deepEqual(
    rows.filter((r) => r.kind === 'run').map((r) => r.id),
    [],
  );
});

test('an unowned run does not fan out across a checkout\'s other worktrees', () => {
  // Every worktree of a checkout resolves to the same path, so the link is a
  // one-to-many edge: without the branch, one parked run would take over every
  // sibling tree's card - its step, its gate, its folded agent and a Focus
  // button to a window that cannot answer it. Ownership must not be what saves
  // this, hence an empty map.
  const rows = build({
    sessions: [
      session({ sessionId: 'driver', cwd: '/Users/x/.treehouse/repo-9f/2/repo', state: 'idle' }),
      session({ sessionId: 'sibling', cwd: '/Users/x/.treehouse/repo-9f/1/repo', state: 'idle' }),
      session({ sessionId: 'checkout', cwd: '/Users/x/work/repo', state: 'idle' }),
    ],
    runs: [run({ runId: 'r1', parked: true, branch: 'feat/thing' })],
    mainCheckouts: new Map([
      ['driver', '/Users/x/work/repo'],
      ['sibling', '/Users/x/work/repo'],
    ]),
    branches: new Map([
      ['driver', 'feat/thing'],
      ['sibling', 'feat/other'],
      ['checkout', 'main'],
    ]),
    runOwners: new Map(),
    now: 5000,
  });
  const byId = new Map(rows.filter((r) => r.kind === 'session').map((r) => [r.sessionId, r]));
  assert.equal(byId.get('driver').run?.runId, 'r1');
  assert.equal(byId.get('sibling').run, null);
  assert.equal(byId.get('sibling').attention, 'idle');
  // The session physically inside the checkout used to be the exception, on the
  // rule that a run is placed there by repo path alone whatever branch it has
  // moved to. That exception is gone: it is on `main`, the run is not, so the
  // run is no more its business than the sibling worktree's.
  assert.equal(byId.get('checkout').run, null);
});

test('a session inside the checkout does not keep a run from another branch', () => {
  // The reverse of what this used to assert. The old rule - a row keeps showing
  // its repo's recent pipeline whatever branch the checkout moved to - put a
  // live pipeline from somebody else's branch on an idle card, with a Focus
  // button to a window that could not answer its gate. A run belongs to the
  // session driving it, and switching branch is how you say you are done.
  const rows = build({
    sessions: [session({ sessionId: 's1', cwd: '/Users/x/work/repo/src' })],
    runs: [run({ runId: 'r1', branch: 'feat/thing' })],
    branches: new Map([['s1', 'main']]),
    now: 5000,
  });
  const row = rows.find((r) => r.kind === 'session');
  assert.equal(row.run, null);
  assert.equal(row.branch, 'main');
});

test('a checkout with no readable branch is matched to nothing at all', () => {
  // Fails closed, like every other match on this page. A detached HEAD is
  // routine under Treehouse, and with nothing to match on a guess would be a
  // confident wrong answer with a Focus button attached. The run is not lost -
  // it goes to the unattributable card, which says why it is there.
  const rows = build({
    sessions: [session({ sessionId: 's1', cwd: '/Users/x/work/repo/src' })],
    runs: [run({ runId: 'r1', branch: 'feat/thing' })],
    branches: new Map([['s1', null]]),
    now: 5000,
  });
  const row = rows.find((r) => r.kind === 'session');
  assert.equal(row.run, null);
  assert.equal(row.branch, null, 'and it does not borrow the run\'s branch either');
  assert.equal(rows.find((r) => r.kind === 'run')?.attributable, false);
});

test('a worktree registered in its own right keeps its own run', () => {
  // The link is a fallback, never an override. no-mistakes will happily
  // register a worktree as a repo of its own, and that run is the more specific
  // answer - the same rule `matchRunForCwd` already applies to nesting.
  const worktree = '/Users/x/.treehouse/repo-9f/2/repo';
  const rows = build({
    sessions: [session({ sessionId: 'worktree', cwd: worktree })],
    runs: [
      run({ runId: 'main-run', repoPath: '/Users/x/work/repo' }),
      run({ runId: 'own-run', repoPath: worktree }),
    ],
    mainCheckouts: new Map([['worktree', '/Users/x/work/repo']]),
    now: 5000,
  });
  assert.equal(rows[0].run?.runId, 'own-run');
});

test("a worktree session finds its branch's pull request in the main checkout", () => {
  // Pull requests are placed by the same prefix match, so they went missing on
  // a worktree session for exactly the same reason the run did.
  const rows = build({
    sessions: [session({ sessionId: 'worktree', cwd: '/Users/x/.treehouse/repo-9f/2/repo' })],
    runs: [],
    mainCheckouts: new Map([['worktree', '/Users/x/work/repo']]),
    branches: new Map([['worktree', 'feat/thing']]),
    pullRequests: [
      {
        url: 'https://github.com/x/repo/pull/7',
        number: 7,
        state: 'open',
        observedAt: 900,
        branch: 'feat/thing',
        repoPath: '/Users/x/work/repo',
        current: true,
      },
    ],
    now: 5000,
  });
  assert.equal(rows[0].pr?.number, 7);
});

test("a bystander keeps the branch's pull request, which is not the run's to lend", () => {
  // A pull request belongs to the checkout's branch, so every session on that
  // branch is waiting on the same review. Only the pipeline state is exclusive.
  const rows = build({
    sessions: [session({ sessionId: 'bystander' })],
    runs: [run({ runId: 'r1' })],
    runOwners: new Map([['r1', 'owner']]),
    branches: new Map([['bystander', 'main']]),
    pullRequests: [
      {
        url: 'https://github.com/x/repo/pull/7',
        number: 7,
        state: 'open',
        observedAt: 900,
        branch: 'main',
        repoPath: '/Users/x/work/repo',
        current: true,
      },
    ],
    now: 5000,
  });
  assert.equal(rows[0].pr?.number, 7);
});

test("the pipeline's own agent is folded into the owner's row alone", () => {
  const agentSession = session({
    sessionId: 'agent',
    cwd: '/Users/mattw/.no-mistakes/worktrees/ab12/r1',
    state: 'blocked',
    message: 'Claude needs your permission to use Bash',
  });
  const rows = build({
    sessions: [
      agentSession,
      session({ sessionId: 'owner' }),
      session({ sessionId: 'bystander', state: 'idle' }),
    ],
    runs: [run({ runId: 'r1' })],
    runOwners: new Map([['r1', 'owner']]),
    now: 5000,
  });
  const byId = new Map(rows.map((r) => [r.sessionId, r]));
  // A blocked pipeline agent has stalled the run, so the owner goes red and
  // carries the agent's own reason - the row is where the folded agent shows.
  assert.equal(byId.get('owner').attention, 'blocked');
  assert.equal(byId.get('owner').message, 'Claude needs your permission to use Bash');
  // The bystander cannot free it and must not be summoned for it.
  assert.equal(byId.get('bystander').attention, 'idle');
  assert.equal(byId.get('bystander').message, null);
});

test('a run whose owner is no longer registered gets a row of its own', () => {
  // The owning session ended while the pipeline carried on. Nobody claims the
  // run, so it falls through to the unattached-run pass rather than attaching
  // itself to whichever other session happens to share the directory.
  const rows = build({
    sessions: [session({ sessionId: 'bystander' })],
    runs: [run({ runId: 'r1' })],
    runOwners: new Map([['r1', 'gone']]),
    now: 5000,
  });
  assert.equal(rows.length, 2);
  const runRow = rows.find((r) => r.kind === 'run');
  assert.equal(runRow.run.runId, 'r1');
  assert.equal(runRow.focusable, false);
});

test('a run taken over by a live session lands on that session, not on a row of its own', () => {
  // The counterpart to the test above, and the reason `RunOwners.release`
  // exists: the session that started the run ended at the gate, and the one
  // that answered it with `axi respond` is now the owner. That session must
  // carry the pipeline - it is the only window that can act on it - rather than
  // watching it render beside them as a row with no Focus button.
  const rows = build({
    sessions: [
      session({ sessionId: 'taker', state: 'working' }),
      session({ sessionId: 'bystander', state: 'idle', host: { tty: '/dev/ttys005' } }),
    ],
    runs: [run({ runId: 'r1', parked: true })],
    runOwners: new Map([['r1', 'taker']]),
    now: 5000,
  });
  assert.equal(rows.length, 2);
  const byId = new Map(rows.map((r) => [r.sessionId, r]));
  assert.equal(byId.get('taker').run?.runId, 'r1');
  assert.equal(byId.get('taker').attention, 'parked');
  assert.equal(byId.get('taker').focusable, true);
  assert.equal(byId.get('bystander').run, null);
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
  const rows = build({ sessions: [session()], runs: [], now: 5000 });
  assert.equal(rows[0].title, 'repo');
});

test('two checkouts of the same repo are told apart by their parent directory', () => {
  // The real case this exists for: a repo and a worktree copy of it both
  // render as one word, and the page becomes a guessing game.
  const rows = build({
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
  const rows = build({
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
  const rows = build({
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
  const rows = build({
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
  const rows = build({
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
  current: false,
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
  const rows = build({
    sessions: [session({ cwd: '/Users/x/work/repo' })],
    runs: [],
    branches: new Map([['s1', 'feat/x']]),
    pullRequests: [pr()],
  });
  assert.equal(rows[0].pr.number, 7);
  assert.equal(rows[0].pr.current, false, 'and it is honest that the state is a past reading');
});

test('the branch comes from the checkout, not from whichever run happened to match', () => {
  // A run's branch belongs to a pipeline that may have finished on a branch
  // since left behind. The checkout is the truth about where the session is.
  const rows = build({
    sessions: [session()],
    runs: [run({ branch: 'old-branch' })],
    branches: new Map([['s1', 'feat/current']]),
  });
  assert.equal(rows[0].branch, 'feat/current');
});

test('the branch is the checkout"s own, never borrowed from a run', () => {
  // A run used to lend its branch to a session in its repo whose `.git` could
  // not be read. There is nothing left to borrow from: a run is matched *on*
  // the branch, so in the one case the fallback existed for there is no matched
  // run. And the pull request is gated on the branch, so a borrowed branch was
  // a borrowed review link.
  const rows = build({
    sessions: [session()],
    runs: [run({ branch: 'from-run' })],
    branches: new Map([['s1', null]]),
  });
  assert.equal(rows.find((r) => r.kind === 'session').branch, null);
});

test('a live run"s own pull request wins, and is reported as current', () => {
  const rows = build({
    sessions: [session()],
    runs: [
      run({
        active: true,
        prUrl: 'https://example.com/pull/9',
        prState: 'open',
        prStateObservedAt: 9000,
      }),
    ],
    branches: new Map([['s1', 'main']]),
    now: 10_000,
  });
  assert.equal(rows[0].pr.number, 9);
  assert.equal(rows[0].pr.current, true);
});

test('a live run whose pull request stopped being observed does not claim its state', () => {
  // The bug: a merged pull request still rendered an `open` chip. `live` meant
  // "the run that owns it is still going", which is not "this reading is
  // current" - and the two come apart whenever the CI monitor stops observing
  // without the run stopping. Measured in the real database: two runs were last
  // observed at the same second, 2026-07-22T13:45:13Z, and stayed `running` in
  // the `ci` step for a further 7h23m carrying `pr_state = 'open'`.
  const rows = build({
    sessions: [session()],
    runs: [
      run({
        active: true,
        prUrl: 'https://example.com/pull/9',
        prState: 'open',
        prStateObservedAt: 1000,
        // The run keeps working, so its own clock keeps advancing. This is why
        // `updatedAt` cannot stand in for an observation time.
        updatedAt: 7 * 60 * 60 * 1000,
      }),
    ],
    branches: new Map([['s1', 'main']]),
    now: 7 * 60 * 60 * 1000,
  });
  assert.equal(rows[0].pr.number, 9, 'the link survives - only the state word is a claim');
  assert.equal(rows[0].pr.state, 'open', 'and the reading is still reported, as a past one');
  assert.equal(rows[0].pr.current, false);
});

test('a run with no observation time at all cannot present a state as current', () => {
  // The degraded `axi status` path has no observation time to offer, and a
  // schema too old to carry one reads as null. Fail closed: showing the word is
  // a claim, and we have nothing to base it on.
  const rows = build({
    sessions: [session()],
    runs: [run({ active: true, prUrl: 'https://example.com/pull/9', prState: 'open' })],
    branches: new Map([['s1', 'main']]),
    now: 10_000,
  });
  assert.equal(rows[0].pr.current, false);
});

// --------------------------------------------------------------- the forge
//
// The one source allowed to *assert* a state rather than only disprove one,
// because it is the authority on its own pull requests where every other source
// here is a recollection of one.

const forgeReadings = (url, state, observedAt) =>
  new Map([[String(url).replace(/\/+$/, '').toLowerCase(), { state, observedAt }]]);

test('the forge overrules a live run that says something else', () => {
  // The residual RAI-10 could not close: for the couple of minutes between a
  // merge and no-mistakes noticing, the database reading is honestly fresh and
  // honestly wrong.
  const rows = build({
    sessions: [session()],
    runs: [
      run({
        active: true,
        prUrl: 'https://github.com/acme/repo/pull/9',
        prState: 'open',
        prStateObservedAt: 9500,
      }),
    ],
    branches: new Map([['s1', 'main']]),
    forgeStates: forgeReadings('https://github.com/acme/repo/pull/9', 'merged', 9900),
    now: 10_000,
  });
  assert.equal(rows[0].pr.state, 'merged');
  assert.equal(rows[0].pr.current, true);
  assert.equal(rows[0].pr.observedAt, 9900, 'and it reports when *we* asked');
});

test('the forge answers for a pull request nobody is watching at all', () => {
  // The bigger prize, and the reason this feature exists: once the run ends -
  // or for a pull request opened by hand - there is no observer, so the page had
  // a link and no way to find out. The transcript source is never `current` on
  // its own.
  const rows = build({
    sessions: [session({ cwd: '/Users/x/work/repo' })],
    runs: [],
    summaries: new Map([['s1', seen({ url: 'https://github.com/acme/repo/pull/40', number: 40 })]]),
    branches: new Map([['s1', 'feat/x']]),
    forgeStates: forgeReadings('https://github.com/acme/repo/pull/40', 'open', 9000),
    now: 10_000,
  });
  assert.equal(rows[0].pr.number, 40);
  assert.equal(rows[0].pr.state, 'open');
  assert.equal(rows[0].pr.current, true);
});

test('a forge reading ages exactly like anybody else"s', () => {
  // "The forge wins" must not become "the forge's last answer wins forever",
  // which would be RAI-10 again with a new source. If the lookups stop
  // answering - the network gone, the laptop asleep - the row goes back to
  // saying "was open, last checked" within the same five minutes.
  const rows = build({
    sessions: [session()],
    runs: [],
    summaries: new Map([['s1', seen({ url: 'https://github.com/acme/repo/pull/40', number: 40 })]]),
    branches: new Map([['s1', 'feat/x']]),
    forgeStates: forgeReadings('https://github.com/acme/repo/pull/40', 'open', 0),
    now: 6 * 60 * 1000,
  });
  assert.equal(rows[0].pr.state, 'open', 'the reading survives as a past one');
  assert.equal(rows[0].pr.current, false);
});

test('the forge may never leave a row less current than it found it', () => {
  // The acceptance criterion for the whole feature, and `merged` is the case
  // that breaks it: a merged pull request is never asked about again - it
  // cannot un-merge - so its reading is the one here whose `observedAt` is
  // frozen by design, while a live run keeps re-observing at about a
  // two-minute cadence. Aged through the ordinary gate, the forge would take
  // the MERGED chip off a row that had been showing it perfectly well without
  // any forge at all: this feature making the page worse than the source it
  // outranks.
  const url = 'https://github.com/acme/repo/pull/9';
  const now = 60 * 60 * 1000;
  const input = {
    sessions: [session()],
    runs: [run({ active: true, prUrl: url, prState: 'merged', prStateObservedAt: now - 1000 })],
    branches: new Map([['s1', 'main']]),
    now,
  };
  assert.equal(build(input)[0].pr.current, true, 'the run is watching, so it says so');

  const rows = build({ ...input, forgeStates: forgeReadings(url, 'merged', now - 30 * 60 * 1000) });
  assert.equal(rows[0].pr.state, 'merged');
  assert.equal(rows[0].pr.current, true, 'and the forge agreeing may not take that away');
});

test('a stale forge reading does not displace a local one still being watched', () => {
  // The same rule where the answer genuinely could have changed, so the
  // freshness gate still applies to the forge's word - it just does not get to
  // replace an answer somebody is still observing with one nobody can confirm.
  // Outranking decides between two answers; it is not a licence to swap an
  // answer for silence.
  const url = 'https://github.com/acme/repo/pull/9';
  const now = 60 * 60 * 1000;
  const rows = build({
    sessions: [session()],
    runs: [run({ active: true, prUrl: url, prState: 'open', prStateObservedAt: now - 1000 })],
    branches: new Map([['s1', 'main']]),
    forgeStates: forgeReadings(url, 'closed', now - 30 * 60 * 1000),
    now,
  });
  assert.equal(rows[0].pr.state, 'open');
  assert.equal(rows[0].pr.current, true);
  assert.equal(rows[0].pr.observedAt, now - 1000, 'the local reading is kept whole');
});

test('a forge reading for some other review changes nothing', () => {
  const rows = build({
    sessions: [session()],
    runs: [
      run({
        active: true,
        prUrl: 'https://github.com/acme/repo/pull/9',
        prState: 'open',
        prStateObservedAt: 9500,
      }),
    ],
    branches: new Map([['s1', 'main']]),
    forgeStates: forgeReadings('https://github.com/acme/repo/pull/11', 'merged', 9900),
    now: 10_000,
  });
  assert.equal(rows[0].pr.state, 'open');
});

test('no forge readings at all leaves every row exactly as it was', () => {
  // The feature disabled has to be byte-identical to before it existed. This is
  // the pure half of that proof; `server.test.js` holds the half that says no
  // request goes out.
  const input = {
    sessions: [session()],
    runs: [
      run({
        active: true,
        prUrl: 'https://github.com/acme/repo/pull/9',
        prState: 'open',
        prStateObservedAt: 9500,
      }),
    ],
    branches: new Map([['s1', 'main']]),
    now: 10_000,
  };
  assert.deepEqual(build({ ...input, forgeStates: new Map() }), build(input));
});

test('a run does not lend its pull request to a session that has moved on', () => {
  // Observed live: a merged run from twenty minutes earlier put its PR on a
  // session sitting in the same repo on `main`, so the row said `main` and
  // carried a link to another branch's review. `matchRunForCwd` matches on the
  // repo path alone - deliberately - so the run attaching is right and the
  // pull request coming with it is not. Same rule as `matchPullRequest`: the
  // branch has to agree, or there is no link.
  const rows = build({
    sessions: [session()],
    runs: [
      run({
        active: false,
        status: 'completed',
        branch: 'fix/something-merged',
        prUrl: 'https://example.com/pull/5',
        prState: 'merged',
      }),
    ],
    branches: new Map([['s1', 'main']]),
  });
  assert.equal(rows[0].branch, 'main');
  assert.equal(rows[0].pr, null);
});

test('a run on another branch still falls through to the branch-verified source', () => {
  // Rejecting the run's pull request must not cost the row the right one.
  const rows = build({
    sessions: [session()],
    runs: [run({ branch: 'fix/other', prUrl: 'https://example.com/pull/5' })],
    branches: new Map([['s1', 'feat/x']]),
    pullRequests: [pr()],
  });
  assert.equal(rows[0].pr.number, 7);
});

test('a checkout whose branch could not be read gets no run and no pull request', () => {
  // It used to take the run's word for both, on the grounds that the run's
  // branch was all there was and the row showed it too, so the two agreed. They
  // agreed with each other and not necessarily with the checkout: several runs
  // now share one repo path, so "the run's branch" is whichever ranked highest.
  // Nothing is better than a confident wrong review link.
  const rows = build({
    sessions: [session()],
    runs: [run({ branch: 'feat/x', active: true, prUrl: 'https://example.com/pull/9' })],
    branches: new Map([['s1', null]]),
  });
  const row = rows.find((r) => r.kind === 'session');
  assert.equal(row.branch, null);
  assert.equal(row.run, null);
  assert.equal(row.pr, null);
});

test('lastActivityAt reaches the row from the transcript', () => {
  const rows = build({
    sessions: [session()],
    runs: [],
    summaries: new Map([['s1', { title: 't', mode: null, activity: null, lavishFile: null, lastActivityAt: 4242 }]]),
  });
  assert.equal(rows[0].lastActivityAt, 4242);
});

test('a run with no session behind it reports its own clock', () => {
  const rows = build({ sessions: [], runs: [run({ updatedAt: 777 })] });
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
  assert.equal(pr.current, false, 'nothing is watching it, so the state is not current');
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
  const rows = build({
    sessions: [session({ cwd: '/Users/x/work/repo' })],
    runs: [],
    branches: new Map([['s1', 'feat/x']]),
    pullRequests: [pr({ number: 7 })],
    summaries: new Map([['s1', seen()]]),
  });
  assert.equal(rows[0].pr.number, 7);
});

test('the transcript fills the gap when the database has nothing for this branch', () => {
  const rows = build({
    sessions: [session({ cwd: '/Users/x/work/repo' })],
    runs: [],
    branches: new Map([['s1', 'feat/unrun']]),
    pullRequests: [],
    summaries: new Map([['s1', seen()]]),
  });
  assert.equal(rows[0].pr.number, 40);
});

test("the transcript's pull request is checked against the repo, not against the run", () => {
  // The slug guard compares the repository in the URL with the basename of the
  // path it is given, so which path it is given decides whether a real review
  // link survives. Handing it the branch-gated run match meant a session in a
  // subdirectory, on a branch none of the repo's runs were on, compared `repo`
  // against `api` and dropped the link its own transcript had reported.
  const rows = build({
    sessions: [session({ cwd: '/Users/x/work/repo/packages/api' })],
    runs: [run({ runId: 'r1', branch: 'main' })],
    branches: new Map([['s1', 'feat/unrun']]),
    pullRequests: [],
    summaries: new Map([['s1', seen()]]),
    now: 5000,
  });
  assert.equal(rows.find((r) => r.kind === 'session').pr?.number, 40);
});

test('a pull request the database records on another branch is not ours', () => {
  // The transcript only guesses which branch a URL belongs to. no-mistakes
  // knows, because it opened it, so a sighting it recognises elsewhere is
  // rejected rather than rendered.
  const known = pr({
    url: 'https://bitbucket.org/mattw_watson/repo/pull-requests/40',
    number: 40,
    branch: 'feat/other',
  });
  assert.equal(transcriptPullRequest(seen(), '/Users/x/work/repo', 'feat/x', [known]), null);
  assert.equal(
    transcriptPullRequest(seen(), '/Users/x/work/repo', 'feat/x', [pr({ number: 7 })])?.number,
    40,
    'a pull request the database has never heard of is what this source is for',
  );
});

test('a trailing slash or a capital in the host does not smuggle a rejected one back', () => {
  const known = pr({
    url: 'https://Bitbucket.org/mattw_watson/repo/pull-requests/40/',
    number: 40,
    branch: 'feat/other',
  });
  assert.equal(transcriptPullRequest(seen(), '/Users/x/work/repo', 'feat/x', [known]), null);
});

test('the run table no-mistakes injects does not put its first PR on the card', () => {
  // Verbatim shape of the `no-mistakes axi` home output, which is what got past
  // the exactly-one-distinct-URL rule: two rows, one carrying a pull request
  // and one an empty string, so the listing reads as a single sighting. The
  // line naming our branch has no URL on it, so nothing ties the one URL to us.
  const home = [
    'runs[2]{id,branch,status,head,pr}:',
    '  01KZ31SSP3F8GV2AH86S135JFW,feat/monitor-runs-and-sessions,completed,fab1881,"https://bitbucket.org/mattw_watson/repo/pull-requests/1"',
    '  01KZ36ZR0MA0BDQ6DK12H6PSC8,feat/session-summaries-and-typecheck,running,d80b1c3,""',
  ].join('\n');
  const record = {
    timestamp: '2026-08-03T01:00:00.000Z',
    message: { content: [{ type: 'tool_result', content: home }] },
  };
  const sighting = pullRequestFromRecords([record], 'feat/session-summaries-and-typecheck');
  assert.equal(sighting.number, 1, 'the transcript alone still reports it');

  const known = pr({
    url: 'https://bitbucket.org/mattw_watson/repo/pull-requests/1',
    number: 1,
    branch: 'feat/monitor-runs-and-sessions',
  });
  const rows = build({
    sessions: [session({ cwd: '/Users/x/work/repo' })],
    runs: [],
    branches: new Map([['s1', 'feat/session-summaries-and-typecheck']]),
    pullRequests: [known],
    summaries: new Map([['s1', { ...seen(), pullRequest: sighting }]]),
  });
  assert.equal(rows[0].pr, null, "and the database says it belongs to somebody else's branch");
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
  const rows = build({
    sessions: [
      session({ sessionId: 'human', cwd: '/Users/x/work/repo' }),
      session({ sessionId: 'agent', cwd: AGENT_CWD }),
    ],
    runs: [agentRun({ step: { name: 'review', status: 'running', findings: 0 } })],
    summaries: new Map([
      ['agent', { title: 'Review the terrain change', activity: 'Reading terrain.ts', mode: null, lavishFile: null, lastActivityAt: 9000, pullRequest: null }],
    ]),
  });
  assert.equal(rows.length, 1, 'one row per repo, never two');
  assert.equal(rows[0].sessionId, 'human');
  // Folded in rather than lost: what the agent is doing is the pipeline line.
  assert.equal(rows[0].pipeline?.what, 'Reading terrain.ts');
});

test('a blocked pipeline agent still reaches you, on the repo row', () => {
  // Folding the agent in must not swallow the one signal the tool exists for:
  // an agent on a permission prompt has stalled the pipeline, and only a human
  // can free it.
  const rows = build({
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

test("a granted agent prompt stops pinning the repo's row red", () => {
  // The same hook silence as a human session: nothing fires between the
  // permission prompt and the end of the turn, so only the agent's own
  // transcript can say it carried on. Folding must not import the stale block
  // this branch exists to get rid of.
  const rows = build({
    sessions: [
      session({ sessionId: 'human', cwd: '/Users/x/work/repo', state: 'working' }),
      session({
        sessionId: 'agent',
        cwd: AGENT_CWD,
        state: 'blocked',
        stateSince: 1000,
        message: 'Needs permission to push',
      }),
    ],
    // Live, because a finished run now leaves the card altogether and takes its
    // folded agent with it - there would be no agent left to assert about.
    runs: [agentRun({ updatedAt: 1000 })],
    summaries: new Map([
      ['agent', { title: null, activity: 'Running npm', mode: null, lavishFile: null, lastActivityAt: 9000, pullRequest: null }],
    ]),
  });
  assert.equal(rows[0].attention, 'working');
  assert.equal(rows[0].message, null, 'and the reason for a block that is over goes with it');
});

test("a live pipeline answers the agent's idle nudge and nothing else", () => {
  const rowFor = (message) =>
    build({
      sessions: [session({ sessionId: 'agent', cwd: AGENT_CWD, state: 'blocked', message })],
      runs: [agentRun()],
      pipelines: new Set(['agent']),
    })[0];

  assert.notEqual(rowFor('Claude is waiting for your input').attention, 'blocked');
  assert.equal(rowFor('Claude needs your permission to use Bash').attention, 'blocked');
});

test('the newest agent of a run is the one shown, not whichever wrote last', () => {
  // One step's agent is still registered while the next starts, and sessions
  // arrive newest first. An older calm agent must not mask a new blocked one.
  const rows = build({
    sessions: [
      session({ sessionId: 'new-agent', cwd: AGENT_CWD, state: 'blocked', message: 'Needs permission to push' }),
      session({ sessionId: 'old-agent', cwd: AGENT_CWD, state: 'working' }),
    ],
    runs: [agentRun({ step: { name: 'push', status: 'running', findings: 0 } })],
    summaries: new Map([
      ['new-agent', { title: null, activity: 'Running git push', mode: null, lavishFile: null, lastActivityAt: 9000, pullRequest: null }],
      ['old-agent', { title: null, activity: 'Running npm test', mode: null, lavishFile: null, lastActivityAt: 8000, pullRequest: null }],
    ]),
  });
  assert.equal(rows[0].pipeline?.what, 'Running git push');
  assert.equal(rows[0].attention, 'blocked');
});

test("an agent's block is never captioned with the human's granted prompt", () => {
  // The registry keeps a message for as long as it holds the block, so a
  // session whose own prompt was granted still carries the text.
  const rows = build({
    sessions: [
      session({
        sessionId: 'human',
        cwd: '/Users/x/work/repo',
        state: 'blocked',
        stateSince: 1000,
        message: 'Claude needs your permission to use Edit',
      }),
      session({ sessionId: 'agent', cwd: AGENT_CWD, state: 'blocked', message: 'Needs permission to push' }),
    ],
    runs: [agentRun()],
    summaries: new Map([
      ['human', { title: null, activity: null, mode: null, lavishFile: null, lastActivityAt: 9000, pullRequest: null }],
    ]),
  });
  assert.equal(rows[0].attention, 'blocked');
  assert.equal(rows[0].message, 'Needs permission to push');
});

test('the agent lands on the run row when nobody else is in that repo', () => {
  const rows = build({
    sessions: [session({ sessionId: 'agent', cwd: AGENT_CWD })],
    runs: [agentRun({ step: { name: 'test', status: 'running', findings: 0 } })],
    summaries: new Map([
      ['agent', { title: null, activity: 'Running npm', mode: null, lavishFile: null, lastActivityAt: 9000, pullRequest: null }],
    ]),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'run');
  assert.equal(rows[0].pipeline?.what, 'Running npm');
  assert.equal(rows[0].lastActivityAt, 9000, "the agent's transcript beats the run's own clock");
});

test('an ordinary session is never mistaken for a pipeline agent', () => {
  // Its own tool stays its own: read off the session line, and never folded
  // into the pipeline's as though no-mistakes were running it.
  const rows = build({
    sessions: [session({ sessionId: 'human', cwd: '/Users/x/work/repo' })],
    runs: [agentRun({ step: { name: 'test', status: 'running', findings: 0 } })],
    summaries: new Map([
      ['human', { title: null, activity: 'Editing terrain.ts', mode: null, lavishFile: null, lastActivityAt: 9000, pullRequest: null }],
    ]),
  });
  assert.equal(rows[0].sessionId, 'human');
  assert.equal(rows[0].activity, 'Editing terrain.ts');
  assert.equal(rows[0].pipeline?.what, null);
});

test('the pipeline line does not blink out between two tool calls', () => {
  // `activity` is the tool with no result yet, so it is null every time one
  // call finishes before the next begins - most seconds, on a busy agent.
  // Rendering on it made the marker flash in and out several times a minute,
  // which on a pinned page reads as the pipeline starting and stopping. So
  // presence follows the *run*, and the accepted consequence is that between
  // two tool calls the line carries the step name alone.
  const between = new Map([
    ['agent', { title: 'Review the terrain change', activity: null, mode: null, lavishFile: null, lastActivityAt: 9000, pullRequest: null }],
  ]);
  const rows = build({
    sessions: [
      session({ sessionId: 'human', cwd: '/Users/x/work/repo' }),
      session({ sessionId: 'agent', cwd: AGENT_CWD }),
    ],
    runs: [agentRun({ step: { name: 'review', status: 'running', findings: 0 } })],
    summaries: between,
  });
  assert.ok(rows[0].pipeline, 'the line is still there between tools');
  assert.equal(rows[0].pipeline.step, 'review');
  assert.equal(rows[0].pipeline.what, null);
});

test("the pipeline line prefers the agent's live tool over the step's own report", () => {
  // Two sources for one line, most specific first: a step running a Claude
  // agent says what tool is in flight, and a step with no agent - the CI
  // monitor, which runs inside the daemon - has only its own last activity.
  const whatFor = (activity) =>
    build({
      sessions: [session({ sessionId: 'agent', cwd: AGENT_CWD })],
      runs: [
        agentRun({
          step: {
            name: 'ci',
            status: 'running',
            findings: 0,
            lastActivity: 'log: base branch advanced, re-arming CI monitor',
          },
        }),
      ],
      summaries: new Map([
        ['agent', { title: 'Review the change', activity, mode: null, lavishFile: null, lastActivityAt: 1, pullRequest: null }],
      ]),
    })[0].pipeline.what;

  assert.equal(whatFor('Reading terrain.ts'), 'Reading terrain.ts');
  assert.equal(whatFor(null), 'base branch advanced, re-arming CI monitor');
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

test('the notification type settles it outright, and the message is not consulted', () => {
  // Claude Code names the kind of notification it is sending, so the answer is
  // read rather than inferred. A type that says nudge is a nudge whatever the
  // wording, and a type that says permission prompt is a hard block even if the
  // message happens to contain the nudge's own words.
  assert.equal(isIdleNudge('reworded entirely', 'idle_prompt'), true);
  assert.equal(isIdleNudge('Claude is waiting for your input', 'permission_prompt'), false);
});

test('an unrecognised notification type is a hard block, not a fallback to the message', () => {
  // A type we do not know is new, not absent - Claude Code told us something
  // and we did not understand it. Reading the message underneath would be
  // guessing, and the safe guess here is the one that still asks for a human.
  assert.equal(isIdleNudge('Claude is waiting for your input', 'agent_needs_input'), false);
});

test('without a type at all, the message still decides', () => {
  // A session started under a Claude Code that predates the field, or one
  // whose record was written before this change. Nothing regresses for it.
  assert.equal(isIdleNudge('Claude is waiting for your input', null), true);
  assert.equal(isIdleNudge('Claude is waiting for your input', undefined), true);
  assert.equal(isIdleNudge('Claude needs your permission to use Bash', null), false);
});

test('a live pipeline answers a typed idle nudge', () => {
  const [row] = build({
    sessions: [
      session({
        state: 'blocked',
        stateSince: 5000,
        message: 'Claude is waiting for your input',
        notificationType: 'idle_prompt',
      }),
    ],
    runs: [],
    now: 6000,
    pipelines: new Set(['s1']),
  });
  assert.equal(row.attention, 'working');
});

test('a live pipeline does not answer a typed permission prompt', () => {
  const [row] = build({
    sessions: [
      session({
        state: 'blocked',
        stateSince: 5000,
        message: 'Claude needs your permission to use Bash',
        notificationType: 'permission_prompt',
      }),
    ],
    runs: [],
    now: 6000,
    pipelines: new Set(['s1']),
  });
  assert.equal(row.attention, 'blocked');
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
  const [row] = build({
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
  const [row] = build({
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
  const [row] = build({
    sessions: [
      session({ state: 'blocked', stateSince: 5000, message: 'Claude is waiting for your input' }),
    ],
    runs: [],
    now: 6000,
  });
  assert.equal(row.attention, 'blocked');
});

/**
 * A session sitting on Claude Code's sixty-second nudge, which is the one block
 * a human is allowed to say is not owed.
 */
const nudged = (over = {}) =>
  session({
    state: 'blocked',
    stateSince: 5000,
    blockAnnouncedAt: 5000,
    message: 'Claude is waiting for your input',
    notificationType: 'idle_prompt',
    ...over,
  });

test('an idle nudge offers a dismiss control, and says who may use it', () => {
  const [row] = build({ sessions: [nudged()], runs: [], now: 6000 });
  assert.equal(row.attention, 'blocked');
  assert.equal(row.dismissible, true);
  assert.equal(row.dismissed, false);
});

test('a dismissed idle nudge drops out of the waiting-for-you group', () => {
  const [row] = build({
    sessions: [nudged({ dismissedBlockAt: 5000 })],
    runs: [],
    now: 6000,
  });
  assert.equal(row.attention, 'idle');
  assert.equal(row.sessionState, 'idle');
  // Nothing is waiting, so nothing is being timed and nothing is being asked.
  assert.equal(row.waitingForMs, null);
  assert.equal(row.message, null);
});

test('a dismissed row says so, because a hidden signal is the failure it replaces', () => {
  const [row] = build({
    sessions: [nudged({ dismissedBlockAt: 5000 })],
    runs: [],
    now: 6000,
  });
  assert.equal(row.dismissed, true, 'the page and the CLI both render this');
  // And it offers no second dismissal: the row is not red, so there is nothing
  // left to answer.
  assert.equal(row.dismissible, false);
});

test('a new block announcement spends the dismissal with no further action', () => {
  // The whole safety of the feature. `blockAnnouncedAt` moves on *every* event
  // that says blocked, so a permission prompt arriving on a dismissed session
  // announces a new block, the two timestamps stop agreeing, and the row is red
  // again on the very next poll.
  const [row] = build({
    sessions: [
      nudged({
        dismissedBlockAt: 5000,
        blockAnnouncedAt: 9000,
        message: 'Claude needs your permission to use Bash',
        notificationType: 'permission_prompt',
      }),
    ],
    runs: [],
    now: 10000,
  });
  assert.equal(row.attention, 'blocked');
  assert.equal(row.message, 'Claude needs your permission to use Bash');
  assert.equal(row.dismissed, false);
  // And it is a permission prompt, so no control is offered on it at all.
  assert.equal(row.dismissible, false);
});

test('a second idle nudge is a new announcement too, so it asks again', () => {
  // A dismissal answers one announcement rather than a session. This is why the
  // key may never be `stateSince`, which would not have moved here and would
  // have made the dismissal permanent.
  const [row] = build({
    sessions: [nudged({ dismissedBlockAt: 5000, blockAnnouncedAt: 65000 })],
    runs: [],
    now: 66000,
  });
  assert.equal(row.attention, 'blocked');
  assert.equal(row.dismissible, true);
});

test('a permission prompt is never dismissible', () => {
  const [row] = build({
    sessions: [
      nudged({
        message: 'Claude needs your permission to use Bash',
        notificationType: 'permission_prompt',
      }),
    ],
    runs: [],
    now: 6000,
  });
  assert.equal(row.attention, 'blocked');
  assert.equal(row.dismissible, false);
});

test('a notification type we do not recognise is not dismissible either', () => {
  // `isIdleNudge` fails closed, and that polarity has to survive all the way to
  // the control: a block we cannot classify is a hard block, and a hard block
  // offers nothing to press.
  const [row] = build({
    sessions: [nudged({ notificationType: 'agent_needs_input' })],
    runs: [],
    now: 6000,
  });
  assert.equal(row.attention, 'blocked');
  assert.equal(row.dismissible, false);
});

test('a stale dismissal cannot suppress a permission prompt even keyed correctly', () => {
  // Defence in depth. Nothing should ever write a dismissal against a permission
  // prompt - the server refuses it - but if a record ever carried one, the state
  // rule holds it to `isIdleNudge` a second time and the block stands.
  const [row] = build({
    sessions: [
      nudged({
        dismissedBlockAt: 5000,
        message: 'Claude needs your permission to use Bash',
        notificationType: 'permission_prompt',
      }),
    ],
    runs: [],
    now: 6000,
  });
  assert.equal(row.attention, 'blocked');
});

test('a dismissal has nothing to say about a block held by the pipeline agent', () => {
  // The row is red because no-mistakes' own agent is stuck, which this session
  // cannot answer by looking at it. `dismissible` follows the session's own
  // state, never the row's attention.
  const runs = [run({ runId: 'r9', step: { name: 'review', findings: 0, lastActivity: null } })];
  const rows = build({
    sessions: [
      session({ sessionId: 's1', state: 'idle', stateSince: 1000 }),
      session({
        sessionId: 'agent',
        cwd: '/Users/x/.no-mistakes/worktrees/abc/r9',
        state: 'blocked',
        stateSince: 5000,
        blockAnnouncedAt: 5000,
        message: 'Claude is waiting for your input',
        notificationType: 'idle_prompt',
      }),
    ],
    runs,
    now: 6000,
  });
  const row = rows.find((r) => r.sessionId === 's1');
  assert.equal(row.attention, 'blocked', 'the folded agent still reddens the row');
  assert.equal(row.dismissible, false);
});

test('a dismissed session whose pipeline agent then blocks does not say dismissed', () => {
  // The word explains why a row is quiet, so beside a red "Waiting for you" it
  // is the exact confusion this page cannot afford: the row is asking for a
  // human on the agent's behalf while a marker says it was told not to, and the
  // marker's own promise - that the row goes red again next time it asks - has
  // already come true.
  const runs = [run({ runId: 'r9', step: { name: 'review', findings: 0, lastActivity: null } })];
  const rows = build({
    sessions: [
      nudged({ dismissedBlockAt: 5000 }),
      session({
        sessionId: 'agent',
        cwd: '/Users/x/.no-mistakes/worktrees/abc/r9',
        state: 'blocked',
        stateSince: 5000,
        blockAnnouncedAt: 5000,
        message: 'Claude needs your permission to use Bash',
        notificationType: 'permission_prompt',
      }),
    ],
    runs,
    now: 6000,
  });
  const row = rows.find((r) => r.sessionId === 's1');
  assert.equal(row.attention, 'blocked');
  assert.equal(row.dismissed, false);
});

test('a dismissed session the transcript disproves reads working, and only that', () => {
  // The transcript is the stronger evidence and "Working" is the more accurate
  // word, so the disproof deliberately wins the state. What must not ride along
  // is the marker: the dismissal is not why this row is quiet, and a row that is
  // not quiet has nothing to explain.
  const [row] = build({
    sessions: [nudged({ dismissedBlockAt: 5000 })],
    runs: [],
    summaries: new Map([['s1', { lastActivityAt: 60000 }]]),
    now: 61000,
  });
  assert.equal(row.attention, 'working');
  assert.equal(row.dismissed, false);
});

test('an unattributable run offers no dismissal - there is no session to answer', () => {
  const [row] = build({
    sessions: [],
    runs: [run({ parked: true, parkedSince: 1000 })],
    now: 6000,
  });
  assert.equal(row.kind, 'run');
  assert.equal(row.dismissible, false);
  assert.equal(row.dismissed, false);
});

test('a session with no announcement to answer cannot be dismissed', () => {
  // A record from a Claude Code old enough not to have sent one, or one written
  // before nmmon recorded it. There is nothing to key a dismissal on, so no
  // control is offered rather than one keyed on a guess.
  const [row] = build({
    sessions: [nudged({ blockAnnouncedAt: null })],
    runs: [],
    now: 6000,
  });
  assert.equal(row.attention, 'blocked');
  assert.equal(row.dismissible, false);
});

test('a row carries which agent is running it', () => {
  const rows = build({
    sessions: [session({ agent: 'pi' })],
    runs: [],
  });
  assert.equal(rows[0].agentKind, 'pi');
});

test('a session record written before pi existed is Claude Code', () => {
  // The field is simply absent on every record already on disk.
  const rows = build({ sessions: [session()], runs: [] });
  assert.equal(rows[0].agentKind, 'claude');
});

test('a row carries which tool started its window, when one declared itself', () => {
  const rows = build({
    sessions: [session()],
    runs: [],
    spawnedBy: new Map([['s1', 'firstmate']]),
  });
  assert.equal(rows[0].spawnedBy, 'firstmate');
});

test('a session nobody in particular started claims nothing', () => {
  // Positive evidence or nothing: an absent answer is the ordinary case, not a
  // gap to guess at. Most sessions on this page are ones you started yourself.
  const rows = build({ sessions: [session()], runs: [] });
  assert.equal(rows[0].spawnedBy, null);
});

test('a run with no session behind it has no window for anyone to have started', () => {
  const rows = build({ sessions: [], runs: [run()] });
  assert.equal(rows[0].spawnedBy, null);
});

test('a run with no session behind it claims no agent', () => {
  // Nobody is running it - it is a pipeline the database knows about - and
  // naming an agent there would be an invention.
  const rows = build({ sessions: [], runs: [run()] });
  assert.equal(rows[0].agentKind, null);
});

// ---------------------------------------------------------------- the model
//
// These pin the reframing this tool went through: the session is the unit, and
// a no-mistakes run is an *attribute* of one. Everything below follows from
// that - a run may not displace what the session is doing, may not be claimed
// by a session that is not on its branch, and may not be shown at all once it
// has passed. Each one replaces a decision written when a run was the subject.

test('an active pipeline does not displace what the session is working on', () => {
  // The step used to overwrite the summary outright, so the moment no-mistakes
  // started you lost sight of what you had been talking to the session about -
  // and the two are concurrent, not alternatives.
  const rows = build({
    sessions: [session({ sessionId: 's1' })],
    runs: [run({ runId: 'r1', step: { name: 'test', status: 'running', findings: 0 } })],
    summaries: new Map([['s1', { title: 'Make app optional for phase one' }]]),
    branches: new Map([['s1', 'main']]),
    now: 5000,
  });
  assert.equal(rows[0].summary, 'Make app optional for phase one');
  assert.equal(rows[0].pipeline?.step, 'test');
});

test('the pipeline line says what no-mistakes is doing when no agent exists', () => {
  // The CI monitor runs inside the no-mistakes daemon, so there is no agent
  // session to fold in - and `step.lastActivity` was already reaching the page
  // and being thrown away. This is the case that reads as "nothing attributed".
  const rows = build({
    sessions: [session({ sessionId: 's1' })],
    runs: [
      run({
        runId: 'r1',
        step: {
          name: 'ci',
          status: 'running',
          findings: 0,
          lastActivity: 'log: base branch advanced (25185a53..b42e9299), re-arming CI monitor',
        },
      }),
    ],
    branches: new Map([['s1', 'main']]),
    now: 5000,
  });
  assert.equal(rows[0].pipeline?.step, 'ci');
  assert.match(rows[0].pipeline?.what, /base branch advanced/);
  // The `log: ` prefix is a transport detail, not something to read on a card.
  assert.doesNotMatch(rows[0].pipeline?.what, /^log:/);
});

test('a failed step says why, on the one card that must not go quiet', () => {
  // Verbatim from the live database, where `step failed:` is the commonest
  // prefix after `status:` - 79 rows of it. The allowlist knew only `log:`, so
  // the reason a run failed was thrown away and the failed card, the one thing
  // this page deliberately keeps after a run ends, showed a step name and an
  // empty tail. The prefix is kept here: without it the reason reads as
  // something the step is doing rather than how it ended.
  const rows = build({
    sessions: [session({ sessionId: 's1' })],
    runs: [
      run({
        runId: 'r1',
        status: 'failed',
        active: false,
        step: {
          name: 'push',
          status: 'failed',
          findings: 0,
          lastActivity: 'step failed: push to upstream: exit status 1',
        },
      }),
    ],
    branches: new Map([['s1', 'main']]),
    now: 5000,
  });
  assert.equal(rows[0].pipeline?.what, 'step failed: push to upstream: exit status 1');
});

test('a status line, and a prefix no-mistakes has yet to invent, are both dropped', () => {
  // `status:` restates the step status the line above already carries. An
  // unrecognised prefix is dropped for a different reason: the vocabulary is
  // no-mistakes' to grow, and an allowlist is what stops the next thing it adds
  // arriving on a card raw.
  const what = (lastActivity) =>
    build({
      sessions: [session({ sessionId: 's1' })],
      runs: [run({ runId: 'r1', step: { name: 'ci', status: 'running', findings: 0, lastActivity } })],
      branches: new Map([['s1', 'main']]),
      now: 5000,
    })[0].pipeline?.what;
  assert.equal(what('status: completed'), null);
  assert.equal(what('telemetry: 41 spans flushed'), null);
  // And the line itself still renders, because presence follows the run.
  assert.equal(
    build({
      sessions: [session({ sessionId: 's1' })],
      runs: [run({ runId: 'r1', step: { name: 'ci', status: 'running', findings: 0, lastActivity: 'status: completed' } })],
      branches: new Map([['s1', 'main']]),
      now: 5000,
    })[0].pipeline?.step,
    'ci',
  );
});

test('the branch narrows which run a card shows, never what the card is called', () => {
  // One value was doing both jobs, so gating it by branch quietly renamed the
  // card. A session in a subdirectory, on a branch none of the repo's runs are
  // on, retitled itself from `repo` to `api` - and flipped back the moment a run
  // on its branch entered the reading, changing name under the person reading
  // it. Identity comes from the session's own path now; only the run moves.
  const rowFor = (branch) =>
    build({
      sessions: [session({ sessionId: 's1', cwd: '/Users/x/work/repo/packages/api' })],
      runs: [run({ runId: 'r1', branch: 'main' })],
      branches: new Map([['s1', branch]]),
      now: 5000,
    }).find((r) => r.kind === 'session');

  const onIt = rowFor('main');
  const offIt = rowFor('feat/x');
  assert.equal(offIt.title, onIt.title, 'the name does not move with the branch');
  assert.equal(offIt.titlePath, onIt.titlePath);
  assert.equal(offIt.title, 'repo');
  assert.equal(offIt.titlePath, '/Users/x/work/repo');
  // And the thing the branch is there to narrow is still narrowed.
  assert.equal(onIt.run?.runId, 'r1');
  assert.equal(offIt.run, null);
});

test('a checkout does not inherit a run from another branch', () => {
  // The rule used to stop at the worktree link: a session sitting in the repo
  // matched by path alone, so an idle `main` card claimed a live pipeline on a
  // branch it was not on, with a Focus button to a window that could not answer
  // its gate.
  const rows = build({
    sessions: [session({ sessionId: 's1', cwd: '/Users/x/work/repo' })],
    runs: [run({ runId: 'r1', branch: 'feat/elsewhere', parked: true })],
    branches: new Map([['s1', 'main']]),
    now: 5000,
  });
  assert.equal(rows.find((r) => r.sessionId === 's1').run, null);
  assert.equal(rows.find((r) => r.sessionId === 's1').attention, 'working');
});

test('a passed run drops off the card; a failed one stays', () => {
  // Being back on a branch with a finished run means that task is done - except
  // when it failed, which is unfinished business and the case you most need the
  // card to keep saying something about.
  const passed = build({
    sessions: [session({ sessionId: 's1' })],
    runs: [run({ runId: 'r1', status: 'completed', active: false })],
    branches: new Map([['s1', 'main']]),
    now: 5000,
  });
  assert.equal(passed.find((r) => r.sessionId === 's1').run, null);
  assert.equal(passed.length, 1, 'and it does not fall through to a card of its own');

  const failed = build({
    sessions: [session({ sessionId: 's1' })],
    runs: [run({ runId: 'r1', status: 'failed', active: false })],
    branches: new Map([['s1', 'main']]),
    now: 5000,
  });
  assert.equal(failed.find((r) => r.sessionId === 's1').run?.runId, 'r1');
});

test('a status no-mistakes has yet to invent stays on the page', () => {
  // Only the two quiet endings are named, so a word added later - `timed_out`
  // here, which does not exist today - cannot be dropped in silence. This fails
  // *open*, the opposite way round to `isRunOwnerCommand`: an unrecognised
  // driving verb must not claim a run, and an unrecognised status must not hide
  // one.
  const rows = build({
    sessions: [session({ sessionId: 's1' })],
    runs: [run({ runId: 'r1', status: 'timed_out', active: false })],
    branches: new Map([['s1', 'main']]),
    now: 5000,
  });
  assert.equal(rows.find((r) => r.sessionId === 's1').run?.runId, 'r1');

  // And a run you cancelled still leaves. `ACTIVE_STATUSES` is an allowlist, so
  // the two are only ever told apart by the word.
  const cancelled = build({
    sessions: [session({ sessionId: 's1' })],
    runs: [run({ runId: 'r1', status: 'cancelled', active: false })],
    branches: new Map([['s1', 'main']]),
    now: 5000,
  });
  assert.equal(cancelled.find((r) => r.sessionId === 's1').run, null);
  assert.equal(cancelled.length, 1);
});

test('a status no-mistakes has yet to invent is never rendered as a failure', () => {
  // Being on the page is knowledge; being red is a claim. An unknown word could
  // be a new ending (`errored`) or a new running state (`queued`) - and
  // `ACTIVE_STATUSES` is an allowlist, so it is not `active` either way. Red
  // that sometimes means nothing is wrong is how this page stops being
  // believed, so it shows as work in progress instead.
  const unknown = run({ runId: 'r1', status: 'timed_out', active: false });
  assert.equal(attentionFor({ session: null, run: unknown }), 'working');
  assert.equal(attentionFor({ session: { state: 'idle' }, run: unknown }), 'idle');

  // The one known ending that stays on the page is untouched: `failed` is still
  // a failure. The quiet ones have no state of their own to assert - they leave
  // the page entirely, which the test above is what checks.
  assert.equal(
    attentionFor({ session: null, run: run({ status: 'failed', active: false }) }),
    'failed',
  );

  const rows = build({
    sessions: [session({ sessionId: 's1' })],
    runs: [unknown],
    branches: new Map([['s1', 'main']]),
    now: 5000,
  });
  assert.equal(rows.find((r) => r.sessionId === 's1').attention, 'working');
});

test('a run nobody can be tied to gets one honest card, never a false attribute', () => {
  // The old rule put an unattributed run on every session in its repo, on the
  // grounds that showing it three times beat showing it never. Under a
  // session-centric model that is two wrong cards and one right one, and you
  // cannot tell which is which - so it is shown once and says what it is.
  const rows = build({
    sessions: [
      session({ sessionId: 'a', cwd: '/Users/x/work/repo' }),
      session({ sessionId: 'b', cwd: '/Users/x/.treehouse/repo-9f/2/repo' }),
    ],
    runs: [run({ runId: 'r1', branch: 'feat/nobody-here', parked: true })],
    branches: new Map([
      ['a', 'main'],
      ['b', 'feat/other'],
    ]),
    mainCheckouts: new Map([['b', '/Users/x/work/repo']]),
    now: 5000,
  });
  const sessions = rows.filter((r) => r.kind === 'session');
  const runRows = rows.filter((r) => r.kind === 'run');
  assert.deepEqual(sessions.map((r) => r.run), [null, null], 'no session claims it');
  assert.equal(runRows.length, 1);
  assert.equal(runRows[0].attributable, false);
  // Both sessions resolve to the same logical repo, worktree included, so the
  // card can say how many windows it might belong to instead of guessing.
  assert.equal(runRows[0].candidateSessions, 2);
});

test('an unattributable run sorts below every session, whatever its state', () => {
  // It cannot be focused, so it must never outrank a card you can act on - even
  // parked, which normally outranks working.
  const rows = build({
    sessions: [session({ sessionId: 'a', state: 'idle' })],
    runs: [run({ runId: 'r1', branch: 'feat/nobody-here', parked: true })],
    branches: new Map([['a', 'main']]),
    now: 5000,
  });
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['session', 'run'],
  );
});
