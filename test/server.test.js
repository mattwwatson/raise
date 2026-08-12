import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { createMonitorServer, writeFrame, stableJson } from '../src/server.js';
import { probeHealth } from '../src/health.js';

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * The three agents' homes, which the scan for untracked sessions reads.
 *
 * Pointed at the scratch directory by `scratch()` below, and restored with it.
 * Without that the suite walks whatever transcripts the machine running it
 * happens to have on disk, so `/state` carries a row per session the developer
 * had open - which is both a test that touches the real machine and one whose
 * result changes between two runs a minute apart.
 */
const AGENT_HOMES = ['CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'CODEX_HOME'];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'raise-test-'));
  const previous = AGENT_HOMES.map((name) => [name, process.env[name]]);
  for (const name of AGENT_HOMES) process.env[name] = dir;
  return {
    dir,
    cleanup: () => {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
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
  // Raise is the thing that tells you a session is blocked, its death is
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
  // Left behind, it is not just a stale URL in `raise open`: every hook keeps
  // posting the session id, cwd, transcript path and the token to whatever
  // binds this port next.
  const { dir, cleanup } = scratch();
  const previousHome = process.env.RAISE_HOME;
  process.env.RAISE_HOME = dir;
  try {
    const port = await freePort();
    const monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      fetch: () => assert.fail('no outbound requests from the server'),
      execAsync: async () => '',
    });
    const info = await monitor.start();
    assert.equal(info.port, port);
    assert.equal(existsSync(join(dir, 'server.json')), true);

    await monitor.stop();
    assert.equal(existsSync(join(dir, 'server.json')), false);
  } finally {
    if (previousHome === undefined) delete process.env.RAISE_HOME;
    else process.env.RAISE_HOME = previousHome;
    cleanup();
  }
});

test('/dismiss quiets an idle nudge, and a real prompt spends the dismissal', async () => {
  // The whole feature end to end, against a live server: the page and the CLI
  // share `buildRows`, so proving it on `/state` proves both.
  const { dir, cleanup } = scratch();
  const previousHome = process.env.RAISE_HOME;
  process.env.RAISE_HOME = dir;
  // Stopped in the finally, so a failed assertion reports itself rather than
  // leaving a listening server to hang the whole run.
  let monitor = null;
  try {
    const port = await freePort();
    monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      fetch: () => assert.fail('no outbound requests from the server'),
      execAsync: async () => '',
    });
    await monitor.start();

    const post = (path, body) =>
      fetch(`http://127.0.0.1:${port}${path}?t=test-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-raise-token': 'test-token' },
        body: JSON.stringify(body),
      });
    const rowFor = async (sessionId) => {
      const state = await (await fetch(`http://127.0.0.1:${port}/state?t=test-token`)).json();
      return state.rows.find((r) => r.sessionId === sessionId);
    };

    const nudge = {
      session_id: 'nudged',
      hook_event_name: 'Notification',
      cwd: dir,
      message: 'Claude is waiting for your input',
      notification_type: 'idle_prompt',
      host: { tty: '/dev/ttys004', term_program: 'iTerm.app' },
    };
    assert.equal((await post('/event', nudge)).status, 204);
    assert.equal((await rowFor('nudged')).attention, 'blocked');
    assert.equal((await rowFor('nudged')).dismissible, true);

    const dismissed = await post('/dismiss', { sessionId: 'nudged' });
    assert.equal(dismissed.status, 200);
    assert.deepEqual(await dismissed.json(), { ok: true });

    const quiet = await rowFor('nudged');
    assert.equal(quiet.attention, 'idle', 'out of the waiting-for-you group');
    assert.equal(quiet.dismissed, true, 'and saying why, rather than silently hidden');

    // A permission prompt is a new announcement, so the dismissal is spent with
    // nothing further asked of anybody. `PermissionRequest` carries neither a
    // message nor a type - it fires the instant Claude decides it needs a human,
    // and the reason follows on the Notification - so this is what a real one
    // looks like, and `isIdleNudge` fails closed on it.
    assert.equal(
      (await post('/event', { session_id: 'nudged', hook_event_name: 'PermissionRequest' })).status,
      204,
    );
    const red = await rowFor('nudged');
    assert.equal(red.attention, 'blocked');
    assert.equal(red.dismissed, false);
    assert.equal(red.dismissible, false, 'and no control is offered on a permission prompt');

    // The server does not take the page's word for eligibility: a stale tab
    // clicking through on that row is refused.
    const refused = await post('/dismiss', { sessionId: 'nudged' });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).ok, false);
    assert.equal((await rowFor('nudged')).attention, 'blocked');

    const missing = await post('/dismiss', { sessionId: 'never-seen' });
    assert.equal(missing.status, 404);
  } finally {
    if (monitor) await monitor.stop();
    if (previousHome === undefined) delete process.env.RAISE_HOME;
    else process.env.RAISE_HOME = previousHome;
    cleanup();
  }
});

test('/focus never runs a synchronous child process', async () => {
  // The guard the other tests carry - exec: assert.fail - only means anything
  // if something actually exercises the route. Focusing shells out to osascript
  // and tmux, and a synchronous child in the HTTP handler stalls the poll
  // timer, every open event stream and every hook post at once.
  const { dir, cleanup } = scratch();
  const previousHome = process.env.RAISE_HOME;
  process.env.RAISE_HOME = dir;
  try {
    const port = await freePort();
    const ran = [];
    const monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      fetch: () => assert.fail('no outbound requests from the server'),
      execAsync: async (command, _args = []) => {
        ran.push(command);
        return '';
      },
    });
    await monitor.start();

    // Register a focusable session the way a hook would.
    const registered = await fetch(`http://127.0.0.1:${port}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-raise-token': 'test-token' },
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
      headers: { 'content-type': 'application/json', 'x-raise-token': 'test-token' },
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
    if (previousHome === undefined) delete process.env.RAISE_HOME;
    else process.env.RAISE_HOME = previousHome;
    cleanup();
  }
});

test('/focus answers a session that is no longer registered', async () => {
  const { dir, cleanup } = scratch();
  const previousHome = process.env.RAISE_HOME;
  process.env.RAISE_HOME = dir;
  try {
    const port = await freePort();
    const monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      fetch: () => assert.fail('no outbound requests from the server'),
      execAsync: async () => '',
    });
    await monitor.start();

    const res = await fetch(`http://127.0.0.1:${port}/focus?t=test-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-raise-token': 'test-token' },
      body: JSON.stringify({ sessionId: 'gone' }),
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).ok, false);

    await monitor.stop();
  } finally {
    if (previousHome === undefined) delete process.env.RAISE_HOME;
    else process.env.RAISE_HOME = previousHome;
    cleanup();
  }
});

