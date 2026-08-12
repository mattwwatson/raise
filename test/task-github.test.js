import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPECTED_STATE,
  ISSUE_LIMIT,
  fetchIssues,
  issueListCommand,
  issuesFromJson,
  reconcile,
  renderValidation,
} from '../scripts/task-github.js';

const spec = (over = {}) => ({
  file: '23-roadmap-tooling.md',
  ticket: '23',
  title: 'Roadmap tooling',
  status: 'shipped',
  size: 'M',
  depends: [],
  branch: '23-roadmap-tooling',
  shipped: '2026-08-12',
  ...over,
});

const issue = (over = {}) => ({ key: '23', title: 'Roadmap tooling', open: false, notPlanned: false, ...over });

const indexed = (list) => new Map(list.map((one) => [one.ticket, one]));

const text = (rendered) => [...rendered.out, ...rendered.err].join('\n');

test('the issue list asks for every state, because a shipped spec wants a closed issue', () => {
  // The default is open-only, which would report every finished item as an
  // issue that does not exist - the one thing here that is a hard failure.
  const { command, args } = issueListCommand();
  assert.equal(command, 'gh');
  assert.ok(args.includes('--state'));
  assert.equal(args[args.indexOf('--state') + 1], 'all');
});

test('the issue list asks for far more than the default page', () => {
  // Same reason: a cap below the real count turns present issues into absent
  // ones, and absent is the error case.
  const { args } = issueListCommand();
  assert.equal(args[args.indexOf('--limit') + 1], String(ISSUE_LIMIT));
  assert.ok(ISSUE_LIMIT >= 100);
});

test('nothing in the command goes through a shell', () => {
  // Arguments are passed as a list, so a repository or title containing shell
  // syntax is data rather than something to execute.
  const { args } = issueListCommand();
  assert.ok(args.every((arg) => typeof arg === 'string'));
});

test('issues are read out of what gh returns', () => {
  const parsed = issuesFromJson(JSON.stringify([
    { number: 23, title: 'Roadmap tooling', state: 'CLOSED', stateReason: 'COMPLETED' },
    { number: 24, title: 'A bug', state: 'OPEN', stateReason: null },
  ]));
  assert.deepEqual(parsed, [
    { key: '23', title: 'Roadmap tooling', open: false, notPlanned: false },
    { key: '24', title: 'A bug', open: true, notPlanned: false },
  ]);
});

test('the issue number becomes a string, so it compares against a spec key', () => {
  const [only] = issuesFromJson('[{"number":7,"title":"x","state":"OPEN"}]');
  assert.equal(only.key, '7');
});

test('a closed-as-not-planned issue is distinguished from one that was completed', () => {
  const [only] = issuesFromJson(
    '[{"number":7,"title":"x","state":"CLOSED","stateReason":"NOT_PLANNED"}]',
  );
  assert.equal(only.notPlanned, true);
});

test('anything that is not a list of issues is refused rather than half-read', () => {
  // A partial reading would invent the "issue does not exist" fault, which is
  // the only thing here that fails a build.
  assert.equal(issuesFromJson('not json'), null);
  assert.equal(issuesFromJson('{"issues":[]}'), null);
  assert.equal(issuesFromJson('[{"title":"no number"}]'), null);
  assert.equal(issuesFromJson('[null]'), null);
});

test('an empty list is a real answer, not a failure', () => {
  assert.deepEqual(issuesFromJson('[]'), []);
});

