import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  ASSERTION_MAX_AGE_MS,
  CAPTAIN_UNREADABLE,
  FirstmateDecisions,
  MAX_CONSECUTIVE_FAILURES,
  REFRESH_MS,
  parseSnapshot,
  windowFromTarget,
} from '../src/firstmate-decisions.js';
import {
  APX_412,
  APX_412_WORKTREE,
  RAISE_25,
  ZED_207,
  fleetSnapshotJson,
} from './fixtures/fm-fleet-snapshot.js';

/**
 * Let the fired-and-forgotten read settle.
 *
 * `#read` is a promise chain over an async runner, so a single microtask is not
 * enough - and a test that waited one would pass or fail on how many `.then`s
 * the implementation happens to have.
 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const HOME = '/Users/x/work/firstmate';
const SCRIPT = join(HOME, 'bin', 'fm-fleet-snapshot.sh');

/**
 * A status directory that answers, with a signature the test can move.
 *
 * `stat` is keyed on the file name so a test can touch one status log without
 * touching the others, which is what the mtime gate is actually watching for.
 */
function files({ names = ['crew.status'], mtimes = {} } = {}) {
  return {
    readdir: () => [...names, 'crew.meta', '.lock'],
    stat: (path) => ({ size: 1, mtimeMs: mtimes[path.split('/').pop()] ?? 1 }),
  };
}

// ----------------------------------------------------------------- the parse

test('the snapshot is read into one task per crewmate, with its decisions', () => {
  const tasks = parseSnapshot(fleetSnapshotJson());
  assert.equal(tasks.length, 3);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // The window name is `endpoint.target` past the tmux session, which is the
  // same pinned `fm-<id>` firstmate.js keys crewmates on.
  assert.equal(byId.get(APX_412).window, `fm-${APX_412}`);
  assert.equal(byId.get(APX_412).worktree, APX_412_WORKTREE);
});

test('four open decisions on one crewmate are read as four', () => {
  // The case that makes this item non-hypothetical: built for one decision, the
  // first version would have shown a quarter of what was waiting.
  const tasks = parseSnapshot(fleetSnapshotJson());
  const apx = tasks.find((t) => t.id === APX_412);
  assert.equal(apx.decisions.length, 4);
  assert.deepEqual(
    apx.decisions.map((d) => d.key),
    [
      'apx-412-review-gate',
      'apx-412-numbers-confirmed',
      'apx-412-flag-ticket',
      'apx-412-migration-order',
    ],
  );
  // Both verbs open a decision, and which one it is survives the read: `blocked`
  // is a crewmate hard-stopped, `needs-decision` one that has stopped to ask.
  assert.deepEqual(
    apx.decisions.map((d) => d.verb),
    ['needs-decision', 'needs-decision', 'needs-decision', 'blocked'],
  );
  // Most recently opened last, which is the order the fold returns.
  assert.equal(apx.decisions[3].key, 'apx-412-migration-order');
  // The summary survives the read as written, which is the whole of what a
  // renderer downstream depends on. It is the fixture's stand-in text rather
  // than the crewmate's own words - see that file's header for why they are not
  // in this repository.
  assert.match(apx.decisions[0].summary, /^Stand-in text\. The dependency audit/);
});

test('a decision the crew has moved past is not in the reading at all', () => {
  // zed-207's status log carries seven unclosed `needs-decision` lines and its
  // `open_decisions` is empty, because firstmate reconciled the fold against a
  // live run-step. Nothing here re-derives that; the whole point is that we do
  // not have to.
  const tasks = parseSnapshot(fleetSnapshotJson());
  assert.deepEqual(tasks.find((t) => t.id === ZED_207).decisions, []);
  assert.deepEqual(tasks.find((t) => t.id === RAISE_25).decisions, []);
});

test('a reading we did not get is null, and a reading of nothing is an empty list', () => {
  // The distinction the caller depends on: `null` keeps the previous answer,
  // `[]` replaces it. An empty output, unparseable output and a schema we have
  // not read are all failures to read; a snapshot with no tasks is an answer.
  assert.equal(parseSnapshot(''), null);
  assert.equal(parseSnapshot(null), null);
  assert.equal(parseSnapshot('not json at all'), null);
  assert.equal(parseSnapshot(JSON.stringify({ schema: 'fm-fleet-snapshot.v2', tasks: [] })), null);
  assert.equal(parseSnapshot(JSON.stringify({ schema: 'fm-fleet-snapshot.v1' })), null);
  assert.deepEqual(parseSnapshot(JSON.stringify({ schema: 'fm-fleet-snapshot.v1', tasks: [] })), []);
});

