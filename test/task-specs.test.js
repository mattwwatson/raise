import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectSpecs,
  findDependencyCycles,
  parseFrontmatter,
  parseSpec,
  readSpecs,
  STATUSES,
  compareTickets,
  isIssueKey,
  ticketNumber,
  titleOf,
} from '../scripts/task-specs.js';

/**
 * A spec document, rendered the way the real files are written.
 *
 * `frontmatter: null` produces a file with no block at all, which is the
 * reference-prose case the board is meant to pass over.
 */
const doc = (over = {}) => {
  const {
    file = 'RAI-1-thing.md',
    heading = '# RAI-1 - A thing that needs doing',
    body = '',
    frontmatter = { ticket: 'RAI-1', status: 'backlog', size: 'S', depends: '-' },
  } = over;
  const block = frontmatter
    ? `---\n${Object.entries(frontmatter)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n')}\n---\n`
    : '';
  return { file, text: `${block}${heading}\n${body}` };
};

/** The tickets a set indexed, in insertion order. */
const tickets = (set) => [...set.byTicket.keys()];

/** The fault codes a set produced, which is what tests assert on. */
const codes = (set) => set.faults.map((problem) => problem.code);

/**
 * An in-memory tree. A `null` entry is a directory; a name in `unreadable`
 * exists but throws when read, which is the case a real permission or
 * disappearing-file error produces.
 */
