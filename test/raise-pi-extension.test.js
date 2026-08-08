import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A fresh copy of the extension for each test.
 *
 * The collected window identity is cached at module scope - one process table
 * walk per pi process is the whole point - so tests that count those walks
 * cannot share an instance.
 *
 * @returns {Promise<Function>}
 */
let instance = 0;
async function loadExtension() {
  instance += 1;
  const module = await import(`../hooks/raise-pi-extension.js?case=${instance}`);
  return module.default;
}

/**
 * A scratch RAISE_HOME, a `fetch` that records posts instead of making them,
 * and a process table that counts how often it is read.
 */
function harness({ serverRunning = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'raise-test-'));
  const startServer = () =>
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ port: 65000, token: 't' }));
  if (serverRunning) startServer();

  const previousHome = process.env.RAISE_HOME;
  const previousFetch = globalThis.fetch;
  process.env.RAISE_HOME = dir;

  /** @type {any[]} */
  const posts = [];
  globalThis.fetch = (_url, init) => {
    posts.push(JSON.parse(String(init.body)));
    return Promise.resolve(/** @type {any} */ ({ ok: true }));
  };

  /** @type {Record<string, Function>} */
  const handlers = {};
  const pi = { on: (event, fn) => { handlers[event] = fn; } };

  /** @type {number[]} */
  const walked = [];
  const readProcess = (pid) => {
    walked.push(pid);
    return { ppid: 1, tty: '/dev/ttys004', command: 'pi', args: 'pi' };
  };

  return {
    pi,
    posts,
    walked,
    readProcess,
    startServer,
    fire: (event, payload) => handlers[event](payload, ctx()),
    cleanup: () => {
      globalThis.fetch = previousFetch;
      if (previousHome === undefined) delete process.env.RAISE_HOME;
      else process.env.RAISE_HOME = previousHome;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function ctx() {
  return {
    cwd: '/repo',
    sessionManager: {
      getSessionId: () => 's1',
      getSessionFile: () => '/sessions/s1.jsonl',
    },
  };
}

test('the window identity is walked once and sent with every post', async () => {
  // The walk is a blocking `ps` per ancestor, inside a handler pi awaits, so it
  // must happen once per process. Sending the cached answer every time is what
  // keeps a dropped post from costing the row its window for good.
  const h = harness();
  try {
    (await loadExtension())(h.pi, { readProcess: h.readProcess });

    h.fire('session_start', {});
    const walkedOnce = h.walked.length;
    assert.ok(walkedOnce > 0, 'the first post should walk the process table');

    h.fire('before_agent_start', {});
    h.fire('agent_settled', {});
    h.fire('session_shutdown', { reason: 'exit' });

    assert.equal(h.posts.length, 4);
    for (const post of h.posts) {
      assert.equal(post.host.tty, '/dev/ttys004', `${post.hook_event_name} should carry the tty`);
      assert.equal(post.host.pid, process.pid);
    }
    assert.equal(h.walked.length, walkedOnce, 'no further process table reads');
  } finally {
    h.cleanup();
  }
});

test('a session that started while Raise was down still reports its window', async () => {
  // Anchoring the identity to session_start would strand this session: its only
  // chance to be placed went nowhere, and it would render as a dead card and
  // outlive its own process by a fortnight in the registry.
  const h = harness({ serverRunning: false });
  try {
    (await loadExtension())(h.pi, { readProcess: h.readProcess });

    h.fire('session_start', {});
    assert.equal(h.posts.length, 0, 'nothing to post to');

    h.startServer();
    h.fire('before_agent_start', {});

    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].host.tty, '/dev/ttys004');
    assert.equal(h.posts[0].host.pid, process.pid);
  } finally {
    h.cleanup();
  }
});

test('a machine not running Raise never reads the process table', async () => {
  const h = harness({ serverRunning: false });
  try {
    (await loadExtension())(h.pi, { readProcess: h.readProcess });

    h.fire('session_start', {});
    h.fire('before_agent_start', {});
    h.fire('agent_settled', {});

    assert.equal(h.posts.length, 0);
    assert.equal(h.walked.length, 0);
  } finally {
    h.cleanup();
  }
});

test('every post names pi, the session and its file', async () => {
  const h = harness();
  try {
    (await loadExtension())(h.pi, { readProcess: h.readProcess });
    h.fire('agent_settled', {});

    const { host, ...rest } = h.posts[0];
    assert.deepEqual(rest, {
      session_id: 's1',
      hook_event_name: 'agent_settled',
      agent: 'pi',
      cwd: '/repo',
      transcript_path: '/sessions/s1.jsonl',
    });
    assert.equal(host.pid, process.pid);
  } finally {
    h.cleanup();
  }
});

test('a reload is not the end of a session, so nothing is posted', async () => {
  const h = harness();
  try {
    (await loadExtension())(h.pi, { readProcess: h.readProcess });
    h.fire('session_shutdown', { reason: 'reload' });
    assert.equal(h.posts.length, 0);
  } finally {
    h.cleanup();
  }
});
