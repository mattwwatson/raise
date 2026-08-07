import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FirstmateWatch,
  isCrewWindowName,
  lockedPid,
  parsePaneWindowNames,
  REFRESH_MS,
} from '../src/firstmate.js';

/**
 * A session record, in the shape the registry stores.
 *
 * @param {object} [overrides]
 */
function session(overrides = {}) {
  return {
    sessionId: 'a',
    agent: 'claude',
    cwd: '/Users/x/.treehouse/repo-1/1/repo',
    transcriptPath: null,
    event: 'SessionStart',
    state: 'idle',
    message: null,
    notificationType: null,
    host: { pid: 100, tmux: '/tmp/tmux-501/default,900,0', tmux_pane: '%1' },
    startedAt: 0,
    updatedAt: 0,
    stateSince: 0,
    blockAnnouncedAt: null,
    ...overrides,
  };
}

/**
 * A file access whose contents are a plain map, so nothing touches the disk.
 *
 * `mtime` is bumped by `write` rather than by a clock, which is what lets a
 * test say "the lock changed" without any timing at all.
 *
 * @param {Record<string, string>} [initial]
 */
function files(initial = {}) {
  const contents = new Map(Object.entries(initial));
  const mtimes = new Map([...contents.keys()].map((path) => [path, 1]));
  let reads = 0;
  return {
    stat(path) {
      if (!contents.has(path)) throw new Error('ENOENT');
      return { size: contents.get(path).length, mtimeMs: mtimes.get(path), isDirectory: false };
    },
    readText(path) {
      if (!contents.has(path)) throw new Error('ENOENT');
      reads += 1;
      return contents.get(path);
    },
    write(path, text) {
      contents.set(path, text);
      mtimes.set(path, (mtimes.get(path) || 0) + 1);
    },
    remove(path) {
      contents.delete(path);
    },
    get reads() {
      return reads;
    },
  };
}

/** The live tmux server this machine runs, as read off it on 07/08/2026. */
const PANES = [
  '%0\tFirst Mate',
  '%358\tfm-sls-87-push-subscription-ownership',
  '%359\tfm-sls-89-deploy-unpinned-install',
  '%330\thandoff-sls-75-4d7a',
  '%323\tzsh',
].join('\n');

test('a window name firstmate pinned is crew, and one that merely starts alike is not', () => {
  assert.equal(isCrewWindowName('fm-sls-89-deploy-unpinned-install'), true);
  // The prefix on its own is a window somebody called that, not `fm-<id>`.
  assert.equal(isCrewWindowName('fm-'), false);
  assert.equal(isCrewWindowName(''), false);
  assert.equal(isCrewWindowName(null), false);
  // The two names this whole item exists to keep apart.
  assert.equal(isCrewWindowName('handoff-sls-75-4d7a'), false);
  assert.equal(isCrewWindowName('First Mate'), false);
});

test('a linked window is emitted once per session and reads the same every time', () => {
  // tmux lists a window linked into two sessions twice, and a window name is a
  // property of the window rather than of whoever is looking at it.
  const names = parsePaneWindowNames('%330\thandoff-sls-75-4d7a\n%330\thandoff-sls-75-4d7a\n');
  assert.equal(names.size, 1);
  assert.equal(names.get('%330'), 'handoff-sls-75-4d7a');
});

test('a window name containing a tab keeps all of it', () => {
  const names = parsePaneWindowNames('%1\tone\ttwo');
  assert.equal(names.get('%1'), 'one\ttwo');
});

test('a lock holds one pid and nothing else counts', () => {
  assert.equal(lockedPid('49672\n'), 49672);
  assert.equal(lockedPid('49672'), 49672);
  // A file that happens to be called .lock and is not firstmate's.
  assert.equal(lockedPid('pid=49672'), null);
  assert.equal(lockedPid(''), null);
  assert.equal(lockedPid(null), null);
});

