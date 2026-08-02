import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMonitorServer, writeFrame, stableJson } from '../src/server.js';
import { probeHealth } from '../src/health.js';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'nmmon-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Ask the OS for a port nobody is using, then hand it straight back. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test('a write to a destroyed client cannot take the process down', () => {
  // Sleep, wake, a dropped network, or an abort racing the close handler all
  // leave a response whose socket is gone. An unguarded write emits 'error' on
  // an emitter with no listener, which is an uncaught exception - and since
  // nmmon is the thing that tells you a session is blocked, its death is
  // silent.
  const dropped = [];
  const throwing = {
    write() {
      throw new Error('write after end');
    },
  };
  assert.equal(writeFrame(throwing, 'frame', (err) => dropped.push(err.message)), false);
  assert.deepEqual(dropped, ['write after end']);
});

test('an asynchronous socket failure drops the client too', () => {
  const dropped = [];
  const failsLater = {
    write(frame, cb) {
      cb(new Error('EPIPE'));
      return true;
    },
  };
  assert.equal(writeFrame(failsLater, 'frame', (err) => dropped.push(err.message)), true);
  assert.deepEqual(dropped, ['EPIPE']);
});

test('a healthy client is written to and kept', () => {
  const written = [];
  const healthy = {
    write(frame, cb) {
      written.push(frame);
      cb();
      return true;
    },
  };
  assert.equal(
    writeFrame(healthy, 'frame', () => assert.fail('a good write must not drop the client')),
    true,
  );
  assert.deepEqual(written, ['frame']);
});

test('a ticking clock is not a change - elapsed fields must not defeat the push guard', () => {
  // waitingForMs and parkedForMs are recomputed from now on every poll, so
  // comparing them means a blocked session or a parked run - exactly what this
  // tool is for - pushes a full frame and a full DOM rebuild every second.
  const snapshot = (now) => ({
    generatedAt: now,
    summary: { blocked: 1, parked: 1, failed: 0, total: 2 },
    rows: [
      { id: 'session:s1', attention: 'blocked', sessionStateSince: 1000, waitingForMs: now - 1000 },
      { id: 'run:r1', attention: 'parked', run: { parkedSince: 500, parkedForMs: now - 500 } },
    ],
  });
  assert.equal(stableJson(snapshot(9000)), stableJson(snapshot(90_000)));
  assert.notEqual(
    stableJson(snapshot(9000)),
    stableJson({ ...snapshot(9000), rows: [] }),
    'a real change must still be seen',
  );
});

test('stopping the server removes the file that tells hooks where to post', async () => {
  // Left behind, it is not just a stale URL in `nmmon open`: every hook keeps
  // posting the session id, cwd, transcript path and the token to whatever
  // binds this port next.
  const { dir, cleanup } = scratch();
  const previousHome = process.env.NMMON_HOME;
  process.env.NMMON_HOME = dir;
  try {
    const port = await freePort();
    const monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      execAsync: async () => '',
    });
    const info = await monitor.start();
    assert.equal(info.port, port);
    assert.equal(existsSync(join(dir, 'server.json')), true);

    await monitor.stop();
    assert.equal(existsSync(join(dir, 'server.json')), false);
  } finally {
    if (previousHome === undefined) delete process.env.NMMON_HOME;
    else process.env.NMMON_HOME = previousHome;
    cleanup();
  }
});

test('/focus never runs a synchronous child process', async () => {
  // The guard the other tests carry - exec: assert.fail - only means anything
  // if something actually exercises the route. Focusing shells out to osascript
  // and tmux, and a synchronous child in the HTTP handler stalls the poll
  // timer, every open event stream and every hook post at once.
  const { dir, cleanup } = scratch();
  const previousHome = process.env.NMMON_HOME;
  process.env.NMMON_HOME = dir;
  try {
    const port = await freePort();
    const ran = [];
    const monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      execAsync: async (command, args = []) => {
        ran.push(command);
        return '';
      },
    });
    await monitor.start();

    // Register a focusable session the way a hook would.
    const registered = await fetch(`http://127.0.0.1:${port}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nmmon-token': 'test-token' },
      body: JSON.stringify({
        session_id: 'focus-me',
        hook_event_name: 'SessionStart',
        cwd: dir,
        host: { tty: '/dev/ttys004', term_program: 'iTerm.app' },
      }),
    });
    assert.equal(registered.status, 204);

    const res = await fetch(`http://127.0.0.1:${port}/focus?t=test-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nmmon-token': 'test-token' },
      body: JSON.stringify({ sessionId: 'focus-me' }),
    });
    // No terminal answers the fake runner, so the honest outcome is 409 with a
    // reason - what matters is that it got there without a blocking exec.
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.ok(body.reason, 'a failed focus always explains itself');
    if (process.platform === 'darwin') {
      assert.ok(ran.includes('osascript'), 'the async runner is the one that was used');
    }

    // And the server is still answering afterwards.
    const state = await fetch(`http://127.0.0.1:${port}/state?t=test-token`);
    assert.equal(state.status, 200);

    await monitor.stop();
  } finally {
    if (previousHome === undefined) delete process.env.NMMON_HOME;
    else process.env.NMMON_HOME = previousHome;
    cleanup();
  }
});

