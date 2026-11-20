import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isHerdrAddress,
  herdrServerName,
  typedAttachAddress,
  parseHerdrProcesses,
  findTypedAttach,
  isAppServer,
  herdrAppSucceeded,
  showInHerdrApp,
  attachHint,
  HERDR_BUNDLE_ID,
} from '../src/focus/herdr.js';

const STATE = '/Users/me/.local/state/herdr-core';
const DEFAULT_SOCKET = `${STATE}/default/default.sock`;
const LAB_SOCKET = `${STATE}/lab/lab.sock`;

/** The holder line as `ps` printed it for the default server on hc 0.1.21. */
const DEFAULT_HOLDER =
  `?? /Users/me/.local/share/herdr-core/active/Herdr Core.app/Contents/MacOS/herdr-core hold --socket ${STATE}/default/default.holder.42bd4a65.sock`;

/**
 * A fake exec that answers from a table and records what it was asked. The
 * first pattern contained in the command line wins.
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

test('a Herdr address is t, a digit, then digits or lowercase letters, and nothing else', () => {
  assert.equal(isHerdrAddress('t5'), true);
  assert.equal(isHerdrAddress('t123'), true);
  // Measured on hc 0.1.21: the local server handed out t17, t18, t19, t1b, t1c, t1d.
  assert.equal(isHerdrAddress('t1b'), true);
  assert.equal(isHerdrAddress('t1d'), true);
  // The digit after the t is what keeps an ordinary word from reading as an address.
  const words = ['fix', 'tab', 'tmux', 'T1B'];
  const elsewhere = ['mac/t5', 'mac/t1b'];
  for (const bad of ['', 't', '5', ...words, ...elsewhere, '--terminal', 't5 ', null, 5]) {
    assert.equal(isHerdrAddress(bad), false, String(bad));
  }
});

test('a server is named by the <name>/<name>.sock shape and by nothing else', () => {
  assert.equal(herdrServerName(DEFAULT_SOCKET), 'default');
  assert.equal(herdrServerName(LAB_SOCKET), 'lab');
  // The holder's socket sits in the same directory and is not the server's.
  assert.equal(herdrServerName(`${STATE}/default/default.holder.42bd4a65.sock`), null);
  // A custom HC_SOCKET has no name we could vouch for.
  assert.equal(herdrServerName('/tmp/mine.sock'), null);
  assert.equal(herdrServerName(null), null);
});

test('only the default server is the one the desktop app shows', () => {
  assert.equal(isAppServer(DEFAULT_SOCKET), true);
  assert.equal(isAppServer(LAB_SOCKET), false);
  assert.equal(isAppServer('/tmp/mine.sock'), false);
  assert.equal(isAppServer(null), false);
});

test('a typed attach names its address however hc was invoked', () => {
  assert.equal(typedAttachAddress('hc attach t6'), 't6');
  assert.equal(typedAttachAddress('/Users/me/.local/bin/hc attach t6'), 't6');
  assert.equal(typedAttachAddress('herdr-core attach t6'), 't6');
  assert.equal(
    typedAttachAddress('/Users/me/.local/share/herdr-core/active/Herdr Core.app/Contents/MacOS/herdr-core attach t6'),
    't6',
  );
  assert.equal(typedAttachAddress('hc attach --observe --history 200 t6 --json'), 't6');
  assert.equal(typedAttachAddress('hc attach --history=200 t6'), 't6');
});

test('a typed attach names an address with a letter in it', () => {
  assert.equal(typedAttachAddress('hc attach t1b'), 't1b');
  assert.equal(typedAttachAddress('hc attach --observe t1d'), 't1d');
});

test('the picker and anything else that names no address is not a typed attach', () => {
  // The picker's argv stays bare whatever it ends up showing - which is the
  // whole reason it is not supported.
  assert.equal(typedAttachAddress('hc'), null);
  assert.equal(typedAttachAddress('hc attach'), null);
  // Another machine's t6 is not this machine's.
  assert.equal(typedAttachAddress('hc attach macbook/t6'), null);
  // A name is resolved by the server, and we cannot ask it which terminal it means.
  assert.equal(typedAttachAddress('hc attach fix'), null);
  assert.equal(typedAttachAddress('hc attach tab'), null);
  assert.equal(typedAttachAddress('hc attach macbook/t1b'), null);
  assert.equal(typedAttachAddress('hc read t6'), null);
});

test('a typed attach with a flag we do not know is not trusted', () => {
  // `--frobnicate t5 t6` could mean either; a wrong address raises somebody
  // else's tab.
  assert.equal(typedAttachAddress('hc attach --frobnicate t5'), null);
  assert.equal(typedAttachAddress('hc attach t5 t6'), null);
});

test('a path is only read as the client when a space sits inside an app bundle', () => {
  assert.equal(typedAttachAddress('vim notes/hc attach t6'), null);
  assert.equal(typedAttachAddress('/usr/bin/vim /tmp/hc attach t6'), null);
});

test('the process table yields this address\'s typed attaches and every running server', () => {
  const ps = [
    `ttys022  hc attach t6`,
    `ttys020  hc attach t7`,
    `ttys021  hc`,
    `??       hc attach t6`,
    DEFAULT_HOLDER,
    `ttys004  -zsh`,
  ].join('\n');
  const sighting = parseHerdrProcesses(ps, 't6');
  // The client with no terminal has no tab to raise, so it is not counted.
  assert.deepEqual(sighting.attachTtys, ['/dev/ttys022']);
  assert.deepEqual(sighting.serverDirs, [`${STATE}/default`]);
});

test('findTypedAttach hands back the one tab showing the address on this server', async () => {
  const exec = fakeExec({ ps: `ttys022  hc attach t6\n${DEFAULT_HOLDER}` });
  const found = await findTypedAttach(exec, { address: 't6', socket: DEFAULT_SOCKET });
  assert.deepEqual(found, { tty: '/dev/ttys022', ambiguous: false });
});

test('findTypedAttach finds the tab showing an address with a letter in it', async () => {
  const exec = fakeExec({ ps: `ttys022  hc attach t1b\nttys020  hc attach t1\n${DEFAULT_HOLDER}` });
  const found = await findTypedAttach(exec, { address: 't1b', socket: DEFAULT_SOCKET });
  assert.deepEqual(found, { tty: '/dev/ttys022', ambiguous: false });
});

test('findTypedAttach calls two typed attaches of one address ambiguous', async () => {
  const exec = fakeExec({ ps: `ttys022  hc attach t6\nttys020  hc attach --observe t6` });
  const found = await findTypedAttach(exec, { address: 't6', socket: DEFAULT_SOCKET });
  assert.deepEqual(found, { tty: null, ambiguous: true });
});

test('findTypedAttach drops the address when a second server is running', async () => {
  // A typed attach names no server, so with a lab server up as well this t6
  // could be either one's - and the lab's t6 is a different terminal.
  const exec = fakeExec({
    ps: [
      `ttys022  hc attach t6`,
      DEFAULT_HOLDER,
      `?? herdr-core hold --socket ${STATE}/lab/lab.holder.9.sock`,
    ].join('\n'),
  });
  const found = await findTypedAttach(exec, { address: 't6', socket: DEFAULT_SOCKET });
  assert.deepEqual(found, { tty: null, ambiguous: false });
});

test('findTypedAttach trusts the address when no holder can be seen at all', async () => {
  // The holder check can only disprove. Finding none asserts nothing, and the
  // typed address is still the evidence.
  const exec = fakeExec({ ps: `ttys022  hc attach t6` });
  const found = await findTypedAttach(exec, { address: 't6', socket: DEFAULT_SOCKET });
  assert.equal(found.tty, '/dev/ttys022');
});

test('findTypedAttach does not look without the session\'s server, and a failed ps is no sighting', async () => {
  const unused = fakeExec({});
  assert.deepEqual(await findTypedAttach(unused, { address: 't6', socket: null }), {
    tty: null,
    ambiguous: false,
  });
  assert.deepEqual(unused.calls, []);

  const failing = fakeExec({ ps: new Error('ps failed') });
  assert.deepEqual(await findTypedAttach(failing, { address: 't6', socket: DEFAULT_SOCKET }), {
    tty: null,
    ambiguous: false,
  });
});

test('herdr-app success is a reply without an error, and anything unparseable is not', () => {
  assert.equal(herdrAppSucceeded(''), true);
  assert.equal(herdrAppSucceeded('{ "pane": "p12" }'), true);
  assert.equal(herdrAppSucceeded('{ "error": "no such pane" }'), false);
  assert.equal(herdrAppSucceeded('focused p12'), false);
  assert.equal(herdrAppSucceeded('null'), false);
});

test('showInHerdrApp focuses the app\'s own pane and brings the app forward', async () => {
  const exec = fakeExec({
    'is running': 'true',
    'pane.focus': '{}',
    activate: '',
  });
  assert.deepEqual(await showInHerdrApp(exec, { address: 't5' }), { via: 'pane', front: true });
  assert.deepEqual(exec.calls.slice(1), [
    'herdr-app do pane.focus --terminal t5',
    `osascript -e tell application id "${HERDR_BUNDLE_ID}" to activate`,
  ]);
  assert.ok(!exec.calls.some((c) => c.includes('terminal.show')), 'no pane was borrowed');
});

test('showInHerdrApp borrows the focused pane only when the app has none for it', async () => {
  const exec = fakeExec({
    'is running': 'true',
    'pane.focus': new Error('herdr-app exited 1: {"error":"no such pane"}'),
    'terminal.show': '{}',
    activate: '',
  });
  assert.deepEqual(await showInHerdrApp(exec, { address: 't8' }), { via: 'shown', front: true });
  assert.ok(exec.calls.includes('herdr-app do terminal.show --terminal t8'));
  assert.ok(exec.calls.at(-1).includes('activate'));
});

test('showInHerdrApp never launches the app and never runs herdr-app when it is not running', async () => {
  const exec = fakeExec({ 'is running': 'false' });
  assert.equal(await showInHerdrApp(exec, { address: 't5' }), null);
  assert.equal(exec.calls.length, 1);
  assert.ok(!exec.calls.some((c) => c.startsWith('herdr-app') || c.includes('to activate')));
});

test('showInHerdrApp still reports a focused pane when the app would not come forward', async () => {
  const exec = fakeExec({
    'is running': 'true',
    'pane.focus': '{}',
    activate: new Error('osascript failed'),
  });
  assert.deepEqual(await showInHerdrApp(exec, { address: 't5' }), { via: 'pane', front: false });
});

test('showInHerdrApp still reports a borrowed pane when the app would not come forward', async () => {
  const exec = fakeExec({
    'is running': 'true',
    'pane.focus': '{ "error": "no such pane" }',
    'terminal.show': '{}',
    activate: new Error('osascript failed'),
  });
  assert.deepEqual(await showInHerdrApp(exec, { address: 't8' }), { via: 'shown', front: false });
});

test('showInHerdrApp reports nothing when neither command works', async () => {
  const exec = fakeExec({
    'is running': 'true',
    'pane.focus': '{ "error": "no such pane" }',
    'terminal.show': '{ "error": "no such running terminal" }',
  });
  assert.equal(await showInHerdrApp(exec, { address: 't5' }), null);
  assert.ok(!exec.calls.some((c) => c.includes('to activate')), 'nothing to bring forward');
});

test('the attach hint names the server only when a bare hc would reach another', () => {
  assert.equal(attachHint({ address: 't8', socket: DEFAULT_SOCKET }), 'hc attach t8');
  assert.equal(attachHint({ address: 't8', socket: null }), 'hc attach t8');
  assert.equal(attachHint({ address: 't8', socket: LAB_SOCKET }), `HC_SOCKET=${LAB_SOCKET} hc attach t8`);
  assert.equal(
    attachHint({ address: 't8', socket: '/Users/a b/x.sock' }),
    `HC_SOCKET='/Users/a b/x.sock' hc attach t8`,
  );
});