test('a task or a decision that does not fit is skipped rather than guessed at', () => {
  const out = JSON.stringify({
    schema: 'fm-fleet-snapshot.v1',
    tasks: [
      { kind: 'ship' },
      { id: '   ' },
      {
        id: 'good',
        hints: {
          open_decisions: [
            null,
            { key: 'k', summary: 'no verb, so not a decision we can name' },
            { verb: 'needs-decision', summary: 'a fold with no key still folded something' },
            { key: 'real', verb: 'blocked', summary: 'held' },
          ],
        },
      },
    ],
  });
  const tasks = parseSnapshot(out);
  assert.deepEqual(
    tasks.map((t) => t.id),
    ['good'],
  );
  assert.deepEqual(tasks[0].decisions, [
    // No key is `default`, which is the key the fold's own grammar gives an
    // untagged line - a stand-in, never a reason to drop what is waiting.
    { key: 'default', verb: 'needs-decision', summary: 'a fold with no key still folded something' },
    { key: 'real', verb: 'blocked', summary: 'held' },
  ]);
  // No endpoint and no worktree is a task nothing can be joined to, which is a
  // fact about it rather than a reason to refuse it.
  assert.equal(tasks[0].window, null);
  assert.equal(tasks[0].worktree, null);
});

test('the window name is the target past the tmux session, split on the first colon', () => {
  assert.equal(windowFromTarget('firstmate:fm-apx-412'), 'fm-apx-412');
  // A window name containing a colon survives whole; only the session is taken
  // off the front.
  assert.equal(windowFromTarget('firstmate:fm-a:b'), 'fm-a:b');
  assert.equal(windowFromTarget('fm-lonely'), 'fm-lonely');
  assert.equal(windowFromTarget(''), null);
  assert.equal(windowFromTarget('firstmate:'), null);
  assert.equal(windowFromTarget(undefined), null);
});

// ------------------------------------------------------------------ the gate

test('with no home nothing is asked, and no subprocess runs', async () => {
  // A machine without firstmate has no captain, so there is no home to pass and
  // this is the whole of the guarantee that it stays quiet.
  const ran = [];
  const decisions = new FirstmateDecisions({
    execAsync: async (cmd, args) => {
      ran.push([cmd, args]);
      return fleetSnapshotJson();
    },
    files: files(),
  });
  decisions.refresh(null);
  decisions.refresh(undefined);
  await decisions.load(null);
  assert.deepEqual(ran, []);
  assert.deepEqual(decisions.tasks, []);
});

test('the snapshot is run once and then not again until a status log moves', async () => {
  let runs = 0;
  const mtimes = { 'crew.status': 1 };
  const decisions = new FirstmateDecisions({
    execAsync: async () => {
      runs += 1;
      return fleetSnapshotJson();
    },
    files: files({ mtimes }),
  });

  decisions.refresh(HOME, 0);
  await settle();
  assert.equal(runs, 1);

  // Well past the floor, short of the ceiling, and nothing has moved.
  decisions.refresh(HOME, REFRESH_MS * 5);
  await settle();
  assert.equal(runs, 1, 'a steady state costs nothing at all');

  // A crewmate writes to its own event log.
  mtimes['crew.status'] = 2;
  decisions.refresh(HOME, REFRESH_MS * 6);
  await settle();
  assert.equal(runs, 2);
});

test('the floor holds even when a status log has moved', async () => {
  // Stamped when the read goes out rather than when it returns, so a command
  // taking tens of seconds is never retried on the next one-second tick.
  let runs = 0;
  const mtimes = { 'crew.status': 1 };
  const decisions = new FirstmateDecisions({
    execAsync: async () => {
      runs += 1;
      return fleetSnapshotJson();
    },
    files: files({ mtimes }),
  });
  decisions.refresh(HOME, 0);
  await settle();
  assert.equal(runs, 1);

  mtimes['crew.status'] = 2;
  decisions.refresh(HOME, REFRESH_MS - 1);
  await settle();
  assert.equal(runs, 1);

  decisions.refresh(HOME, REFRESH_MS);
  await settle();
  assert.equal(runs, 2);
});

