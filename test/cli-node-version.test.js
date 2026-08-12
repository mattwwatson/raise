/**
 * `raise doctor` on a Node too old to run Raise.
 *
 * The whole of issue 5: the version check was correct and unreachable. Node 22.5
 * through 22.12 have `node:sqlite` behind `--experimental-sqlite`, `bin/raise.js`
 * statically imported `src/nm-state.js` which statically imported it, and an
 * unresolvable builtin throws while the graph is being *linked* - before any
 * module body runs, the entry point's included. So the user got a stack trace
 * naming a builtin they have never heard of, and the one message that would have
 * explained their setup was the one message that could not print.
 *
 * These tests spawn the real `bin/raise.js` under `test/fixtures/old-node.mjs`,
 * which makes a modern Node behave like 22.9 in the two ways that matter. See
 * that file for what it fakes and, more importantly, what it does not.
 *
 * **The first test is a control on the harness itself.** A simulated
 * reproduction that has quietly stopped simulating anything passes for the wrong
 * reason forever, so the harness is required to demonstrate it still bites
 * before anything below it is believed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'raise.js');
const HARNESS = join(HERE, 'fixtures', 'old-node.mjs');
const IMPORTS_SQLITE = join(HERE, 'fixtures', 'imports-sqlite.mjs');

/**
 * Run a script under the old-Node harness and report what the user would see.
 *
 * Deliberately not `promisify(execFile)`: a non-zero exit is the expected result
 * of most of this file, and the rejected promise would hide stdout behind an
 * error object. Failure is data here, so it is returned rather than thrown.
 *
 * @param {string} script absolute path to run as the entry point
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function runOnOldNode(script) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', HARNESS, script],
      // The CLI must not read the developer's own installation, and `doctor`
      // reaches for every one of these. A directory that does not exist is the
      // honest answer for all of them - nothing is installed on a machine this
      // old, which is the situation being reported on.
      {
        env: {
          ...process.env,
          RAISE_HOME: join(HERE, 'no-such-raise-home'),
          NM_HOME: join(HERE, 'no-such-nm-home'),
          CLAUDE_CONFIG_DIR: join(HERE, 'no-such-claude-home'),
          PI_CODING_AGENT_DIR: join(HERE, 'no-such-pi-home'),
          CODEX_HOME: join(HERE, 'no-such-codex-home'),
        },
      },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

test('the harness really does make node:sqlite unavailable', async () => {
  // The control. Without this the reproduction below could pass on a Node that
  // no longer routes builtin specifiers through resolve hooks, having simulated
  // nothing at all.
  const { code, stdout, stderr } = await runOnOldNode(IMPORTS_SQLITE);
  assert.notEqual(code, 0, `expected the import to fail, got stdout: ${stdout}`);
  assert.match(stderr, /ERR_UNKNOWN_BUILTIN_MODULE/);
  assert.doesNotMatch(stdout, /imported/);
});

test('raise doctor on a Node in the 22.5-22.12 gap explains itself instead of dying', async () => {
  const { stdout, stderr } = await runOnOldNode(CLI);

  // The bug. Before the entry point became a shim this was the whole output: a
  // link-time throw from a module the user never asked for.
  assert.doesNotMatch(
    stdout + stderr,
    /ERR_UNKNOWN_BUILTIN_MODULE/,
    'the version guard has fallen back behind a static import of node:sqlite',
  );
  assert.match(stdout + stderr, /22\.13 or newer/);
  assert.match(stdout + stderr, /22\.9\.0/);
});

test('the refusal is an error exit, so a script calling raise can act on it', async () => {
  // Not part of the reproduction - a link-time crash exits 1 as well, so this
  // passed before the fix too. It is here because the exit code is the half of
  // the contract a caller sees, and it would be easy to lose while making the
  // message nicer.
  const { code } = await runOnOldNode(CLI);
  assert.equal(code, 1);
});

test('a supported Node reaches the CLI, so the guard is not simply refusing everything', async () => {
  // The other half of the control: the harness proves the guard *can* fire, and
  // this proves it does not fire on the Node actually running the suite. Without
  // it a guard that refused every version would pass everything above.
  const { code, stdout } = await new Promise((resolve) => {
    execFile(process.execPath, [CLI, '--version'], (error, out) =>
      resolve({ code: error?.code ?? 0, stdout: out }),
    );
  });
  assert.equal(code, 0);
  assert.match(stdout, /^\d+\.\d+\.\d+/);
});
