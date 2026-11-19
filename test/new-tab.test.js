import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NEW_TAB_BLOCK,
  newTabFrom,
  newTabTerminals,
  chooseNewTabTerminal,
  tmuxAttachArgv,
  herdrAttachArgv,
  openInNewTab,
} from '../src/focus/new-tab.js';
import { ALL_TERMINALS, iterm2, terminalApp, ghostty } from '../src/focus/terminals.js';
import { CONFIG_FEATURES } from '../src/user-config.js';

/** A config file as `readUserConfig` hands it back. */
function file(data, problem = null) {
  return { data, problem };
}

test('the setting lives in the block CONFIG_FEATURES writes', () => {
  const feature = CONFIG_FEATURES.find((f) => f.name === 'new-tab');
  assert.equal(feature?.block, NEW_TAB_BLOCK);
  assert.equal(feature?.field, 'terminal');
  assert.equal(feature?.watched, true);
});

test('every terminal adapter can be named, read off the adapter list', () => {
  assert.deepEqual(
    newTabTerminals().map((t) => t.name),
    ['iterm2', 'terminal-app', 'ghostty'],
  );
  assert.deepEqual(newTabTerminals(ALL_TERMINALS), [iterm2, terminalApp, ghostty]);
});

test('the setting is off unless enabled is the boolean true', () => {
  for (const data of [
    null,
    {},
    { newTab: { terminal: 'iterm2' } },
    { newTab: { enabled: 'true', terminal: 'iterm2' } },
    { newTab: { enabled: false, terminal: 'iterm2' } },
  ]) {
    assert.deepEqual(newTabFrom(file(data)), { enabled: false, terminal: null, problem: null });
  }
});

test('the setting names the terminal to open in', () => {
  assert.deepEqual(newTabFrom(file({ newTab: { enabled: true, terminal: 'ghostty' } })), {
    enabled: true,
    terminal: 'ghostty',
    problem: null,
  });
});

test('a terminal Raise cannot open a tab in is a problem, never a fallback to another', () => {
  const unknown = newTabFrom(file({ newTab: { enabled: true, terminal: 'wezterm' } }));
  assert.equal(unknown.terminal, null);
  assert.match(unknown.problem, /"wezterm" is not a terminal Raise can open a tab in/);
  assert.match(unknown.problem, /iterm2, terminal-app, ghostty/);

  const missing = newTabFrom(file({ newTab: { enabled: true } }));
  assert.equal(missing.terminal, null);
  assert.match(missing.problem, /no terminal is named/);

  // An adapter with no openTab cannot be named, even though it is a terminal.
  const focusOnly = { ...iterm2, openTab: undefined };
  const refused = newTabFrom(file({ newTab: { enabled: true, terminal: 'iterm2' } }), {
    terminals: [focusOnly],
  });
  assert.equal(refused.terminal, null);
});

test('an unusable config file turns the setting off and passes its problem on', () => {
  const setting = newTabFrom(file(null, 'mode 0644'));
  assert.deepEqual(setting, { enabled: false, terminal: null, problem: 'mode 0644' });
});

test('a terminal the user names is chosen without looking at what is running', () => {
  assert.deepEqual(chooseNewTabTerminal({ named: 'ghostty', running: [] }), { terminal: 'ghostty' });
  // Named, it replaces whatever the file had.
  assert.deepEqual(
    chooseNewTabTerminal({ named: 'terminal-app', existing: 'iterm2', running: [iterm2] }),
    { terminal: 'terminal-app' },
  );
});

test('an unknown terminal name is refused rather than written', () => {
  const choice = chooseNewTabTerminal({ named: 'iTerm', running: [iterm2] });
  assert.equal(choice.terminal, undefined);
  assert.match(choice.error, /Unknown terminal "iTerm"\. Raise can open a tab in: iterm2, terminal-app, ghostty\./);
});

test('a terminal already in the file is kept when none is named', () => {
  assert.deepEqual(chooseNewTabTerminal({ existing: 'ghostty', running: [iterm2] }), {});
});

test('with none named and none in the file, the one running terminal is written', () => {
  assert.deepEqual(chooseNewTabTerminal({ running: [ghostty] }), { terminal: 'ghostty' });
  // A name in the file nothing recognises is no reason to stop looking.
  assert.deepEqual(chooseNewTabTerminal({ existing: 'wezterm', running: [iterm2] }), {
    terminal: 'iterm2',
  });
});

test('several running terminals is a refusal that names them', () => {
  const choice = chooseNewTabTerminal({ running: [iterm2, ghostty] });
  assert.equal(choice.terminal, undefined);
  assert.match(choice.error, /More than one terminal is running \(iTerm2, Ghostty\)/);
  assert.match(choice.error, /raise enable new-tab <terminal> \(iterm2, ghostty\)/);
});

test('no running terminal is a refusal that says how to name one', () => {
  const choice = chooseNewTabTerminal({ running: [], platform: 'darwin' });
  assert.match(choice.error, /No terminal Raise can open a tab in is running/);
  assert.match(choice.error, /raise enable new-tab <terminal> \(iterm2, terminal-app, ghostty\)/);
  const linux = chooseNewTabTerminal({ running: [], platform: 'linux' });
  assert.match(linux.error, /macOS-only/);
});

test('the tmux attach argv names the socket and the session id, never the name', () => {
  assert.deepEqual(
    tmuxAttachArgv({ tmux: '/opt/bin/tmux', tmuxEnv: "/tmp/raise test/it's.sock,123,4", sessionId: '$4' }),
    ['/opt/bin/tmux', '-S', "/tmp/raise test/it's.sock", 'attach-session', '-t', '$4'],
  );
  assert.deepEqual(tmuxAttachArgv({ tmux: '/opt/bin/tmux', tmuxEnv: null, sessionId: '$0' }), [
    '/opt/bin/tmux',
    'attach-session',
    '-t',
    '$0',
  ]);
});

test('the Herdr attach argv names its server, the default one included', () => {
  const socket = '/Users/me/.local/state/herdr-core/default/default.sock';
  assert.deepEqual(herdrAttachArgv({ hc: '/opt/bin/hc', address: 't5', socket }), [
    '/usr/bin/env',
    '-u',
    'HC_SESSION',
    `HC_SOCKET=${socket}`,
    '/opt/bin/hc',
    'attach',
    't5',
  ]);
});

test('openInNewTab asks only the named terminal, and reads a failure as not opened', async () => {
  const asked = [];
  const make = (name, outcome) => ({
    ...iterm2,
    name,
    openTab: async (_exec, { argv }) => {
      asked.push([name, argv]);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  });
  const terminals = [make('a', true), make('b', false), make('c', new Error('boom'))];
  const exec = async () => '';
  assert.deepEqual(await openInNewTab(exec, { argv: ['x'], terminal: 'a', terminals }), {
    ok: true,
    adapter: 'a',
  });
  assert.equal(await openInNewTab(exec, { argv: ['x'], terminal: 'b', terminals }), null);
  assert.equal(await openInNewTab(exec, { argv: ['x'], terminal: 'c', terminals }), null);
  assert.equal(await openInNewTab(exec, { argv: ['x'], terminal: 'zzz', terminals }), null);
  assert.deepEqual(asked.map(([name]) => name), ['a', 'b', 'c']);
});