test('a reading being taken is never overlapped by another', async () => {
  // The command is bash walking a fleet. Two at once would be two of them.
  let runs = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const decisions = new FirstmateDecisions({
    execAsync: async () => {
      runs += 1;
      await pending;
      return fleetSnapshotJson();
    },
    files: files({ mtimes: { 'crew.status': 1 } }),
  });
  decisions.refresh(HOME, 0);
  decisions.refresh(HOME, REFRESH_MS * 10);
  await settle();
  assert.equal(runs, 1);
  release();
});

test('while decisions are open the reading is re-taken even if no status log moves', async () => {
  // The mtime gate cannot see the reconciliation: a decision clears when the
  // crew resumes past it, and a live run-step or a busy pane touches no file.
  // So a silence needs no refresh - opening a decision always writes a status
  // line - and an assertion does.
  let runs = 0;
  const decisions = new FirstmateDecisions({
    execAsync: async () => {
      runs += 1;
      return fleetSnapshotJson();
    },
    files: files({ mtimes: { 'crew.status': 1 } }),
  });
  decisions.refresh(HOME, 0);
  await settle();
  assert.equal(runs, 1);
  assert.equal(decisions.tasks.some((t) => t.decisions.length > 0), true);

  decisions.refresh(HOME, ASSERTION_MAX_AGE_MS - 1);
  await settle();
  assert.equal(runs, 1);

  decisions.refresh(HOME, ASSERTION_MAX_AGE_MS);
  await settle();
  assert.equal(runs, 2);
});

test('a fleet with nothing open is not re-read on the ceiling', async () => {
  // The other half of the rule above, and the reason it costs nothing: with no
  // assertion standing there is nothing that can go stale, and a new decision
  // always writes a status line the gate can see.
  let runs = 0;
  const decisions = new FirstmateDecisions({
    execAsync: async () => {
      runs += 1;
      return JSON.stringify({ schema: 'fm-fleet-snapshot.v1', tasks: [] });
    },
    files: files({ mtimes: { 'crew.status': 1 } }),
  });
  decisions.refresh(HOME, 0);
  await settle();
  assert.equal(runs, 1);
  decisions.refresh(HOME, ASSERTION_MAX_AGE_MS * 10);
  await settle();
  assert.equal(runs, 1);
});

test('a failing or empty snapshot leaves the previous reading in place', async () => {
  // A reading we did not get is not evidence. firstmate mid-upgrade, a script
  // that is not there and a timeout all arrive here, and clearing on any of
  // them would take every ruling off the page at once.
  let answer = fleetSnapshotJson();
  const mtimes = { 'crew.status': 1 };
  const decisions = new FirstmateDecisions({
    execAsync: async () => {
      if (answer === null) throw new Error('bash: no such file');
      return answer;
    },
    files: files({ mtimes }),
  });
  decisions.refresh(HOME, 0);
  await settle();
  const before = decisions.tasks;
  assert.equal(before.length, 3);

  answer = null;
  mtimes['crew.status'] = 2;
  decisions.refresh(HOME, REFRESH_MS);
  await settle();
  assert.equal(decisions.tasks, before, 'a failed command is not an answer');

  answer = '';
  mtimes['crew.status'] = 3;
  decisions.refresh(HOME, REFRESH_MS * 2);
  await settle();
  assert.equal(decisions.tasks, before, 'and neither is empty output');
});

