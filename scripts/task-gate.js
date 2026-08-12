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

/** @typedef {'ok'|'untracked'|'no-branch'|'no-spec'|'not-shipped'} GateOutcome */

/**
 * @typedef {object} GateResult
 * @property {GateOutcome} outcome
 * @property {string|null} branch
 * @property {string|null} ticket
 * @property {Spec|null} spec
 * @property {number} exitCode 0 for `ok` and for `untracked` - the two passes -
 *   and 1 for every failure
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
 * here - and the branch is untracked, which passes. See `gateBranch` for why no
 * attempt is made to tell that apart from an ordinary name.
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
  // slip past, and so does `wip-23-tooling`, whose key is right there in the
  // name. That gap is known and is the price of the pass above.
  //
  // **Do not rebuild misplaced-key detection. It was tried twice and both
  // mechanisms were removed.**
  //
  // The first matched the *shape* of a key with the anchors relaxed, and could
  // not be made to cover the separators without covering ordinary names too:
  // `23_stale_page_code`, `23/stale-page-code`, `RAI-14_tooling` and `RAI-14x`
  // escaped it, while `release-2026-08-12`, `bump-node-24` and
  // `fix/readme-node-22` tripped it. The two sets are the same shape - a number
  // at a token boundary - so no arrangement of separators separates them.
  //
  // The second asked this very `byTicket` whether the number named a real item,
  // which is precise about the set and wrong about everything else. It failed
  // `release/v1.2.3`, `fix/oauth2-callback`, `fix/http-2-notes` and `3d-render`
  // on the bare items this repo already has, and the surface *grows*: every new
  // issue number turns another class of ordinary name into a failure. Worse, a
  // legacy key collides with the bare issue sharing its number - `wip-RAI-7-x`
  // was reported as issue 7 - so the failure named the wrong item and its
  // rename advice routed the branch to a different item's spec. `7-...` is
  // shipped, so following the gate's own instruction turned it green while
  // RAI-7's spec still said in-progress: the one thing this gate exists to
  // prevent, reached through its own guidance.
  //
  // The conclusion both attempts reach is that a misnamed branch is not
  // something this can reliably tell from an ordinary one. The gate protects
  // against *forgetting* to mark an item shipped, which needs a correctly named
  // branch anyway, and a misnamed branch still goes through review.
  const ticket = ticketFromBranch(branch);
  if (!ticket) return { ...base, outcome: 'untracked', exitCode: 0 };

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
  } else if (result.outcome === 'no-spec') {
    err.push(`${label} - ${paint(ANSI.red, `no spec in docs/tasks/ has "issue: ${result.ticket}".`)}`);
    err.push('');
    err.push('  Every tracked item needs one, and this branch names one. Create');
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
