import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkLinks,
  isScannedDir,
  isScannedFile,
  readTree,
  referencesIn,
  renderLinks,
  walkTree,
} from '../scripts/task-links.js';

/** A tree keyed by directory. A `null` entry is a subdirectory. */
const fakeFiles = (tree = {}, unreadable = new Set()) => ({
  readDir(path) {
    const entries = tree[path];
    if (!entries) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return Object.keys(entries).map((name) => ({ name, isDirectory: entries[name] === null }));
  },
  readText(path) {
    if (unreadable.has(path)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const at = path.lastIndexOf('/');
    const text = tree[path.slice(0, at)]?.[path.slice(at + 1)];
    if (typeof text !== 'string') throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
    return text;
  },
});

/** Documents of the shape `readTree` produces. */
const docs = (entries) => Object.entries(entries).map(([file, text]) => ({ file, text }));

const targets = (report) => report.broken.map((one) => `${one.file}:${one.line} -> ${one.target}`);

test('a docs/tasks reference that resolves is not reported', () => {
  const report = checkLinks(
    docs({
      'AGENTS.md': 'see docs/tasks/RAI-12-stale.md for the detail',
      'docs/tasks/RAI-12-stale.md': '# RAI-12 - Stale',
    }),
  );
  assert.deepEqual(report.broken, []);
  assert.equal(report.checked, 1);
  assert.equal(report.exitCode, 0);
});

test('a reference to a file that does not exist is broken and names both files', () => {
  const report = checkLinks(docs({ 'AGENTS.md': 'see docs/tasks/RAI-99-gone.md' }));
  assert.deepEqual(targets(report), ['AGENTS.md:1 -> docs/tasks/RAI-99-gone.md']);
  assert.equal(report.exitCode, 1);
});

test('the line number of a broken reference is reported, so it can be opened', () => {
  const report = checkLinks(docs({ 'AGENTS.md': 'one\ntwo\nsee docs/tasks/RAI-99-gone.md\n' }));
  assert.equal(report.broken[0].line, 3);
});

test('a ../docs/tasks reference resolves the same as a plain one', () => {
  const report = checkLinks(
    docs({
      'docs/notes.md': 'see ../docs/tasks/RAI-12-stale.md',
      'docs/tasks/RAI-12-stale.md': '# RAI-12 - Stale',
    }),
  );
  assert.deepEqual(report.broken, []);
});

test('a reference written tasks/X.md without the docs prefix still resolves', () => {
  const report = checkLinks(
    docs({ 'AGENTS.md': 'see tasks/RAI-12-stale.md', 'docs/tasks/RAI-12-stale.md': '#' }),
  );
  assert.deepEqual(report.broken, []);
});

test('a bare markdown link is resolved against the referring file, but only inside docs/tasks', () => {
  const report = checkLinks(
    docs({
      'docs/tasks/RAI-13-forge.md': 'prerequisite: [RAI-10](RAI-10-pr-state.md)',
      'docs/tasks/RAI-10-pr-state.md': '# RAI-10 - PR state',
    }),
  );
  assert.deepEqual(report.broken, []);
  assert.equal(report.checked, 1);
});

test('a bare link outside docs/tasks is not treated as a spec reference', () => {
  // Otherwise every relative markdown link in the repository would be claimed.
  const report = checkLinks(docs({ 'README.md': 'see [the guide](CONTRIBUTING.md)' }));
  assert.equal(report.checked, 0);
  assert.deepEqual(report.broken, []);
});

test('an anchor on a bare link does not stop it resolving', () => {
  const report = checkLinks(
    docs({
      'docs/tasks/a.md': '[why](b.md#design-constraints)',
      'docs/tasks/b.md': '# B',
    }),
  );
  assert.deepEqual(report.broken, []);
});

test('several references on one line are each checked', () => {
  const report = checkLinks(
    docs({ 'AGENTS.md': 'docs/tasks/RAI-1-a.md and docs/tasks/RAI-2-b.md' }),
  );
  assert.equal(report.checked, 2);
  assert.equal(report.broken.length, 2);
});

test('the same broken target in two files is reported once per file', () => {
  const report = checkLinks(
    docs({ 'a.md': 'docs/tasks/RAI-99-gone.md', 'b.md': 'docs/tasks/RAI-99-gone.md' }),
  );
  assert.deepEqual(
    report.broken.map((one) => one.file),
    ['a.md', 'b.md'],
  );
});

test('a reference inside a code comment is checked like any other', () => {
  // A spec path rots in source exactly as it does in prose.
  const report = checkLinks(docs({ 'src/thing.js': '// see docs/tasks/RAI-99-gone.md' }));
  assert.equal(report.broken.length, 1);
});

test('node_modules and .git are never walked', () => {
  assert.equal(isScannedDir('node_modules'), false);
  assert.equal(isScannedDir('.git'), false);
});

test('test directories are never walked, because a fixture is not a claim about the tree', () => {
  // This very file writes down spec paths that deliberately do not exist, in
  // order to assert that a broken one is caught. Scanning it would make the
  // check permanently red the first time it ran.
  assert.equal(isScannedDir('test'), false);
  assert.equal(isScannedDir('__tests__'), false);
  assert.equal(isScannedDir('fixtures'), false);
});

test('.claude is walked, because the roadmap skill lives there and names spec files', () => {
  assert.equal(isScannedDir('.claude'), true);
});

test('a file with an extension we do not scan is never read', () => {
  assert.equal(isScannedFile('notes.txt'), false);
  assert.equal(isScannedFile('AGENTS.md'), true);
  assert.equal(isScannedFile('pipelines.yml'), true);
});

test('the walk descends directories and returns root-relative paths', () => {
  const files = fakeFiles({
    '/repo': { 'AGENTS.md': 'x', docs: null, node_modules: null },
    '/repo/docs': { tasks: null },
    '/repo/docs/tasks': { 'RAI-1-a.md': 'y' },
    '/repo/node_modules': { 'evil.md': 'z' },
  });
  assert.deepEqual(walkTree('/repo', files), ['AGENTS.md', 'docs/tasks/RAI-1-a.md']);
});

test('a file that cannot be read is skipped rather than failing the run', () => {
  const files = fakeFiles(
    { '/repo': { 'a.md': 'docs/tasks/RAI-99-gone.md', 'b.md': 'fine' } },
    new Set(['/repo/a.md']),
  );
  assert.deepEqual(
    readTree('/repo', files).map((one) => one.file),
    ['b.md'],
  );
});

test('a directory that vanished under the walk is not a broken link', () => {
  const files = fakeFiles({ '/repo': { docs: null } });
  assert.deepEqual(walkTree('/repo', files), []);
});

test('a clean tree says how many references across how many files resolved', () => {
  const report = checkLinks(docs({ 'a.md': 'docs/tasks/b.md', 'docs/tasks/b.md': '# B' }));
  const { out } = renderLinks(report);
  assert.ok(out.join('\n').includes('1 reference across 2 files'));
});

test('the broken report explains why a reference goes stale in the first place', () => {
  const report = checkLinks(docs({ 'a.md': 'docs/tasks/RAI-99-gone.md' }));
  const { err } = renderLinks(report);
  assert.ok(err.join('\n').includes('rewritten when its item is captured'));
});

test('the renderer writes no escape codes when colour is off', () => {
  const report = checkLinks(docs({ 'a.md': 'docs/tasks/RAI-99-gone.md' }));
  const { out, err } = renderLinks(report, { colour: false });
  for (const line of [...out, ...err]) assert.ok(!line.includes('\x1b['), line);
});

test('referencesIn reports nothing for a file that mentions no spec', () => {
  assert.deepEqual(referencesIn('README.md', 'nothing to see'), []);
});