test('a snapshot that can never succeed eventually drops the reading it was holding', async () => {
  // The other half of `ASSERTION_MAX_AGE_MS`. The ceiling re-dispatches, and a
  // re-dispatch that always fails replaces nothing - so the assertion would
  // stand for the life of the process while a fourteen-second bash ran every
  // thirty seconds to keep it looking fresh. An assertion may not outlive its
  // evidence, and this is the reachable case: a schema bump we refuse by
  // design, the script renamed by an upgrade, or output past `exec.js`'s 1MB
  // cap.
  let answer = fleetSnapshotJson();
  const mtimes = { 'crew.status': 1 };
  let runs = 0;
  const decisions = new FirstmateDecisions({
    execAsync: async () => {
      runs += 1;
      if (answer === null) throw new Error('bash: no such file or directory');
      return answer;
    },
    files: files({ mtimes }),
  });
  decisions.refresh(HOME, 0);
  await settle();
  assert.equal(decisions.tasks.length, 3);

  // The script goes away, and the reading is held through the first failures -
  // a timeout on a busy machine must never take the rulings off the page.
  answer = null;
  let at = 0;
  for (let failure = 1; failure < MAX_CONSECUTIVE_FAILURES; failure += 1) {
    at += ASSERTION_MAX_AGE_MS;
    decisions.refresh(HOME, at);
    await settle();
    assert.equal(runs, failure + 1, `failure ${failure} was re-dispatched`);
    assert.equal(decisions.tasks.length, 3, `failure ${failure} held the reading`);
  }

  // And past the ceiling it is dropped rather than held.
  at += ASSERTION_MAX_AGE_MS;
  decisions.refresh(HOME, at);
  await settle();
  assert.deepEqual(decisions.tasks, [], 'a refresh that can never succeed is not evidence');

  // Dropping it does not stop the retry, and nothing here touches a status
  // file. Waiting for one would be waiting for the very thing a stopped
  // crewmate cannot do: it wrote its `needs-decision` line before all this and
  // will write nothing further, so a gate that waits for a write is a gate that
  // never opens and the crewmate is a quiet card again for good.
  const dropped = runs;
  at += ASSERTION_MAX_AGE_MS;
  decisions.refresh(HOME, at);
  await settle();
  assert.equal(runs, dropped + 1, 'a failing state keeps trying with no status file moving');
  assert.deepEqual(decisions.tasks, [], 'and holds nothing while it does');

  // And a snapshot that starts working again restores the reading on its own.
  answer = fleetSnapshotJson();
  at += ASSERTION_MAX_AGE_MS;
  decisions.refresh(HOME, at);
  await settle();
  assert.equal(decisions.tasks.length, 3, 'the reading comes back when the snapshot does');

  // The count is reset by that success, so the ceiling stops costing anything:
  // a healthy fleet with nothing open is back to paying only the mtime gate.
  answer = JSON.stringify({ schema: 'fm-fleet-snapshot.v1', tasks: [] });
  mtimes['crew.status'] = 2;
  at += ASSERTION_MAX_AGE_MS;
  decisions.refresh(HOME, at);
  await settle();
  assert.deepEqual(decisions.tasks, []);
  const healthy = runs;
  decisions.refresh(HOME, at + ASSERTION_MAX_AGE_MS * 10);
  await settle();
  assert.equal(runs, healthy, 'healthy and asserting nothing pays no ceiling');
});

test('a captain lock we could not read is counted like any other missed reading', async () => {
  // The route that used to have no ceiling on it at all: the caller skipped the
  // refresh outright, so nothing advanced and the rulings were held for as long
  // as the lock stayed unreadable - which for a `state/.lock` directory is for
  // ever. It is the same fact as a snapshot that would not run, so it goes
  // through the same counter and the same ceiling.
  let runs = 0;
  const decisions = new FirstmateDecisions({
    execAsync: async () => {
      runs += 1;
      return fleetSnapshotJson();
    },
    files: files({ mtimes: { 'crew.status': 1 } }),
  });
  decisions.refresh(HOME, 0);
  await settle();
  assert.equal(decisions.tasks.length, 3);

  // The home is kept - this is not the captain leaving - and nothing is run,
  // because there is nothing to run a snapshot against.
  let at = 0;
  for (let failure = 1; failure < MAX_CONSECUTIVE_FAILURES; failure += 1) {
    at += ASSERTION_MAX_AGE_MS;
    decisions.refresh(CAPTAIN_UNREADABLE, at);
    await settle();
    assert.equal(decisions.home, HOME, 'the reading still belongs to that home');
    assert.equal(decisions.tasks.length, 3, `${failure} unreadable ticks hold the reading`);
  }
  assert.equal(runs, 1, 'and none of them ran a snapshot');

  at += ASSERTION_MAX_AGE_MS;
  decisions.refresh(CAPTAIN_UNREADABLE, at);
  await settle();
  assert.deepEqual(decisions.tasks, [], 'past the ceiling the assertion is let go of');

  // A lock that reads again recovers by the ordinary route, on the ceiling and
  // with no status file moving.
  at += ASSERTION_MAX_AGE_MS;
  decisions.refresh(HOME, at);
  await settle();
  assert.equal(decisions.tasks.length, 3);
  assert.equal(runs, 2);
});

