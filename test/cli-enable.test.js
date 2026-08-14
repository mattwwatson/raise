/**
 * `raise enable` and `raise disable` against a real file on disk.
 *
 * `user-config.test.js` proves the merge and the mode; this proves the command -
 * that it writes where `RAISE_HOME` says, that the contract it inherited from
 * `install-hooks` actually holds (diff, ask, back up, safe twice), and that the
 * bug it exists for is gone.
 *
 * Everything happens in a temp directory under `RAISE_HOME`. Nothing reads or
 * writes a real installation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'raise.js');

/** A file already carrying the forge opt-in and a Bitbucket credential. */
const WITH_CREDENTIAL = `{
  "forge": {
    "enabled": true,
    "bitbucket": { "email": "you@example.com", "token": "the-token" }
  }
}
`;

function scratch({ config = null, fileMode = 0o600 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'raise-enable-'));
  const home = join(dir, '.raise');
  mkdirSync(home);
  const path = join(home, 'config.json');
  if (config !== null) {
    writeFileSync(path, config);
    chmodSync(path, fileMode);
  }
  return { home, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The scratch home, plus every other installation this CLI might otherwise read.
 *
 * `raise doctor` opens the no-mistakes database and walks all three agents'
 * session directories, so with `RAISE_HOME` alone the doctor test below reads
 * whatever the machine running the suite happens to have - a live no-mistakes
 * database included, since this suite runs inside that pipeline.
 * `cli-serve.test.js` isolates the same three agent homes for the same reason.
 */
function scratchEnv(home) {
  return {
    ...process.env,
    RAISE_HOME: home,
    NM_HOME: home,
    CLAUDE_CONFIG_DIR: home,
    PI_CODING_AGENT_DIR: home,
    CODEX_HOME: home,
  };
}

function raise(args, home, options = {}) {
  return execFileAsync(process.execPath, [CLI, ...args], {
    env: scratchEnv(home),
    ...options,
  });
}

function read(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function mode(path) {
  return (statSync(path).mode & 0o777).toString(8).padStart(4, '0');
}

test('enable creates the file 0600 when there is none', async () => {
  const s = scratch();
  try {
    const { stdout } = await raise(['enable', 'update-check', '--yes'], s.home);
    assert.match(stdout, /add updates\.enabled: true/);
    assert.match(stdout, /Update check enabled/);
    assert.deepEqual(read(s.path), { updates: { enabled: true } });
    assert.equal(mode(s.path), '0600');
  } finally {
    s.cleanup();
  }
});

test('enabling the update check keeps an existing forge opt-in and its credential', async () => {
  // The bug in one test. The README used to document this as `cat >`, which
  // truncates: following it lost the credential and the opt-in in one command,
  // and nothing said so.
  const s = scratch({ config: WITH_CREDENTIAL });
  try {
    await raise(['enable', 'update-check', '--yes'], s.home);
    const after = read(s.path);
    assert.equal(after.forge.enabled, true);
    assert.deepEqual(after.forge.bitbucket, { email: 'you@example.com', token: 'the-token' });
    assert.deepEqual(after.updates, { enabled: true });
  } finally {
    s.cleanup();
  }
});

test('disable turns the feature off and keeps the credential', async () => {
  const s = scratch({ config: WITH_CREDENTIAL });
  try {
    const { stdout } = await raise(['disable', 'pull-request-state', '--yes'], s.home);
    assert.match(stdout, /change forge\.enabled: true -> false/);
    const after = read(s.path);
    assert.equal(after.forge.enabled, false);
    assert.deepEqual(after.forge.bitbucket, { email: 'you@example.com', token: 'the-token' });
  } finally {
    s.cleanup();
  }
});

test('a second enable writes nothing and says so', async () => {
  const s = scratch();
  try {
    await raise(['enable', 'update-check', '--yes'], s.home);
    const afterFirst = readFileSync(s.path, 'utf8');
    const { stdout } = await raise(['enable', 'update-check', '--yes'], s.home);
    assert.match(stdout, /Already enabled/);
    assert.equal(readFileSync(s.path, 'utf8'), afterFirst, 'the file must be untouched');
  } finally {
    s.cleanup();
  }
});

test('a file whose boolean is right but whose mode is wrong is repaired, not called done', async () => {
  // "Safe to run twice" must not swallow this: at 0644 the file is refused by
  // `readUserConfig`, so the feature is off however the boolean reads.
  const s = scratch({ config: '{"updates":{"enabled":true}}\n', fileMode: 0o644 });
  try {
    const { stdout } = await raise(['enable', 'update-check', '--yes'], s.home);
    assert.match(stdout, /repair mode 0644 -> 0600/);
    assert.doesNotMatch(stdout, /Already enabled/);
    assert.equal(mode(s.path), '0600');
  } finally {
    s.cleanup();
  }
});

test('the backup of a repaired file is 0600, not a readable copy of the credential', async () => {
  const s = scratch({ config: WITH_CREDENTIAL, fileMode: 0o644 });
  try {
    await raise(['enable', 'update-check', '--yes'], s.home);
    assert.equal(mode(`${s.path}.raise-backup`), '0600');
    assert.match(readFileSync(`${s.path}.raise-backup`, 'utf8'), /the-token/);
  } finally {
    s.cleanup();
  }
});

test('--dry-run shows the change and writes nothing', async () => {
  const s = scratch();
  try {
    const { stdout } = await raise(['enable', 'update-check', '--dry-run'], s.home);
    assert.match(stdout, /add updates\.enabled: true/);
    assert.match(stdout, /nothing written/i);
    assert.throws(() => readFileSync(s.path, 'utf8'), 'no file should have been created');
  } finally {
    s.cleanup();
  }
});

test('answering no at the prompt writes nothing', async () => {
  const s = scratch();
  try {
    const child = execFileAsync(process.execPath, [CLI, 'enable', 'update-check'], {
      env: scratchEnv(s.home),
    });
    child.child.stdin.end('n\n');
    const { stdout } = await child;
    assert.match(stdout, /Nothing written/);
    assert.throws(() => readFileSync(s.path, 'utf8'), 'no file should have been created');
  } finally {
    s.cleanup();
  }
});

test('a config file that does not parse is refused rather than overwritten', async () => {
  const broken = '{ "forge": { "bitbucket": { "token": "half-typed"\n';
  const s = scratch({ config: broken });
  try {
    await assert.rejects(
      raise(['enable', 'update-check', '--yes'], s.home),
      (err) => /not valid JSON/.test(err.stderr) && err.code === 1,
    );
    assert.equal(readFileSync(s.path, 'utf8'), broken, 'the half-typed file survives');
  } finally {
    s.cleanup();
  }
});

test('an unknown feature is refused and both real names are printed', async () => {
  const s = scratch();
  try {
    await assert.rejects(raise(['enable', 'pull-requests', '--yes'], s.home), (err) => {
      assert.match(err.stderr, /Unknown feature "pull-requests"/);
      assert.match(err.stderr, /pull-request-state, update-check/);
      return err.code === 1;
    });
  } finally {
    s.cleanup();
  }
});

test('no feature name at all prints the usage rather than guessing one', async () => {
  const s = scratch();
  try {
    await assert.rejects(raise(['enable', '--yes'], s.home), (err) => {
      assert.match(err.stderr, /Usage: raise enable <feature>/);
      return err.code === 1;
    });
  } finally {
    s.cleanup();
  }
});

test('there is no way to pass a credential on the command line', async () => {
  // A token in argv is a token in shell history and in every ps on the machine.
  // The flag must not quietly appear later, so its absence is asserted here
  // rather than left as a note in a spec.
  const s = scratch();
  try {
    await raise(['enable', 'pull-request-state', '--token', 'secret', '--yes'], s.home);
    const after = read(s.path);
    assert.deepEqual(after, { forge: { enabled: true } }, 'nothing from --token may be stored');
    assert.doesNotMatch(readFileSync(s.path, 'utf8'), /secret/);
  } finally {
    s.cleanup();
  }
});

test('what a running server does with the write is said per feature, not as a blanket line', async () => {
  // The forge block is re-read on the poll loop, so "nothing to restart" is true
  // of it. The update check is asked once at `raise serve` startup, so the same
  // sentence over it would be a confident false claim - the failure this whole
  // page is built against, printed by the tool itself.
  const s = scratch();
  try {
    const forge = await raise(['enable', 'pull-request-state', '--yes'], s.home);
    assert.match(forge.stdout, /picks this up within a second; nothing to restart/);

    const updates = await raise(['enable', 'update-check', '--yes'], s.home);
    assert.match(updates.stdout, /will not pick this up until you restart it/);
    assert.doesNotMatch(updates.stdout, /nothing to restart/);
  } finally {
    s.cleanup();
  }
});

test('doctor names the command that turns each feature on', async () => {
  // What you read in the diagnostic is what you type to fix it.
  const s = scratch();
  try {
    const { stdout } = await raise(['doctor'], s.home);
    assert.match(stdout, /raise enable pull-request-state/);
    assert.match(stdout, /raise enable update-check/);
  } finally {
    s.cleanup();
  }
});