test('an event stream survives a client that vanishes mid-broadcast', async () => {
  const { dir, cleanup } = scratch();
  const previousHome = process.env.RAISE_HOME;
  process.env.RAISE_HOME = dir;
  try {
    const port = await freePort();
    const monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      fetch: () => assert.fail('no outbound requests from the server'),
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
      headers: { 'content-type': 'application/json', 'x-raise-token': 'test-token' },
      body: JSON.stringify({ session_id: 's1', hook_event_name: 'Notification', cwd: dir }),
    });
    assert.equal(posted.status, 204);

    const state = await fetch(`http://127.0.0.1:${port}/state?t=test-token`);
    const payload = await state.json();
    assert.equal(payload.summary.blocked, 1, 'the server is still alive and still reporting');

    await monitor.stop();
  } finally {
    if (previousHome === undefined) delete process.env.RAISE_HOME;
    else process.env.RAISE_HOME = previousHome;
    cleanup();
  }
});

test('the keepalive is an event the page can see, not an invisible comment', async () => {
  // It used to be `: keepalive`, an SSE comment. EventSource discards comments
  // without telling the page, so the only liveness signal the browser had was
  // an error - which never fires while the socket is merely quiet. A server
  // frozen with SIGSTOP left the dashboard on a green "live" dot indefinitely.
  const { dir, cleanup } = scratch();
  const previousHome = process.env.RAISE_HOME;
  process.env.RAISE_HOME = dir;
  try {
    const port = await freePort();
    const monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      keepaliveMs: 40,
      exec: () => assert.fail('no blocking commands from the server'),
      fetch: () => assert.fail('no outbound requests from the server'),
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
    if (previousHome === undefined) delete process.env.RAISE_HOME;
    else process.env.RAISE_HOME = previousHome;
    cleanup();
  }
});

test('the page can load the connection module, and only with the token', async () => {
  const { dir, cleanup } = scratch();
  const previousHome = process.env.RAISE_HOME;
  process.env.RAISE_HOME = dir;
  try {
    const port = await freePort();
    const monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      fetch: () => assert.fail('no outbound requests from the server'),
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
    if (previousHome === undefined) delete process.env.RAISE_HOME;
    else process.env.RAISE_HOME = previousHome;
    cleanup();
  }
});

// -------------------------------------------------------------- probeHealth

/** Occupy a port with something that is emphatically not Raise. */
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
  // caller asking "is Raise there?" has no reason to know its token, and may be
  // a different installation entirely.
  const { dir, cleanup } = scratch();
  const previousHome = process.env.RAISE_HOME;
  process.env.RAISE_HOME = dir;
  try {
    const port = await freePort();
    const monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      fetch: () => assert.fail('no outbound requests from the server'),
      execAsync: async () => '',
    });
    await monitor.start();

    assert.deepEqual(await probeHealth(port), { pid: process.pid });

    await monitor.stop();
  } finally {
    if (previousHome === undefined) delete process.env.RAISE_HOME;
    else process.env.RAISE_HOME = previousHome;
    cleanup();
  }
});

test('probeHealth says nothing is there when nothing is there', async () => {
  const port = await freePort();
  assert.equal(await probeHealth(port), null);
});

test('probeHealth refuses to mistake another program for Raise', async () => {
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
      assert.equal(await probeHealth(port), null, `${handler} must not read as Raise`);
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

test('/recent serves one session"s history, and only to an authenticated caller', async () => {
  // The expando is pulled rather than pushed: putting every session's history
  // in every state frame would send it to every open page once a second, to
  // render something that is collapsed nearly all of the time.
  const { dir, cleanup } = scratch();
  const previousHome = process.env.RAISE_HOME;
  process.env.RAISE_HOME = dir;
  try {
    const port = await freePort();
    const transcriptPath = join(dir, 'transcript.jsonl');
    const records = [
      { type: 'user', timestamp: '2026-08-03T01:00:00.000Z', message: { content: [{ type: 'text', text: 'do the thing' }] } },
      { type: 'assistant', timestamp: '2026-08-03T01:00:05.000Z', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { description: 'run the tests' } }] } },
    ];
    const monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      fetch: () => assert.fail('no outbound requests from the server'),
      execAsync: async () => '',
      transcriptFiles: {
        stat: () => ({ size: 1, mtimeMs: 1 }),
        readTail: () => ({ text: records.map((r) => JSON.stringify(r)).join('\n'), partial: false }),
      },
    });
    await monitor.start();

    await fetch(`http://127.0.0.1:${port}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-raise-token': 'test-token' },
      body: JSON.stringify({
        session_id: 'expand-me',
        hook_event_name: 'SessionStart',
        cwd: dir,
        transcript_path: transcriptPath,
      }),
    });

    const res = await fetch(`http://127.0.0.1:${port}/recent?session=expand-me&t=test-token`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(
      body.events.map((e) => [e.kind, e.text]),
      [
        ['you', 'do the thing'],
        ['tool', 'run the tests'],
      ],
    );

    // The token is load-bearing on this route above all: it serves the contents
    // of a conversation, and localhost is not a boundary.
    const bare = await fetch(`http://127.0.0.1:${port}/recent?session=expand-me`);
    assert.equal(bare.status, 401);

    const unknown = await fetch(`http://127.0.0.1:${port}/recent?session=nobody&t=test-token`);
    assert.equal(unknown.status, 404);

    const missing = await fetch(`http://127.0.0.1:${port}/recent?t=test-token`);
    assert.equal(missing.status, 404);

    await monitor.stop();
  } finally {
    if (previousHome === undefined) delete process.env.RAISE_HOME;
    else process.env.RAISE_HOME = previousHome;
    cleanup();
  }
});

