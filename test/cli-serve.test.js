/**
 * `nmmon serve` against a port it cannot have.
 *
 * A busy port is the most likely way `serve` ever fails, and it used to fail by
 * printing a Node stack trace - which names the port and nothing else. That is
 * exactly the wrong output: the three reasons a port is busy need three
 * different actions, and the one that actually happened here was a leftover
 * nmmon from a deleted NMMON_HOME, which no amount of reading server.json would
 * have revealed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createMonitorServer } from '../src/server.js';

const execFileAsync = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nmmon.js');

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'nmmon-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

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

/**
 * Run the CLI and return its outcome rather than throwing on a non-zero exit,
 * since a non-zero exit is what every test here is about.
 */
async function cli(args, home, extraEnv = {}) {
  const env = { ...process.env, NMMON_HOME: home, NM_HOME: home };
  delete env.NMMON_PORT;
  Object.assign(env, extraEnv);
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

/** Every busy-port failure, whichever kind, must stay a message. */
function assertNoStackTrace(stderr) {
  assert.ok(!stderr.includes('EADDRINUSE'), `raw errno leaked:\n${stderr}`);
  assert.ok(!/\n\s+at /.test(stderr), `stack trace leaked:\n${stderr}`);
}

async function withMonitor(home, port, fn) {
  const previousHome = process.env.NMMON_HOME;
  process.env.NMMON_HOME = home;
  const monitor = createMonitorServer({
    port,
    token: 'test-token',
    dbPath: join(home, 'no-such.sqlite'),
    sessionsPath: join(home, 'sessions'),
    exec: () => assert.fail('no blocking commands from the server'),
    execAsync: async () => '',
  });
  try {
    await monitor.start();
    await fn();
  } finally {
    await monitor.stop();
    if (previousHome === undefined) delete process.env.NMMON_HOME;
    else process.env.NMMON_HOME = previousHome;
  }
}

test('serve says so when this installation is already running', async () => {
  const { dir, cleanup } = scratch();
  try {
    const port = await freePort();
    await withMonitor(dir, port, async () => {
      const { code, stderr } = await cli(['serve', '--port', String(port)], dir);
      assert.equal(code, 1);
      assert.match(stderr, new RegExp(`is already running on port ${port} \\(pid ${process.pid}\\)`));
      assert.match(stderr, /nmmon open/);
      assertNoStackTrace(stderr);
    });
  } finally {
    cleanup();
  }
});

test('serve names the leftover nmmon that this installation has no record of', async () => {
  // The incident: a server started under an NMMON_HOME that no longer exists
  // holds the port and leaves no server.json anywhere, so the record says
  // "not running" while the port says otherwise.
  const theirs = scratch();
  const ours = scratch();
  try {
    const port = await freePort();
    await withMonitor(theirs.dir, port, async () => {
      const { code, stderr } = await cli(['serve', '--port', String(port)], ours.dir);
      assert.equal(code, 1);
      assert.match(
        stderr,
        new RegExp(`Port ${port} is held by another nmmon \\(pid ${process.pid}\\)`),
      );
      assert.match(stderr, /NMMON_HOME/);
      assert.match(stderr, new RegExp(`kill ${process.pid}`), 'it tells you which pid to stop');
      assertNoStackTrace(stderr);
    });
  } finally {
    theirs.cleanup();
    ours.cleanup();
  }
});

test('serve does not claim an unrelated program is nmmon', async () => {
  const { dir, cleanup } = scratch();
  const port = await freePort();
  const squatter = createServer((req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"hello":"world"}'),
  );
  await new Promise((resolve) => squatter.listen(port, '127.0.0.1', resolve));
  try {
    const { code, stderr } = await cli(['serve', '--port', String(port)], dir);
    assert.equal(code, 1);
    assert.match(stderr, new RegExp(`Port ${port} is in use, and whatever is listening is not nmmon`));
    assert.match(stderr, new RegExp(`lsof -nP -iTCP:${port}`), 'it says how to find the culprit');
    assert.ok(!/kill \d/.test(stderr), 'never suggest killing a pid we have not identified');
    assertNoStackTrace(stderr);
  } finally {
    squatter.closeAllConnections();
    await new Promise((resolve) => squatter.close(resolve));
    cleanup();
  }
});

test('open refuses to hand you a URL for a server that has stopped', async () => {
  // server.json outlives a server that was killed rather than stopped.
  const { dir, cleanup } = scratch();
  try {
    const port = await freePort();
    // Start and stop cleanly, then write the record back the way a SIGKILL
    // would have left it.
    await withMonitor(dir, port, async () => {});
    writeFileSync(
      join(dir, 'server.json'),
      JSON.stringify({ port, token: 'test-token', pid: 999999, startedAt: Date.now() }),
    );

    const { code, stderr, stdout } = await cli(['open'], dir);
    assert.equal(code, 1);
    assert.match(stderr, /nothing is answering/);
    assert.ok(!stdout.includes('http://'), 'no dead URL is printed for a caller to pipe onwards');
  } finally {
    cleanup();
  }
});

test('doctor reports a port held by an nmmon it has no record of', async () => {
  const theirs = scratch();
  const ours = scratch();
  try {
    const port = await freePort();
    await withMonitor(theirs.dir, port, async () => {
      // doctor takes no --port; it checks the port serve would use, so point
      // the default at the occupied one.
      const { stdout } = await cli(['doctor'], ours.dir, { NMMON_PORT: String(port) });
      assert.match(
        stdout,
        new RegExp(`port ${port} is held by another nmmon \\(pid ${process.pid}\\)`),
        'doctor must not report "not running" while a server holds the port',
      );
    });
  } finally {
    theirs.cleanup();
    ours.cleanup();
  }
});
