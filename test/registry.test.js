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

test('list returns most recently updated first', () => {
  const { dir, cleanup } = scratch();
  try {
    const registry = new SessionRegistry({ dir });
    registry.record({ session_id: 'old', hook_event_name: 'SessionStart' }, 1000);
    registry.record({ session_id: 'new', hook_event_name: 'SessionStart' }, 2000);
    assert.deepEqual(
      registry.list({ isAlive: alwaysAlive }).map((r) => r.sessionId),
      ['new', 'old'],
    );
  } finally {
    cleanup();
  }
});