test('a pipeline lands on the session that started it, not on its neighbours', async () => {
  // Three Claude sessions open on one checkout is an ordinary day. The run was
  // reaching all of them, because a run is matched by repo path - so two of the
  // three cards showed a pipeline they had nothing to do with, each offering a
  // Focus button to a window that could not answer its gate.
  const { dir, cleanup } = scratch();
  const previousHome = process.env.RAISE_HOME;
  process.env.RAISE_HOME = dir;
  const repo = join(dir, 'repo');
  let monitor = null;
  try {
    const dbPath = join(dir, 'state.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(
      'CREATE TABLE repos (id TEXT, working_path TEXT);' +
        'CREATE TABLE runs (id TEXT, repo_id TEXT, branch TEXT, status TEXT,' +
        ' awaiting_agent_since INTEGER, created_at INTEGER, updated_at INTEGER,' +
        ' pr_url TEXT, pr_state TEXT, pr_state_observed_at INTEGER, head_sha TEXT, error TEXT);' +
        'CREATE TABLE step_results (run_id TEXT, step_name TEXT, status TEXT, step_order INTEGER,' +
        ' findings_json TEXT, last_activity TEXT, last_activity_at INTEGER, log_path TEXT);',
    );
    const seconds = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO repos VALUES (?, ?)').run('repo-1', repo);
    db.prepare(
      'INSERT INTO runs VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL)',
    ).run('run-1', 'repo-1', 'main', 'running', seconds, seconds);
    db.close();
    // A real checkout, because a sighting is resolved by branch: `axi run` acts
    // on the branch it is issued from, so a session with none owns nothing.
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    // The registry prunes a session whose agent pid is not alive, so these have
    // to be real - our own process and its parent, standing in for two agents.
    const driverPid = process.pid;
    const neighbourPid = process.ppid;
    // The real chain, minus the shell wrappers Claude Code puts in between: the
    // driver hangs off one agent, and the other is merely sitting in the same
    // directory. Both are pipeline commands; only one of them is ownership.
    const ps = [
      '  100     1 /Applications/iTerm.app/Contents/MacOS/iTerm2',
      `  ${driverPid}   100 claude`,
      `  999999   ${driverPid} /usr/local/bin/no-mistakes axi run --intent "ship it"`,
      `  ${neighbourPid}   100 claude`,
      `  999998   ${neighbourPid} /usr/local/bin/no-mistakes axi status`,
    ].join('\n');

    const port = await freePort();
    monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath,
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      fetch: () => assert.fail('no outbound requests from the server'),
      execAsync: async (command) => (command === 'ps' ? ps : ''),
    });
    await monitor.start();

    for (const [sessionId, pid] of [
      ['driver', driverPid],
      ['neighbour', neighbourPid],
    ]) {
      const registered = await fetch(`http://127.0.0.1:${port}/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-raise-token': 'test-token' },
        body: JSON.stringify({
          session_id: sessionId,
          hook_event_name: 'SessionStart',
          cwd: repo,
          host: { tty: '/dev/ttys004', term_program: 'iTerm.app', pid },
        }),
      });
      assert.equal(registered.status, 204);
    }

    // Asking is what schedules the scan, so the first reading predates it.
    await (await fetch(`http://127.0.0.1:${port}/state?t=test-token`)).json();
    for (let i = 0; i < 10; i += 1) await nextTick();

    const body = await (await fetch(`http://127.0.0.1:${port}/state?t=test-token`)).json();
    const byId = new Map(body.rows.map((r) => [r.sessionId, r]));
    assert.equal(byId.get('driver')?.run?.runId, 'run-1');
    assert.equal(byId.get('neighbour')?.run, null);
    // Identity is shared even though the pipeline is not: both are the one repo.
    assert.equal(byId.get('driver')?.title, 'repo');
    assert.equal(byId.get('neighbour')?.title, 'repo');
    // And the run does not also appear as an unattached row of its own.
    assert.equal(body.rows.length, 2);
  } finally {
    // In the finally, not at the end of the try: a failed assertion that leaves
    // the poll timer running wedges the whole test run rather than failing it.
    await monitor?.stop();
    if (previousHome === undefined) delete process.env.RAISE_HOME;
    else process.env.RAISE_HOME = previousHome;
    cleanup();
  }
});

