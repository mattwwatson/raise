/**
 * `validate` - how the specs on disk and the GitHub issues differ.
 *
 * It replaced a Jira client when the project moved to GitHub under RAI-5, and
 * the shape survived the move: this is a **report, not a gate.** Disk and the
 * tracker differing is the normal state of a repository with work in flight,
 * because a checkout describes what is merged *here* while the tracker describes
 * where the workflow is. Divergence exits 0. Only a spec naming an issue that
 * does not exist is a fault.
 *
 * **GitHub knows less than Jira did, and that is a real reduction rather than a
 * porting detail.** Jira carried four workflow states, so `in-progress` on disk
 * could be checked against `In Progress` on the board. An issue is open or
 * closed and nothing else, so `backlog` and `in-progress` are indistinguishable
 * from here and are not compared. What remains checkable is the pair that
 * actually goes wrong: **a spec saying `shipped` while its issue is still open,
 * and an issue closed while its spec says the work never finished.** Those are
 * the two that leave `main` telling one story and the tracker another.
 *
 * Claiming more than that would be worse than checking less. A validator that
 * reported `backlog` against `in-progress` would have to guess which of them an
 * open issue meant, and be wrong about half the time.
 *
 * **The legacy Jira items are exempt, not faults.** The 21 specs keyed `RAI-12`
 * were tracked in a system that no longer exists and have no GitHub issue to be
 * reconciled against. Reported as missing they would be 21 permanent errors that
 * can never be cleared, which is how a check stops being read.
 *
 * **No credential lives here.** `gh` authenticates itself, which is the same
 * reason `src/forge.js` shells out to it rather than holding a GitHub token -
 * see the note in AGENTS.md about there deliberately being no GitHub token path.
 * That is also what makes this command runnable in CI at all, unlike the Jira
 * one it replaced, though nothing runs it there yet.
 */

import { ANSI, cell, painter } from './task-format.js';
import { compareTickets, isIssueKey } from './task-specs.js';

/** @typedef {import('./task-specs.js').Spec} Spec */
/** @typedef {import('./task-specs.js').Fault} Fault */
/** @typedef {import('./task-specs.js').TaskStatus} TaskStatus */

/**
 * One issue, reduced to what reconciliation actually reads.
 *
 * @typedef {object} Issue
 * @property {string} key the number as a string, so it compares against `Spec.ticket`
 * @property {string} title
 * @property {boolean} open
 * @property {boolean} notPlanned closed as "not planned" rather than completed
 */

/**
 * @typedef {object} FetchResult
 * @property {boolean} ok
 * @property {Issue[]} issues empty unless `ok`
 * @property {number} exitCode 0 when `ok`, otherwise 2
 * @property {string} reason empty when `ok`
 * @property {string[]} detail empty when `ok`
 */

/**
 * @typedef {object} ValidationReport
 * @property {{spec: Spec, issueState: string, expected: string}[]} diverged
 * @property {{key: string, title: string, open: boolean}[]} orphans
 * @property {number} exemptLegacy specs keyed `RAI-N`, with no issue to compare
 * @property {number} exemptUndecided open issues whose spec is `backlog` or `in-progress`
 * @property {Fault[]} faults
 * @property {number} specCount
 * @property {number} issueCount
 * @property {number} exitCode
 */

/** The repository whose issues are the board. */
export const REPO = 'mattwwatson/raise';

/**
 * High enough to be the whole backlog rather than a page of it.
 *
 * `gh` defaults to 30, which would silently make every issue past the thirtieth
 * look like a spec with no issue - the one thing here that *is* a fault. A cap
 * that turns absence into an error has to be well clear of the real count.
 */
export const ISSUE_LIMIT = 500;

/**
 * What a spec's status says its issue should be.
 *
 * `null` means "open or closed both make sense, do not compare" - see the note
 * at the top of this file. It is a value rather than an absence so that adding a
 * fifth status is a decision here rather than a silent skip.
 */
export const EXPECTED_STATE = Object.freeze({
  backlog: null,
  'in-progress': null,
  shipped: 'closed',
  'wont-do': 'closed',
});

