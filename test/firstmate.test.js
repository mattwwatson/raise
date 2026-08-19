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

test('two sessions on one tmux server share a table and read it once', async () => {
  // `$TMUX` is "<socket>,<server pid>,<session index>", so two sessions on one
  // server differ in the last field. Keyed on the raw string that is two tables,
  // two rate limits and two `list-panes -a` for one server.
  let reads = 0;
  const watch = new FirstmateWatch({
    execAsync: async () => {
      reads += 1;
      return PANES;
    },
    files: files(),
  });
  const first = session({ host: { pid: 1, tmux: '/tmp/default,29202,0', tmux_pane: '%358' } });
  const second = session({ host: { pid: 2, tmux: '/tmp/default,29202,187', tmux_pane: '%323' } });
  watch.spawnedBy(first, 0);
  watch.spawnedBy(second, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1, 'one server, one read');
  assert.equal(watch.spawnedBy(first, 0), 'firstmate');
  assert.equal(watch.spawnedBy(second, 0), null);
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

test('captainSession names the session whose own directory is $FM_HOME', () => {
  // Its `cwd` is what `firstmate-decisions.js` runs the fleet snapshot out of,
  // so the path is never hardcoded and a machine with no lock never looks.
  const access = files({ '/Users/x/work/firstmate/state/.lock': '49672\n' });
  const watch = new FirstmateWatch({ files: access });
  const crew = session({ sessionId: 'crew' });
  const captain = session({
    sessionId: 'captain',
    cwd: '/Users/x/work/firstmate',
    host: { pid: 49672, tmux: '', tmux_pane: null },
  });
  const editing = session({
    sessionId: 'editing',
    cwd: '/Users/x/work/firstmate',
    host: { pid: 51234, tmux: '', tmux_pane: null },
  });
  assert.equal(watch.captainSession([crew, editing, captain])?.sessionId, 'captain');
  // Same rule as the chip, by the same two halves: the directory alone is
  // anybody with firstmate's source open.
  assert.equal(watch.captainSession([crew, editing]), null);
  assert.equal(watch.captainSession([]), null);
  assert.equal(watch.captainSession(null), null);
});

test('only a read that threw is unreadable - everything a lock contains is an answer', () => {
  // The caller acts on the absence of a captain - it is what says firstmate has
  // gone and takes every open ruling off the page - so a null that came from a
  // read we did not get has to be distinguishable from a null that is an answer.
  // The line between them is drawn by the *read*, never by the text: `stat` said
  // a lock is there and `readText` then threw.
  const home = '/Users/x/work/firstmate';
  const path = `${home}/state/.lock`;

  // The lock is gone, which is the ordinary every-session case and an answer.
  const gone = files({ [path]: '49672\n' });
  gone.remove(path);
  assert.equal(new FirstmateWatch({ files: gone }).lockUnreadableAt(home), false);

  // Held by firstmate, and read: also an answer.
  assert.equal(
    new FirstmateWatch({ files: files({ [path]: '49672\n' }) }).lockUnreadableAt(home),
    false,
  );

  // There and unreadable. `stat` answered, so a lock exists, and this is where
  // a `state/.lock` *directory* lands: `stat` accepts one and the read rejects
  // it with EISDIR.
  const throwing = {
    ...files({ [path]: '49672\n' }),
    readText() {
      throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
    },
  };
  assert.equal(new FirstmateWatch({ files: throwing }).lockUnreadableAt(home), true);

  // Empty, whitespace and a foreign tool's own format are each an answer, and
  // none of them needs a case of its own. Four rounds of review narrowed a
  // predicate about lock text and each narrowing let a different shape through,
  // so there is no predicate left to walk past.
  for (const text of ['', '   \n', 'held-by=some-other-tool\n', '  ']) {
    assert.equal(
      new FirstmateWatch({ files: files({ [path]: text }) }).lockUnreadableAt(home),
      false,
      `${JSON.stringify(text)} is an answer`,
    );
  }

  // And with no home there is nothing to ask about, which is not a failed read.
  assert.equal(new FirstmateWatch({ files: files({ [path]: '49672\n' }) }).lockUnreadableAt(null), false);
});

test('a lock at one session says nothing about any other session directory', () => {
  // The question `lockUnreadableAt` answers is "has the captain gone", and the
  // only lock that can answer it is the one at the home the standing reading
  // came from. Asked across every session instead, a single stray `state/.lock`
  // in an unrelated checkout would suppress the refresh for the whole machine
  // and leave every crewmate row asserting a ruling for the life of the process.
  const access = {
    stat: () => ({ size: 1, mtimeMs: 1 }),
    readText: (path) => {
      if (path.startsWith('/Users/x/other/')) throw new Error('EIO');
      return '49672\n';
    },
  };
  const watch = new FirstmateWatch({ files: access });
  assert.equal(watch.lockUnreadableAt('/Users/x/other'), true);
  assert.equal(watch.lockUnreadableAt('/Users/x/work/firstmate'), false);
});

test('a lock that reads fine and holds no pid is an answer, and is read once', () => {
  // `lockedPid` parses strictly on purpose: content that is not one line of
  // digits is a file that happens to be called `.lock` and is not firstmate's.
  const path = '/Users/x/other/state/.lock';
  const bystander = session({
    sessionId: 'bystander',
    cwd: '/Users/x/other',
    host: { pid: 700, tmux: '', tmux_pane: null },
  });
  const access = files({ [path]: 'held-by=some-other-tool\n' });
  const watch = new FirstmateWatch({ files: access });
  assert.equal(watch.captainSession([bystander]), null);
  // And cached like any other answer. It is a stable fact about somebody else's
  // file, where `#lockPidFor` runs twice per session per tick.
  watch.captainSession([bystander]);
  watch.spawnedBy(bystander);
  assert.equal(access.reads, 1);
});

test('an empty lock is cached as an answer, and the completed write moves past it', () => {
  // Caching it is safe by the key rather than by a predicate: `bin/fm-lock.sh`
  // writes the lock with a single `printf`, so the only torn read possible is
  // an empty one - and the entry it caches is keyed on a size and mtime the
  // completed write immediately moves past.
  const path = '/Users/x/work/firstmate/state/.lock';
  const captain = session({
    sessionId: 'captain',
    cwd: '/Users/x/work/firstmate',
    host: { pid: 49672, tmux: '', tmux_pane: null },
  });
  const torn = files({ [path]: '' });
  const watch = new FirstmateWatch({ files: torn });
  assert.equal(watch.captainSession([captain]), null);
  torn.write(path, '49672\n');
  assert.equal(watch.captainSession([captain])?.sessionId, 'captain');
});

test('windowName answers from the table and never schedules a read of its own', async () => {
  // `spawnedBy` is called for every session on every tick and is what keeps the
  // table warm. A second scheduler here would only add a way for the two to
  // disagree about when a pane was last looked up.
  const ran = [];
  const watch = new FirstmateWatch({
    files: files(),
    execAsync: async (command, args) => {
      ran.push(command);
      void args;
      return '%1\tfm-crew-1';
    },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const crew = session();
  assert.equal(watch.windowName(crew), null, 'nothing has been read yet');
  // Awaited before asserting, because a scheduled read runs its command on a
  // microtask - checking synchronously would pass whether or not one was fired.
  await settle();
  assert.deepEqual(ran, [], 'and asking did not go and read it');

  // The chip is what schedules the table.
  watch.spawnedBy(crew, 0);
  await settle();
  assert.equal(watch.windowName(crew), 'fm-crew-1');
  assert.deepEqual(ran, ['tmux']);

  // A session with no pane has no window, and still runs nothing.
  assert.equal(watch.windowName(session({ host: { pid: 1, tmux: '', tmux_pane: null } })), null);
  assert.equal(watch.windowName(null), null);
  await settle();
  assert.deepEqual(ran, ['tmux']);
});