const fakeFiles = (tree = {}, unreadable = new Set()) => ({
  readDir(path) {
    const entries = tree[path];
    if (!entries) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return Object.keys(entries).map((name) => ({ name, isDirectory: entries[name] === null }));
  },
  readText(path) {
    const at = path.lastIndexOf('/');
    const name = path.slice(at + 1);
    if (unreadable.has(name)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const text = tree[path.slice(0, at)]?.[name];
    if (typeof text !== 'string') throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
    return text;
  },
});

test('frontmatter is read as fixed key/value pairs, not parsed as YAML', () => {
  const fields = parseFrontmatter('---\nticket: RAI-1\nstatus: backlog\n---\n# Title\n');
  assert.deepEqual(fields, { ticket: 'RAI-1', status: 'backlog' });
});

test('a quoted value keeps its content and loses its quotes', () => {
  const fields = parseFrontmatter('---\nbranch: "RAI-1-thing"\n---\n');
  assert.equal(fields.branch, 'RAI-1-thing');
});

test('a documented inline comment is stripped, so the skill\'s own block parses', () => {
  // The roadmap-workflow skill documents each field with a trailing comment
  // naming its legal values. Copying that block is what the skill is for, so a
  // parser that faults on it is wrong about its own format.
  const fields = parseFrontmatter(
    '---\nstatus: backlog          # backlog | in-progress | shipped | wont-do\n---\n',
  );
  assert.equal(fields.status, 'backlog');
});

test('a file with no frontmatter is not a work item and is skipped rather than faulted', () => {
  const read = parseSpec('notes.md', '# Just some prose\n');
  assert.equal(read.skipped, true);
  assert.equal(read.fault, null);
});

test('frontmatter that names neither a ticket nor a status is not claiming to be a work item', () => {
  const read = parseSpec('notes.md', '---\nauthor: someone\n---\n# Prose\n');
  assert.equal(read.skipped, true);
});

test('frontmatter whose block never closes is skipped, not read as half a spec', () => {
  const read = parseSpec('broken.md', '---\nticket: RAI-1\nstatus: backlog\n# Title\n');
  assert.equal(read.skipped, true);
});

test('a body rule written --- does not close the frontmatter early', () => {
  // The specs in this repository use --- rules between sections, so an
  // unanchored terminator would cut every one of them short.
  const fields = parseFrontmatter('---\nticket: RAI-1\nstatus: backlog\n---\n# T\n\n---\n\nmore\n');
  assert.deepEqual(fields, { ticket: 'RAI-1', status: 'backlog' });
});

test('the title is the first heading with its own ticket key stripped off it', () => {
  assert.equal(titleOf('# RAI-12 - A pinned dashboard goes stale\n', 'x.md'), 'A pinned dashboard goes stale');
});

test('a second-level heading is not mistaken for the title', () => {
  assert.equal(titleOf('## What and why\n# RAI-1 - The real title\n', 'x.md'), 'The real title');
});

test('a spec with no heading falls back to its filename', () => {
  assert.equal(titleOf('no headings here\n', 'RAI-1-thing.md'), 'RAI-1-thing.md');
});

test('a spec with no ticket is a fault, because every work item needs a Jira key', () => {
  const read = parseSpec('x.md', '---\nstatus: backlog\n---\n# T\n');
  assert.equal(read.fault?.code, 'no-ticket');
});

test('a status we do not recognise is a fault and names the four that are allowed', () => {
  const read = parseSpec('x.md', '---\nticket: RAI-1\nstatus: nearly\n---\n# T\n');
  assert.equal(read.fault?.code, 'unknown-status');
  for (const status of STATUSES) assert.ok(read.fault?.message.includes(status));
});

test('size defaults to a question mark rather than to a guess', () => {
  const read = parseSpec('x.md', '---\nticket: RAI-1\nstatus: backlog\n---\n# T\n');
  assert.equal(read.spec?.size, '?');
});

test('branch and shipped are null when the frontmatter omits them', () => {
  // Every in-progress spec in this repository omits `branch:` today, so a
  // reader that required it would fault on the tree as it stands.
  const read = parseSpec('x.md', '---\nticket: RAI-1\nstatus: in-progress\n---\n# T\n');
  assert.equal(read.spec?.branch, null);
  assert.equal(read.spec?.shipped, null);
});

test('depends of a single dash means no dependencies', () => {
  const read = parseSpec('x.md', '---\nticket: RAI-1\nstatus: backlog\ndepends: -\n---\n# T\n');
  assert.deepEqual(read.spec?.depends, []);
});

test('depends is split on commas and each key trimmed', () => {
  const text = '---\nticket: RAI-1\nstatus: backlog\ndepends: RAI-2, RAI-3 ,RAI-4\n---\n# T\n';
  assert.deepEqual(parseSpec('x.md', text).spec?.depends, ['RAI-2', 'RAI-3', 'RAI-4']);
});

test('two files claiming one ticket key is a fault, and it names both files', () => {
  const set = collectSpecs([
    doc({ file: 'a.md', frontmatter: { ticket: 'RAI-1', status: 'backlog' } }),
    doc({ file: 'b.md', frontmatter: { ticket: 'RAI-1', status: 'backlog' } }),
  ]);
  assert.deepEqual(codes(set), ['duplicate-ticket']);
  assert.ok(set.faults[0].message.includes('a.md'));
  assert.ok(set.faults[0].message.includes('b.md'));
});

test('the first file to claim a key keeps it, so one duplicate costs one spec and not two', () => {
  const set = collectSpecs([
    doc({ file: 'a.md', frontmatter: { ticket: 'RAI-1', status: 'backlog' } }),
    doc({ file: 'b.md', frontmatter: { ticket: 'RAI-1', status: 'shipped' } }),
  ]);
  assert.equal(set.byTicket.size, 1);
  assert.equal(set.byTicket.get('RAI-1')?.file, 'a.md');
});

test('depending on a key no spec claims is a fault', () => {
  const set = collectSpecs([
    doc({ file: 'a.md', frontmatter: { ticket: 'RAI-1', status: 'backlog', depends: 'RAI-99' } }),
  ]);
  assert.deepEqual(codes(set), ['unknown-depends']);
});

test('a faulty spec does not stop the other specs being read', () => {
  const set = collectSpecs([
    doc({ file: 'bad.md', frontmatter: { status: 'backlog' } }),
    doc({ file: 'good.md', frontmatter: { ticket: 'RAI-2', status: 'backlog' } }),
  ]);
  assert.deepEqual(tickets(set), ['RAI-2']);
  assert.deepEqual(codes(set), ['no-ticket']);
});

test('a file with no frontmatter is listed as skipped, so it is not silently absent', () => {
  const set = collectSpecs([doc({ file: 'notes.md', frontmatter: null })]);
  assert.deepEqual(set.skipped, ['notes.md']);
});

test('depending on itself is reported as a ring of one', () => {
  const set = collectSpecs([
    doc({ file: 'a.md', frontmatter: { ticket: 'RAI-1', status: 'backlog', depends: 'RAI-1' } }),
  ]);
  assert.deepEqual(codes(set), ['depends-cycle']);
  assert.ok(set.faults[0].message.includes('depends on itself'));
});

test('a ring of three is a fault, because nothing in it can ever become ready', () => {
  const set = collectSpecs([
    doc({ file: 'a.md', frontmatter: { ticket: 'RAI-1', status: 'backlog', depends: 'RAI-2' } }),
    doc({ file: 'b.md', frontmatter: { ticket: 'RAI-2', status: 'backlog', depends: 'RAI-3' } }),
    doc({ file: 'c.md', frontmatter: { ticket: 'RAI-3', status: 'backlog', depends: 'RAI-1' } }),
  ]);
  assert.deepEqual(codes(set), ['depends-cycle']);
});

test('a ring is reported once however many of its members it is reached from', () => {
  const rings = findDependencyCycles(
    collectSpecs([
      doc({ file: 'a.md', frontmatter: { ticket: 'RAI-1', status: 'backlog', depends: 'RAI-2' } }),
      doc({ file: 'b.md', frontmatter: { ticket: 'RAI-2', status: 'backlog', depends: 'RAI-1' } }),
    ]).byTicket,
  );
  assert.equal(rings.length, 1);
  assert.deepEqual(rings[0], ['RAI-1', 'RAI-2']);
});

test('a diamond of dependencies is not a ring', () => {
  const set = collectSpecs([
    doc({ file: 'a.md', frontmatter: { ticket: 'RAI-1', status: 'backlog', depends: 'RAI-2, RAI-3' } }),
    doc({ file: 'b.md', frontmatter: { ticket: 'RAI-2', status: 'backlog', depends: 'RAI-4' } }),
    doc({ file: 'c.md', frontmatter: { ticket: 'RAI-3', status: 'backlog', depends: 'RAI-4' } }),
    doc({ file: 'd.md', frontmatter: { ticket: 'RAI-4', status: 'shipped' } }),
  ]);
  assert.deepEqual(codes(set), []);
});

test('RAI-2 orders before RAI-10, which string order would get backwards', () => {
  assert.ok(ticketNumber('RAI-2') < ticketNumber('RAI-10'));
});

test('a key with no number sorts to the front rather than throwing', () => {
  assert.equal(ticketNumber('banana'), 0);
});

test('reading a directory takes only the markdown files, in filename order', () => {
  const files = fakeFiles({
    '/docs/tasks': {
      'b.md': '---\nticket: RAI-2\nstatus: backlog\n---\n# RAI-2 - Second\n',
      'a.md': '---\nticket: RAI-1\nstatus: backlog\n---\n# RAI-1 - First\n',
      'notes.txt': 'ignored',
    },
  });
  const set = readSpecs('/docs/tasks', files);
  assert.deepEqual(tickets(set), ['RAI-1', 'RAI-2']);
});

test('a subdirectory of docs/tasks is not read as a spec', () => {
  const files = fakeFiles({ '/docs/tasks': { 'archive.md': null } });
  assert.deepEqual(codes(readSpecs('/docs/tasks', files)), []);
});

test('a spec file that cannot be read is a fault rather than an exception', () => {
  // One unreadable spec must not take the board down, for the same reason a
  // malformed one does not.
  const files = fakeFiles(
    {
      '/docs/tasks': {
        'a.md': 'unreachable',
        'b.md': '---\nticket: RAI-2\nstatus: backlog\n---\n# RAI-2 - Fine\n',
      },
    },
    new Set(['a.md']),
  );
  const set = readSpecs('/docs/tasks', files);
  assert.deepEqual(codes(set), ['unreadable']);
  assert.deepEqual(tickets(set), ['RAI-2']);
});

test('a docs/tasks that is not there at all is a fault naming the directory', () => {
  const set = readSpecs('/nowhere', fakeFiles());
  assert.deepEqual(codes(set), ['unreadable']);
  assert.ok(set.faults[0].message.includes('/nowhere'));
});

test('a spec keyed by its GitHub issue number is a work item', () => {
  const { spec } = parseSpec('23-roadmap-tooling.md', [
    '---',
    'issue: 23',
    'status: shipped',
    'size: M',
    'depends: -',
    '---',
    '# 23 - Roadmap tooling',
  ].join('\n'));
  assert.equal(spec.ticket, '23');
  assert.equal(spec.status, 'shipped');
  // The heading repeats the key, and the board column does not need it twice.
  assert.equal(spec.title, 'Roadmap tooling');
});

test('a legacy Jira key still parses, because 21 shipped specs carry one', () => {
  const { spec } = parseSpec('RAI-14-roadmap-tooling.md', [
    '---',
    'ticket: RAI-14',
    'status: shipped',
    '---',
    '# RAI-14 - Roadmap tooling',
  ].join('\n'));
  assert.equal(spec.ticket, 'RAI-14');
  assert.equal(spec.title, 'Roadmap tooling');
});

test('a spec carrying both keys is a fault, because an item has one identity', () => {
  // Nothing downstream could say which of them a branch or a dependency meant.
  const { spec, fault } = parseSpec('23-x.md', [
    '---',
    'issue: 23',
    'ticket: RAI-14',
    'status: shipped',
    '---',
  ].join('\n'));
  assert.equal(spec, null);
  assert.equal(fault.code, 'two-keys');
});

test('an issue key that is not a number is refused rather than taken literally', () => {
  const { fault } = parseSpec('x.md', ['---', 'issue: RAI-14', 'status: shipped', '---'].join('\n'));
  assert.equal(fault.code, 'no-ticket');
});

test('an issue key and a Jira key of the same number are different items', () => {
  // This is what lets both namespaces live in one directory: RAI-12 and 12 are
  // distinct strings and cannot collide in the index.
  assert.equal(isIssueKey('12'), true);
  assert.equal(isIssueKey('RAI-12'), false);
  assert.notEqual('12', 'RAI-12');
});

test('a bare issue number orders numerically, as a Jira key does', () => {
  assert.ok(ticketNumber('2') < ticketNumber('10'));
});

test('the two namespaces sort apart rather than interleaving', () => {
  // Sorting on the number alone would put issue 12 next to RAI-12, which reads
  // as one sequence when it is two unrelated ones.
  const keys = ['23', 'RAI-14', '9', 'RAI-2'].sort(compareTickets);
  assert.deepEqual(keys, ['RAI-2', 'RAI-14', '9', '23']);
});
