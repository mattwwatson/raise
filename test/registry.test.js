import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionRegistry, stateForEvent, isSafeSessionId } from '../src/registry.js';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'nmmon-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const alwaysAlive = () => true;

test('hook events map to the right session state', () => {
  assert.equal(stateForEvent('SessionStart'), 'idle');
  assert.equal(stateForEvent('UserPromptSubmit'), 'working');
  assert.equal(stateForEvent('Notification'), 'blocked');
  assert.equal(stateForEvent('Stop'), 'idle');
  assert.equal(stateForEvent('SessionEnd'), 'ended');
});

test('pi events map to the right session state', () => {
  assert.equal(stateForEvent('session_start', 'pi'), 'idle');
  assert.equal(stateForEvent('before_agent_start', 'pi'), 'working');
  assert.equal(stateForEvent('agent_settled', 'pi'), 'idle');
  assert.equal(stateForEvent('session_shutdown', 'pi'), 'ended');
});

test('nothing pi can report is a block, and that is the design', () => {
  // pi ships no sandbox and no approval gate, so no event inside it means "a
  // human is needed right now". Inferring one would put pi rows in competition
  // with real permission prompts on the strength of a guess.
  const states = ['session_start', 'before_agent_start', 'agent_start', 'turn_start',
    'agent_settled', 'session_shutdown', 'something_new_pi_adds']
    .map((event) => stateForEvent(event, 'pi'));
  assert.equal(states.includes('blocked'), false);
});

test('the two agents" event names do not leak into each other', () => {
  // A Claude event name arriving on a pi session, or the reverse, must not be
  // silently honoured - it would mean a payload was mislabelled, and the safe
  // reading of an unknown event is that the session is busy.
  assert.equal(stateForEvent('Notification', 'pi'), 'working');
  assert.equal(stateForEvent('SessionEnd', 'pi'), 'working');
  assert.equal(stateForEvent('session_shutdown', 'claude'), 'working');
});

test('a session that does not say which agent it is, is Claude Code', () => {
  // Claude Code's hook has no field to say so, and only Claude Code existed
  // when the records already on disk were written.
  assert.equal(stateForEvent('Notification'), 'blocked');
  const { dir, cleanup } = scratch();
  try {
    const registry = new SessionRegistry({ dir });
    const record = registry.record({ session_id: 's1', hook_event_name: 'SessionStart' });
    assert.equal(record.agent, 'claude');
  } finally {
    cleanup();
  }
});

test('a pi session is recorded as one, and its shutdown deregisters it', () => {
  const { dir, cleanup } = scratch();
  try {
    const registry = new SessionRegistry({ dir, isAlive: alwaysAlive });
    const record = registry.record({
      session_id: 'pi1',
      hook_event_name: 'session_start',
      agent: 'pi',
      cwd: '/Users/x/work/repo',
    });
    assert.equal(record.agent, 'pi');
    assert.equal(record.state, 'idle');
    assert.equal(registry.record({ session_id: 'pi1', hook_event_name: 'session_shutdown', agent: 'pi' }), null);
    assert.equal(registry.get('pi1'), null);
  } finally {
    cleanup();
  }
});

test('session ids are validated before they reach the filesystem', () => {
  assert.equal(isSafeSessionId('abc-123_DEF'), true);
  assert.equal(isSafeSessionId('../../etc/passwd'), false);
  assert.equal(isSafeSessionId('a/b'), false);
  assert.equal(isSafeSessionId(''), false);
  assert.equal(isSafeSessionId(null), false);
});

test('a path traversal session id is rejected rather than written', () => {
  const { dir, cleanup } = scratch();
  try {
    const registry = new SessionRegistry({ dir });
    assert.throws(
      () => registry.record({ session_id: '../escape', hook_event_name: 'SessionStart' }),
      /invalid session id/,
    );
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    cleanup();
  }
});

