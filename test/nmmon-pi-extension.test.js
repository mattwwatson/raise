import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import register from '../hooks/nmmon-pi-extension.js';

/**
 * A scratch NMMON_HOME with a server record the extension will believe, and a
 * `fetch` that records the posts instead of making them.
 */
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'nmmon-test-'));
  writeFileSync(join(dir, 'server.json'), JSON.stringify({ port: 65000, token: 't' }));
  const previousHome = process.env.NMMON_HOME;
  const previousFetch = globalThis.fetch;
  process.env.NMMON_HOME = dir;

  /** @type {object[]} */
  const posts = [];
  globalThis.fetch = (_url, init) => {
    posts.push(JSON.parse(String(init.body)));
    return Promise.resolve(/** @type {any} */ ({ ok: true }));
  };

  /** @type {Record<string, Function>} */
  const handlers = {};
  const pi = { on: (event, fn) => { handlers[event] = fn; } };

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
    fire: (event, payload) => handlers[event](payload, ctx()),
    cleanup: () => {
      globalThis.fetch = previousFetch;
      if (previousHome === undefined) delete process.env.NMMON_HOME;
      else process.env.NMMON_HOME = previousHome;
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

test('the window identity is captured at session start and not resent', () => {
  // The walk is a blocking `ps` per ancestor, inside a handler pi awaits, so it
  // must not run on the steady-state events. The registry merges `host` over
  // the record it already holds, so omitting the field keeps the identity.
  const h = harness();
  try {
    register(h.pi, { readProcess: h.readProcess });

    h.fire('session_start', {});
    assert.equal(h.posts[0].host.tty, '/dev/ttys004');
    assert.equal(h.posts[0].host.pid, process.pid);
    const walkedAtStart = h.walked.length;
    assert.ok(walkedAtStart > 0, 'session start should walk the process table');

    h.fire('before_agent_start', {});
    h.fire('agent_settled', {});
    h.fire('session_shutdown', { reason: 'exit' });

    for (const post of h.posts.slice(1)) {
      assert.equal('host' in post, false, `${post.hook_event_name} should carry no host`);
    }
    assert.equal(h.walked.length, walkedAtStart, 'no further process table reads');
  } finally {
    h.cleanup();
  }
});

test('every post names pi, the session and its file', () => {
  const h = harness();
  try {
    register(h.pi, { readProcess: h.readProcess });
    h.fire('agent_settled', {});

    assert.deepEqual(h.posts[0], {
      session_id: 's1',
      hook_event_name: 'agent_settled',
      agent: 'pi',
      cwd: '/repo',
      transcript_path: '/sessions/s1.jsonl',
    });
  } finally {
    h.cleanup();
  }
});

test('a reload is not the end of a session, so nothing is posted', () => {
  const h = harness();
  try {
    register(h.pi, { readProcess: h.readProcess });
    h.fire('session_shutdown', { reason: 'reload' });
    assert.equal(h.posts.length, 0);
  } finally {
    h.cleanup();
  }
});
