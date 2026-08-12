/**
 * The Node version boundary, tested at the versions the suite will never run on.
 *
 * `cli-node-version.test.js` proves the guard is *reachable*, which was the bug.
 * This proves it is *right*, which nothing else can: the interesting versions are
 * all ones `engines` refuses, so the only way to see 22.12 rejected and 22.13
 * accepted is to hand the predicate the string.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { supportsNode, nodeVersionProblem, MIN_NODE_MAJOR, MIN_NODE_MINOR } from '../src/node-support.js';

test('the boundary is 22.13, either side of it', () => {
  // 22.13.0 is where `--experimental-sqlite` stopped being needed. 22.12 is the
  // last version that imports `node:sqlite` and dies, and it is the one a floor
  // of 22.5 used to wave through.
  assert.equal(supportsNode('22.12.0'), false);
  assert.equal(supportsNode('22.13.0'), true);
});

test('the whole flagged range is refused, including the version node:sqlite landed in', () => {
  // 22.5 is the tempting number: the module appeared then. It appeared behind a
  // flag, so every version from here to 22.12 is broken for Raise.
  for (const version of ['22.5.0', '22.6.0', '22.9.0', '22.11.0', '22.12.1']) {
    assert.equal(supportsNode(version), false, version);
  }
});

test('anything older than 22 is refused too', () => {
  assert.equal(supportsNode('20.19.0'), false);
  assert.equal(supportsNode('18.20.4'), false);
});

test('later majors are supported without being listed', () => {
  // 23.4.0 is where the flag came off in the 23 line, but the check is a simple
  // ordering: a newer major is newer, and nothing needs adding here per release.
  for (const version of ['23.4.0', '24.0.0', '26.3.0', '100.0.0']) {
    assert.equal(supportsNode(version), true, version);
  }
});

test('a version string we cannot read is treated as supported', () => {
  // Not evidence of an old Node. Refusing to start over an unparseable version
  // would turn a guard against a known-broken range into a guess that can
  // strand a working installation - and this guard runs before anything else,
  // so there would be no way past it.
  for (const version of ['', 'v-unknown', 'nightly', undefined]) {
    assert.equal(supportsNode(/** @type {string} */ (version)), true, String(version));
  }
});

test('a supported version has no problem to report', () => {
  assert.equal(nodeVersionProblem('24.0.0'), null);
});

test('the refusal names the version it saw and the one it wants', () => {
  // Both halves matter to somebody reading it: their version, so they can tell
  // the message is about them, and the floor, so they know what to install.
  const message = nodeVersionProblem('22.9.0');
  assert.match(String(message), /v22\.9\.0/);
  assert.match(String(message), /22\.13 or newer/);
});

test('the message is built from the constants, so the two cannot drift apart', () => {
  assert.match(String(nodeVersionProblem('20.0.0')), new RegExp(`${MIN_NODE_MAJOR}\\.${MIN_NODE_MINOR}`));
});
