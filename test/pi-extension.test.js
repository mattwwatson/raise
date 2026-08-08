import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeExtension, removeExtension, EXTENSION_MARKER } from '../src/pi-extension.js';

const OURS = '/Users/x/work/no-mistakes-monitor/hooks/raise-pi-extension.js';

test('installing into an empty settings file adds the path', () => {
  const { settings, changes } = mergeExtension({}, OURS);
  assert.deepEqual(settings.extensions, [OURS]);
  assert.equal(changes.length, 1);
});

test('installing twice changes nothing the second time', () => {
  const first = mergeExtension({}, OURS);
  const second = mergeExtension(first.settings, OURS);
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.settings.extensions, [OURS]);
});

test('somebody else"s extensions keep their place', () => {
  // Load order is meaningful in pi - a later handler sees earlier mutations -
  // so ours goes on the end and nothing else moves.
  const existing = { extensions: ['/a/first.js', '/b/second.js'] };
  const { settings } = mergeExtension(existing, OURS);
  assert.deepEqual(settings.extensions, ['/a/first.js', '/b/second.js', OURS]);
});

test('a moved checkout updates our entry rather than adding a second', () => {
  // Two copies would load the extension twice and post every event twice.
  const existing = { extensions: ['/old/path/hooks/raise-pi-extension.js', '/a/other.js'] };
  const { settings, changes } = mergeExtension(existing, OURS);
  assert.deepEqual(settings.extensions, [OURS, '/a/other.js']);
  assert.match(changes[0], /^update /);
});

test('a duplicate added by hand is dropped', () => {
  const existing = {
    extensions: [OURS, '/a/other.js', '/another/raise-pi-extension.js'],
  };
  const { settings } = mergeExtension(existing, OURS);
  assert.deepEqual(settings.extensions, [OURS, '/a/other.js']);
});

test('the rest of the settings file is left alone', () => {
  const existing = { theme: 'dark', defaultProvider: 'anthropic', packages: ['npm:x'] };
  const { settings } = mergeExtension(existing, OURS);
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.defaultProvider, 'anthropic');
  assert.deepEqual(settings.packages, ['npm:x']);
});

test('the input object is never mutated', () => {
  const existing = { extensions: ['/a/other.js'] };
  mergeExtension(existing, OURS);
  assert.deepEqual(existing.extensions, ['/a/other.js']);
});

test('uninstalling removes ours and keeps everything else', () => {
  const existing = { extensions: ['/a/other.js', OURS], theme: 'dark' };
  const { settings, changes } = removeExtension(existing);
  assert.deepEqual(settings.extensions, ['/a/other.js']);
  assert.equal(settings.theme, 'dark');
  assert.equal(changes.length, 1);
});

test('uninstalling the only extension takes the key away too', () => {
  // We added the key; leaving an empty array behind is litter in a config file
  // that is not ours.
  const { settings } = removeExtension({ extensions: [OURS] });
  assert.equal('extensions' in settings, false);
});

test('uninstalling when we were never there reports no change', () => {
  assert.deepEqual(removeExtension({ extensions: ['/a/other.js'] }).changes, []);
  assert.deepEqual(removeExtension({}).changes, []);
});

test('the marker is what identifies our entry', () => {
  assert.ok(OURS.includes(EXTENSION_MARKER));
});
