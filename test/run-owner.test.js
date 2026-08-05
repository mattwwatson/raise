import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RunOwners } from '../src/run-owner.js';

const session = (overrides = {}) => ({
  sessionId: 's1',
  cwd: '/Users/x/work/repo',
  host: { pid: 100 },
  ...overrides,
});

const run = (overrides = {}) => ({
  runId: 'r1',
  repoPath: '/Users/x/work/repo',
  branch: 'main',
  active: true,
  ...overrides,
});

test('a run is owned by the session first seen driving it', () => {
  const owners = new RunOwners();
  owners.observe('r1', 's1');
  assert.equal(owners.ownerOf('r1'), 's1');
});

test('ownership does not change hands', () => {
  // `axi run` holds the run for minutes and is seen on the first poll, so a
  // later sighting is another session running a driving command in the same
  // repo - not a handover. Letting it win would take the row off the session
  // that actually started the pipeline.
  const owners = new RunOwners();
  owners.observe('r1', 's1');
  owners.observe('r1', 's2');
  assert.equal(owners.ownerOf('r1'), 's1');
});

test('a run nobody was seen to drive has no owner', () => {
  const owners = new RunOwners();
  assert.equal(owners.ownerOf('r1'), null);
  assert.equal(owners.ownerOf(null), null);
});

test('a sighting missing either half is not a sighting', () => {
  const owners = new RunOwners();
  owners.observe(null, 's1');
  owners.observe('r1', null);
  assert.equal(owners.owners.size, 0);
});

test('an owner is forgotten once its run drops out of the reading', () => {
  const owners = new RunOwners();
  owners.observe('r1', 's1');
  owners.observe('r2', 's2');
  owners.prune(new Set(['r2']));
  assert.equal(owners.ownerOf('r1'), null);
  assert.equal(owners.ownerOf('r2'), 's2');
});

test('the map handed to buildRows is what was observed', () => {
  const owners = new RunOwners();
  owners.observe('r1', 's1');
  assert.deepEqual([...owners.owners], [['r1', 's1']]);
});

test('a live session cannot take a run off another live session', () => {
  // The guarantee release must not weaken: while both are registered, the one
  // seen driving first keeps the row, because the later sighting is a session
  // running a driving command near the end of somebody else's pipeline.
  const owners = new RunOwners();
  owners.observe('r1', 's1');
  owners.release(new Set(['s1', 's2']));
  owners.observe('r1', 's2');
  assert.equal(owners.ownerOf('r1'), 's1');
});

test('a run is released once its owner is no longer registered', () => {
  const owners = new RunOwners();
  owners.observe('r1', 's1');
  owners.release(new Set(['s2']));
  assert.equal(owners.ownerOf('r1'), null);
});

test('the session that drives a released run takes it over', () => {
  // The owning window closed while the run sat at a gate - `axi run` returns
  // there - and another session answered it with `axi respond`. Held by the
  // departed owner, the run showed on nobody's card and fell through to a row
  // with no Focus button: this memory's own purpose inverted.
  const owners = new RunOwners();
  owners.observe('r1', 's1');
  owners.release(new Set(['s2']));
  owners.observe('r1', 's2');
  assert.equal(owners.ownerOf('r1'), 's2');
  assert.deepEqual([...owners.owners], [['r1', 's2']]);
});

test('releasing one departed owner leaves the live ones alone', () => {
  const owners = new RunOwners();
  owners.observe('r1', 's1');
  owners.observe('r2', 's2');
  owners.release(new Set(['s2']));
  assert.equal(owners.ownerOf('r1'), null);
  assert.equal(owners.ownerOf('r2'), 's2');
});

test('observeFrom records the sessions seen driving, and only those', () => {
  const owners = new RunOwners();
  owners.observeFrom(
    [session({ sessionId: 'driver' }), session({ sessionId: 'bystander' })],
    [run()],
    (s) => s.sessionId === 'driver',
    new Map(),
    new Map([
      ['driver', 'main'],
      ['bystander', 'main'],
    ]),
  );
  assert.deepEqual([...owners.owners], [['r1', 'driver']]);
});

test('a finished run cannot be owned', () => {
  // The rule both callers share: a driving command seen while the newest match
  // for that directory is a run that already ended would otherwise claim it.
  const owners = new RunOwners();
  owners.observeFrom(
    [session()],
    [run({ active: false })],
    () => true,
    new Map(),
    new Map([['s1', 'main']]),
  );
  assert.equal(owners.owners.size, 0);
});