test('a pipeline driven from a worktree lands on the worktree, not on the checkout', async () => {
  // Seen live, and the reason this was written: a Treehouse session at
  // `~/.treehouse/<repo>-<hash>/2/<repo>` drove a run to a parked review gate
  // and showed no pipeline at all, while the idle `main` checkout next door
  // claimed it - a Focus button to the one window that could not answer the
  // gate. no-mistakes registers a run against the main checkout, because that
  // is where a worktree's repository resolves to, so nothing but the worktree's
  // own `.git` ties the session to it. Real files here, because the point of
  // the test is that the link is read.
  //
  // Two trees and two runs, because the link is a one-to-many edge and this is
  // where the wiring of the branch into `observeFrom` shows: a sighting that
  // resolved to the wrong one of a checkout's runs would be discarded as
  // already owned, and the run it was really of would land on a bystander.
  const { dir, cleanup } = scratch();
  const previousHome = process.env.RAISE_HOME;
  process.env.RAISE_HOME = dir;
  const repo = join(dir, 'repo');
  const worktree = join(dir, 'trees', '2', 'repo');
  const sibling = join(dir, 'trees', '1', 'repo');
  let monitor = null;
  try {
    mkdirSync(join(repo, '.git', 'worktrees', 'repo2'), { recursive: true });
    mkdirSync(join(repo, '.git', 'worktrees', 'repo1'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(repo, '.git', 'worktrees', 'repo2', 'HEAD'), 'ref: refs/heads/feat/thing\n');
    writeFileSync(join(repo, '.git', 'worktrees', 'repo1', 'HEAD'), 'ref: refs/heads/feat/other\n');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'repo2')}\n`);
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'repo1')}\n`);

    const dbPath = join(dir, 'state.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(
      'CREATE TABLE repos (id TEXT, working_path TEXT);' +
        'CREATE TABLE runs (id TEXT, repo_id TEXT, branch TEXT, status TEXT,' +
        ' awaiting_agent_since INTEGER, created_at INTEGER, updated_at INTEGER,' +
        ' pr_url TEXT, pr_state TEXT, pr_state_observed_at INTEGER, head_sha TEXT, error TEXT);' +
        'CREATE TABLE step_results (run_id TEXT, step_name TEXT, status TEXT, step_order INTEGER,' +
        ' findings_json TEXT, last_activity TEXT, last_activity_at INTEGER, log_path TEXT);',
    );
    const seconds = Math.floor(Date.now() / 1000);
    // Both runs are registered against the main checkout, exactly as
    // no-mistakes records them, each on the branch only its own worktree is on.
    // Two at once in one repo is an ordinary half-hour on this machine, and it
    // is what the link alone cannot tell apart: every worktree resolves to this
    // one path, so without the branch the parked run would take both cards.
    db.prepare('INSERT INTO repos VALUES (?, ?)').run('repo-1', repo);
    db.prepare(
      'INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)',
    ).run('run-1', 'repo-1', 'feat/thing', 'running', seconds, seconds, seconds);
    db.prepare(
      'INSERT INTO runs VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL)',
    ).run('run-2', 'repo-1', 'feat/other', 'running', seconds, seconds);
    db.close();

    // The registry prunes a session whose agent pid is not alive, so all three
    // are real. pid 1 is always there, and stands in for the second worktree's
    // agent - only its liveness and its place in the tree below matter.
    const driverPid = process.pid;
    const siblingPid = 1;
    const neighbourPid = process.ppid;
    const ps = [
      '  100     1 /Applications/iTerm.app/Contents/MacOS/iTerm2',
      `  ${driverPid}   100 claude`,
      `  999999   ${driverPid} /usr/local/bin/no-mistakes axi run --intent "ship it"`,
      `  999998   ${siblingPid} /usr/local/bin/no-mistakes axi run --intent "ship the other"`,
      `  ${neighbourPid}   100 claude`,
    ].join('\n');

    const port = await freePort();
    monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath,
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      fetch: () => assert.fail('no outbound requests from the server'),
      execAsync: async (command) => (command === 'ps' ? ps : ''),
    });
    await monitor.start();

    for (const [sessionId, pid, cwd] of [
      ['worktree', driverPid, worktree],
      ['sibling', siblingPid, sibling],
      ['checkout', neighbourPid, repo],
    ]) {
      const registered = await fetch(`http://127.0.0.1:${port}/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-raise-token': 'test-token' },
        body: JSON.stringify({
          session_id: sessionId,
          hook_event_name: 'SessionStart',
          cwd,
          host: { tty: '/dev/ttys004', term_program: 'iTerm.app', pid },
        }),
      });
      assert.equal(registered.status, 204);
    }

    // Asking is what schedules the scan, so the first reading predates it.
    await (await fetch(`http://127.0.0.1:${port}/state?t=test-token`)).json();
    for (let i = 0; i < 10; i += 1) await nextTick();

    const body = await (await fetch(`http://127.0.0.1:${port}/state?t=test-token`)).json();
    const byId = new Map(body.rows.map((r) => [r.sessionId, r]));
    // Each tree carries its own run, on its own branch. Resolving the link by
    // rank instead would give both trees the parked one and leave the other
    // run unowned, on a row with no window behind it.
    assert.equal(byId.get('worktree')?.run?.runId, 'run-1');
    assert.equal(byId.get('worktree')?.branch, 'feat/thing');
    assert.equal(byId.get('sibling')?.run?.runId, 'run-2');
    assert.equal(byId.get('sibling')?.branch, 'feat/other');
    assert.equal(byId.get('checkout')?.run, null);
    assert.equal(byId.get('checkout')?.branch, 'main');
    // Three cards on one repo, still tellable apart: the run match must not
    // lend a worktree the checkout's path, or they would all just read "repo".
    assert.equal(byId.get('worktree')?.title, '2/repo');
    assert.equal(byId.get('sibling')?.title, '1/repo');
    assert.equal(byId.get('checkout')?.title, `${basename(dir)}/repo`);
    // And neither run is also left over as a row of its own that nobody can
    // focus - the sessions between them account for both.
    assert.equal(body.rows.length, 3);
  } finally {
    await monitor?.stop();
    if (previousHome === undefined) delete process.env.RAISE_HOME;
    else process.env.RAISE_HOME = previousHome;
    cleanup();
  }
});

