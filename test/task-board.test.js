import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  blockersFor,
  buildBoard,
  renderBoard,
  SECTION_ORDER,
  TITLE_WIDTH,
} from '../scripts/task-board.js';

const spec = (over = {}) => ({
  file: 'RAI-1-thing.md',
  ticket: 'RAI-1',
  title: 'A thing that needs doing',
  status: 'backlog',
  size: 'S',
  depends: [],
  branch: null,
  shipped: null,
  ...over,
});

/** A spec set of the shape `collectSpecs` returns, with no faults by default. */
const specs = (list, over = {}) => ({
  byTicket: new Map(list.map((one) => [one.ticket, one])),
  faults: [],
  skipped: [],
  ...over,
});

const rowFor = (board, ticket) => board.rows.find((row) => row.ticket === ticket);

test('an item whose every dependency has shipped is READY', () => {
  const board = buildBoard(
    specs([
      spec({ ticket: 'RAI-1', depends: ['RAI-2'] }),
      spec({ ticket: 'RAI-2', status: 'shipped', shipped: '2026-08-01' }),
    ]),
  );
  assert.equal(rowFor(board, 'RAI-1').state, 'ready');
});

test('an item with no dependencies at all is READY', () => {
  assert.equal(buildBoard(specs([spec()])).rows[0].state, 'ready');
});

test('an item waiting on a backlog dependency is blocked and names it', () => {
  const board = buildBoard(
    specs([spec({ ticket: 'RAI-1', depends: ['RAI-2'] }), spec({ ticket: 'RAI-2' })]),
  );
  const row = rowFor(board, 'RAI-1');
  assert.equal(row.state, 'blocked');
  assert.deepEqual(row.blockers, [{ ticket: 'RAI-2', reason: 'pending' }]);
});

test("a dependency that will not be done blocks the item, and says won't-do rather than leaving it looking late", () => {
  // 'pending' clears on its own when the dependency ships. This one never
  // will, and a row that cannot distinguish them is one you stop believing.
  const board = buildBoard(
    specs([
      spec({ ticket: 'RAI-1', depends: ['RAI-2'] }),
      spec({ ticket: 'RAI-2', status: 'wont-do' }),
    ]),
  );
  assert.deepEqual(rowFor(board, 'RAI-1').blockers, [{ ticket: 'RAI-2', reason: 'abandoned' }]);
});

test('a dependency no spec claims blocks the item rather than letting it read as READY', () => {
  const board = buildBoard(specs([spec({ ticket: 'RAI-1', depends: ['RAI-99'] })]));
  assert.equal(rowFor(board, 'RAI-1').state, 'blocked');
  assert.deepEqual(rowFor(board, 'RAI-1').blockers, [{ ticket: 'RAI-99', reason: 'unknown' }]);
});

test('an in-progress item is never READY, whatever its dependencies say', () => {
  const board = buildBoard(specs([spec({ status: 'in-progress', branch: 'RAI-1-thing' })]));
  assert.equal(board.rows[0].state, 'in-progress');
  assert.equal(board.counts.ready, 0);
});

test('an in-progress item carries the branch it is on', () => {
  const board = buildBoard(specs([spec({ status: 'in-progress', branch: 'RAI-1-thing' })]));
  const { out } = renderBoard(board);
  assert.ok(out.some((line) => line.includes('in progress') && line.includes('RAI-1-thing')));
});

test('a shipped item carries the date it shipped', () => {
  const board = buildBoard(specs([spec({ status: 'shipped', shipped: '2026-08-01' })]));
  const { out } = renderBoard(board);
  assert.ok(out.some((line) => line.includes('shipped 2026-08-01')));
});

test('sections appear in a fixed order and an empty section is omitted', () => {
  const board = buildBoard(
    specs([
      spec({ ticket: 'RAI-1', status: 'shipped' }),
      spec({ ticket: 'RAI-2', status: 'in-progress' }),
    ]),
  );
  assert.deepEqual(
    board.sections.map((section) => section.state),
    ['in-progress', 'shipped'],
  );
  assert.ok(SECTION_ORDER.indexOf('in-progress') < SECTION_ORDER.indexOf('shipped'));
});