test('a session driving in a directory no run covers owns nothing', () => {
  const owners = new RunOwners();
  owners.observeFrom(
    [session({ cwd: '/Users/x/work/elsewhere' })],
    [run()],
    () => true,
    new Map(),
    new Map([['s1', 'main']]),
  );
  assert.equal(owners.owners.size, 0);
});

test('a session in the checkout owns the run on its own branch, not the parked one', () => {
  // Several runs on one `repoPath` is the ordinary reading now that every
  // worktree's run registers against the main checkout. Resolved by rank, this
  // sighting claims the parked run - `rankRun` puts parked above active, and a
  // parked run *is* active, so the "only an active run can be owned" guard does
  // not catch it - and the session actually driving `axi run` loses its row.
  const owners = new RunOwners();
  owners.observeFrom(
    [session({ sessionId: 'driver' })],
    [
      run({ runId: 'parked', branch: 'feat/other', parked: true }),
      run({ runId: 'mine', branch: 'feat/mine' }),
    ],
    () => true,
    new Map(),
    new Map([['driver', 'feat/mine']]),
  );
  assert.deepEqual([...owners.owners], [['mine', 'driver']]);
});

test('a driving session with no branch of its own owns nothing', () => {
  // A detached HEAD in the checkout itself, same rule as through the link:
  // ownership is a question about a branch, so with none there is no answer,
  // and the run falls back to showing on every session in its repo.
  const owners = new RunOwners();
  owners.observeFrom(
    [session({ sessionId: 'detached' })],
    [run()],
    () => true,
    new Map(),
    new Map([['detached', null]]),
  );
  assert.equal(owners.owners.size, 0);
});

test('a session driving from a worktree owns the run in its main checkout', () => {
  // The sighting was there all along - the process table saw `no-mistakes axi
  // run` under the worktree session - and it was thrown away here, because
  // `matchRunForCwd` had nothing to match a worktree path against. The run then
  // fell through to every session in the main checkout, unowned.
  const owners = new RunOwners();
  const cwd = '/Users/x/.treehouse/repo-9f/2/repo';
  owners.observeFrom(
    [session({ sessionId: 'worktree', cwd })],
    [run()],
    () => true,
    new Map([['worktree', '/Users/x/work/repo']]),
    new Map([['worktree', 'main']]),
  );
  assert.deepEqual([...owners.owners], [['r1', 'worktree']]);
});

test('a link to a checkout with no run still owns nothing', () => {
  const owners = new RunOwners();
  owners.observeFrom(
    [session({ sessionId: 'worktree', cwd: '/Users/x/.treehouse/other-9f/1/other' })],
    [run()],
    () => true,
    new Map([['worktree', '/Users/x/work/other']]),
    new Map([['worktree', 'main']]),
  );
  assert.equal(owners.owners.size, 0);
});

test('each worktree driving a run owns the one on its own branch', () => {
  // Two trees of one checkout, two runs registered against that one path. The
  // sighting has to resolve exactly as the page resolves it, or the second
  // tree's genuine `axi run` claims the *first* tree's run, is discarded as
  // already owned, and the run it was really of is left to fall through to a
  // bystander - this feature's failure mode, reached through its own fix.
  const owners = new RunOwners();
  owners.observeFrom(
    [
      session({ sessionId: 'a', cwd: '/Users/x/.treehouse/repo-9f/1/repo' }),
      session({ sessionId: 'b', cwd: '/Users/x/.treehouse/repo-9f/2/repo' }),
    ],
    [run({ runId: 'ra', branch: 'feat/a' }), run({ runId: 'rb', branch: 'feat/b' })],
    () => true,
    new Map([
      ['a', '/Users/x/work/repo'],
      ['b', '/Users/x/work/repo'],
    ]),
    new Map([
      ['a', 'feat/a'],
      ['b', 'feat/b'],
    ]),
  );
  assert.deepEqual(
    [...owners.owners].sort(),
    [
      ['ra', 'a'],
      ['rb', 'b'],
    ].sort(),
  );
});

test('a worktree with no branch of its own claims nothing through the link', () => {
  // A detached HEAD - Treehouse produces them routinely - has nothing to match
  // on, and guessing by rank would hand a sibling's run to the wrong session.
  const owners = new RunOwners();
  owners.observeFrom(
    [session({ sessionId: 'detached', cwd: '/Users/x/.treehouse/repo-9f/1/repo' })],
    [run()],
    () => true,
    new Map([['detached', '/Users/x/work/repo']]),
    new Map([['detached', null]]),
  );
  assert.equal(owners.owners.size, 0);
});
