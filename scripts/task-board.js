/**
 * The board: what is ready, what is blocked, and what has already happened.
 *
 * Two rules are worth stating before the code, because both were arrived at by
 * getting them wrong somewhere else.
 *
 * **The board says nothing about priority.** Jira owns the ordering and the
 * repository must not start encoding one; the skill is explicit that the board
 * *is* the roadmap. So sections are the row's state and rows within a section
 * are ordered by ticket number, which is arbitrary rather than ranked. The
 * original grouped by a `phase` field this repository's frontmatter does not
 * have, and sorted by a `legacy-id` it does not have either - ported literally,
 * every row lands in one `?` group in whatever order the directory listed.
 *
 * **A blocker records why it blocks.** A dependency that is `wont-do`, or that
 * no spec claims, can never clear on its own; reporting it as a bare key makes
 * an item that needs a human decision look exactly like one that is merely
 * waiting its turn. That is this repository's recurring failure mode in
 * miniature - a confident line you eventually stop believing.
 *
 * `buildBoard` returns rows and `renderBoard` turns them into lines, because
 * the READY rule is the one thing here that can be wrong and asserting it
 * through rendered text means asserting through padding, truncation and escape
 * codes at the same time.
 */

import { ANSI, cell, pad, painter } from './task-format.js';
import { ticketNumber } from './task-specs.js';

/** @typedef {import('./task-specs.js').Spec} Spec */
/** @typedef {import('./task-specs.js').Fault} Fault */
/** @typedef {import('./task-specs.js').SpecSet} SpecSet */

/** @typedef {'ready'|'blocked'|'in-progress'|'shipped'|'wont-do'} RowState */

/**
 * `pending` clears when the dependency ships. `abandoned` and `unknown` never
 * do without somebody editing a `depends:` line.
 *
 * @typedef {object} Blocker
 * @property {string} ticket
 * @property {'pending'|'abandoned'|'unknown'} reason
 */

/**
 * @typedef {object} BoardRow
 * @property {string} ticket
 * @property {string} title
 * @property {string} size
 * @property {string} file
 * @property {RowState} state
 * @property {Blocker[]} blockers empty unless `state` is `blocked`
 * @property {string|null} branch
 * @property {string|null} shipped
 */

/**
 * @typedef {object} BoardCounts
 * @property {number} total
 * @property {number} ready
 * @property {number} backlog ready plus blocked
 * @property {number} inProgress
 * @property {number} shipped
 * @property {number} wontDo
 */

/**
 * @typedef {object} Board
 * @property {BoardRow[]} rows
 * @property {{state: RowState, rows: BoardRow[]}[]} sections empty ones omitted
 * @property {BoardCounts} counts
 * @property {string[]} skipped
 * @property {Fault[]} faults
 * @property {number} exitCode
 */

/** Reading order: what is moving, what could move, what cannot, what is over. */
export const SECTION_ORDER = Object.freeze(
  /** @type {RowState[]} */ (['in-progress', 'ready', 'blocked', 'shipped', 'wont-do']),
);

/** @type {Record<RowState, string>} */
const SECTION_LABELS = {
  'in-progress': 'In progress',
  ready: 'Ready',
  blocked: 'Blocked',
  shipped: 'Shipped',
  'wont-do': "Won't do",
};

/** @type {Record<Blocker['reason'], string>} */
const BLOCKER_NOTES = {
  pending: '',
  abandoned: " (won't do)",
  unknown: ' (no spec)',
};

export const TICKET_WIDTH = 8;
export const SIZE_WIDTH = 2;
/**
 * Chosen against the real titles rather than as a round number. At 52, *"Two
 * sessions on one branch both claim the same pipeline"* lost the clause naming
 * the bug; 58 fits it and every other title in `docs/tasks/` bar one.
 *
 * The exception is deliberate. One title runs to 67 characters, and widening
 * for it would cost nine columns on every row of the board forever to save a
 * single line from an ellipsis. The widest row here is around 110 columns,
 * which is past 80 and comfortable anywhere this is actually read.
 */
export const TITLE_WIDTH = 58;

/** Where the ordering actually lives, printed under every board. */
export const BOARD_URL =
  'https://mattwwatson.atlassian.net/jira/software/c/projects/RAI/boards/6';

/**
 * What stands between a spec and being ready.
 *
 * @param {Spec} spec
 * @param {Map<string, Spec>} byTicket
 * @returns {Blocker[]}
 */
export function blockersFor(spec, byTicket) {
  /** @type {Blocker[]} */
  const blockers = [];
  for (const ticket of spec.depends) {
    const dependency = byTicket.get(ticket);
    if (!dependency) blockers.push({ ticket, reason: 'unknown' });
    else if (dependency.status === 'wont-do') blockers.push({ ticket, reason: 'abandoned' });
    else if (dependency.status !== 'shipped') blockers.push({ ticket, reason: 'pending' });
  }
  return blockers;
}

