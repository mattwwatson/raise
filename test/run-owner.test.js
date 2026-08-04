import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RunOwners } from '../src/run-owner.js';

test('a run is owned by the session first seen driving it', () => {
  const owners = new RunOwners();
  owners.observe('r1', 's1');
  assert.equal(owners.ownerOf('r1'), 's1');
});

test('ownership does not change hands', () => {
  // `axi run` holds the run for minutes and is seen on the first poll, so a
  // later sighting is another session running a driving command in the same
  // repo - not a handover. Letting it win would take the row off the session
  // that actually started the pipeline.
  const owners = new RunOwners();
  owners.observe('r1', 's1');
  owners.observe('r1', 's2');
  assert.equal(owners.ownerOf('r1'), 's1');
});

test('a run nobody was seen to drive has no owner', () => {
  const owners = new RunOwners();
  assert.equal(owners.ownerOf('r1'), null);
  assert.equal(owners.ownerOf(null), null);
});

test('a sighting missing either half is not a sighting', () => {
  const owners = new RunOwners();
  owners.observe(null, 's1');
  owners.observe('r1', null);
  assert.equal(owners.owners.size, 0);
});

test('an owner is forgotten once its run drops out of the reading', () => {
  const owners = new RunOwners();
  owners.observe('r1', 's1');
  owners.observe('r2', 's2');
  owners.prune(new Set(['r2']));
  assert.equal(owners.ownerOf('r1'), null);
  assert.equal(owners.ownerOf('r2'), 's2');
});

test('the map handed to buildRows is what was observed', () => {
  const owners = new RunOwners();
  owners.observe('r1', 's1');
  assert.deepEqual([...owners.owners], [['r1', 's1']]);
});
