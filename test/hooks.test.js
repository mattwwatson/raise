import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeHooks,
  removeHooks,
  hookCommand,
  hookInstallState,
  HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  CODEX_HOOK_TIMEOUTS,
} from '../src/hooks.js';

const COMMAND = '/usr/local/bin/node /opt/raise/hooks/raise-hook.js';

test('mergeHooks adds an entry for every event', () => {
  const { settings, changes } = mergeHooks({}, COMMAND);
  assert.equal(changes.length, HOOK_EVENTS.length);
  for (const event of HOOK_EVENTS) {
    assert.equal(settings.hooks[event][0].hooks[0].command, COMMAND);
  }
});

test('the events installed are the ones that are rare and mean something', () => {
  // Named rather than derived, so that widening the list to a per-tool-call
  // event has to be a deliberate edit to a test that says why it is not one.
  assert.deepEqual(HOOK_EVENTS, [
    'SessionStart',
    'UserPromptSubmit',
    'PermissionRequest',
    'Notification',
    'Stop',
    'SessionEnd',
  ]);
  for (const perCall of ['PreToolUse', 'PostToolUse', 'PostToolBatch', 'MessageDisplay']) {
    assert.equal(HOOK_EVENTS.includes(perCall), false, `${perCall} fires inside the editing loop`);
  }
});

test('mergeHooks is idempotent', () => {
  const first = mergeHooks({}, COMMAND);
  const second = mergeHooks(first.settings, COMMAND);
  assert.deepEqual(second.changes, [], 'a second install should change nothing');
  assert.deepEqual(second.settings, first.settings);
});

test('mergeHooks updates our entry in place rather than stacking duplicates', () => {
  // This is what happens when Raise is moved or node is upgraded.
  const first = mergeHooks({}, '/old/node /old/path/raise-hook.js').settings;
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

test('hookInstallState tells an install that has gone stale from no install at all', () => {
  // Adding an event to HOOK_EVENTS leaves every existing installation one
  // short. Calling that "not installed" would tell the user Raise cannot see
  // when Claude is waiting and cannot focus windows, when both still work.
  assert.deepEqual(hookInstallState(mergeHooks({}, COMMAND).settings), {
    state: 'installed',
    missing: [],
  });
  assert.deepEqual(hookInstallState({}), { state: 'missing', missing: [...HOOK_EVENTS] });

  const older = HOOK_EVENTS.filter((event) => event !== 'PermissionRequest');
  assert.deepEqual(hookInstallState(mergeHooks({}, COMMAND, older).settings), {
    state: 'partial',
    missing: ['PermissionRequest'],
  });
});

test('hookInstallState does not count somebody else\'s hooks as ours', () => {
  const foreign = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
  assert.equal(hookInstallState(foreign).state, 'missing');
});

test('hookCommand quotes paths containing spaces', () => {
  assert.equal(
    hookCommand('/usr/bin/node', '/Users/a b/raise/hooks/raise-hook.js'),
    '/usr/bin/node "/Users/a b/raise/hooks/raise-hook.js"',
  );
});

// ---------------------------------------------------------------------- codex

/**
 * A copy of a real `~/.codex/hooks.json`, three foreign `SessionStart` groups
 * and nothing of ours. This is the fixture the install has to survive: all
 * three must come through install, reinstall and uninstall untouched and in
 * order.
 */
function codexHooksFixture() {
  return {
    hooks: {
      SessionStart: [
        { matcher: '', hooks: [{ type: 'command', command: 'lavish-axi', timeout: 10 }] },
        { matcher: '', hooks: [{ type: 'command', command: 'chrome-devtools-axi', timeout: 10 }] },
        { matcher: '', hooks: [{ type: 'command', command: 'gh-axi', timeout: 10 }] },
      ],
    },
  };
}

const CODEX_COMMAND = `${COMMAND} --agent codex`;

test('the Codex hook command declares the agent; Claude Code stays silent', () => {
  // Codex's payload has no field for it, and the command is the only place it
  // gives us. Claude Code's installed command must not change, or every
  // existing installation reports an update it does not need.
  assert.equal(hookCommand('/usr/bin/node', '/opt/raise/hooks/raise-hook.js', 'codex'),
    '/usr/bin/node /opt/raise/hooks/raise-hook.js --agent codex');
  assert.equal(hookCommand('/usr/bin/node', '/opt/raise/hooks/raise-hook.js'),
    '/usr/bin/node /opt/raise/hooks/raise-hook.js');
});

test('the Codex events installed are the rare ones, and there is no Notification', () => {
  // Named rather than derived, so widening this to a per-tool-call event has to
  // be a deliberate edit to a test saying why it is not one. `Notification` is
  // absent because Codex has none at all, not because we chose to skip it.
  assert.deepEqual(CODEX_HOOK_EVENTS, [
    'SessionStart',
    'UserPromptSubmit',
    'PermissionRequest',
    'Stop',
    'SessionEnd',
  ]);
  for (const perCall of ['PreToolUse', 'PostToolUse', 'PreCompact', 'PostCompact']) {
    assert.equal(CODEX_HOOK_EVENTS.includes(perCall), false, `${perCall} fires per tool call`);
  }
  for (const absent of ['Notification', 'SubagentStart', 'SubagentStop']) {
    assert.equal(CODEX_HOOK_EVENTS.includes(absent), false);
  }
});

test('SessionEnd asks for three seconds, because Codex warns about more', () => {
  // Codex clamps it and prints a warning on every session start otherwise. Our
  // reporter is bounded at two seconds, so the rest was never used.
  const { settings } = mergeHooks({}, CODEX_COMMAND, CODEX_HOOK_EVENTS, CODEX_HOOK_TIMEOUTS);
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].timeout, 3);
  assert.equal(settings.hooks.SessionStart[0].hooks[0].timeout, 5);
});