/**
 * The rows, their sections and the counts. Never reads anything.
 *
 * @param {SpecSet} specs
 * @returns {Board}
 */
export function buildBoard(specs) {
  /** @type {BoardRow[]} */
  const rows = [];
  for (const spec of specs.byTicket.values()) {
    const blockers = blockersFor(spec, specs.byTicket);
    /** @type {RowState} */
    let state;
    if (spec.status === 'shipped') state = 'shipped';
    else if (spec.status === 'wont-do') state = 'wont-do';
    else if (spec.status === 'in-progress') state = 'in-progress';
    else state = blockers.length > 0 ? 'blocked' : 'ready';

    rows.push({
      ticket: spec.ticket,
      title: spec.title,
      size: spec.size,
      file: spec.file,
      state,
      blockers: state === 'blocked' ? blockers : [],
      branch: spec.branch,
      shipped: spec.shipped,
    });
  }

  rows.sort((a, b) => ticketNumber(a.ticket) - ticketNumber(b.ticket));

  const of = (/** @type {RowState} */ state) => rows.filter((row) => row.state === state);
  const sections = SECTION_ORDER.map((state) => ({ state, rows: of(state) })).filter(
    (section) => section.rows.length > 0,
  );

  return {
    rows,
    sections,
    counts: {
      total: rows.length,
      ready: of('ready').length,
      backlog: of('ready').length + of('blocked').length,
      inProgress: of('in-progress').length,
      shipped: of('shipped').length,
      wontDo: of('wont-do').length,
    },
    skipped: specs.skipped,
    faults: specs.faults,
    exitCode: specs.faults.length > 0 ? 1 : 0,
  };
}

/**
 * The state column for one row, already coloured.
 *
 * @param {BoardRow} row
 * @param {(code: string, text: string) => string} paint
 * @returns {string}
 */
function stateColumn(row, paint) {
  if (row.state === 'shipped') {
    return paint(ANSI.green, `shipped${row.shipped ? ` ${row.shipped}` : ''}`);
  }
  if (row.state === 'wont-do') return paint(ANSI.dim, "won't do");
  if (row.state === 'in-progress') {
    const branch = row.branch ? ` ${paint(ANSI.dim, row.branch)}` : '';
    return `${paint(ANSI.yellow, 'in progress')}${branch}`;
  }
  if (row.state === 'ready') return paint(ANSI.ready, 'READY');
  const blockers = row.blockers
    .map((blocker) => `${blocker.ticket}${BLOCKER_NOTES[blocker.reason]}`)
    .join(', ');
  return paint(ANSI.dim, `blocked by ${blockers}`);
}

/**
 * The board as lines. `err` carries the faults, so a broken spec is loud
 * without taking the good ones off the page.
 *
 * @param {Board} board
 * @param {{colour?: boolean}} [options]
 * @returns {{out: string[], err: string[]}}
 */
export function renderBoard(board, { colour = false } = {}) {
  const paint = painter(colour);
  /** @type {string[]} */
  const out = [];

  out.push('');
  out.push(
    `${paint(ANSI.bold, 'roadmap')} ` +
      paint(ANSI.dim, '- status from docs/tasks/, ordering lives in Jira'),
  );
  out.push('');

  for (const section of board.sections) {
    out.push(`  ${paint(ANSI.bold, SECTION_LABELS[section.state])}`);
    for (const row of section.rows) {
      out.push(
        `    ${paint(ANSI.cyan, cell(row.ticket, TICKET_WIDTH))} ` +
          `${pad(row.size, SIZE_WIDTH)} ${cell(row.title, TITLE_WIDTH)} ${stateColumn(row, paint)}`,
      );
    }
    out.push('');
  }

  const { counts } = board;
  out.push(
    `  ${counts.total} items: ${counts.shipped} shipped, ${counts.inProgress} in progress, ` +
      `${counts.backlog} backlog (${counts.ready} ready)`,
  );
  if (board.skipped.length > 0) {
    out.push(paint(ANSI.dim, `  no frontmatter, so not work items: ${board.skipped.join(', ')}`));
  }
  out.push('');
  out.push(
    paint(
      ANSI.dim,
      '  READY means every dependency has shipped. Priority order, epics and\n' +
        `  explicitly-set blockers live on the board, and a Jira blocker wins:\n  ${BOARD_URL}`,
    ),
  );
  out.push('');

  /** @type {string[]} */
  const err = [];
  if (board.faults.length > 0) {
    err.push(`${board.faults.length} problem(s) in docs/tasks/:`);
    for (const problem of board.faults) err.push(paint(ANSI.red, `  ! ${problem.message}`));
    err.push('');
  }

  return { out, err };
}