test('one empty reading does not forget who owns what', async () => {
  // A reading we did not get is not evidence that every run ended - the
  // degraded `axi status` path serves an empty cache until its first
  // background refresh lands. Pruning on that would drop every ownership in a
  // single tick, and a parked run has no live process to be re-observed from,
  // so it would scatter back across its repo silently and for good.
  const { dir, cleanup } = scratch();
  const previousHome = process.env.RAISE_HOME;
  process.env.RAISE_HOME = dir;
  const repo = join(dir, 'repo');
  let monitor = null;
  try {
    const dbPath = join(dir, 'state.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(
      'CREATE TABLE repos (id TEXT, working_path TEXT);' +
        'CREATE TABLE runs (id TEXT, repo_id TEXT, branch TEXT, status TEXT,' +
        ' awaiting_agent_since INTEGER, created_at INTEGER, updated_at INTEGER,' +
        ' pr_url TEXT, pr_state TEXT, pr_state_observed_at INTEGER, head_sha TEXT, error TEXT);' +
        'CREATE TABLE step_results (run_id TEXT, step_name TEXT, status TEXT, step_order INTEGER,' +
        ' findings_json TEXT, last_activity TEXT, last_activity_at INTEGER, log_path TEXT);',
    );
    const seconds = Math.floor(Date.now() / 1000);
    const insertRun = (status) =>
      db
        .prepare('INSERT INTO runs VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL)')
        .run('run-1', 'repo-1', 'main', status, seconds, seconds);
    db.prepare('INSERT INTO repos VALUES (?, ?)').run('repo-1', repo);
    insertRun('running');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    const driverPid = process.pid;
    const neighbourPid = process.ppid;
    const ps = [
      '  100     1 /Applications/iTerm.app/Contents/MacOS/iTerm2',
      `  ${driverPid}   100 claude`,
      `  999999   ${driverPid} /usr/local/bin/no-mistakes axi run --intent "ship it"`,
      `  ${neighbourPid}   100 claude`,
      `  999998   ${neighbourPid} /usr/local/bin/no-mistakes axi status`,
    ].join('\n');

    const port = await freePort();
    monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath,
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      fetch: () => assert.fail('no outbound requests from the server'),
      execAsync: async (command) => (command === 'ps' ? ps : ''),
    });
    await monitor.start();

    for (const [sessionId, pid] of [
      ['driver', driverPid],
      ['neighbour', neighbourPid],
    ]) {
      const registered = await fetch(`http://127.0.0.1:${port}/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-raise-token': 'test-token' },
        body: JSON.stringify({
          session_id: sessionId,
          hook_event_name: 'SessionStart',
          cwd: repo,
          host: { tty: '/dev/ttys004', term_program: 'iTerm.app', pid },
        }),
      });
      assert.equal(registered.status, 204);
    }

    const state = async () =>
      (await (await fetch(`http://127.0.0.1:${port}/state?t=test-token`)).json()).rows;
    // Asking is what schedules the scan, so the first reading predates it.
    await state();
    for (let i = 0; i < 10; i += 1) await nextTick();
    assert.equal((await state()).find((r) => r.sessionId === 'driver')?.run?.runId, 'run-1');

    // The degraded tick: nothing at all comes back.
    db.prepare('DELETE FROM runs').run();
    assert.deepEqual(
      (await state()).map((r) => r.run),
      [null, null],
    );

    // The run comes back terminal, so nothing can be re-observed driving it -
    // only the memory can still say whose it was. Without the guard above the
    // pipeline would be back on both cards, which is the bug this whole change
    // exists to fix.
    //
    // `failed` rather than `completed`: a run that passed leaves the page the
    // moment it does, so a completed one would prove nothing here. A failure is
    // unfinished business and stays, which is exactly what this needs.
    insertRun('failed');
    const rows = await state();
    const byId = new Map(rows.map((r) => [r.sessionId, r]));
    assert.equal(byId.get('driver')?.run?.runId, 'run-1');
    assert.equal(byId.get('neighbour')?.run, null);
    assert.equal(rows.length, 2);
    db.close();
  } finally {
    await monitor?.stop();
    if (previousHome === undefined) delete process.env.RAISE_HOME;
    else process.env.RAISE_HOME = previousHome;
    cleanup();
  }
});

