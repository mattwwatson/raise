import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { parseArgv, parseFlags } from '../src/cli-args.js';

const execFileAsync = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'raise.js');

// Serving creates its state directory before it has a chance to reject a bad
// port, so an unscoped spawn would litter the real ~/.raise just by running the
// suite.
const SCRATCH_HOME = mkdtempSync(join(tmpdir(), 'raise-test-'));
after(() => rmSync(SCRATCH_HOME, { recursive: true, force: true }));

const cli = (args, env) =>
  execFileAsync(process.execPath, [CLI, ...args], {
    env: { ...process.env, RAISE_HOME: SCRATCH_HOME, ...env },
  });

test('a bare word is the command', () => {
  const { command, flags } = parseArgv(['status']);
  assert.equal(command, 'status');
  assert.deepEqual(flags, {});
});

test('no arguments means serve', () => {
  assert.equal(parseArgv([]).command, 'serve');
});

test('a leading flag is parsed as a flag, not eaten as the command', () => {
  // Regression: `raise --help` used to fall through to `serve` and silently
  // start a server, because the flag was consumed as the command name.
  for (const argv of [['--help'], ['-h']]) {
    const parsed = parseArgv(argv);
    assert.equal(parsed.wantsHelp, true, `${argv} should ask for help`);
  }
  assert.equal(parseArgv(['help']).wantsHelp, true);
});

test('the version is asked for by flag, short flag or bare word', () => {
  for (const argv of [['--version'], ['-V'], ['version']]) {
    assert.equal(parseArgv(argv).wantsVersion, true, `${argv} should ask for the version`);
  }
});

test('a lowercase -v is not the version flag', () => {
  // Deliberate: `-v` reads as verbose to most people, so it is left unclaimed
  // rather than quietly answering a question that was not asked.
  assert.equal(parseArgv(['-v']).wantsVersion, false);
});

test('nothing else asks for the version, help included', () => {
  // `wantsVersion` short-circuits the whole CLI before any command runs, so a
  // false positive here would make `raise serve` print a number and exit.
  for (const argv of [[], ['serve'], ['--help'], ['status'], ['--port', '8080']]) {
    assert.equal(parseArgv(argv).wantsVersion, false, `${argv} must not ask for the version`);
  }
});

test('a leading option with a value still runs the default command', () => {
  const { command, flags } = parseArgv(['--port', '8080']);
  assert.equal(command, 'serve');
  assert.equal(flags.port, '8080');
});

test('flags after a command are attached to it', () => {
  const { command, flags } = parseArgv(['install-hooks', '--dry-run', '--settings', '/tmp/s.json']);
  assert.equal(command, 'install-hooks');
  assert.equal(flags['dry-run'], true);
  assert.equal(flags.settings, '/tmp/s.json');
});

test('positional arguments survive alongside flags', () => {
  const { command, positional } = parseArgv(['focus', 'abc-123']);
  assert.equal(command, 'focus');
  assert.deepEqual(positional, ['abc-123']);
});

test('inline --name=value is supported', () => {
  assert.equal(parseFlags(['--port=9000']).flags.port, '9000');
});

test('a boolean flag is not fed the next flag as its value', () => {
  const { flags } = parseFlags(['--dry-run', '--yes']);
  assert.equal(flags['dry-run'], true);
  assert.equal(flags.yes, true);
});

test('a boolean flag is not fed a following short flag as its value', () => {
  const { flags } = parseFlags(['--dry-run', '-h']);
  assert.equal(flags['dry-run'], true, 'a value of "-h" would be nonsense');
  assert.equal(flags.h, true);
});

test('bundled short flags each become a flag', () => {
  assert.deepEqual(parseFlags(['-ab']).flags, { a: true, b: true });
});

test('--help still prints help when RAISE_PORT is malformed', async () => {
  // The usage text quotes the default port, so it used to resolve RAISE_PORT
  // unguarded and throw a stack trace instead - at exactly the moment you are
  // asking what that variable is meant to contain.
  const { stdout } = await cli(['--help'], { RAISE_PORT: 'not-a-port' });
  assert.match(stdout, /raise serve/);
  assert.match(stdout, /RAISE_PORT is currently set to something that is not a port/);
});

test('--help reports the configured port when RAISE_PORT is valid', async () => {
  const { stdout } = await cli(['--help'], { RAISE_PORT: '9123' });
  assert.match(stdout, /default 9123/);
});

test('serve still refuses a malformed RAISE_PORT rather than binding a random one', async () => {
  // Help is forgiving; actually starting a server is not. A port that reaches
  // server.listen unvalidated binds an ephemeral one and every hook then
  // decides Raise is not running.
  const failed = await cli(['serve'], { RAISE_PORT: 'not-a-port' }).catch((err) => err);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /RAISE_PORT must be a whole number/);
});
