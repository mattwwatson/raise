import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv, parseFlags } from '../src/cli-args.js';

test('a bare word is the command', () => {
  const { command, flags } = parseArgv(['status']);
  assert.equal(command, 'status');
  assert.deepEqual(flags, {});
});

test('no arguments means serve', () => {
  assert.equal(parseArgv([]).command, 'serve');
});

test('a leading flag is parsed as a flag, not eaten as the command', () => {
  // Regression: `nmmon --help` used to fall through to `serve` and silently
  // start a server, because the flag was consumed as the command name.
  for (const argv of [['--help'], ['-h']]) {
    const parsed = parseArgv(argv);
    assert.equal(parsed.wantsHelp, true, `${argv} should ask for help`);
  }
  assert.equal(parseArgv(['help']).wantsHelp, true);
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