/**
 * The `gh` invocation, as a command and arguments.
 *
 * Split out so a test can assert on it without running anything. `--state all`
 * because a closed issue is exactly what a `shipped` spec should be matched
 * against, and the default of open-only would report every finished item as
 * missing.
 *
 * @returns {{command: string, args: string[]}}
 */
export function issueListCommand() {
  return {
    command: 'gh',
    args: [
      'issue', 'list',
      '--repo', REPO,
      '--state', 'all',
      '--limit', String(ISSUE_LIMIT),
      '--json', 'number,title,state,stateReason',
    ],
  };
}

/**
 * `gh`'s JSON, reduced to `Issue[]`.
 *
 * Anything that is not an array of objects carrying a number is refused rather
 * than partially believed: this feeds a check whose one hard failure is "the
 * issue does not exist", so a half-parsed list would invent that failure.
 *
 * @param {string} text
 * @returns {Issue[]|null}
 */
export function issuesFromJson(text) {
  /** @type {unknown} */
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(payload)) return null;

  /** @type {Issue[]} */
  const issues = [];
  for (const row of payload) {
    if (!row || typeof row !== 'object') return null;
    const entry = /** @type {Record<string, unknown>} */ (row);
    if (typeof entry.number !== 'number') return null;
    const state = String(entry.state || '').toUpperCase();
    issues.push({
      key: String(entry.number),
      title: String(entry.title || ''),
      open: state === 'OPEN',
      notPlanned: String(entry.stateReason || '').toUpperCase() === 'NOT_PLANNED',
    });
  }
  return issues;
}

/**
 * Ask GitHub, through `gh`.
 *
 * @param {{run: (command: string, args: string[]) => {ok: boolean, stdout: string, stderr: string}}} deps
 * @returns {FetchResult}
 */
export function fetchIssues({ run }) {
  const { command, args } = issueListCommand();
  const result = run(command, args);

  if (!result.ok) {
    const stderr = String(result.stderr || '').trim();
    return {
      ok: false,
      issues: [],
      exitCode: 2,
      reason: `could not list issues for ${REPO}`,
      detail: [
        stderr || `${command} exited non-zero and said nothing.`,
        '',
        'This needs the GitHub CLI, authenticated: `gh auth status`.',
        'Nothing else here does, which is why only `validate` can fail this way.',
      ],
    };
  }

  const issues = issuesFromJson(result.stdout);
  if (!issues) {
    return {
      ok: false,
      issues: [],
      exitCode: 2,
      reason: `could not read what ${command} returned`,
      detail: [
        'Expected a JSON array of issues. A partial reading is refused rather',
        'than used, because a missing issue is the one thing this treats as an',
        'error and a truncated list would manufacture it.',
      ],
    };
  }

  return { ok: true, issues, exitCode: 0, reason: '', detail: [] };
}

/**
 * Specs against issues.
 *
 * @param {Map<string, Spec>} byTicket
 * @param {Issue[]} issues
 * @returns {ValidationReport}
 */
export function reconcile(byTicket, issues) {
  const byNumber = new Map(issues.map((issue) => [issue.key, issue]));

  /** @type {ValidationReport['diverged']} */
  const diverged = [];
  /** @type {Fault[]} */
  const faults = [];
  let exemptLegacy = 0;
  let exemptUndecided = 0;

  for (const spec of byTicket.values()) {
    // A legacy Jira key has no issue and never will. Not a gap.
    if (!isIssueKey(spec.ticket)) {
      exemptLegacy += 1;
      continue;
    }

    const issue = byNumber.get(spec.ticket);
    if (!issue) {
      faults.push({
        code: 'no-tracker-issue',
        file: spec.file,
        ticket: spec.ticket,
        message: `${spec.file}: issue ${spec.ticket} does not exist in ${REPO}`,
      });
      continue;
    }

    const expected = EXPECTED_STATE[spec.status];
    if (!expected) {
      exemptUndecided += 1;
      continue;
    }

    const actual = issue.open ? 'open' : 'closed';
    if (actual !== expected) diverged.push({ spec, issueState: actual, expected });
  }

  // Sorted rather than left in `gh`'s order, which is newest first - an
  // unsorted list reads backwards against the board printed above it.
  const orphans = issues
    .filter((issue) => !byTicket.has(issue.key))
    .map((issue) => ({ key: issue.key, title: issue.title, open: issue.open }))
    .sort((a, b) => compareTickets(a.key, b.key));

  return {
    diverged,
    orphans,
    exemptLegacy,
    exemptUndecided,
    faults,
    specCount: byTicket.size,
    issueCount: issues.length,
    exitCode: faults.length > 0 ? 1 : 0,
  };
}