test('installing into a Codex file leaves its three foreign hooks exactly as found', () => {
  const before = codexHooksFixture();
  const { settings } = mergeHooks(before, CODEX_COMMAND, CODEX_HOOK_EVENTS, CODEX_HOOK_TIMEOUTS);
  assert.deepEqual(
    settings.hooks.SessionStart.slice(0, 3),
    before.hooks.SessionStart,
    'the foreign groups must keep their contents and their order',
  );
  assert.equal(settings.hooks.SessionStart.length, 4);
  assert.equal(settings.hooks.SessionStart[3].hooks[0].command, CODEX_COMMAND);
});

test('a second Codex install changes nothing', () => {
  const first = mergeHooks(
    codexHooksFixture(),
    CODEX_COMMAND,
    CODEX_HOOK_EVENTS,
    CODEX_HOOK_TIMEOUTS,
  );
  const second = mergeHooks(
    first.settings,
    CODEX_COMMAND,
    CODEX_HOOK_EVENTS,
    CODEX_HOOK_TIMEOUTS,
  );
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.settings, first.settings);
});

test('uninstalling from a Codex file gives back exactly the file we started with', () => {
  const before = codexHooksFixture();
  const installed = mergeHooks(
    before,
    CODEX_COMMAND,
    CODEX_HOOK_EVENTS,
    CODEX_HOOK_TIMEOUTS,
  ).settings;
  const { settings, changes } = removeHooks(installed, CODEX_HOOK_EVENTS);
  assert.equal(changes.length, CODEX_HOOK_EVENTS.length);
  assert.deepEqual(settings, before, 'uninstall must be the exact inverse of install');
});

test('a Claude Code install is not seen as a Codex one, or vice versa', () => {
  // Both write `raise-hook.js`, so the marker alone cannot tell them apart -
  // but they are different files, and the state of one is read with the other's
  // event list. `Notification` is in Claude Code's list and not Codex's, so a
  // Codex file read as a Claude Code one is correctly reported as incomplete.
  const codex = mergeHooks(
    codexHooksFixture(),
    CODEX_COMMAND,
    CODEX_HOOK_EVENTS,
    CODEX_HOOK_TIMEOUTS,
  ).settings;
  assert.equal(hookInstallState(codex, CODEX_HOOK_EVENTS).state, 'installed');
  assert.deepEqual(hookInstallState(codex, HOOK_EVENTS).missing, ['Notification']);
});

test('a Codex file with none of ours in it reports missing, not partial', () => {
  const state = hookInstallState(codexHooksFixture(), CODEX_HOOK_EVENTS);
  assert.equal(state.state, 'missing');
  assert.deepEqual(state.missing, CODEX_HOOK_EVENTS);
});