test('an unreadable captain with no reading in hand costs nothing at all', async () => {
  // There is no assertion to protect, so there is nothing to account for. It
  // must not invent a home to fail against, and it must not run anything.
  let runs = 0;
  const decisions = new FirstmateDecisions({
    execAsync: async () => {
      runs += 1;
      return fleetSnapshotJson();
    },
    files: files(),
  });
  decisions.refresh(CAPTAIN_UNREADABLE, 0);
  await settle();
  assert.equal(decisions.home, null);
  assert.deepEqual(decisions.tasks, []);
  assert.equal(runs, 0);
});

test('a tick that dispatched nothing does not swallow the write it saw', async () => {
  // The signature records the status files a *reading* covers, so a tick that
  // ran no snapshot has covered nothing. Consuming it there loses the one write
  // that would have opened the gate: a crewmate opens a decision during a
  // two-second lock blip, and the ruling then waits on the five-minute ceiling
  // instead of arriving as soon as the lock reads again.
  let runs = 0;
  const mtimes = { 'crew.status': 1 };
  const decisions = new FirstmateDecisions({
    execAsync: async () => {
      runs += 1;
      return JSON.stringify({ schema: 'fm-fleet-snapshot.v1', tasks: [] });
    },
    files: files({ mtimes }),
  });
  decisions.refresh(HOME, 0);
  await settle();
  assert.equal(runs, 1);
  assert.deepEqual(decisions.tasks, [], 'nothing is open, so nothing is asserted');

  // A crewmate opens a decision while the captain's lock will not read.
  mtimes['crew.status'] = 2;
  decisions.refresh(CAPTAIN_UNREADABLE, REFRESH_MS);
  await settle();
  assert.equal(runs, 1, 'there was nothing to run a snapshot against');

  // The lock reads again on the next tick the floor allows, and the write is
  // still there to be acted on - no ceiling wait, and no status file has moved
  // since.
  decisions.refresh(HOME, REFRESH_MS * 2);
  await settle();
  assert.equal(runs, 2, 'the write the unreadable tick saw still opens the gate');
});

test('a snapshot that answers with no tasks does clear the reading', async () => {
  // The other side of that rule, and it has to be the other side: the fleet
  // genuinely draining to nothing is a reading, and holding the last decisions
  // for ever would be the confident stale alarm this feature exists to avoid.
  let answer = fleetSnapshotJson();
  const mtimes = { 'crew.status': 1 };
  const decisions = new FirstmateDecisions({
    execAsync: async () => answer,
    files: files({ mtimes }),
  });
  decisions.refresh(HOME, 0);
  await settle();
  assert.equal(decisions.tasks.length, 3);

  answer = JSON.stringify({ schema: 'fm-fleet-snapshot.v1', tasks: [] });
  mtimes['crew.status'] = 2;
  decisions.refresh(HOME, REFRESH_MS);
  await settle();
  assert.deepEqual(decisions.tasks, []);
});

test('a directory we could not read never triggers a snapshot of its own', async () => {
  // A signature we could not take is not evidence that a status file moved, so
  // it is treated exactly as a failed reading is: nothing is asked, and the
  // signature the gate is comparing against is left where it was.
  let runs = 0;
  let readable = true;
  const mtimes = { 'crew.status': 1 };
  const decisions = new FirstmateDecisions({
    execAsync: async () => {
      runs += 1;
      return JSON.stringify({ schema: 'fm-fleet-snapshot.v1', tasks: [] });
    },
    files: {
      readdir: () => {
        if (!readable) throw new Error('EACCES');
        return ['crew.status'];
      },
      stat: (path) => ({ size: 1, mtimeMs: mtimes[path.split('/').pop()] ?? 1 }),
    },
  });
  decisions.refresh(HOME, 0);
  await settle();
  assert.equal(runs, 1);

  readable = false;
  decisions.refresh(HOME, REFRESH_MS);
  decisions.refresh(HOME, REFRESH_MS * 2);
  await settle();
  assert.equal(runs, 1);

  // And the gate is still comparing against the signature it had.
  readable = true;
  decisions.refresh(HOME, REFRESH_MS * 3);
  await settle();
  assert.equal(runs, 1, 'nothing moved while we could not look');

  mtimes['crew.status'] = 2;
  decisions.refresh(HOME, REFRESH_MS * 4);
  await settle();
  assert.equal(runs, 2);
});