test('a session reading we did not get releases nobody', async () => {
  // The twin of the guard above, and the same rule: `registry.list()` returns
  // an empty list when `readdirSync` on the sessions directory throws, so one
  // transient filesystem error would look like every owner having departed and
  // let go of the lot in a single tick. A parked run has no live process to be
  // re-observed from, so it would scatter back across its repo for good.
  const { dir, cleanup } = scratch();
  const previousHome = process.env.RAISE_HOME;
  process.env.RAISE_HOME = dir;
  const repo = join(dir, 'repo');
  const sessionsPath = join(dir, 'sessions');
  const hidden = join(dir, 'sessions-unreadable');
  let monitor = null;
  try {
    const dbPath = join(dir, 'state.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(
      'CREATE TABLE repos (id TEXT, working_path TEXT);' +
        'CREATE TABLE runs (id TEXT, repo_id TEXT, branch TEXT, status TEXT,' +
        ' awaiting_agent_since INTEGER, created_at INTEGER, updated_at INTEGER,' +
        ' pr_url TEXT, pr_state TEXT, pr_state_observed_at INTEGER, head_sha TEXT, error TEXT);' +
        'CREATE TABLE step_results (run_id TEXT, step_name TEXT, status TEXT, step_order INTEGER,' +
        ' findings_json TEXT, last_activity TEXT, last_activity_at INTEGER, log_path TEXT);',
    );
    const seconds = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO repos VALUES (?, ?)').run('repo-1', repo);
    db.prepare(
      'INSERT INTO runs VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL)',
    ).run('run-1', 'repo-1', 'main', 'running', seconds, seconds);
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    const driverPid = process.pid;
    const neighbourPid = process.ppid;
    const ps = [
      '  100     1 /Applications/iTerm.app/Contents/MacOS/iTerm2',
      `  ${driverPid}   100 claude`,
      `  999999   ${driverPid} /usr/local/bin/no-mistakes axi run --intent "ship it"`,
      `  ${neighbourPid}   100 claude`,
      `  999998   ${neighbourPid} /usr/local/bin/no-mistakes axi status`,
    ].join('\n');

    const port = await freePort();
    monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath,
      sessionsPath,
      exec: () => assert.fail('no blocking commands from the server'),
      fetch: () => assert.fail('no outbound requests from the server'),
      execAsync: async (command) => (command === 'ps' ? ps : ''),
    });
    await monitor.start();

    for (const [sessionId, pid] of [
      ['driver', driverPid],
      ['neighbour', neighbourPid],
    ]) {
      const registered = await fetch(`http://127.0.0.1:${port}/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-raise-token': 'test-token' },
        body: JSON.stringify({
          session_id: sessionId,
          hook_event_name: 'SessionStart',
          cwd: repo,
          host: { tty: '/dev/ttys004', term_program: 'iTerm.app', pid },
        }),
      });
      assert.equal(registered.status, 204);
    }

    const state = async () =>
      (await (await fetch(`http://127.0.0.1:${port}/state?t=test-token`)).json()).rows;
    // Asking is what schedules the scan, so the first reading predates it.
    await state();
    for (let i = 0; i < 10; i += 1) await nextTick();
    assert.equal((await state()).find((r) => r.sessionId === 'driver')?.run?.runId, 'run-1');

    // Terminal before the bad reading, so nothing can be re-observed driving it
    // afterwards - only the memory can still say whose run it was. `failed`
    // rather than `completed`, because a run that passed leaves the page as
    // soon as it does and there would be nothing left here to attribute.
    db.prepare("UPDATE runs SET status = 'failed'").run();

    // The unreadable tick: no sessions come back at all, so the run stands
    // alone and there are no session rows for ownership to affect anyway.
    renameSync(sessionsPath, hidden);
    assert.deepEqual(
      (await state()).map((r) => r.sessionId),
      [null],
    );

    renameSync(hidden, sessionsPath);
    const rows = await state();
    const byId = new Map(rows.map((r) => [r.sessionId, r]));
    assert.equal(byId.get('driver')?.run?.runId, 'run-1');
    assert.equal(byId.get('neighbour')?.run, null);
    assert.equal(rows.length, 2);
    db.close();
  } finally {
    await monitor?.stop();
    if (previousHome === undefined) delete process.env.RAISE_HOME;
    else process.env.RAISE_HOME = previousHome;
    cleanup();
  }
});

test('a machine with neither no-mistakes nor lavish-axi runs quietly', async () => {
  // Both are optional. The evidence that they are is negative and therefore
  // easy to lose: no warning on the page, and not one external command run for
  // either of them. `no-mistakes axi status` would otherwise be spawned per
  // session directory every fifteen seconds, forever, for a binary that is not
  // there - and a banner would send the user looking for a fault they do not
  // have.
  const { dir, cleanup } = scratch();
  const previousHome = process.env.RAISE_HOME;
  process.env.RAISE_HOME = dir;
  try {
    const port = await freePort();
    const ran = [];
    const monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      fetch: () => assert.fail('no outbound requests from the server'),
      execAsync: async (command) => {
        ran.push(command);
        return '';
      },
    });
    assert.equal(monitor.probe.mode, 'absent');
    assert.equal(monitor.probe.warning, null);
    await monitor.start();

    // A live session, which is what puts a directory in front of the degraded
    // path and a transcript in front of the Lavish lookup.
    await fetch(`http://127.0.0.1:${port}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-raise-token': 'test-token' },
      body: JSON.stringify({ session_id: 'quiet', hook_event_name: 'SessionStart', cwd: dir }),
    });

    const state = await (await fetch(`http://127.0.0.1:${port}/state?t=test-token`)).json();
    assert.equal(state.warning, null, 'a missing optional dependency is not a warning');
    assert.equal(state.source, 'absent');
    assert.equal(state.rows.length, 1, 'the session itself still shows');

    // Whatever the process scan runs is fair game; these are not. `tmux` is
    // here for the same reason as the other two: a session with no pane has no
    // window name to read, so nothing may go looking for one.
    assert.equal(ran.includes('no-mistakes'), false);
    assert.equal(ran.includes('lavish-axi'), false);
    assert.equal(ran.includes('tmux'), false);

    await monitor.stop();
  } finally {
    if (previousHome === undefined) delete process.env.RAISE_HOME;
    else process.env.RAISE_HOME = previousHome;
    cleanup();
  }
});

test('a firstmate crewmate is marked on the page, and its neighbours are not', async () => {
  // The whole point of the item, end to end and against the real shapes: the
  // crew window firstmate pinned, the handoff window that uses the very same
  // mechanism with a different prefix, and the first mate itself - which is
  // identified by its lock rather than by its window, because the captain's
  // window is the one firstmate leaves free to be renamed.
  const { dir, cleanup } = scratch();
  const previousHome = process.env.RAISE_HOME;
  process.env.RAISE_HOME = dir;
  let monitor;
  try {
    const fmHome = join(dir, 'firstmate');
    mkdirSync(join(fmHome, 'state'), { recursive: true });
    // The captain is the session whose *own* pid is in the lock.
    writeFileSync(join(fmHome, 'state', '.lock'), `${process.pid}\n`);

    const panes = [
      '%0\tFirst Mate',
      '%358\tfm-sls-87-push-subscription-ownership',
      '%330\thandoff-sls-75-4d7a',
    ].join('\n');

    const port = await freePort();
    monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      fetch: () => assert.fail('no outbound requests from the server'),
      execAsync: async (command) => (command === 'tmux' ? panes : ''),
    });
    await monitor.start();

    // Real pids, or the registry prunes the record before a row is ever built.
    const sessions = [
      ['captain', fmHome, '%0', process.pid],
      ['crew', join(dir, 'crew'), '%358', process.pid],
      ['handoff', join(dir, 'handoff'), '%330', process.ppid],
      ['editing-firstmate', fmHome, null, process.ppid],
    ];
    for (const [sessionId, cwd, pane, pid] of sessions) {
      const registered = await fetch(`http://127.0.0.1:${port}/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-raise-token': 'test-token' },
        body: JSON.stringify({
          session_id: sessionId,
          hook_event_name: 'SessionStart',
          cwd,
          host: { tmux: '', tmux_pane: pane, pid },
        }),
      });
      assert.equal(registered.status, 204);
    }

    // Asking is what schedules the pane read, so the first reading predates it.
    await (await fetch(`http://127.0.0.1:${port}/state?t=test-token`)).json();
    for (let i = 0; i < 10; i += 1) await nextTick();

    const body = await (await fetch(`http://127.0.0.1:${port}/state?t=test-token`)).json();
    const byId = new Map(body.rows.map((r) => [r.sessionId, r]));
    assert.equal(byId.get('crew')?.spawnedBy, 'firstmate');
    assert.equal(byId.get('captain')?.spawnedBy, 'firstmate');
    // A handoff worker is every bit as headless, worktree-bound and permissive
    // as a crewmate. Only the name firstmate pinned tells them apart.
    assert.equal(byId.get('handoff')?.spawnedBy, null);
    // And someone with firstmate's source open is not the first mate: the cwd
    // matches, the lock is right there, and the pid in it is somebody else's.
    assert.equal(byId.get('editing-firstmate')?.spawnedBy, null);
  } finally {
    await monitor?.stop();
    if (previousHome === undefined) delete process.env.RAISE_HOME;
    else process.env.RAISE_HOME = previousHome;
    cleanup();
  }
});

