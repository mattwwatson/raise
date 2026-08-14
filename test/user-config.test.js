/**
 * The write half of `~/.raise/config.json` - the merge, and the mode.
 *
 * The merge is pure and is tested by calling it, per AGENTS.md. The writer is
 * not, and is deliberately tested against a real temp directory rather than
 * through an injected file access: **what it has to get right is the mode**, and
 * a fake would happily report whatever mode we told it to. The two things that
 * would silently break here - a file created `0644` under a permissive umask,
 * and a `0644` file left `0644` because `writeFileSync`'s `mode` only applies at
 * creation - are both invisible to anything but a real `stat`.
 *
 * The read half is covered by `forge-config.test.js` and `update-check.test.js`,
 * which is where the refusal rule is exercised through the features that own the
 * blocks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONFIG_FEATURES,
  configFeature,
  readUserConfigForWrite,
  setFeature,
  writeUserConfig,
} from '../src/user-config.js';

const UPDATES = configFeature('update-check');
const FORGE = configFeature('pull-request-state');

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'raise-config-'));
  return { path: join(dir, 'config.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function mode(path) {
  return (statSync(path).mode & 0o777).toString(8).padStart(4, '0');
}

test('the feature names are the ones raise doctor prints, kebab-cased', () => {
  // The point of the whole naming decision: what you read in the diagnostic is
  // what you type to fix it. If a label is ever reworded, this fails rather than
  // the two quietly drifting apart.
  for (const feature of CONFIG_FEATURES) {
    assert.equal(feature.name, feature.label.toLowerCase().replace(/ /g, '-'));
  }
  assert.equal(configFeature('nonsense'), null);
});

test('enabling a feature in an empty file adds only that block', () => {
  const { data, changes } = setFeature({}, UPDATES, true);
  assert.deepEqual(data, { updates: { enabled: true } });
  assert.deepEqual(changes, ['add updates.enabled: true']);
});

test('enabling one feature leaves the other block and its credential untouched', () => {
  // This is the regression the whole item is about: the README's `cat >` recipe
  // for the update check destroyed the forge opt-in and the Bitbucket token
  // written by the recipe above it.
  const before = {
    forge: { enabled: true, bitbucket: { email: 'you@example.com', token: 'secret' } },
  };
  const { data, changes } = setFeature(before, UPDATES, true);
  assert.deepEqual(data.forge, before.forge);
  assert.deepEqual(data.updates, { enabled: true });
  assert.deepEqual(changes, ['add updates.enabled: true']);
});

test('disabling writes false and keeps the credential, so re-enabling needs no new token', () => {
  const before = {
    forge: { enabled: true, bitbucket: { email: 'you@example.com', token: 'secret' } },
  };
  const { data, changes } = setFeature(before, FORGE, false);
  assert.equal(data.forge.enabled, false);
  assert.deepEqual(data.forge.bitbucket, before.forge.bitbucket);
  assert.deepEqual(changes, ['change forge.enabled: true -> false']);
});

test('setting a feature to what it already says is no change at all', () => {
  const { changes } = setFeature({ updates: { enabled: true } }, UPDATES, true);
  assert.deepEqual(changes, []);
});

test('the merge never mutates what it was given', () => {
  const before = { updates: { enabled: false } };
  setFeature(before, UPDATES, true);
  assert.deepEqual(before, { updates: { enabled: false } }, 'the caller still holds the old file');
});

test('a block of the wrong type is refused rather than replaced', () => {
  // Somebody wrote `"updates": "yes"`. Replacing it would discard whatever they
  // meant, and the file may hold a credential, so it is a refusal.
  assert.throws(() => setFeature({ updates: 'yes' }, UPDATES, true), /rather than a block/);
  assert.throws(() => setFeature({ forge: [] }, FORGE, true), /rather than a block/);
});

test('a new file is created 0600, whatever the umask says', () => {
  const s = scratch();
  try {
    const backup = writeUserConfig(s.path, { updates: { enabled: true } });
    assert.equal(backup, null, 'nothing to back up when there was no file');
    assert.equal(mode(s.path), '0600');
    assert.deepEqual(JSON.parse(readFileSync(s.path, 'utf8')), { updates: { enabled: true } });
  } finally {
    s.cleanup();
  }
});

test('an existing 0644 file is repaired to 0600, which the mode option alone would not do', () => {
  // `writeFileSync`'s `mode` is handed to open(2) and applies at creation only,
  // so without the explicit chmod this file stays 0644 - and `readUserConfig`
  // goes on refusing it while the command reports success.
  const s = scratch();
  try {
    writeFileSync(s.path, '{"updates":{"enabled":true}}\n');
    chmodSync(s.path, 0o644);
    writeUserConfig(s.path, { updates: { enabled: true } });
    assert.equal(mode(s.path), '0600');
  } finally {
    s.cleanup();
  }
});

test('the backup is 0600 even when the file it copies was not', () => {
  // copyFileSync takes the source's mode, so a backup taken during a mode repair
  // would otherwise be a world-readable copy of the credential, created by the
  // command that had just secured the original.
  const s = scratch();
  try {
    writeFileSync(s.path, '{"forge":{"bitbucket":{"token":"secret"}}}\n');
    chmodSync(s.path, 0o644);
    const backup = writeUserConfig(s.path, { forge: { enabled: true } });
    assert.equal(backup, `${s.path}.raise-backup`);
    assert.equal(mode(backup), '0600');
  } finally {
    s.cleanup();
  }
});

test('reading for a write sees past an unsafe mode, because repairing it is the job', () => {
  const s = scratch();
  try {
    writeFileSync(s.path, '{"updates":{"enabled":true}}\n');
    chmodSync(s.path, 0o644);
    const current = readUserConfigForWrite({ path: s.path });
    assert.equal(current.exists, true);
    assert.deepEqual(current.data, { updates: { enabled: true } });
  } finally {
    s.cleanup();
  }
});

test('reading for a write throws on JSON it cannot parse, rather than offering an empty file', () => {
  // The difference from `readUserConfig`, which fails closed to nothing: here
  // "nothing" would become an overwrite of whatever the user was typing.
  const s = scratch();
  try {
    writeFileSync(s.path, '{ "updates": ');
    assert.throws(() => readUserConfigForWrite({ path: s.path }), /not valid JSON/);
    writeFileSync(s.path, '[1, 2]');
    assert.throws(() => readUserConfigForWrite({ path: s.path }), /rather than a JSON object/);
  } finally {
    s.cleanup();
  }
});

test('no file at all is an empty object rather than an error', () => {
  const s = scratch();
  try {
    const current = readUserConfigForWrite({ path: s.path });
    assert.deepEqual(current, { exists: false, mode: null, data: {} });
  } finally {
    s.cleanup();
  }
});