test('window identity captured at session start survives later events', () => {
  // Only SessionStart carries the host environment in practice. If a later
  // Stop event wiped it, the session would silently stop being focusable.
  const { dir, cleanup } = scratch();
  try {
    const registry = new SessionRegistry({ dir });
    registry.record({
      session_id: 's1',
      hook_event_name: 'SessionStart',
      cwd: '/repo',
      host: { tmux_pane: '%4', pid: process.pid },
    });
    registry.record({ session_id: 's1', hook_event_name: 'Stop' });

    const record = registry.get('s1');
    assert.equal(record.host.tmux_pane, '%4');
    assert.equal(record.cwd, '/repo', 'cwd should also carry forward');
    assert.equal(record.state, 'idle');
  } finally {
    cleanup();
  }
});

test('a pi session keeps its window whether an event repeats it or omits it', () => {
  // pi's extension caches the identity and resends it, so the merge is what
  // makes a repeat idempotent - and an event that carries none, from before the
  // walk could run, must still leave the row focusable.
  const { dir, cleanup } = scratch();
  try {
    const registry = new SessionRegistry({ dir });
    const host = { tty: '/dev/ttys004', pid: process.pid };
    registry.record({
      session_id: 'p1',
      hook_event_name: 'session_start',
      agent: 'pi',
      cwd: '/repo',
      host,
    });
    registry.record({
      session_id: 'p1',
      hook_event_name: 'before_agent_start',
      agent: 'pi',
      cwd: '/repo',
    });
    registry.record({
      session_id: 'p1',
      hook_event_name: 'agent_settled',
      agent: 'pi',
      cwd: '/repo',
      host,
    });

    const record = registry.get('p1');
    assert.equal(record.host.tty, '/dev/ttys004');
    assert.equal(record.host.pid, process.pid);
    assert.equal(record.state, 'idle');
  } finally {
    cleanup();
  }
});

test('a notification message is kept while blocked and cleared when it moves on', () => {
  const { dir, cleanup } = scratch();
  try {
    const registry = new SessionRegistry({ dir });
    registry.record({ session_id: 's1', hook_event_name: 'SessionStart', host: { pid: process.pid } });
    registry.record({
      session_id: 's1',
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });
    assert.equal(registry.get('s1').state, 'blocked');
    assert.match(registry.get('s1').message, /permission/);

    registry.record({ session_id: 's1', hook_event_name: 'UserPromptSubmit' });
    assert.equal(registry.get('s1').message, null, 'a stale "needs permission" would be a lie');
  } finally {
    cleanup();
  }
});

test('a PermissionRequest blocks the session before any notification arrives', () => {
  // Claude Code fires this the moment it decides a tool needs a human, and the
  // Notification saying so only follows six to twelve seconds later. There is
  // no message on it, so the row says a human is needed and picks up the reason
  // when the Notification catches up.
  const { dir, cleanup } = scratch();
  try {
    const registry = new SessionRegistry({ dir });
    registry.record({ session_id: 's1', hook_event_name: 'UserPromptSubmit' }, 1000);
    registry.record({ session_id: 's1', hook_event_name: 'PermissionRequest' }, 2000);

    const blocked = registry.get('s1');
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.message, null);
    assert.equal(blocked.stateSince, 2000);

    registry.record(
      {
        session_id: 's1',
        hook_event_name: 'Notification',
        message: 'Claude needs your permission to use Bash',
        notification_type: 'permission_prompt',
      },
      9000,
    );
    const named = registry.get('s1');
    assert.match(named.message, /permission/);
    assert.equal(
      named.stateSince,
      2000,
      'the wait started when Claude asked, not when it got round to saying so',
    );
  } finally {
    cleanup();
  }
});

test('the notification type rides along with the message, under the same rule', () => {
  // Claude Code says which kind of notification this is rather than leaving it
  // to be read out of the message. Stored on the same terms: it is only true
  // while the block it describes is.
  const { dir, cleanup } = scratch();
  try {
    const registry = new SessionRegistry({ dir });
    registry.record({
      session_id: 's1',
      hook_event_name: 'Notification',
      message: 'Claude is waiting for your input',
      notification_type: 'idle_prompt',
    });
    assert.equal(registry.get('s1').notificationType, 'idle_prompt');

    registry.record({ session_id: 's1', hook_event_name: 'UserPromptSubmit' });
    assert.equal(registry.get('s1').notificationType, null);
  } finally {
    cleanup();
  }
});