// ------------------------------------------------- the forge lookup, end to end

/**
 * A checkout with a branch and a transcript that printed its own pull request.
 *
 * The transcript source is the one the forge matters most to: nothing is
 * watching a pull request opened by hand, so its state is never `current` on its
 * own and the page can only offer "was open, last checked".
 */
function checkoutWithPullRequest(repo, url) {
  const records = [
    {
      type: 'assistant',
      timestamp: '2026-08-07T01:00:00.000Z',
      message: { content: [{ type: 'text', text: `opened ${url} from feat/live-pr` }] },
    },
  ];
  return {
    transcriptFiles: {
      stat: () => ({ size: 1, mtimeMs: 1 }),
      readTail: () => ({ text: records.map((r) => JSON.stringify(r)).join('\n'), partial: false }),
    },
    gitFiles: {
      stat: (path) => {
        if (path === join(repo, '.git')) return { size: 0, mtimeMs: 1, isDirectory: true };
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      readText: (path) => {
        if (path === join(repo, '.git', 'HEAD')) return 'ref: refs/heads/feat/live-pr\n';
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    },
  };
}

test('with the forge lookup off, a pull request on the page sends nothing anywhere', async () => {
  // The requirement this feature is held to: a user who never configures it
  // cannot tell it exists. `fetch` here is the sibling of the `exec` guard the
  // other tests carry, and it is the half of "byte-identical when disabled"
  // that the pure tests in dashboard.test.js cannot prove.
  const { dir, cleanup } = scratch();
  const previousHome = process.env.RAISE_HOME;
  process.env.RAISE_HOME = dir;
  const repo = join(dir, 'widgets');
  let monitor = null;
  try {
    const port = await freePort();
    const url = 'https://github.com/acme/widgets/pull/41';
    monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      execAsync: async (command) => {
        assert.notEqual(command, 'gh', 'gh must not run when the lookup is off');
        return '';
      },
      fetch: () => assert.fail('no outbound requests from the server'),
      forgeConfig: { enabled: false, bitbucket: null, problem: null },
      ...checkoutWithPullRequest(repo, url),
    });
    await monitor.start();

    await fetch(`http://127.0.0.1:${port}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-raise-token': 'test-token' },
      body: JSON.stringify({
        session_id: 'quiet',
        hook_event_name: 'SessionStart',
        cwd: repo,
        transcript_path: join(dir, 'transcript.jsonl'),
      }),
    });

    await (await fetch(`http://127.0.0.1:${port}/state?t=test-token`)).json();
    for (let i = 0; i < 10; i += 1) await nextTick();
    const body = await (await fetch(`http://127.0.0.1:${port}/state?t=test-token`)).json();

    const row = body.rows.find((r) => r.sessionId === 'quiet');
    assert.equal(row.pr.url, url, 'the link is there exactly as it was before');
    assert.equal(row.pr.current, false, 'and nobody is watching it, so the state is not asserted');
  } finally {
    await monitor?.stop();
    if (previousHome === undefined) delete process.env.RAISE_HOME;
    else process.env.RAISE_HOME = previousHome;
    cleanup();
  }
});

test('with it on, the forge settles a pull request nothing else was watching', async () => {
  // The case RAI-10 left open: the run has ended, or there never was one, so
  // there is no observer at all and the page had a link and no way to find out.
  const { dir, cleanup } = scratch();
  const previousHome = process.env.RAISE_HOME;
  process.env.RAISE_HOME = dir;
  const repo = join(dir, 'widgets');
  let monitor = null;
  try {
    const port = await freePort();
    const url = 'https://github.com/acme/widgets/pull/41';
    const ran = [];
    monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      execAsync: async (command, args = []) => {
        if (command !== 'gh') return '';
        ran.push(args);
        return JSON.stringify({ state: 'MERGED' });
      },
      fetch: () => assert.fail('GitHub goes through gh, never through a request of ours'),
      forgeConfig: { enabled: true, bitbucket: null, problem: null },
      ...checkoutWithPullRequest(repo, url),
    });
    await monitor.start();

    await fetch(`http://127.0.0.1:${port}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-raise-token': 'test-token' },
      body: JSON.stringify({
        session_id: 'watched',
        hook_event_name: 'SessionStart',
        cwd: repo,
        transcript_path: join(dir, 'transcript.jsonl'),
      }),
    });

    // Asking is what schedules the lookup, so an answer is never in the same
    // snapshot that asked for it - the arrangement the Lavish link and the
    // firstmate chip both use. Registering the session has already produced a
    // snapshot here, so the wait is all that is needed.
    for (let i = 0; i < 10; i += 1) await nextTick();

    const body = await (await fetch(`http://127.0.0.1:${port}/state?t=test-token`)).json();
    const row = body.rows.find((r) => r.sessionId === 'watched');
    assert.deepEqual(ran, [['pr', 'view', url, '--json', 'state']]);
    assert.equal(row.pr.state, 'merged');
    assert.equal(row.pr.current, true, 'and now it may be said as the state now');
  } finally {
    await monitor?.stop();
    if (previousHome === undefined) delete process.env.RAISE_HOME;
    else process.env.RAISE_HOME = previousHome;
    cleanup();
  }
});