test('rows within a section are ordered by ticket number, so RAI-2 comes before RAI-10', () => {
  const board = buildBoard(specs([spec({ ticket: 'RAI-10' }), spec({ ticket: 'RAI-2' })]));
  assert.deepEqual(
    board.sections[0].rows.map((row) => row.ticket),
    ['RAI-2', 'RAI-10'],
  );
});

test('the counts add up to the number of specs', () => {
  const board = buildBoard(
    specs([
      spec({ ticket: 'RAI-1' }),
      spec({ ticket: 'RAI-2', depends: ['RAI-9'] }),
      spec({ ticket: 'RAI-3', status: 'in-progress' }),
      spec({ ticket: 'RAI-4', status: 'shipped' }),
      spec({ ticket: 'RAI-5', status: 'wont-do' }),
    ]),
  );
  const { counts } = board;
  assert.equal(counts.total, 5);
  assert.equal(counts.backlog + counts.inProgress + counts.shipped + counts.wontDo, counts.total);
});

test('the ready count counts only backlog items with nothing outstanding', () => {
  const board = buildBoard(
    specs([spec({ ticket: 'RAI-1' }), spec({ ticket: 'RAI-2', depends: ['RAI-9'] })]),
  );
  assert.equal(board.counts.ready, 1);
  assert.equal(board.counts.backlog, 2);
});

test('the board exits 1 when any spec is faulty and 0 when none is', () => {
  assert.equal(buildBoard(specs([spec()])).exitCode, 0);
  const faulty = specs([spec()], {
    faults: [{ code: 'no-ticket', file: 'x.md', ticket: null, message: 'x.md: no "ticket:"' }],
  });
  assert.equal(buildBoard(faulty).exitCode, 1);
});

test('a fault is written to stderr while the board itself stays on stdout', () => {
  const board = buildBoard(
    specs([spec()], {
      faults: [{ code: 'no-ticket', file: 'x.md', ticket: null, message: 'x.md: no "ticket:"' }],
    }),
  );
  const { out, err } = renderBoard(board);
  assert.ok(err.some((line) => line.includes('x.md')));
  assert.ok(out.some((line) => line.includes('RAI-1')));
});

test('a file with no frontmatter is named, so it is not silently absent from the board', () => {
  const board = buildBoard(specs([spec()], { skipped: ['notes.md'] }));
  const { out } = renderBoard(board);
  assert.ok(out.some((line) => line.includes('notes.md')));
});

test('the renderer writes no escape codes when colour is off', () => {
  const board = buildBoard(specs([spec({ status: 'shipped', shipped: '2026-08-01' })]));
  const { out, err } = renderBoard(board, { colour: false });
  for (const line of [...out, ...err]) assert.ok(!line.includes('\x1b['), line);
});

test('the renderer colours when asked, so the flag is doing something', () => {
  const board = buildBoard(specs([spec()]));
  const { out } = renderBoard(board, { colour: true });
  assert.ok(out.some((line) => line.includes('\x1b[')));
});

test('a long title is truncated with a mark rather than breaking the column', () => {
  const board = buildBoard(specs([spec({ title: 'x'.repeat(TITLE_WIDTH + 20) })]));
  const { out } = renderBoard(board);
  const row = out.find((line) => line.includes('RAI-1'));
  assert.ok(row.includes('…'));
  assert.ok(!row.includes('x'.repeat(TITLE_WIDTH + 1)));
});

test('blockersFor reports nothing when every dependency has shipped', () => {
  const byTicket = new Map([['RAI-2', spec({ ticket: 'RAI-2', status: 'shipped' })]]);
  assert.deepEqual(blockersFor(spec({ depends: ['RAI-2'] }), byTicket), []);
});