test('a Notification from a Claude Code too old to type it is still recorded', () => {
  const { dir, cleanup } = scratch();
  try {
    const registry = new SessionRegistry({ dir });
    registry.record({
      session_id: 's1',
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });
    assert.equal(registry.get('s1').state, 'blocked');
    assert.equal(registry.get('s1').notificationType, null);
  } finally {
    cleanup();
  }
});

test('a restated block moves the announcement anchor but not stateSince', () => {
  // One permission prompt, announced twice: PermissionRequest the moment Claude
  // decides it needs a human, then the Notification six to twelve seconds later.
  // The waiting timer wants the first - that is how long you have kept it
  // waiting - and the transcript's disproof wants the last, so a block restated
  // eight seconds in is not already eight seconds through its tolerance.
  const { dir, cleanup } = scratch();
  try {
    const registry = new SessionRegistry({ dir });
    registry.record({ session_id: 's1', hook_event_name: 'PermissionRequest' }, 1000);
    const asked = registry.get('s1');
    assert.equal(asked.stateSince, 1000);
    assert.equal(asked.blockAnnouncedAt, 1000);

    registry.record(
      {
        session_id: 's1',
        hook_event_name: 'Notification',
        message: 'Claude needs your permission to use Bash',
        notification_type: 'permission_prompt',
      },
      9000,
    );
    const restated = registry.get('s1');
    assert.equal(restated.stateSince, 1000, 'the wait still started when Claude asked');
    assert.equal(restated.blockAnnouncedAt, 9000);

    registry.record({ session_id: 's1', hook_event_name: 'UserPromptSubmit' }, 12000);
    assert.equal(
      registry.get('s1').blockAnnouncedAt,
      null,
      'the anchor expires with the block it describes, like the message does',
    );
  } finally {
    cleanup();
  }
});

test('dismissing a block records the announcement it answers, not the session', () => {
  const { dir, cleanup } = scratch();
  try {
    const registry = new SessionRegistry({ dir });
    registry.record(
      {
        session_id: 's1',
        hook_event_name: 'Notification',
        message: 'Claude is waiting for your input',
        notification_type: 'idle_prompt',
      },
      1000,
    );
    const dismissed = registry.dismissBlock('s1');
    assert.equal(dismissed.dismissedBlockAt, 1000);
    assert.equal(dismissed.blockAnnouncedAt, 1000, 'and the announcement itself is untouched');
    assert.equal(registry.get('s1').dismissedBlockAt, 1000, 'and it is on disk');
  } finally {
    cleanup();
  }
});

test('a dismissal outlives the events between two blocks, and only agrees with its own', () => {
  // It is spent by disagreeing with `blockAnnouncedAt`, so it is carried across
  // every event rather than cleared with the block. What matters is that the
  // *next* announcement gets a new timestamp, which it always does.
  const { dir, cleanup } = scratch();
  try {
    const registry = new SessionRegistry({ dir });
    registry.record({ session_id: 's1', hook_event_name: 'Notification' }, 1000);
    registry.dismissBlock('s1');

    registry.record({ session_id: 's1', hook_event_name: 'Stop' }, 2000);
    const quiet = registry.get('s1');
    assert.equal(quiet.dismissedBlockAt, 1000, 'survives an ordinary event');
    assert.equal(quiet.blockAnnouncedAt, null, 'with nothing left for it to agree with');

    registry.record({ session_id: 's1', hook_event_name: 'PermissionRequest' }, 3000);
    const asked = registry.get('s1');
    assert.equal(asked.blockAnnouncedAt, 3000);
    assert.notEqual(
      asked.dismissedBlockAt,
      asked.blockAnnouncedAt,
      'so the new block is not dismissed by the old dismissal',
    );
  } finally {
    cleanup();
  }
});

test('a session with no block announced has nothing to dismiss', () => {
  const { dir, cleanup } = scratch();
  try {
    const registry = new SessionRegistry({ dir });
    registry.record({ session_id: 's1', hook_event_name: 'Stop' }, 1000);
    assert.equal(registry.dismissBlock('s1'), null);
    assert.equal(registry.get('s1').dismissedBlockAt, null);
    assert.equal(registry.dismissBlock('nobody'), null, 'nor does a session we have never seen');
  } finally {
    cleanup();
  }
});

