import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planFocus, itermUuid, focusSession } from '../src/focus/index.js';
import { orderedTerminals } from '../src/focus/terminals.js';
import { socketArgs, resolveTmuxTarget } from '../src/focus/tmux.js';
import { itermFocusScript, terminalAppFocusScript, escapeAppleScript } from '../src/focus/applescript.js';

/** A fake exec that answers from a table and records what it was asked. */
function fakeExec(responses) {
  const calls = [];
  const run = (command, args = []) => {
    const key = [command, ...args].join(' ');
    calls.push(key);
    for (const [pattern, value] of Object.entries(responses)) {
      if (key.includes(pattern)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    throw new Error(`unexpected command: ${key}`);
  };
  run.calls = calls;
  return run;
}

test('itermUuid pulls the UUID out of ITERM_SESSION_ID', () => {
  assert.equal(
    itermUuid('w0t2p0:57A1A161-0489-48BD-8C6E-A540C57DD9DE'),
    '57A1A161-0489-48BD-8C6E-A540C57DD9DE',
  );
  assert.equal(itermUuid(null), null);
  assert.equal(itermUuid('w0t2p0:'), null);
});

test('planFocus routes a tmux pane to the tmux path', () => {
  const plan = planFocus({ host: { tmux_pane: '%12', tmux: '/tmp/tmux-501/default,123,0' } });
  assert.equal(plan.kind, 'tmux');
  assert.equal(plan.pane, '%12');
});

test('planFocus prefers tmux even when terminal identifiers are also present', () => {
  // Inside tmux, ITERM_SESSION_ID is inherited from whenever the tmux server
  // started, so it may point at a completely different tab. tmux must win.
  const plan = planFocus({
    host: { tmux_pane: '%3', iterm_session_id: 'w0t0p0:57A1A161-0489-48BD-8C6E-A540C57DD9DE' },
  });
  assert.equal(plan.kind, 'tmux');
});

test('planFocus routes a plain tab to the tab path', () => {
  const plan = planFocus({
    host: { iterm_session_id: 'w0t2p0:57A1A161-0489-48BD-8C6E-A540C57DD9DE', tty: '/dev/ttys004' },
  });
  assert.equal(plan.kind, 'tab');
  assert.equal(plan.sessionUuid, '57A1A161-0489-48BD-8C6E-A540C57DD9DE');
  assert.equal(plan.tty, '/dev/ttys004');
});

test('planFocus falls back to TERM_SESSION_ID when ITERM_SESSION_ID is absent', () => {
  // Observed in the wild: iTerm2 sets both, but ITERM_SESSION_ID comes from
  // shell integration and can be missing, while TERM_SESSION_ID carries the
  // same UUID. Without this fallback the session looks unfocusable.
  const plan = planFocus({
    host: { term_session_id: 'w0t4p0:B9EF3FA3-E809-46A3-BACD-638C49A74DDC' },
  });
  assert.equal(plan.kind, 'tab');
  assert.equal(plan.sessionUuid, 'B9EF3FA3-E809-46A3-BACD-638C49A74DDC');
});

test('planFocus prefers ITERM_SESSION_ID when both are present', () => {
  const plan = planFocus({
    host: {
      iterm_session_id: 'w0t1p0:11111111-1111-1111-1111-111111111111',
      term_session_id: 'w0t4p0:22222222-2222-2222-2222-222222222222',
    },
  });
  assert.equal(plan.sessionUuid, '11111111-1111-1111-1111-111111111111');
});

test('planFocus reports a session with no window identity as unfocusable', () => {
  const plan = planFocus({ host: {} });
  assert.equal(plan.kind, 'unfocusable');
  assert.match(plan.reason, /before the hooks were installed/);
});

test('orderedTerminals tries the reported terminal first but keeps the rest', () => {
  const a = { name: 'a', termProgram: 'iTerm.app' };
  const b = { name: 'b', termProgram: 'Apple_Terminal' };
  assert.deepEqual(
    orderedTerminals('Apple_Terminal', [a, b]).map((t) => t.name),
    ['b', 'a'],
  );
  assert.deepEqual(
    orderedTerminals(null, [a, b]).map((t) => t.name),
    ['a', 'b'],
  );
});

test('socketArgs honours a custom tmux socket', () => {
  assert.deepEqual(socketArgs('/tmp/tmux-501/firstmate,4242,0'), ['-S', '/tmp/tmux-501/firstmate']);
  assert.deepEqual(socketArgs(null), []);
});

test('resolveTmuxTarget returns the attached client tty', () => {
  const exec = fakeExec({
    'display-message': 'firstmate',
    'list-clients': '/dev/ttys002',
  });
  assert.deepEqual(resolveTmuxTarget(exec, { pane: '%1', tmuxEnv: null }), {
    ok: true,
    session: 'firstmate',
    tty: '/dev/ttys002',
  });
});

test('resolveTmuxTarget reports a detached session with an attach hint', () => {
  const exec = fakeExec({ 'display-message': 'background', 'list-clients': '' });
  const result = resolveTmuxTarget(exec, { pane: '%1', tmuxEnv: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'detached');
  assert.equal(result.hint, 'tmux attach -t background');
});

test('resolveTmuxTarget reports a pane that no longer exists', () => {
  const exec = fakeExec({ 'display-message': new Error('no such pane') });
  const result = resolveTmuxTarget(exec, { pane: '%99', tmuxEnv: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'pane-gone');
});

test('focusSession focuses a plain tab through the matching terminal', () => {
  const seen = [];
  const terminals = [
    {
      name: 'iterm2',
      label: 'iTerm2',
      termProgram: 'iTerm.app',
      isAvailable: () => true,
      focus: (_exec, target) => {
        seen.push(target);
        return true;
      },
    },
  ];
  const result = focusSession(
    { host: { iterm_session_id: 'w0t1p0:57A1A161-0489-48BD-8C6E-A540C57DD9DE', term_program: 'iTerm.app' } },
    { exec: fakeExec({}), terminals },
  );
  assert.deepEqual(result, { ok: true, adapter: 'iterm2' });
  assert.equal(seen[0].sessionUuid, '57A1A161-0489-48BD-8C6E-A540C57DD9DE');
});

test('focusSession falls through to the next terminal when the first has no match', () => {
  const terminals = [
    { name: 'a', label: 'A', termProgram: 'x', isAvailable: () => true, focus: () => false },
    { name: 'b', label: 'B', termProgram: 'y', isAvailable: () => true, focus: () => true },
  ];
  const result = focusSession({ host: { tty: '/dev/ttys004' } }, { exec: fakeExec({}), terminals });
  assert.equal(result.ok, true);
  assert.equal(result.adapter, 'b');
});

test('focusSession does not let a throwing adapter block the others', () => {
  const terminals = [
    {
      name: 'broken',
      label: 'Broken',
      termProgram: 'x',
      isAvailable: () => true,
      focus: () => {
        throw new Error('osascript blew up');
      },
    },
    { name: 'good', label: 'Good', termProgram: 'y', isAvailable: () => true, focus: () => true },
  ];
  const result = focusSession({ host: { tty: '/dev/ttys004' } }, { exec: fakeExec({}), terminals });
  assert.equal(result.ok, true);
  assert.equal(result.adapter, 'good');
});

test('focusSession selects the pane then focuses the tmux host window', () => {
  const exec = fakeExec({
    'display-message': 'firstmate',
    'list-clients': '/dev/ttys002',
    'select-window': '',
    'select-pane': '',
  });
  const focused = [];
  const terminals = [
    {
      name: 'iterm2',
      label: 'iTerm2',
      termProgram: 'iTerm.app',
      isAvailable: () => true,
      focus: (_e, target) => {
        focused.push(target);
        return true;
      },
    },
  ];
  const result = focusSession(
    { host: { tmux_pane: '%7', tmux: '/tmp/tmux-501/default,1,0' } },
    { exec, terminals },
  );

  assert.equal(result.ok, true);
  assert.equal(result.tmuxSession, 'firstmate');
  // The pane is raised inside tmux before the window comes forward, otherwise
  // you get the right window showing the wrong pane.
  assert.ok(exec.calls.some((c) => c.includes('select-window -t %7')));
  assert.ok(exec.calls.some((c) => c.includes('select-pane -t %7')));
  // The host terminal is matched on the live client tty, never on a stored one.
  assert.deepEqual(focused[0], { sessionUuid: null, tty: '/dev/ttys002' });
});

test('focusSession explains a detached tmux session instead of failing silently', () => {
  const exec = fakeExec({ 'display-message': 'background', 'list-clients': '' });
  const result = focusSession({ host: { tmux_pane: '%7' } }, { exec, terminals: [] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not attached/);
  assert.equal(result.hint, 'tmux attach -t background');
});

test('focusSession reports when no supported terminal is running', () => {
  const terminals = [
    { name: 'a', label: 'A', termProgram: 'x', isAvailable: () => false, focus: () => true },
  ];
  const result = focusSession({ host: { tty: '/dev/ttys004' } }, { exec: fakeExec({}), terminals });
  assert.equal(result.ok, false);
  assert.match(result.reason, /No supported terminal|only implemented for macOS/);
});

test('AppleScript values are escaped', () => {
  assert.equal(escapeAppleScript('a"b\\c'), 'a\\"b\\\\c');
  const script = itermFocusScript({ sessionUuid: 'A"B' });
  assert.ok(script.includes('\\"'));
  assert.ok(!/is "A"B"/.test(script), 'an unescaped quote would break out of the literal');
});

test('the iTerm script tolerates sessions with no tty', () => {
  // Restored-but-dead iTerm2 sessions report `missing value` for tty, which
  // would otherwise error out of the whole loop.
  const script = itermFocusScript({ tty: '/dev/ttys004' });
  assert.ok(script.includes('is not missing value'));
});

test('the Terminal.app script matches on tty', () => {
  const script = terminalAppFocusScript({ tty: '/dev/ttys009' });
  assert.ok(script.includes('tty of t'));
  assert.ok(script.includes('/dev/ttys009'));
  assert.ok(script.includes('set frontmost of w to true'));
});
