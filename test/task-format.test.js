import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ANSI, cell, ELLIPSIS, pad, painter, truncate } from '../scripts/task-format.js';

test('padding widens a value to its column', () => {
  assert.equal(pad('RAI-2', 8), 'RAI-2   ');
});

test('padding a value longer than its column leaves it intact rather than cutting it', () => {
  // A ticket key or a status word that overflows is worth seeing whole. Only
  // the title column asks to be shortened, and it asks `truncate` for it.
  assert.equal(pad('RAI-12345678', 8), 'RAI-12345678');
});

test('truncation marks that it truncated', () => {
  assert.equal(truncate('abcdefghij', 5), `abcd${ELLIPSIS}`);
});

test('a value that fits is not truncated and gains no mark', () => {
  assert.equal(truncate('abcde', 5), 'abcde');
});

test('a cell is exactly its column wide, whichever way it had to get there', () => {
  assert.equal(cell('ab', 6).length, 6);
  assert.equal(cell('abcdefghij', 6).length, 6);
});

test('no escape codes are written when colour is off', () => {
  const paint = painter(false);
  assert.equal(paint(ANSI.green, 'shipped'), 'shipped');
});

test('colour wraps the text exactly once and resets afterwards', () => {
  const paint = painter(true);
  assert.equal(paint(ANSI.green, 'shipped'), '\x1b[32mshipped\x1b[0m');
});