test('/focus answers a session that is no longer registered', async () => {
  const { dir, cleanup } = scratch();
  const previousHome = process.env.NMMON_HOME;
  process.env.NMMON_HOME = dir;
  try {
    const port = await freePort();
    const monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      execAsync: async () => '',
    });
    await monitor.start();

    const res = await fetch(`http://127.0.0.1:${port}/focus?t=test-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nmmon-token': 'test-token' },
      body: JSON.stringify({ sessionId: 'gone' }),
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).ok, false);

    await monitor.stop();
  } finally {
    if (previousHome === undefined) delete process.env.NMMON_HOME;
    else process.env.NMMON_HOME = previousHome;
    cleanup();
  }
});

test('an event stream survives a client that vanishes mid-broadcast', async () => {
  const { dir, cleanup } = scratch();
  const previousHome = process.env.NMMON_HOME;
  process.env.NMMON_HOME = dir;
  try {
    const port = await freePort();
    const monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      execAsync: async () => '',
    });
    await monitor.start();

    const controller = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${port}/events?t=test-token`, {
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    controller.abort();

    // Push through the registry so a broadcast happens right after the abort.
    const posted = await fetch(`http://127.0.0.1:${port}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nmmon-token': 'test-token' },
      body: JSON.stringify({ session_id: 's1', hook_event_name: 'Notification', cwd: dir }),
    });
    assert.equal(posted.status, 204);

    const state = await fetch(`http://127.0.0.1:${port}/state?t=test-token`);
    const payload = await state.json();
    assert.equal(payload.summary.blocked, 1, 'the server is still alive and still reporting');

    await monitor.stop();
  } finally {
    if (previousHome === undefined) delete process.env.NMMON_HOME;
    else process.env.NMMON_HOME = previousHome;
    cleanup();
  }
});

test('the keepalive is an event the page can see, not an invisible comment', async () => {
  // It used to be `: keepalive`, an SSE comment. EventSource discards comments
  // without telling the page, so the only liveness signal the browser had was
  // an error - which never fires while the socket is merely quiet. A server
  // frozen with SIGSTOP left the dashboard on a green "live" dot indefinitely.
  const { dir, cleanup } = scratch();
  const previousHome = process.env.NMMON_HOME;
  process.env.NMMON_HOME = dir;
  try {
    const port = await freePort();
    const monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      keepaliveMs: 40,
      exec: () => assert.fail('no blocking commands from the server'),
      execAsync: async () => '',
    });
    await monitor.start();

    const controller = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${port}/events?t=test-token`, {
      signal: controller.signal,
    });
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!/^event: ping$/m.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    controller.abort();

    assert.match(text, /^event: ping$/m, 'the keepalive must be a named event');
    assert.match(text, /^data: \d+$/m, 'and carry data, or EventSource discards the frame');
    assert.ok(!text.includes(': keepalive'), 'the comment form is gone');

    await monitor.stop();
  } finally {
    if (previousHome === undefined) delete process.env.NMMON_HOME;
    else process.env.NMMON_HOME = previousHome;
    cleanup();
  }
});

test('the page can load the connection module, and only with the token', async () => {
  const { dir, cleanup } = scratch();
  const previousHome = process.env.NMMON_HOME;
  process.env.NMMON_HOME = dir;
  try {
    const port = await freePort();
    const monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      execAsync: async () => '',
    });
    await monitor.start();

    const served = await fetch(`http://127.0.0.1:${port}/connection.js?t=test-token`);
    assert.equal(served.status, 200);
    assert.match(served.headers.get('content-type'), /javascript/);
    assert.match(await served.text(), /export function createConnectionWatch/);

    // Serving a static file is no reason to punch a hole in the token rule.
    const bare = await fetch(`http://127.0.0.1:${port}/connection.js`);
    assert.equal(bare.status, 401);

    // And the page is allowed to import it.
    const page = await fetch(`http://127.0.0.1:${port}/?t=test-token`);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);

    await monitor.stop();
  } finally {
    if (previousHome === undefined) delete process.env.NMMON_HOME;
    else process.env.NMMON_HOME = previousHome;
    cleanup();
  }
});

// -------------------------------------------------------------- probeHealth

/** Occupy a port with something that is emphatically not nmmon. */
async function occupy(port, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
}

test('probeHealth identifies a live monitor, with no token', async () => {
  // /health is the one unauthenticated route precisely so this is possible: the
  // caller asking "is nmmon there?" has no reason to know its token, and may be
  // a different installation entirely.
  const { dir, cleanup } = scratch();
  const previousHome = process.env.NMMON_HOME;
  process.env.NMMON_HOME = dir;
  try {
    const port = await freePort();
    const monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      execAsync: async () => '',
    });
    await monitor.start();

    assert.deepEqual(await probeHealth(port), { pid: process.pid });

    await monitor.stop();
  } finally {
    if (previousHome === undefined) delete process.env.NMMON_HOME;
    else process.env.NMMON_HOME = previousHome;
    cleanup();
  }
});

test('probeHealth says nothing is there when nothing is there', async () => {
  const port = await freePort();
  assert.equal(await probeHealth(port), null);
});

test('probeHealth refuses to mistake another program for nmmon', async () => {
  // Anything can be listening on a local port, including something that answers
  // 200 with JSON of its own. Believing it would have us print `kill <pid>` for
  // a pid belonging to an unrelated program.
  const port = await freePort();
  const impostors = [
    (req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"hello":"world"}'),
    (req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('OK'),
    (req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'),
    (req, res) => res.writeHead(500).end('nope'),
  ];
  for (const handler of impostors) {
    const close = await occupy(port, handler);
    try {
      assert.equal(await probeHealth(port), null, `${handler} must not read as nmmon`);
    } finally {
      await close();
    }
  }
});

test('probeHealth gives up on a port that accepts and never answers', async () => {
  // A hung listener must not hang `serve`, `open` or `doctor` with it.
  const port = await freePort();
  const close = await occupy(port, () => {
    // Deliberately never respond.
  });
  try {
    const started = Date.now();
    assert.equal(await probeHealth(port, { timeoutMs: 100 }), null);
    assert.ok(Date.now() - started < 2000, 'the timeout is the one that applies');
  } finally {
    await close();
  }
});