test('a session that predates the hooks is on the page, and a restart replaces it', async () => {
  // RAI-4, end to end. The failure this prevents is the first four seconds of
  // somebody else's experience: install, `install-hooks`, open the page, and see
  // nothing at all, because every session they have open predates the hooks.
  const { dir, cleanup } = scratch();
  const previousHome = process.env.RAISE_HOME;
  process.env.RAISE_HOME = dir;
  try {
    // A Claude Code transcript where one has actually been written, since the
    // scan reads the three agents' homes and `scratch()` has pointed all three
    // here. The `cwd` is on the conversation records, which is where Claude Code
    // really puts it.
    const transcript = join(dir, 'projects', '-a-repo', 'older.jsonl');
    mkdirSync(join(dir, 'projects', '-a-repo'), { recursive: true });
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'ai-title', aiTitle: 'tidying the exporter' }),
        JSON.stringify({
          type: 'assistant',
          cwd: dir,
          timestamp: new Date().toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        }),
      ].join('\n'),
    );

    const port = await freePort();
    const monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      fetch: () => assert.fail('no outbound requests from the server'),
      execAsync: async () => '',
    });
    await monitor.start();
    const state = () => fetch(`http://127.0.0.1:${port}/state?t=test-token`).then((r) => r.json());

    const before = await state();
    assert.equal(before.rows.length, 1, 'the page is populated rather than empty');
    const [row] = before.rows;
    assert.equal(row.kind, 'untracked');
    assert.equal(row.attention, 'untracked');
    assert.equal(row.focusable, false, 'and offers no control it cannot honour');
    assert.equal(row.sessionId, null);
    assert.equal(row.summary, 'tidying the exporter', 'read from the transcript, as for any row');

    // Restarting the session is the remedy the row names, so it has to work
    // without waiting for the next walk of the tree.
    await fetch(`http://127.0.0.1:${port}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-raise-token': 'test-token' },
      body: JSON.stringify({
        session_id: 'restarted',
        hook_event_name: 'SessionStart',
        cwd: dir,
        transcript_path: transcript,
        host: { tty: '/dev/ttys004', term_program: 'iTerm.app' },
      }),
    });

    const after = await state();
    assert.equal(after.rows.length, 1, 'one row, not two - the scan is superseded');
    assert.equal(after.rows[0].kind, 'session');
    assert.equal(after.rows[0].sessionId, 'restarted');
    assert.equal(after.rows[0].focusable, true);

    await monitor.stop();
  } finally {
    if (previousHome === undefined) delete process.env.RAISE_HOME;
    else process.env.RAISE_HOME = previousHome;
    cleanup();
  }
});

test('closing a session does not bring it back as one nothing ever reported', async () => {
  /*
   * The same walk, from the other end. On a machine where Raise is installed
   * this is the ordinary case rather than an edge one: every window closed today
   * has a transcript minutes old and no live record, which is exactly what the
   * scan is looking for. So a feature built to stop a stranger's first page
   * being empty would have filled an established one with a ghost of every
   * session the user had deliberately finished, each saying it had never
   * reported and each advising a restart.
   *
   * The second assertion is the one worth keeping: with the last session closed
   * the page must be able to say nothing is running, which is a true and useful
   * answer that ghosts take away for two hours.
   */
  const { dir, cleanup } = scratch();
  const previousHome = process.env.RAISE_HOME;
  process.env.RAISE_HOME = dir;
  try {
    const transcript = join(dir, 'projects', '-a-repo', 'ending.jsonl');
    mkdirSync(join(dir, 'projects', '-a-repo'), { recursive: true });
    writeFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        cwd: dir,
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      }),
    );

    const port = await freePort();
    const monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      fetch: () => assert.fail('no outbound requests from the server'),
      execAsync: async () => '',
    });
    await monitor.start();
    const state = () => fetch(`http://127.0.0.1:${port}/state?t=test-token`).then((r) => r.json());
    const post = (body) =>
      fetch(`http://127.0.0.1:${port}/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-raise-token': 'test-token' },
        body: JSON.stringify(body),
      });

    await post({
      session_id: 'closing',
      hook_event_name: 'SessionStart',
      cwd: dir,
      transcript_path: transcript,
      host: { pid: process.pid, tty: '/dev/ttys004', term_program: 'iTerm.app' },
    });

    const open = await state();
    assert.equal(open.rows.length, 1);
    assert.equal(open.rows[0].kind, 'session', 'an ordinary row while the session is open');

    await post({
      session_id: 'closing',
      hook_event_name: 'SessionEnd',
      cwd: dir,
      transcript_path: transcript,
    });

    const closed = await state();
    assert.equal(
      closed.rows.find((r) => r.kind === 'untracked'),
      undefined,
      'the session we watched end is not offered back as one that never reported',
    );
    assert.deepEqual(closed.rows, [], 'and "Nothing running" is reachable again');

    await monitor.stop();
  } finally {
    if (previousHome === undefined) delete process.env.RAISE_HOME;
    else process.env.RAISE_HOME = previousHome;
    cleanup();
  }
});