test('a status log removed while another is appended to still opens the gate', async () => {
  // Name, mtime and size together rather than a newest-mtime: one file going
  // away leaves the newest alone, and a signature that misses that is a gate
  // that stops opening.
  let runs = 0;
  let names = ['a.status', 'b.status'];
  const decisions = new FirstmateDecisions({
    execAsync: async () => {
      runs += 1;
      return JSON.stringify({ schema: 'fm-fleet-snapshot.v1', tasks: [] });
    },
    files: {
      readdir: () => names,
      stat: () => ({ size: 1, mtimeMs: 1 }),
    },
  });
  decisions.refresh(HOME, 0);
  await settle();
  assert.equal(runs, 1);

  names = ['a.status'];
  decisions.refresh(HOME, REFRESH_MS);
  await settle();
  assert.equal(runs, 2);
});

test('the command is the snapshot in the captain own home, and nothing else', async () => {
  const ran = [];
  const decisions = new FirstmateDecisions({
    execAsync: async (cmd, args, options) => {
      ran.push([cmd, args, options]);
      return fleetSnapshotJson();
    },
    files: files(),
  });
  await decisions.load(HOME);
  assert.equal(ran.length, 1);
  assert.equal(ran[0][0], 'bash');
  assert.deepEqual(ran[0][1], [SCRIPT, '--json']);
  // Generous, because a snapshot killed halfway is a reading we did not get -
  // which costs the whole cycle rather than failing fast. Measured at 3.5s and
  // at 14s either side of this being written.
  assert.equal(ran[0][2].timeoutMs >= 30000, true);
  assert.equal(decisions.tasks.length, 3);
});

test('load waits for the answer, which refresh deliberately does not', async () => {
  // The one-shot commands have no loop to protect and printing before the
  // answer arrives would mean printing a wrong one. The server must never call
  // it - see LavishState.load.
  const decisions = new FirstmateDecisions({
    execAsync: async () => fleetSnapshotJson(),
    files: files(),
  });
  decisions.refresh(HOME, 0);
  assert.deepEqual(decisions.tasks, [], 'refresh answers on a later tick');

  const waited = new FirstmateDecisions({
    execAsync: async () => fleetSnapshotJson(),
    files: files(),
  });
  await waited.load(HOME);
  assert.equal(waited.tasks.length, 3);
});

test('a different firstmate home clears the reading rather than keeping it', async () => {
  // The one thing that may clear a reading outright, and it is positive
  // evidence rather than an absence: a different home means the old answer is
  // about somebody else's fleet.
  const decisions = new FirstmateDecisions({
    execAsync: async () => fleetSnapshotJson(),
    files: files(),
  });
  decisions.refresh(HOME, 0);
  await settle();
  assert.equal(decisions.tasks.length, 3);

  decisions.refresh('/somewhere/else', 1);
  assert.deepEqual(decisions.tasks, []);
});

test('a reading does not outlive the captain it came from', async () => {
  // firstmate exits, its lock goes with it, and there is no longer anything
  // that could re-open the mtime gate: no crewmate is writing status lines. Left
  // standing the reading would assert a ruling on every crewmate row for the
  // life of the process - a coloured card, a tab count and a notification, from
  // a tool that is not running.
  const decisions = new FirstmateDecisions({
    execAsync: async () => fleetSnapshotJson(),
    files: files(),
  });
  decisions.refresh(HOME, 0);
  await settle();
  assert.equal(decisions.tasks.length, 3);

  decisions.refresh(null, 1);
  assert.deepEqual(decisions.tasks, []);

  // And the captain coming back is read afresh rather than resumed, because the
  // cleared reading took the signature and the stamp with it.
  decisions.refresh(HOME, 2);
  await settle();
  assert.equal(decisions.tasks.length, 3);
});

test('a snapshot still walking the fleet cannot put back a reading the captain cleared', async () => {
  // The command takes tens of seconds, so the captain can leave while it runs.
  // Clearing has to mean cleared, or the answer in flight undoes it.
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const decisions = new FirstmateDecisions({
    execAsync: async () => {
      await pending;
      return fleetSnapshotJson();
    },
    files: files(),
  });
  decisions.refresh(HOME, 0);
  decisions.refresh(null, 1);
  release();
  await settle();
  assert.deepEqual(decisions.tasks, []);
});