test('a crewmate is chipped once its pane has been read', async () => {
  const watch = new FirstmateWatch({
    execAsync: async () => PANES,
    files: files(),
  });
  const crew = session({ host: { pid: 100, tmux: '', tmux_pane: '%358' } });
  // The first ask schedules the read and answers from an empty cache, exactly
  // as the Lavish link does. The chip appears a tick later rather than the poll
  // loop waiting on tmux.
  assert.equal(watch.spawnedBy(crew), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(watch.spawnedBy(crew), 'firstmate');
});

test('a handoff worker and a plain shell are never chipped', async () => {
  const watch = new FirstmateWatch({ execAsync: async () => PANES, files: files() });
  const handoff = session({ host: { pid: 100, tmux: '', tmux_pane: '%330' } });
  const shell = session({ host: { pid: 100, tmux: '', tmux_pane: '%323' } });
  watch.spawnedBy(handoff);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(watch.spawnedBy(handoff), null);
  assert.equal(watch.spawnedBy(shell), null);
});

test('the captain is the session whose own lock holds its pid', () => {
  const access = files({ '/Users/x/work/firstmate/state/.lock': '49672\n' });
  const watch = new FirstmateWatch({ files: access });
  const captain = session({
    cwd: '/Users/x/work/firstmate',
    host: { pid: 49672, tmux: '', tmux_pane: null },
  });
  assert.equal(watch.spawnedBy(captain), 'firstmate');
});

test('a session that merely has firstmate open is not the first mate', () => {
  // The trap this rule exists for: the cwd matches and the lock is right there,
  // but the pid in it belongs to the harness actually running firstmate. Someone
  // fixing firstmate is not the first mate.
  const access = files({ '/Users/x/work/firstmate/state/.lock': '49672\n' });
  const watch = new FirstmateWatch({ files: access });
  const editing = session({
    cwd: '/Users/x/work/firstmate',
    host: { pid: 51234, tmux: '', tmux_pane: null },
  });
  assert.equal(watch.spawnedBy(editing), null);
});

test('the lock is read once and then only when it changes', () => {
  const access = files({ '/Users/x/work/firstmate/state/.lock': '49672\n' });
  const watch = new FirstmateWatch({ files: access });
  const captain = session({
    cwd: '/Users/x/work/firstmate',
    host: { pid: 49672, tmux: '', tmux_pane: null },
  });
  for (let i = 0; i < 5; i += 1) watch.spawnedBy(captain);
  assert.equal(access.reads, 1, 'cached on mtime, like git-branch caches HEAD');

  // A restarted first mate rewrites the lock with its new pid, and the old
  // captain's card must stop claiming it.
  access.write('/Users/x/work/firstmate/state/.lock', '60001\n');
  assert.equal(watch.spawnedBy(captain), null);
  assert.equal(access.reads, 2);
});

test('a lock written after the session started is still picked up', () => {
  // The captain's lock records the harness pid, so it is written *after* the
  // session exists. Caching "no lock here" permanently would mean the captain
  // never got its chip at all.
  const access = files();
  const watch = new FirstmateWatch({ files: access });
  const captain = session({
    cwd: '/Users/x/work/firstmate',
    host: { pid: 49672, tmux: '', tmux_pane: null },
  });
  assert.equal(watch.spawnedBy(captain), null);
  access.write('/Users/x/work/firstmate/state/.lock', '49672\n');
  assert.equal(watch.spawnedBy(captain), 'firstmate');
});

test('a session with no tmux pane never runs tmux', () => {
  const ran = [];
  const watch = new FirstmateWatch({
    execAsync: async (command) => {
      ran.push(command);
      return '';
    },
    files: files(),
  });
  // A Claude Desktop session, which has no pane by nature.
  watch.spawnedBy(session({ host: { pid: 100, app: 'claude-desktop' } }));
  assert.deepEqual(ran, [], 'nothing looks for firstmate on a machine without it');
});

test('a pane table we could not read is not evidence that nobody is crew', async () => {
  let out = PANES;
  const watch = new FirstmateWatch({ execAsync: async () => out, files: files() });
  const crew = session({ host: { pid: 100, tmux: '', tmux_pane: '%358' } });
  watch.spawnedBy(crew, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(watch.spawnedBy(crew, 0), 'firstmate');

  // tmux gone, or a socket we cannot talk to. Dropping the chip off every card
  // and putting it back a tick later is exactly the flicker the never-null rule
  // on the pipeline marker exists to avoid.
  out = '';
  watch.spawnedBy(crew, REFRESH_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(watch.spawnedBy(crew, REFRESH_MS), 'firstmate');
});

test('an unknown pane does not read the table more than once per interval', async () => {
  let reads = 0;
  const watch = new FirstmateWatch({
    execAsync: async () => {
      reads += 1;
      return '';
    },
    files: files(),
  });
  const unknown = session({ host: { pid: 100, tmux: '', tmux_pane: '%999' } });
  for (let i = 0; i < 10; i += 1) {
    watch.spawnedBy(unknown, i * 100);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(reads, 1, 'a per-session lookup, never a per-second one');
});

test('two tmux servers do not share a pane id', async () => {
  // Keyed by the socket, which is what `-S` carries: a custom socket has to be
  // honoured or we would be reading a different server's panes entirely.
  const tables = { '/tmp/a': '%1\tfm-crew', '/tmp/b': '%1\tzsh' };
  const watch = new FirstmateWatch({
    execAsync: async (_cmd, args) => {
      assert.equal(args[0], '-S');
      return tables[args[1]] || '';
    },
    files: files(),
  });
  const onA = session({ host: { pid: 1, tmux: '/tmp/a,1,0', tmux_pane: '%1' } });
  const onB = session({ host: { pid: 2, tmux: '/tmp/b,2,0', tmux_pane: '%1' } });
  watch.spawnedBy(onA);
  watch.spawnedBy(onB);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(watch.spawnedBy(onA), 'firstmate');
  assert.equal(watch.spawnedBy(onB), null);
});

test('load answers without waiting for a second tick, for the one-shot CLI', async () => {
  const watch = new FirstmateWatch({ execAsync: async () => PANES, files: files() });
  const crew = session({ host: { pid: 100, tmux: '', tmux_pane: '%358' } });
  await watch.load([crew]);
  assert.equal(watch.spawnedBy(crew), 'firstmate');
});

test('prune forgets the lock of a session that has gone', () => {
  const access = files({ '/Users/x/work/firstmate/state/.lock': '49672\n' });
  const watch = new FirstmateWatch({ files: access });
  const captain = session({
    cwd: '/Users/x/work/firstmate',
    host: { pid: 49672, tmux: '', tmux_pane: null },
  });
  watch.spawnedBy(captain);
  watch.prune(new Set());
  watch.spawnedBy(captain);
  assert.equal(access.reads, 2, 'the entry was dropped, so it had to be read again');
});
