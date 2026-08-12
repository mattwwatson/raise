/**
 * The CI gate, and deliberately a different question from `validate`.
 *
 * Before a pull request merges, the spec for **this branch's item** must say
 * `shipped` - because merging is what closes the issue, and the spec is the only
 * copy of that fact a session can read without a network call. Without this,
 * `main` lands carrying a closed issue and a file claiming the work never
 * started. The `roadmap-workflow` skill names it as the one convention with no
 * guard; this is the guard.
 *
 * Disk-only on purpose. The branch name is the input and the spec file is the
 * answer, so it cannot fail because a token expired or the tracker was slow.
 *
 * The branch arrives as a string rather than being read here, so the whole gate
 * is asserted without a repository, a subprocess or an environment variable.
 */

import { ANSI, painter } from './task-format.js';

/** @typedef {import('./task-specs.js').Spec} Spec */
/** @typedef {import('./task-specs.js').Fault} Fault */

/** @typedef {'ok'|'untracked'|'no-branch'|'no-key'|'no-spec'|'not-shipped'} GateOutcome */

/**
 * @typedef {object} GateResult
 * @property {GateOutcome} outcome
 * @property {string|null} branch
 * @property {string|null} ticket
 * @property {Spec|null} spec
 * @property {number} exitCode 0 for `ok`, 1 for everything else
 */

/**
 * The item's key, which must start the branch name **or a path segment of it**.
 * `23-roadmap-tooling` and `fix/23-roadmap-tooling` both name issue 23, as
 * `RAI-14-roadmap-tooling` names the legacy Jira item RAI-14.
 *
 * **This is a convention, not a constraint, and that is the whole reason it is
 * checked here.** GitHub links a branch to an issue from the pull request rather
 * than from the branch name, so nothing upstream will ever complain about
 * `wip-23-tooling`. Jira, before it, found the key anywhere in the name and was
 * equally content.
 *
 * What we want is a branch list that can be scanned by key, so the key starts
 * the branch name or a path element of it. A key buried mid-segment has stopped
 * naming the branch and become a substring inside a word, so it names no ticket
 * here - and `MISPLACED_KEY_PATTERN` below is what stops that being mistaken for
 * a branch carrying no key at all, which is a pass.
 *
 * **The bare-number alternative is anchored, and has to be.** A legacy key is
 * self-announcing - `RAI-14` cannot be mistaken for anything else - but a plain
 * number is not, and without `(?:^|\/)` in front and `(?:-|$)` behind, the `2`
 * in `feat/v2-rewrite` would read as issue 2 and the gate would go looking for
 * its spec. Both alternatives share those anchors for that reason.
 *
 * A bare `23` with no short name is accepted, so that branch gets the honest "no
 * spec" or "not shipped" answer rather than passing as one that ships nothing
 * tracked.
 */
export const BRANCH_KEY_PATTERN = /(?:^|\/)([A-Z][A-Z0-9]+-\d+|\d+)(?:-|$)/;

/**
 * A key-shaped token sitting where the convention does not put one.
 *
 * The gate has two ways to find no ticket in a branch name and they mean
 * opposite things. `fix/some-typo` carries no key **anywhere**, so it ships no
 * tracked item and passes. `wip-23-tooling` carries one and has misplaced it -
 * the key is right there in the name, so forgetting cannot be the explanation,
 * and passing it would be the gate waving through precisely the case it exists
 * to catch. Telling the two apart is the whole job of this pattern.
 *
 * It is the same two shapes as `BRANCH_KEY_PATTERN` with the leading anchor
 * traded for a weaker one, and both halves of that matter:
 *
 * - the legacy shape needs no anchor at all, being self-announcing, and drops
 *   the case requirement so `rai-14-roadmap-tooling` is read as the misnamed
 *   branch it is rather than as an untracked change.
 * - a bare number keeps a **token** boundary in front of it - a hyphen - so
 *   `-23-` in `wip-23-tooling` is a misplaced key while the `2` in
 *   `feat/v2-rewrite` is a character inside a word, exactly as
 *   `BRANCH_KEY_PATTERN` already refuses to read it as issue 2. Dropping that
 *   boundary would fail every branch whose name happens to contain a digit.
 *
 * The residue is a branch like `release-2026-08-12`, which is shaped like a
 * misplaced key and cannot be told from one. It fails, which is what it did
 * before any of this, and the failure names the convention it should follow.
 */
