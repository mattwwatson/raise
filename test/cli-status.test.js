/**
 * `raise status` and the page saying the same word about one pull request.
 *
 * The two renderers are one protocol: both print `row.pr.state` from the same
 * `buildRows`, gated on the same `PullRequest.current`. A state word on one and
 * not the other is the two disagreeing about a row, so this runs both against
 * one checkout, one transcript and one forge answer - the CLI as a real process
 * with a stand-in `gh` on its `PATH`, the server with the same answer injected -
 * and asserts the word each of them carries.
 *
 * The case is issue 30's: a draft, which both forges report as OPEN plus a flag,
 * and which used to read `open` - a review waiting on somebody - when it is
 * waiting on its own author.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { createMonitorServer } from '../src/server.js';
import { SessionRegistry } from '../src/registry.js';

const execFileAsync = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'raise.js');

/** See `cli-serve.test.js`: no test here may walk the developer's own transcripts. */
const AGENT_HOMES = ['CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'CODEX_HOME'];

const URL = 'https://github.com/acme/widgets/pull/41';

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

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A checkout on a branch, a transcript that opened a pull request from it, the
 * forge switched on, and a `gh` that answers `answer` for every pull request.
 *
 * The checkout is named for the repository in the URL, because the transcript's
 * sighting is only attributed to a directory whose name matches it.
 */
function world(dir, answer) {
  const repo = join(dir, 'widgets');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/feat/live-pr\n');

  const transcript = join(dir, 'transcript.jsonl');
  const record = {
    type: 'assistant',
    timestamp: '2026-08-07T01:00:00.000Z',
    message: { content: [{ type: 'text', text: `opened ${URL} from feat/live-pr` }] },
  };
  writeFileSync(transcript, `${JSON.stringify(record)}\n`);

  // The same `0600` the real file is held to, or it is refused whole.
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ forge: { enabled: true } }), {
    mode: 0o600,
  });

  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho '${JSON.stringify(answer)}'\n`, {
    mode: 0o755,
  });

  return { repo, transcript, bin };
}

/** The word `raise status` prints beside the pull request, or null for none. */
async function statusWord(dir, bin) {
  const env = { ...process.env, RAISE_HOME: dir, NM_HOME: dir };
  for (const name of AGENT_HOMES) env[name] = dir;
  env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  delete env.RAISE_PORT;
  const { stdout } = await execFileAsync(process.execPath, [CLI, 'status'], { env });
  const line = stdout.split('\n').find((l) => l.includes(URL));
  assert.ok(line, `no pull request line in:\n${stdout}`);
  // The label is wrapped in colour codes, so the word ends at a non-word
  // character rather than at a space.
  const match = line.match(/PR #41(?: (\w+))?\W/);
  assert.ok(match, `unexpected pull request line: ${line}`);
  return match[1] ?? null;
}

/** The state the page is handed for the session's row, and whether it may be shown. */
async function pageWord(dir, repo, transcript, answer) {
  const previousHome = process.env.RAISE_HOME;
  process.env.RAISE_HOME = dir;
  let monitor = null;
  try {
    const port = await freePort();
    monitor = createMonitorServer({
      port,
      token: 'test-token',
      dbPath: join(dir, 'no-such.sqlite'),
      sessionsPath: join(dir, 'page-sessions'),
      exec: () => assert.fail('no blocking commands from the server'),
      execAsync: async (command) => (command === 'gh' ? JSON.stringify(answer) : ''),
      fetch: () => assert.fail('GitHub goes through gh, never through a request of ours'),
      forgeConfig: { enabled: true, bitbucket: null, problem: null },
    });
    await monitor.start();
    await fetch(`http://127.0.0.1:${port}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-raise-token': 'test-token' },
      body: JSON.stringify({
        session_id: 'watched',
        hook_event_name: 'SessionStart',
        cwd: repo,
        transcript_path: transcript,
      }),
    });
    // Asking is what schedules the lookup, so the answer lands a tick later.
    for (let i = 0; i < 10; i += 1) await nextTick();
    const body = await (await fetch(`http://127.0.0.1:${port}/state?t=test-token`)).json();
    const row = body.rows.find((r) => r.sessionId === 'watched');
    assert.ok(row?.pr, 'the row carries the pull request');
    // The page renders `row.pr.state` as the chip only while `current` is true,
    // exactly as `raise status` does - see `public/index.html`.
    return row.pr.current ? row.pr.state : null;
  } finally {
    await monitor?.stop();
    if (previousHome === undefined) delete process.env.RAISE_HOME;
    else process.env.RAISE_HOME = previousHome;
  }
}

for (const [answer, word] of [
  [{ state: 'OPEN', isDraft: true }, 'draft'],
  [{ state: 'OPEN', isDraft: false }, 'open'],
]) {
  test(`raise status and the page both say ${word} for ${JSON.stringify(answer)}`, async () => {
    const { dir, cleanup } = scratch();
    try {
      const { repo, transcript, bin } = world(dir, answer);
      new SessionRegistry({ dir: join(dir, 'sessions') }).record({
        session_id: 'watched',
        hook_event_name: 'SessionStart',
        cwd: repo,
        transcript_path: transcript,
      });

      assert.equal(await statusWord(dir, bin), word, 'raise status');
      assert.equal(await pageWord(dir, repo, transcript, answer), word, 'the page');
    } finally {
      cleanup();
    }
  });
}
