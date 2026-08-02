import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeHooks, removeHooks, hookCommand, HOOK_EVENTS } from '../src/hooks.js';

const COMMAND = '/usr/local/bin/node /opt/nmmon/hooks/nmmon-hook.js';

test('mergeHooks adds an entry for every event', () => {
  const { settings, changes } = mergeHooks({}, COMMAND);
  assert.equal(changes.length, HOOK_EVENTS.length);
  for (const event of HOOK_EVENTS) {
    assert.equal(settings.hooks[event][0].hooks[0].command, COMMAND);
  }
});

test('mergeHooks is idempotent', () => {
  const first = mergeHooks({}, COMMAND);
  const second = mergeHooks(first.settings, COMMAND);
  assert.deepEqual(second.changes, [], 'a second install should change nothing');
  assert.deepEqual(second.settings, first.settings);
});

test('mergeHooks updates our entry in place rather than stacking duplicates', () => {
  // This is what happens when nmmon is moved or node is upgraded.
  const first = mergeHooks({}, '/old/node /old/path/nmmon-hook.js').settings;
  const { settings, changes } = mergeHooks(first, COMMAND);
  assert.ok(changes.every((c) => c.startsWith('update')));
  for (const event of HOOK_EVENTS) {
    assert.equal(settings.hooks[event].length, 1, `${event} should not accumulate entries`);
    assert.equal(settings.hooks[event][0].hooks[0].command, COMMAND);
  }
});

test('mergeHooks never disturbs hooks belonging to anyone else', () => {
  const existing = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh' }] }],
    },
    permissions: { allow: ['Bash(npm test)'] },
  };
  const { settings } = mergeHooks(existing, COMMAND);

  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'say done');
  assert.deepEqual(settings.hooks.PreToolUse, existing.hooks.PreToolUse);
  assert.deepEqual(settings.permissions, existing.permissions);
});

test('mergeHooks does not mutate the input', () => {
  const existing = { hooks: { Stop: [] } };
  const snapshot = structuredClone(existing);
  mergeHooks(existing, COMMAND);
  assert.deepEqual(existing, snapshot);
});

test('removeHooks takes out only our entries', () => {
  const existing = {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
  };
  const installed = mergeHooks(existing, COMMAND).settings;
  const { settings, changes } = removeHooks(installed);

  assert.ok(changes.length > 0);
  assert.deepEqual(settings.hooks.Stop, existing.hooks.Stop);
  for (const event of HOOK_EVENTS) {
    if (event === 'Stop') continue;
    assert.equal(settings.hooks[event], undefined, `${event} should be gone entirely`);
  }
});

test('removeHooks on a clean settings file is a no-op', () => {
  const { changes } = removeHooks({ hooks: {} });
  assert.deepEqual(changes, []);
});

test('hookCommand quotes paths containing spaces', () => {
  assert.equal(
    hookCommand('/usr/bin/node', '/Users/a b/nmmon/hooks/nmmon-hook.js'),
    '/usr/bin/node "/Users/a b/nmmon/hooks/nmmon-hook.js"',
  );
});
