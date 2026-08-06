/**
 * The CI gate, and deliberately a different question from `validate`.
 *
 * Before a pull request merges, the spec for **this branch's ticket** must say
 * `shipped` - because merging is what transitions the ticket to Done, and the
 * spec is the only copy of that fact a session can read without a network call.
 * Without this, `main` lands carrying a ticket marked Done and a file claiming
 * the work never started. The `roadmap-workflow` skill names it as the one
 * convention with no guard; this is the guard.
 *
 * Disk-only on purpose. The branch name is the input and the spec file is the
 * answer, so it cannot fail because a token expired or Jira was slow.
 *
 * The branch arrives as a string rather than being read here, so the whole gate
 * is asserted without a repository, a subprocess or an environment variable.
 */

import { ANSI, painter } from './task-format.js';

/** @typedef {import('./task-specs.js').Spec} Spec */
/** @typedef {import('./task-specs.js').Fault} Fault */

/** @typedef {'ok'|'no-branch'|'no-key'|'no-spec'|'not-shipped'} GateOutcome */

/**
 * @typedef {object} GateResult
 * @property {GateOutcome} outcome
 * @property {string|null} branch
 * @property {string|null} ticket
 * @property {Spec|null} spec
 * @property {number} exitCode 0 for `ok`, 1 for everything else
 */

/**
 * The ticket key, which must start the branch name **or a path segment of it**.
 * `RAI-14-roadmap-tooling` and `fix/RAI-14-roadmap-tooling` both name RAI-14.
 *
 * The original carries a real contradiction here, and it is worth recording
 * which way it was resolved. Its regex allows the prefix while its own failure
 * message, three lines below, says a prefixed branch transitions nothing
 * because the Jira automation is anchored on the key. Both cannot be right. The
 * **regex** is what this repository adopted: a prefix is a normal way to name a
 * branch, and refusing one buys nothing here.
 *
 * What is still refused is a key buried mid-segment - `wip-RAI-14-tooling` -
 * because at that point the key is no longer naming the branch, it is a
 * substring inside a word.
 *
 * A bare `RAI-14` with no short name is accepted, so that branch gets the
 * honest "no spec" or "not shipped" answer rather than being told it carries no
 * key at all.
 */
export const BRANCH_KEY_PATTERN = /(?:^|\/)([A-Z][A-Z0-9]+-\d+)(?:-|$)/;

/**
 * @param {string|null} branch
 * @returns {string|null}
 */
export function ticketFromBranch(branch) {
  const match = BRANCH_KEY_PATTERN.exec(String(branch || ''));
  return match ? match[1] : null;
}

/**
 * Does this branch's spec say shipped?
 *
 * @param {string|null} branch
 * @param {Map<string, Spec>} byTicket
 * @returns {GateResult}
 */
export function gateBranch(branch, byTicket) {
  /** @type {GateResult} */
  const base = { outcome: 'ok', branch: branch || null, ticket: null, spec: null, exitCode: 1 };

  if (!branch) return { ...base, outcome: 'no-branch' };

  const ticket = ticketFromBranch(branch);
  if (!ticket) return { ...base, outcome: 'no-key' };

  const spec = byTicket.get(ticket) ?? null;
  if (!spec) return { ...base, outcome: 'no-spec', ticket };

  // `wont-do` is not shipped. An item abandoned on a branch that is being
  // merged is a contradiction worth stopping on rather than waving through.
  if (spec.status !== 'shipped') return { ...base, outcome: 'not-shipped', ticket, spec };

  return { ...base, outcome: 'ok', ticket, spec, exitCode: 0 };
}

/**
 * @param {GateResult} result
 * @param {{colour?: boolean, today?: string}} [options] `today` is `YYYY-MM-DD`
 *   and is injected because the failure quotes the `shipped:` line to add.
 * @returns {{out: string[], err: string[]}}
 */
export function renderGate(result, { colour = false, today = '' } = {}) {
  const paint = painter(colour);
  const label = paint(ANSI.bold, 'gate');

  if (result.outcome === 'ok') {
    return {
      out: [
        '',
        `${label} - ${paint(ANSI.green, `${result.ticket} is marked shipped in ${result.spec?.file}`)}`,
        '',
      ],
      err: [],
    };
  }

  /** @type {string[]} */
  const err = [''];

  if (result.outcome === 'no-branch') {
    err.push(`${label} - ${paint(ANSI.red, 'could not read a branch name.')}`);
    err.push('');
    err.push('  Set BITBUCKET_BRANCH, or run this inside a checkout that is on a');
    err.push('  branch. A detached HEAD has no ticket to check.');
  } else if (result.outcome === 'no-key') {
    err.push(`${label} - ${paint(ANSI.red, `branch "${result.branch}" carries no ticket key.`)}`);
    err.push('');
    err.push('  Branches are named <KEY>-<short-name>, and the key must start the');
    err.push('  branch name or a path segment of it - RAI-14-roadmap-tooling and');
    err.push('  fix/RAI-14-roadmap-tooling both work. A key buried inside a segment,');
    err.push('  like wip-RAI-14-roadmap-tooling, does not: at that point it is a');
    err.push('  substring rather than the name of the branch.');
    err.push('');
    err.push('  Without a key no commit links to the ticket, and this has nothing');
    err.push('  to check.');
  } else if (result.outcome === 'no-spec') {
    err.push(`${label} - ${paint(ANSI.red, `no spec in docs/tasks/ has "ticket: ${result.ticket}".`)}`);
    err.push('');
    err.push('  Every item needs one, and no branch may exist without it. Create');
    err.push(`  docs/tasks/${result.ticket}-<short-name>.md.`);
  } else {
    err.push(`${label} - ${paint(ANSI.red, `${result.ticket} is "${result.spec?.status}" in ${result.spec?.file}.`)}`);
    err.push('');
    err.push('  Merging this pull request transitions the ticket to Done, so the spec');
    err.push('  has to say shipped before it lands - otherwise main claims the work');
    err.push('  never started.');
    err.push('');
    err.push(`  Set in docs/tasks/${result.spec?.file}:`);
    err.push('');
    err.push(paint(ANSI.dim, '    status: shipped'));
    if (today) err.push(paint(ANSI.dim, `    shipped: ${today}`));
  }

  err.push('');
  return { out: [], err };
}

/**
 * Structural problems, reported by the gate as well as by the board.
 *
 * The gate and the link check are the only roadmap commands that run on a pull
 * request, so a malformed spec would otherwise reach `main` unremarked - and a
 * duplicate ticket key is worse than unremarked here, because it decides which
 * of two files the gate reads.
 *
 * @param {Fault[]} faults
 * @param {{colour?: boolean}} [options]
 * @returns {{out: string[], err: string[]}}
 */
export function renderGateFaults(faults, { colour = false } = {}) {
  if (faults.length === 0) return { out: [], err: [] };
  const paint = painter(colour);
  const plural = faults.length === 1 ? 'problem' : 'problems';
  return {
    out: [],
    err: [
      `${faults.length} ${plural} in docs/tasks/:`,
      ...faults.map((problem) => paint(ANSI.red, `  ! ${problem.message}`)),
      '',
    ],
  };
}