export const MISPLACED_KEY_PATTERN = /(?:[A-Za-z][A-Za-z0-9]*)?-\d+(?:-|$)/;

/**
 * @param {string|null} branch
 * @returns {string|null}
 */
export function ticketFromBranch(branch) {
  const match = BRANCH_KEY_PATTERN.exec(String(branch || ''));
  return match ? match[1] : null;
}

/**
 * Does this branch carry a key-shaped token that `ticketFromBranch` refused?
 *
 * @param {string|null} branch
 * @returns {boolean}
 */
export function hasMisplacedKey(branch) {
  return MISPLACED_KEY_PATTERN.test(String(branch || ''));
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

  // A branch carrying no issue number is not shipping a tracked item, so there
  // is nothing here to assert. This used to fail, and failing it was the gate
  // answering a question it had not been asked: the rule is *the pull request
  // that ships an item marks that item shipped*, which is a statement about
  // items. With `tasks:gate` inside a required check, that made a one-line
  // correction to a spec cost an issue, a spec of its own, a branch named after
  // it and a full pipeline run - ceremony larger than the change, whose
  // predictable result is that small true corrections stop being made.
  //
  // The trade is accepted and is not a hole being overlooked: somebody could
  // name a branch `fix/whatever` while genuinely shipping a tracked item and
  // slip past. The gate has never been able to tell deliberate evasion from an
  // untracked change. What it protects against is *forgetting*, and forgetting
  // leaves the key in the branch name - which is why a misplaced key is a
  // different answer from no key, and still fails.
  const ticket = ticketFromBranch(branch);
  if (!ticket) {
    if (hasMisplacedKey(branch)) return { ...base, outcome: 'no-key' };
    return { ...base, outcome: 'untracked', exitCode: 0 };
  }

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

  // Passing silently would be indistinguishable from passing because a spec
  // said shipped, and this page's whole habit is saying which. It goes to
  // stdout with the other pass, not to stderr with the failures.
  if (result.outcome === 'untracked') {
    return {
      out: [
        '',
        `${label} - ${paint(ANSI.green, `"${result.branch}" carries no issue number, so it ships no tracked item`)}`,
        `        ${paint(ANSI.dim, 'name a branch <issue>-<short-name> and its spec must say shipped')}`,
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
    err.push('  Set GITHUB_HEAD_REF, or run this inside a checkout that is on a');
    err.push('  branch. A detached HEAD has no ticket to check - which is what a');
    err.push('  pull-request build is, since it checks out the merge commit.');
  } else if (result.outcome === 'no-key') {
    err.push(`${label} - ${paint(ANSI.red, `branch "${result.branch}" carries an issue number, but not where the convention puts it.`)}`);
    err.push('');
    err.push('  Branches are named <ISSUE>-<short-name>, with the number starting');
    err.push('  the branch name or a path element of it - 23-roadmap-tooling and');
    err.push('  fix/23-roadmap-tooling both work.');
    err.push('');
    err.push('  GitHub links the branch from the pull request rather than from its');
    err.push('  name, so wip-23-tooling would upset nothing upstream. This is our');
    err.push('  convention, so that a branch list can be scanned by issue, and this');
    err.push('  check is what enforces it.');
    err.push('');
    err.push('  A branch carrying no issue number anywhere passes instead, because');
    err.push('  it ships no tracked item. This one has one, so it is a name to fix.');
  } else if (result.outcome === 'no-spec') {
    err.push(`${label} - ${paint(ANSI.red, `no spec in docs/tasks/ has "issue: ${result.ticket}".`)}`);
    err.push('');
    err.push('  Every item needs one, and no branch may exist without it. Create');
    err.push(`  docs/tasks/${result.ticket}-<short-name>.md.`);
  } else {
    err.push(`${label} - ${paint(ANSI.red, `${result.ticket} is "${result.spec?.status}" in ${result.spec?.file}.`)}`);
    err.push('');
    err.push('  Merging this pull request closes the issue, so the spec has to say');
    err.push('  shipped before it lands - otherwise main claims the work never');
    err.push('  started.');
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