const STATUS_WIDTH = 12;

/**
 * @param {ValidationReport} report
 * @param {{colour?: boolean}} [options]
 * @returns {{out: string[], err: string[]}}
 */
export function renderValidation(report, { colour = false } = {}) {
  const paint = painter(colour);
  /** @type {string[]} */
  const out = [];

  out.push(
    `${paint(ANSI.bold, 'validate')} - ` +
      `${report.specCount} specs against ${report.issueCount} issues in ${REPO}`,
  );
  out.push('');

  if (report.diverged.length > 0) {
    out.push(paint(ANSI.dim, '  The tracker and disk differ. Expected while work is in flight -'));
    out.push(paint(ANSI.dim, '  disk describes what is merged HERE, the issue describes the workflow.'));
    out.push('');
    for (const { spec, issueState } of report.diverged) {
      out.push(
        `  ${paint(ANSI.yellow, cell(spec.ticket, 8))} ` +
          `issue ${paint(ANSI.cyan, cell(issueState, STATUS_WIDTH))} ` +
          `disk ${paint(ANSI.yellow, cell(spec.status, STATUS_WIDTH))} ${paint(ANSI.dim, spec.file)}`,
      );
    }
    out.push('');
  } else {
    out.push(paint(ANSI.green, '  every item that can be compared matches'));
    out.push('');
  }

  if (report.exemptUndecided > 0) {
    const plural = report.exemptUndecided === 1 ? 'item is' : 'items are';
    out.push(paint(ANSI.dim, `  ${report.exemptUndecided} ${plural} backlog or in-progress, which an open`));
    out.push(paint(ANSI.dim, '  issue cannot tell apart. Not compared rather than guessed at.'));
    out.push('');
  }

  if (report.exemptLegacy > 0) {
    const plural = report.exemptLegacy === 1 ? 'spec' : 'specs';
    out.push(paint(ANSI.dim, `  ${report.exemptLegacy} ${plural} still keyed RAI-N, from before the move to`));
    out.push(paint(ANSI.dim, '  GitHub. Those have no issue and are not expected to.'));
    out.push('');
  }

  if (report.orphans.length > 0) {
    const keys = report.orphans
      .map((orphan) => (orphan.open ? orphan.key : `${orphan.key} (closed)`))
      .join(', ');
    const plural = report.orphans.length === 1 ? 'issue' : 'issues';
    out.push(paint(ANSI.dim, `  ${report.orphans.length} ${plural} with no spec file: ${keys}`));
    out.push(paint(ANSI.dim, '  Expected rather than a gap - an item captured but not yet picked'));
    out.push(paint(ANSI.dim, '  up correctly has no spec until somebody starts it.'));
    out.push('');
  }

  /** @type {string[]} */
  const err = [];
  for (const problem of report.faults) err.push(paint(ANSI.red, `  ! ${problem.message}`));
  if (report.faults.length > 0) err.push('');

  return { out, err };
}

/**
 * A failure to ask, which is not a failure of the repository.
 *
 * @param {{reason: string, detail: string[]}} failure
 * @param {{colour?: boolean}} [options]
 * @returns {{out: string[], err: string[]}}
 */
export function renderFetchFailure(failure, { colour = false } = {}) {
  const paint = painter(colour);
  return {
    out: [],
    err: ['', paint(ANSI.red, failure.reason), '', ...failure.detail.map((line) => `  ${line}`), ''],
  };
}
