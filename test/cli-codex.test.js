/**
 * `raise install-codex` against a real file on disk.
 *
 * `hooks.test.js` proves the merge; this proves the command - that it writes
 * where `CODEX_HOME` says, that running it twice changes nothing the second
 * time, and that uninstalling gives back the file byte for byte. The fixture is
 * a copy of a real `~/.codex/hooks.json` carrying three foreign `SessionStart`
 * hooks, because leaving somebody else's config exactly as found is the whole
 * obligation here and it is the sort of thing a pure test can pass while the
 * command writes to the wrong path.
 *
 * Everything happens in a temp directory. Nothing reads or writes a real Codex
 * installation, and no Codex needs to be installed to run any of this.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { CODEX_HOOK_EVENTS } from '../src/hooks.js';

const execFileAsync = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'raise.js');

/** A real `~/.codex/hooks.json`: three foreign hooks and nothing of ours. */
const FIXTURE = `{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "lavish-axi",
            "timeout": 10
          }
        ]
      },
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "chrome-devtools-axi",
            "timeout": 10
          }
        ]
      },
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "gh-axi",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
`;

function scratchCodexHome({ withFixture = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'raise-codex-'));
  const home = join(dir, '.codex');
  mkdirSync(home);
  const hooks = join(home, 'hooks.json');
  if (withFixture) writeFileSync(hooks, FIXTURE);
  return { dir, home, hooks, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function raise(args, env) {
  return execFileAsync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
  });
}

test('install writes where CODEX_HOME says, keeping the foreign hooks in place', async () => {
  const scratch = scratchCodexHome();
  try {
    const { stdout } = await raise(['install-codex', '--yes'], { CODEX_HOME: scratch.home });
    assert.match(stdout, /Installed/);
    // The half of this that is not like Claude Code, and the half people would
    // otherwise report as a bug: Codex reads a hook it has no trust hash for
    // and silently runs nothing.
    assert.match(stdout, /trust this hook/i);

    const written = JSON.parse(readFileSync(scratch.hooks, 'utf8'));
    const starts = written.hooks.SessionStart;
    assert.equal(starts.length, 4);
    assert.deepEqual(
      starts.slice(0, 3).map((group) => group.hooks[0].command),
      ['lavish-axi', 'chrome-devtools-axi', 'gh-axi'],
    );
    assert.match(starts[3].hooks[0].command, /raise-hook\.js --agent codex$/);
    for (const event of CODEX_HOOK_EVENTS) {
      assert.ok(written.hooks[event], `${event} should be installed`);
    }
    assert.equal(written.hooks.SessionEnd[0].hooks[0].timeout, 3);
  } finally {
    scratch.cleanup();
  }
});

test('a second install reports it is already installed and rewrites nothing', async () => {
  const scratch = scratchCodexHome();
  try {
    await raise(['install-codex', '--yes'], { CODEX_HOME: scratch.home });
    const afterFirst = readFileSync(scratch.hooks, 'utf8');

    const { stdout } = await raise(['install-codex', '--yes'], { CODEX_HOME: scratch.home });
    assert.match(stdout, /Already installed/);
    assert.equal(readFileSync(scratch.hooks, 'utf8'), afterFirst, 'the file must be untouched');
  } finally {
    scratch.cleanup();
  }
});

test('uninstall gives back the three foreign hooks exactly as they were', async () => {
  const scratch = scratchCodexHome();
  try {
    await raise(['install-codex', '--yes'], { CODEX_HOME: scratch.home });
    await raise(['uninstall-codex', '--yes'], { CODEX_HOME: scratch.home });
    // Compared as parsed JSON rather than as text: the fixture's own formatting
    // is not a promise Raise makes, but its contents and their order are.
    assert.deepEqual(JSON.parse(readFileSync(scratch.hooks, 'utf8')), JSON.parse(FIXTURE));
  } finally {
    scratch.cleanup();
  }
});

test('uninstall on a file with none of ours in it writes nothing at all', async () => {
  const scratch = scratchCodexHome();
  try {
    const { stdout } = await raise(['uninstall-codex', '--yes'], { CODEX_HOME: scratch.home });
    assert.match(stdout, /No Raise hooks found/);
    assert.equal(readFileSync(scratch.hooks, 'utf8'), FIXTURE);
  } finally {
    scratch.cleanup();
  }
});

test('a dry run says what it would do and writes nothing', async () => {
  const scratch = scratchCodexHome();
  try {
    const { stdout } = await raise(['install-codex', '--dry-run'], { CODEX_HOME: scratch.home });
    assert.match(stdout, /add SessionStart/);
    assert.match(stdout, /nothing written/i);
    assert.equal(readFileSync(scratch.hooks, 'utf8'), FIXTURE);
  } finally {
    scratch.cleanup();
  }
});

test('install into a Codex home with no hooks file yet creates one', async () => {
  const scratch = scratchCodexHome({ withFixture: false });
  try {
    await raise(['install-codex', '--yes'], { CODEX_HOME: scratch.home });
    const written = JSON.parse(readFileSync(scratch.hooks, 'utf8'));
    assert.equal(Object.keys(written.hooks).length, CODEX_HOOK_EVENTS.length);
  } finally {
    scratch.cleanup();
  }
});

test('doctor says nothing at all about Codex on a machine without it', async () => {
  // The rule no-mistakes and Lavish are held to, applied to a third optional
  // integration: no line, no warning, no subprocess. An `off` line would still
  // be a sentence about something the user never chose to install.
  //
  // Both halves point CODEX_HOME at a directory this test owns, so the
  // assertion never depends on whether the machine running it has Codex.
  const scratch = scratchCodexHome();
  try {
    const absent = await raise(['doctor'], {
      RAISE_HOME: join(scratch.dir, 'raise'),
      NM_HOME: join(scratch.dir, 'nm'),
      CODEX_HOME: join(scratch.dir, 'no-codex-here'),
    });
    assert.doesNotMatch(absent.stdout, /Codex/);

    const present = await raise(['doctor'], {
      RAISE_HOME: join(scratch.dir, 'raise'),
      NM_HOME: join(scratch.dir, 'nm'),
      CODEX_HOME: scratch.home,
    });
    assert.match(present.stdout, /Codex hooks.*not installed/);
  } finally {
    scratch.cleanup();
  }
});