test('a gh that is not installed explains itself rather than throwing', () => {
  const result = fetchIssues({
    run: () => ({ ok: false, stdout: '', stderr: 'gh is not installed, or not on PATH' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.ok(result.detail.join('\n').includes('gh auth status'));
});

test('a failure to ask exits 2, not the structural 1', () => {
  // Not being able to ask is not the repository being wrong, and the two must
  // not be confused by whatever reads the exit code.
  const result = fetchIssues({ run: () => ({ ok: false, stdout: '', stderr: 'nope' }) });
  assert.equal(result.exitCode, 2);
});

test('unreadable output is a failure to ask rather than an empty answer', () => {
  const result = fetchIssues({ run: () => ({ ok: true, stdout: '<html>', stderr: '' }) });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
});

test('a shipped spec whose issue is still open is divergence', () => {
  const report = reconcile(indexed([spec()]), [issue({ open: true })]);
  assert.equal(report.diverged.length, 1);
  assert.equal(report.diverged[0].issueState, 'open');
  assert.equal(report.diverged[0].expected, 'closed');
});

test('a shipped spec whose issue is closed agrees', () => {
  const report = reconcile(indexed([spec()]), [issue({ open: false })]);
  assert.deepEqual(report.diverged, []);
  assert.equal(report.exitCode, 0);
});

test('backlog and in-progress are not compared, because an open issue cannot tell them apart', () => {
  // The honest limit of the move: Jira carried four workflow states and an
  // issue carries two. Guessing which one "open" meant would be wrong about
  // half the time, so it is counted and skipped.
  const report = reconcile(
    indexed([spec({ ticket: '23', status: 'backlog' }), spec({ ticket: '24', file: '24-x.md', status: 'in-progress' })]),
    [issue({ key: '23', open: true }), issue({ key: '24', open: true })],
  );
  assert.deepEqual(report.diverged, []);
  assert.equal(report.exemptUndecided, 2);
});

test('every status has an entry, so a fifth is a decision rather than a silent skip', () => {
  assert.deepEqual(
    Object.keys(EXPECTED_STATE).sort(),
    ['backlog', 'in-progress', 'shipped', 'wont-do'],
  );
});

test('a legacy RAI key is exempt, not a missing issue', () => {
  // 21 specs were tracked in Jira and have no GitHub issue. Reported as faults
  // they would be permanent errors nobody can clear, which is how a check stops
  // being read.
  const report = reconcile(indexed([spec({ ticket: 'RAI-14', file: 'RAI-14-roadmap-tooling.md' })]), []);
  assert.deepEqual(report.faults, []);
  assert.equal(report.exemptLegacy, 1);
  assert.equal(report.exitCode, 0);
});

test('an issue-keyed spec with no issue is the one hard failure', () => {
  const report = reconcile(indexed([spec({ ticket: '99', file: '99-mystery.md' })]), []);
  assert.equal(report.faults.length, 1);
  assert.equal(report.faults[0].code, 'no-tracker-issue');
  assert.equal(report.exitCode, 1);
});

test('divergence alone exits 0, because this is a report and not a gate', () => {
  const report = reconcile(indexed([spec()]), [issue({ open: true })]);
  assert.equal(report.exitCode, 0);
});

test('an issue with no spec is an orphan, and orphans are expected', () => {
  const report = reconcile(indexed([spec()]), [issue(), issue({ key: '41', title: 'Captured, not started', open: true })]);
  assert.deepEqual(report.orphans.map((one) => one.key), ['41']);
  assert.equal(report.exitCode, 0);
});

test('orphans are sorted, because gh answers newest first', () => {
  const report = reconcile(new Map(), [
    issue({ key: '41' }),
    issue({ key: '9' }),
    issue({ key: '23' }),
  ]);
  assert.deepEqual(report.orphans.map((one) => one.key), ['9', '23', '41']);
});

test('a wont-do spec expects a closed issue', () => {
  const abandoned = reconcile(indexed([spec({ status: 'wont-do' })]), [issue({ open: true })]);
  assert.equal(abandoned.diverged.length, 1);
});

test('the report says what it compared and what it could not', () => {
  const report = reconcile(
    indexed([spec(), spec({ ticket: 'RAI-14', file: 'RAI-14-x.md' })]),
    [issue()],
  );
  const rendered = text(renderValidation(report));
  assert.ok(rendered.includes('2 specs against 1 issues'));
  assert.ok(rendered.includes('keyed RAI-N'));
});
