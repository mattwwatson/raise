import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMonitorServer, writeFrame } from '../src/server.js';

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
