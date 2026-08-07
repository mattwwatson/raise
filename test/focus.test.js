import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planFocus, itermUuid, focusSession, titleNeedle } from '../src/focus/index.js';
import { orderedTerminals, ALL_TERMINALS } from '../src/focus/terminals.js';
import {
  socketArgs,
  resolveTmuxTarget,
  parseClients,
  parsePaneSessions,
  chooseTmuxClient,
  selectPane,
} from '../src/focus/tmux.js';
import {
  itermFocusScript,
  itermFocusByTitleScript,
  terminalAppFocusScript,
  escapeAppleScript,
} from '../src/focus/applescript.js';

/**
 * A fake exec that answers from a table and records what it was asked.
 *
 * Async, like the real runner the focus path is given: everything here is
 * reachable from an HTTP handler, so a synchronous exec would be the bug.
 */
function fakeExec(responses) {
  const calls = [];
  const run = async (command, args = []) => {
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

test('planFocus routes a Claude Desktop session to the app path', () => {
  // A desktop session reports none of the terminal identifiers, so before this
  // branch existed it planned as unfocusable and rendered as a dead card.
  const plan = planFocus({
    sessionId: '2205e739-08bc-4ee6-a8d4-b15204bab998',
    host: { app: 'claude-desktop', tty: null, term_program: null },
  });
  assert.equal(plan.kind, 'app');
});

test('planFocus prefers the desktop app over any terminal identity on the record', () => {
  // Host fields are merged across events and never cleared, so a stale tty can
  // outlive the terminal that owned it. The app knows where its own session is;
  // a recycled tty names whatever window has it now.
  const plan = planFocus({
    sessionId: '2205e739-08bc-4ee6-a8d4-b15204bab998',
    host: { app: 'claude-desktop', tty: '/dev/ttys004', tmux_pane: '%3' },
  });
  assert.equal(plan.kind, 'app');
});

test('focusing a desktop session never imports it into the app', async () => {
  // The regression this file exists for. `claude://resume` is an *import*: its
  // only dedupe is on `local_<the id we pass>`, and a session the app hosts
  // natively is filed under `local_<the app's own uuid>` instead. So resuming
  // one gave the user two sidebar entries over one transcript, mirroring each
  // other. Raising the app is the only thing that cannot do that.
  //
  // Every shape of id, because the point is that none of them reaches a link:
  // a uuid the app would accept, one an earlier buggy click already imported,
  // something that is not a uuid at all, and nothing.
  const records = [
    { sessionId: '2205e739-08bc-4ee6-a8d4-b15204bab998', host: { app: 'claude-desktop' } },
    { sessionId: 'ec9c2da1-1f5b-4a3e-9c77-0f6b2a4d81c3', host: { app: 'claude-desktop' } },
    { sessionId: 'run-42', host: { app: 'claude-desktop' } },
    { sessionId: null, host: { app: 'claude-desktop', tty: '/dev/ttys004' } },
  ];
  for (const record of records) {
    const exec = fakeExec({ open: '' });
    const result = await focusSession(record, { exec });
    assert.equal(result.ok, true);
    assert.equal(result.adapter, 'claude-desktop');
    assert.deepEqual(exec.calls, ['open -b com.anthropic.claudefordesktop']);
    assert.ok(
      !exec.calls.some((call) => call.includes('claude://')),
      'no id may produce a deep link, however well formed',
    );
    // Raised, not shown: the note is what the page toasts, and it is the only
    // thing that stops "focused" reading as "you are looking at it".
    assert.match(result.note, /sidebar/);
  }
});

test('a desktop app that will not come to the front reports why, with the command to try', async () => {
  const exec = fakeExec({ open: new Error('LSOpenURLsWithRole() failed') });
  const result = await focusSession(
    { sessionId: '2205e739-08bc-4ee6-a8d4-b15204bab998', host: { app: 'claude-desktop' } },
    { exec },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /Claude Desktop/);
  assert.equal(result.hint, 'open -b com.anthropic.claudefordesktop');
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

test('resolveTmuxTarget returns the attached client tty', async () => {
  const exec = fakeExec({
    'list-panes': '%1\t$0\t@0\t1\tfirstmate',
    'list-clients': '/dev/ttys002\t0\t$0\t@0',
  });
  assert.deepEqual(await resolveTmuxTarget(exec, { pane: '%1', tmuxEnv: null }), {
    ok: true,
    session: 'firstmate',
    sessionId: '$0',
    windowId: '@0',
    tty: '/dev/ttys002',
    controlMode: false,
    title: null,
  });
});

test('resolveTmuxTarget refuses to hand back a control mode client tty', async () => {
  // The bug this exists for. `tmux -CC` is how iTerm2 hosts tmux, and the
  // control client's tty is the tab where `tmux -CC` was typed - an idle tab
  // that shows none of the panes. Treating it as the host tty meant every
  // focus click raised that one tab, whichever session you clicked.
  const exec = fakeExec({
    'list-panes': '%289\t$0\t@0\t1\tfirstmate',
    'list-clients': '/dev/ttys002\t1\t$0\t@0',
    '#{pane_title}': '✹ Enroll multiple operations in webapp',
  });
  const target = await resolveTmuxTarget(exec, { pane: '%289', tmuxEnv: null });
  assert.equal(target.ok, true);
  assert.equal(target.controlMode, true);
  assert.equal(target.tty, null, 'the control client tty must never be offered as the host');
  assert.equal(target.sessionId, null, 'and there is no session to select in either');
  assert.equal(target.title, '✹ Enroll multiple operations in webapp');
});

test('resolveTmuxTarget prefers a plain client when both kinds are attached', async () => {
  const exec = fakeExec({
    'list-panes': '%1\t$0\t@0\t1\tfirstmate',
    'list-clients': '/dev/ttys002\t1\t$0\t@0\n/dev/ttys031\t0\t$0\t@0',
    '#{pane_title}': '✹ something',
  });
  const target = await resolveTmuxTarget(exec, { pane: '%1', tmuxEnv: null });
  assert.equal(target.tty, '/dev/ttys031');
  assert.equal(target.controlMode, true, 'still worth trying the title path first');
});

test('parseClients reads the session and displayed window, not just the tty', () => {
  assert.deepEqual(parseClients('/dev/ttys002\t1\t$0\t@0\n/dev/ttys031\t0\t$4\t@9'), [
    { tty: '/dev/ttys002', controlMode: true, sessionId: '$0', windowId: '@0' },
    { tty: '/dev/ttys031', controlMode: false, sessionId: '$4', windowId: '@9' },
  ]);
  // A client with no session is nothing we can rank, so it is dropped rather
  // than ranked against a session it does not name.
  assert.deepEqual(parseClients('/dev/ttys002\t0'), []);
  assert.deepEqual(parseClients(''), []);
  assert.deepEqual(parseClients(null), []);
});

test('parsePaneSessions reports every session a linked window belongs to', () => {
  assert.deepEqual(
    parsePaneSessions(['%356\t$191\t@349\t5\thv-sls-75', '%356\t$204\t@349\t1\thv-sls-86'].join('\n')),
    [
      { paneId: '%356', sessionId: '$191', windowId: '@349', windowCount: 5, sessionName: 'hv-sls-75' },
      { paneId: '%356', sessionId: '$204', windowId: '@349', windowCount: 1, sessionName: 'hv-sls-86' },
    ],
  );
});

test('parsePaneSessions keeps a session name containing a tab whole', () => {
  // The name is emitted last precisely so it cannot eat a field boundary; a
  // name is user data and nothing stops one holding a tab.
  const [row] = parsePaneSessions('%1\t$0\t@0\t2\tan\tawkward\tname');
  assert.equal(row.sessionName, 'an\tawkward\tname');
  assert.equal(row.windowCount, 2);
});

test('parsePaneSessions drops a row that names no session', () => {
  assert.deepEqual(parsePaneSessions('%1\t\t@0\t1\tname'), []);
  assert.deepEqual(parsePaneSessions(''), []);
  assert.deepEqual(parsePaneSessions(null), []);
});

test('chooseTmuxClient prefers the client already displaying the window', () => {
  // Raising it moves nothing inside tmux, which is the whole point: the other
  // client is looking at something else and must not be dragged off it.
  const candidates = [
    { paneId: '%356', sessionId: '$191', windowId: '@349', windowCount: 5, sessionName: 'parent' },
    { paneId: '%356', sessionId: '$204', windowId: '@349', windowCount: 1, sessionName: 'viewer' },
  ];
  const clients = [
    { tty: '/dev/ttys018', controlMode: false, sessionId: '$191', windowId: '@343' },
    { tty: '/dev/ttys035', controlMode: false, sessionId: '$204', windowId: '@349' },
  ];
  const { chosen, plain } = chooseTmuxClient({ candidates, clients });
  assert.equal(chosen.tty, '/dev/ttys035');
  assert.equal(plain.tty, '/dev/ttys035');
});

test('chooseTmuxClient breaks a tie towards the session dedicated to the window', () => {
  // Both clients show it - which is exactly the state the old bug left the
  // machine in. A session holding only this window is a viewer; one holding
  // five is somebody's working view that happens to be parked here.
  const candidates = [
    { paneId: '%356', sessionId: '$191', windowId: '@349', windowCount: 5, sessionName: 'parent' },
    { paneId: '%356', sessionId: '$204', windowId: '@349', windowCount: 1, sessionName: 'viewer' },
  ];
  const clients = [
    { tty: '/dev/ttys018', controlMode: false, sessionId: '$191', windowId: '@349' },
    { tty: '/dev/ttys035', controlMode: false, sessionId: '$204', windowId: '@349' },
  ];
  assert.equal(chooseTmuxClient({ candidates, clients }).chosen.tty, '/dev/ttys035');
});

test('chooseTmuxClient ignores a client attached to some other session', () => {
  const candidates = [
    { paneId: '%1', sessionId: '$0', windowId: '@0', windowCount: 1, sessionName: 'mine' },
  ];
  const clients = [
    { tty: '/dev/ttys009', controlMode: false, sessionId: '$7', windowId: '@0' },
  ];
  assert.deepEqual(chooseTmuxClient({ candidates, clients }), {
    chosen: null,
    plain: null,
    controlMode: false,
  });
});

test('chooseTmuxClient separates the best client from the best plain one', () => {
  // They answer different questions - is this pane in a native tab tmux cannot
  // see, and which tty do I raise - and collapsing them loses the fallback a
  // control mode session with a second ordinary attach depends on.
  const candidates = [
    { paneId: '%1', sessionId: '$0', windowId: '@0', windowCount: 1, sessionName: 'firstmate' },
  ];
  const clients = [
    { tty: '/dev/ttys002', controlMode: true, sessionId: '$0', windowId: '@0' },
    { tty: '/dev/ttys031', controlMode: false, sessionId: '$0', windowId: '@0' },
  ];
  const { chosen, plain } = chooseTmuxClient({ candidates, clients });
  assert.equal(chosen.tty, '/dev/ttys002');
  assert.equal(plain.tty, '/dev/ttys031');
});

test('chooseTmuxClient reports control mode whatever order the clients arrive in', () => {
  // Two clients on ONE candidate session tie on both ranking keys - tmux has no
  // per-client current window, so `#{window_id}` is the session's - and `chosen`
  // then falls out of `list-clients` ordering, which is attach order. Read off
  // `chosen`, a plain attach that got there first would hide the control client
  // and skip the pane-title path that pane actually needs.
  const candidates = [
    { paneId: '%1', sessionId: '$0', windowId: '@0', windowCount: 1, sessionName: 'firstmate' },
  ];
  const control = { tty: '/dev/ttys002', controlMode: true, sessionId: '$0', windowId: '@0' };
  const attach = { tty: '/dev/ttys031', controlMode: false, sessionId: '$0', windowId: '@0' };
  for (const clients of [
    [control, attach],
    [attach, control],
  ]) {
    assert.equal(chooseTmuxClient({ candidates, clients }).controlMode, true);
  }
});

test('resolveTmuxTarget reports a detached session with an attach hint', async () => {
  const exec = fakeExec({
    'list-panes': '%1\t$3\t@2\t1\tbackground',
    'list-clients': '',
  });
  const result = await resolveTmuxTarget(exec, { pane: '%1', tmuxEnv: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'detached');
  assert.equal(result.hint, 'tmux attach -t background');
});

test('the attach hint stays pasteable when the session name has a space in it', async () => {
  // A bell plugin renames sessions to `hv-sls-86-fb9d 🔔` on this machine.
  // Unquoted that is two arguments, and tmux answers it by prefix-matching
  // some other session entirely.
  const exec = fakeExec({
    'list-panes': '%356\t$204\t@349\t1\thv-sls-86-fb9d 🔔',
    'list-clients': '',
  });
  const result = await resolveTmuxTarget(exec, { pane: '%356', tmuxEnv: null });
  assert.equal(result.hint, "tmux attach -t 'hv-sls-86-fb9d 🔔'");
});

test('a detached pane in two sessions names the one dedicated to it', async () => {
  const exec = fakeExec({
    'list-panes': ['%356\t$191\t@349\t5\tparent', '%356\t$204\t@349\t1\tviewer'].join('\n'),
    'list-clients': '',
  });
  const result = await resolveTmuxTarget(exec, { pane: '%356', tmuxEnv: null });
  assert.equal(result.session, 'viewer');
  assert.equal(result.hint, 'tmux attach -t viewer');
});

test('resolveTmuxTarget reports a pane that no longer exists', async () => {
  const exec = fakeExec({ 'list-panes': new Error('no server running') });
  const result = await resolveTmuxTarget(exec, { pane: '%99', tmuxEnv: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'pane-gone');
});

test('resolveTmuxTarget reports a pane no session claims', async () => {
  // The other half of pane-gone: the command worked, and named no session for
  // this pane. Same answer, different cause.
  const exec = fakeExec({ 'list-panes': '%1\t$0\t@0\t1\tsomething-else' });
  const result = await resolveTmuxTarget(exec, { pane: '%99', tmuxEnv: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'pane-gone');
});

test('selectPane aims at one session, never at the bare pane', async () => {
  const exec = fakeExec({ 'select-window': '', 'select-pane': '' });
  await selectPane(exec, { pane: '%356', tmuxEnv: null, sessionId: '$204', windowId: '@349' });
  assert.ok(exec.calls.some((c) => c.includes('select-window -t $204:@349')));
  assert.ok(exec.calls.some((c) => c.includes('select-pane -t %356')));
  assert.ok(
    !exec.calls.some((c) => c.includes('select-window -t %356')),
    'a bare pane target lets tmux pick which session to move',
  );
});

test('focusSession focuses a plain tab through the matching terminal', async () => {
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
  const result = await focusSession(
    { host: { iterm_session_id: 'w0t1p0:57A1A161-0489-48BD-8C6E-A540C57DD9DE', term_program: 'iTerm.app' } },
    { exec: fakeExec({}), terminals },
  );
  assert.deepEqual(result, { ok: true, adapter: 'iterm2' });
  assert.equal(seen[0].sessionUuid, '57A1A161-0489-48BD-8C6E-A540C57DD9DE');
});

test('focusSession falls through to the next terminal when the first has no match', async () => {
  const terminals = [
    { name: 'a', label: 'A', termProgram: 'x', isAvailable: () => true, focus: () => false },
    { name: 'b', label: 'B', termProgram: 'y', isAvailable: () => true, focus: () => true },
  ];
  const result = await focusSession(
    { host: { tty: '/dev/ttys004' } },
    { exec: fakeExec({}), terminals },
  );
  assert.equal(result.ok, true);
  assert.equal(result.adapter, 'b');
});

test('focusSession does not let a rejecting adapter block the others', async () => {
  const terminals = [
    {
      name: 'broken',
      label: 'Broken',
      termProgram: 'x',
      isAvailable: () => true,
      // A rejected promise, not a synchronous throw: that is how the real
      // async adapters fail, and it has to be caught the same way.
      focus: async () => {
        throw new Error('osascript blew up');
      },
    },
    { name: 'good', label: 'Good', termProgram: 'y', isAvailable: () => true, focus: () => true },
  ];
  const result = await focusSession(
    { host: { tty: '/dev/ttys004' } },
    { exec: fakeExec({}), terminals },
  );
  assert.equal(result.ok, true);
  assert.equal(result.adapter, 'good');
});

test('focusSession survives an adapter whose availability check rejects', async () => {
  const terminals = [
    {
      name: 'broken',
      label: 'Broken',
      termProgram: 'x',
      isAvailable: async () => {
        throw new Error('osascript timed out');
      },
      focus: () => true,
    },
    { name: 'good', label: 'Good', termProgram: 'y', isAvailable: () => true, focus: () => true },
  ];
  const result = await focusSession(
    { host: { tty: '/dev/ttys004' } },
    { exec: fakeExec({}), terminals },
  );
  assert.equal(result.ok, true);
  assert.equal(result.adapter, 'good');
});

test('focusSession selects the pane then focuses the tmux host window', async () => {
  const exec = fakeExec({
    'list-panes': '%7\t$1\t@7\t3\tfirstmate',
    'list-clients': '/dev/ttys002\t0\t$1\t@2',
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
  const result = await focusSession(
    { host: { tmux_pane: '%7', tmux: '/tmp/tmux-501/default,1,0' } },
    { exec, terminals },
  );

  assert.equal(result.ok, true);
  assert.equal(result.tmuxSession, 'firstmate');
  // The pane is raised inside tmux before the window comes forward, otherwise
  // you get the right window showing the wrong pane - and aimed at the one
  // session we mean, since a bare pane target lets tmux choose.
  assert.ok(exec.calls.some((c) => c.includes('select-window -t $1:@7')));
  assert.ok(exec.calls.some((c) => c.includes('select-pane -t %7')));
  // The host terminal is matched on the live client tty, never on a stored one.
  assert.deepEqual(focused[0], { sessionUuid: null, tty: '/dev/ttys002' });
});

test('focusSession raises the viewer session, not the parent a linked window also lives in', async () => {
  // The bug this exists for, with the ids it was reproduced under. A tmux window
  // can belong to more than one session, and `handoff` builds exactly that: the
  // worker runs in a window of a parent session, and that same window is linked
  // into a per-worker viewer session whose tab is the one in front of you.
  //
  // `display-message -p -t %356 '#{session_name}'` returns an arbitrary one of
  // the two - the parent, when this was reported - so nmmon raised the parent's
  // tab, and `select-window -t %356` then dragged that client onto the worker's
  // window and left it there. Which one tmux names varies with which session was
  // last active, so the fixture below is the ranking, not tmux's mood.
  const exec = fakeExec({
    'list-panes': [
      '%356\t$191\t@349\t5\thv-sls-75-4d7a 🔔',
      '%356\t$204\t@349\t1\thv-sls-86-fb9d 🔔',
      '%350\t$191\t@343\t5\thv-sls-75-4d7a 🔔',
    ].join('\n'),
    'list-clients': ['/dev/ttys018\t0\t$191\t@343', '/dev/ttys035\t0\t$204\t@349'].join('\n'),
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
  const result = await focusSession(
    { host: { tmux_pane: '%356', tmux: '/tmp/tmux-502/default,1,0' } },
    { exec, terminals },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(focused, [{ sessionUuid: null, tty: '/dev/ttys035' }]);
  assert.equal(result.tmuxSession, 'hv-sls-86-fb9d 🔔');
  // Aimed at one session by id, so nothing else moves. Run even though ttys035
  // already displays @349: tmux makes that a no-op, and a flag to skip it would
  // be state to keep true.
  assert.ok(exec.calls.some((c) => c.includes('select-window -t $204:@349')));
  assert.ok(exec.calls.some((c) => c.includes('select-pane -t %356')));
  assert.ok(
    !exec.calls.some((c) => c.includes('$191')),
    'the parent client must never be moved',
  );
});

// ------------------------------------------- tmux control mode (`tmux -CC`)

test('titleNeedle survives the spinner that animates in the title', () => {
  // Read from tmux and from the terminal a moment apart, the same pane reports
  // "⠂ port-conflict-diagnostics" and "⠐ port-conflict-diagnostics". Matching
  // the whole string would work about as often as it failed.
  assert.equal(titleNeedle('⠂ port-conflict-diagnostics'), 'port-conflict-diagnostics');
  assert.equal(titleNeedle('⠐ port-conflict-diagnostics'), 'port-conflict-diagnostics');
  assert.equal(titleNeedle('✳ Enroll multiple operations'), 'Enroll multiple operations');
  assert.equal(titleNeedle('plain-title'), 'plain-title');
});

test('titleNeedle refuses a title too short to identify a window', () => {
  // A two-character needle matches half the tabs open, and `ends with` on it
  // would land somewhere arbitrary - the exact failure being fixed here.
  assert.equal(titleNeedle('⠂ ab'), null);
  assert.equal(titleNeedle('⠂'), null);
  assert.equal(titleNeedle(''), null);
  assert.equal(titleNeedle(null), null);
});

test('itermFocusByTitleScript matches on the tail and refuses to guess', () => {
  const script = itermFocusByTitleScript({ title: 'port-conflict-diagnostics' });
  assert.match(script, /ends with "port-conflict-diagnostics"/);
  assert.match(script, /if \(count of matched\) > 1 then return "ambiguous"/);
  assert.match(script, /activate/);
  assert.match(itermFocusByTitleScript({ title: 'say "hi"' }), /ends with "say \\"hi\\""/);
});

test('focusSession finds a control mode pane by title, not by the client tty', async () => {
  // The reported bug end to end: clicking a moroku-skills row focused the tab
  // running `tmux -CC new -s firstmate` instead.
  const exec = fakeExec({
    'list-panes': '%289\t$0\t@0\t1\tfirstmate',
    'list-clients': '/dev/ttys002\t1\t$0\t@0',
    '#{pane_title}': '⠂ Enroll multiple operations in webapp',
  });
  const byTitle = [];
  const byTty = [];
  const terminals = [
    {
      name: 'iterm2',
      label: 'iTerm2',
      termProgram: 'iTerm.app',
      isAvailable: () => true,
      focus: (_e, target) => {
        byTty.push(target);
        return true;
      },
      focusByTitle: (_e, target) => {
        byTitle.push(target);
        return 'ok';
      },
    },
  ];
  const result = await focusSession(
    { host: { tmux_pane: '%289', tmux: '/tmp/tmux-502/default,1,0', term_program: 'tmux' } },
    { exec, terminals },
  );

  assert.equal(result.ok, true);
  assert.equal(result.tmuxSession, 'firstmate');
  assert.deepEqual(byTitle, [{ title: 'Enroll multiple operations in webapp' }]);
  assert.deepEqual(byTty, [], 'the control client tty is never offered to a terminal');
  // select-window moves tmux's active window and the terminal does not follow,
  // so in control mode it is a pure side effect on the user's tmux state.
  assert.ok(
    !exec.calls.some((c) => c.includes('select-window')),
    'nothing should be selected in tmux for a control mode pane',
  );
});

test('focusSession says so rather than raising one of two identical titles', async () => {
  const exec = fakeExec({
    'list-panes': '%1\t$0\t@0\t1\tfirstmate',
    'list-clients': '/dev/ttys002\t1\t$0\t@0',
    '#{pane_title}': '⠂ Claude Code',
  });
  const terminals = [
    {
      name: 'iterm2',
      label: 'iTerm2',
      termProgram: 'iTerm.app',
      isAvailable: () => true,
      focus: () => assert.fail('must not fall through to a tty that does not exist'),
      focusByTitle: () => 'ambiguous',
    },
  ];
  const result = await focusSession({ host: { tmux_pane: '%1' } }, { exec, terminals });
  assert.equal(result.ok, false);
  assert.match(result.reason, /More than one window is called "Claude Code"/);
});

test('focusSession admits there is no tty to fall back to in control mode', async () => {
  const exec = fakeExec({
    'list-panes': '%1\t$0\t@0\t1\tfirstmate',
    'list-clients': '/dev/ttys002\t1\t$0\t@0',
    '#{pane_title}': '⠂ a window that has since closed',
  });
  const terminals = [
    {
      name: 'iterm2',
      label: 'iTerm2',
      termProgram: 'iTerm.app',
      isAvailable: () => true,
      focus: () => assert.fail('the control client tty must never be tried'),
      focusByTitle: () => 'notfound',
    },
  ];
  const result = await focusSession({ host: { tmux_pane: '%1' } }, { exec, terminals });
  assert.equal(result.ok, false);
  assert.match(result.reason, /control mode, so there is no tty to fall back to/);
});

test('focusSession still uses a plain client tty when one is also attached', async () => {
  // Control mode plus a second, ordinary `tmux attach` elsewhere. The title
  // path is tried first, but a real tty is a real fallback.
  const exec = fakeExec({
    'list-panes': '%1\t$0\t@0\t1\tfirstmate',
    'list-clients': '/dev/ttys002\t1\t$0\t@0\n/dev/ttys031\t0\t$0\t@0',
    '#{pane_title}': '⠂ not shown in iTerm2',
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
      focusByTitle: () => 'notfound',
    },
  ];
  const result = await focusSession({ host: { tmux_pane: '%1' } }, { exec, terminals });
  assert.equal(result.ok, true);
  assert.deepEqual(focused, [{ sessionUuid: null, tty: '/dev/ttys031' }]);
  assert.ok(exec.calls.some((c) => c.includes('select-pane -t %1')));
});

test('focusSession explains a detached tmux session instead of failing silently', async () => {
  const exec = fakeExec({
    'list-panes': '%7\t$3\t@2\t1\tbackground',
    'list-clients': '',
  });
  const result = await focusSession({ host: { tmux_pane: '%7' } }, { exec, terminals: [] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not attached/);
  assert.equal(result.hint, 'tmux attach -t background');
});

test('focusSession reports when no supported terminal is running', async () => {
  const terminals = [
    { name: 'a', label: 'A', termProgram: 'x', isAvailable: () => false, focus: () => true },
  ];
  const result = await focusSession(
    { host: { tty: '/dev/ttys004' } },
    { exec: fakeExec({}), terminals },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /No supported terminal|only implemented for macOS/);
});

test('the terminal adapters never run a command synchronously', async () => {
  // The whole point of the async chain: anything the /focus handler can reach
  // must hand back a promise rather than block the event loop. A sync adapter
  // would return a plain boolean here and the assertion would fail.
  const exec = async () => 'false';
  for (const terminal of ALL_TERMINALS) {
    assert.ok(
      terminal.isAvailable(exec) instanceof Promise,
      `${terminal.name}.isAvailable must be async`,
    );
    assert.ok(
      terminal.focus(exec, { tty: '/dev/ttys004' }) instanceof Promise,
      `${terminal.name}.focus must be async`,
    );
  }
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