test('stateSince only moves when the state actually changes', () => {
  const { dir, cleanup } = scratch();
  try {
    const registry = new SessionRegistry({ dir });
    registry.record({ session_id: 's1', hook_event_name: 'Notification' }, 1000);
    registry.record({ session_id: 's1', hook_event_name: 'Notification' }, 5000);
    assert.equal(registry.get('s1').stateSince, 1000, 'it has been waiting since the first one');

    registry.record({ session_id: 's1', hook_event_name: 'Stop' }, 9000);
    assert.equal(registry.get('s1').stateSince, 9000);
  } finally {
    cleanup();
  }
});

test('SessionEnd removes the record', () => {
  const { dir, cleanup } = scratch();
  try {
    const registry = new SessionRegistry({ dir });
    registry.record({ session_id: 's1', hook_event_name: 'SessionStart' });
    assert.equal(registry.record({ session_id: 's1', hook_event_name: 'SessionEnd' }), null);
    assert.equal(registry.get('s1'), null);
    assert.deepEqual(registry.list({ isAlive: alwaysAlive }), []);
  } finally {
    cleanup();
  }
});

test('list drops sessions whose process has died', () => {
  // A killed terminal never sends SessionEnd, so without this the dashboard
  // fills up with rows that focus nothing.
  const { dir, cleanup } = scratch();
  try {
    const registry = new SessionRegistry({ dir });
    registry.record({ session_id: 'alive', hook_event_name: 'SessionStart', host: { pid: 111 } });
    registry.record({ session_id: 'dead', hook_event_name: 'SessionStart', host: { pid: 222 } });

    const list = registry.list({ isAlive: (pid) => pid === 111 });
    assert.deepEqual(
      list.map((r) => r.sessionId),
      ['alive'],
    );
    assert.equal(registry.get('dead'), null, 'the dead record should be cleaned up too');
  } finally {
    cleanup();
  }
});

test('a session with no recorded pid is kept', () => {
  const { dir, cleanup } = scratch();
  try {
    const registry = new SessionRegistry({ dir });
    registry.record({ session_id: 's1', hook_event_name: 'SessionStart', host: {} });
    assert.equal(registry.list({ isAlive: () => false }).length, 1);
  } finally {
    cleanup();
  }
});

test('a pidless record is dropped once it is weeks stale, not while it is merely idle', () => {
  // The agent process cannot always be identified, and such a record has no pid
  // to probe: if that session dies without a SessionEnd its file would live in
  // the registry forever, rendering a row that focuses nothing. Age is the only
  // signal left, so it has to be a generous one.
  const { dir, cleanup } = scratch();
  const day = 24 * 60 * 60 * 1000;
  try {
    const registry = new SessionRegistry({ dir });
    registry.record({ session_id: 'idle', hook_event_name: 'SessionStart', host: {} }, 1000);
    registry.record({ session_id: 'ancient', hook_event_name: 'SessionStart', host: {} }, 1000);

    assert.equal(
      registry.list({ isAlive: alwaysAlive, now: 1000 + 4 * day }).length,
      2,
      'a session left open over a long weekend is still a session',
    );

    const list = registry.list({ isAlive: alwaysAlive, now: 1000 + 30 * day });
    assert.deepEqual(list, []);
    assert.deepEqual(readdirSync(dir), [], 'the files should be cleaned up, not just hidden');
  } finally {
    cleanup();
  }
});

test('list returns most recently updated first', () => {
  const { dir, cleanup } = scratch();
  try {
    const registry = new SessionRegistry({ dir });
    registry.record({ session_id: 'old', hook_event_name: 'SessionStart' }, 1000);
    registry.record({ session_id: 'new', hook_event_name: 'SessionStart' }, 2000);
    assert.deepEqual(
      registry.list({ isAlive: alwaysAlive, now: 3000 }).map((r) => r.sessionId),
      ['new', 'old'],
    );
  } finally {
    cleanup();
  }
});
