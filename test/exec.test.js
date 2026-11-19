/**
 * `findExecutable`, against a real temp directory: what it has to get right is
 * the file system's own answer about what is executable, which a fake would
 * report however it was told to.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';

import { findExecutable } from '../src/exec.js';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'raise-exec-'));
  const make = (sub, name, mode) => {
    mkdirSync(join(dir, sub), { recursive: true });
    const path = join(dir, sub, name);
    writeFileSync(path, '#!/bin/sh\n');
    chmodSync(path, mode);
    return path;
  };
  return { dir, make, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('findExecutable answers the first executable on the path, as the shell would', () => {
  const s = scratch();
  try {
    const first = s.make('a', 'tmux', 0o755);
    s.make('b', 'tmux', 0o755);
    const path = [join(s.dir, 'a'), join(s.dir, 'b')].join(delimiter);
    assert.equal(findExecutable('tmux', { path }), first);
  } finally {
    s.cleanup();
  }
});

test('findExecutable passes over a file that is not executable, and a directory', () => {
  const s = scratch();
  try {
    s.make('a', 'tmux', 0o644);
    mkdirSync(join(s.dir, 'b', 'tmux'), { recursive: true });
    const real = s.make('c', 'tmux', 0o755);
    const path = ['a', 'b', 'c'].map((sub) => join(s.dir, sub)).join(delimiter);
    assert.equal(findExecutable('tmux', { path }), real);
  } finally {
    s.cleanup();
  }
});

test('findExecutable says null rather than guessing, and ignores relative path entries', () => {
  const s = scratch();
  try {
    s.make('a', 'hc', 0o755);
    assert.equal(findExecutable('hc', { path: join(s.dir, 'b') }), null);
    // A relative entry means "wherever the server happened to start", which is
    // not something to hand a terminal app.
    const fromHere = relative(process.cwd(), join(s.dir, 'a'));
    assert.equal(findExecutable('hc', { path: [fromHere, ''].join(delimiter) }), null);
    assert.equal(findExecutable('a/hc', { path: s.dir }), null, 'a name, not a path');
    assert.equal(findExecutable('', { path: join(s.dir, 'a') }), null);
  } finally {
    s.cleanup();
  }
});
