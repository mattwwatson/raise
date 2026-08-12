import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gateBranch, renderGate, renderGateFaults, ticketFromBranch } from '../scripts/task-gate.js';

const spec = (over = {}) => ({
  file: 'RAI-14-roadmap-tooling.md',
  ticket: 'RAI-14',
  title: 'Roadmap tooling',
  status: 'shipped',
  size: 'M',
  depends: [],
  branch: 'RAI-14-roadmap-tooling',
  shipped: '2026-08-06',
  ...over,
});

const indexed = (list) => new Map(list.map((one) => [one.ticket, one]));

const text = (rendered) => [...rendered.out, ...rendered.err].join('\n');

test('the ticket key is the start of the branch name', () => {
  assert.equal(ticketFromBranch('RAI-14-roadmap-tooling'), 'RAI-14');
});

test('a branch that is only the key, with no short name, still names the key', () => {
  // So it gets the honest "no spec" or "not shipped" answer rather than being
  // told it carries no key at all.
  assert.equal(ticketFromBranch('RAI-14'), 'RAI-14');
});

test('a key starting a path segment names the ticket, so a prefixed branch works', () => {
  assert.equal(ticketFromBranch('fix/RAI-14-roadmap-tooling'), 'RAI-14');
  assert.equal(ticketFromBranch('feature/RAI-14'), 'RAI-14');
  assert.equal(ticketFromBranch('mattw/wip/RAI-14-tooling'), 'RAI-14');
});

test('a key buried inside a segment is not the name of the branch', () => {
  // At that point it is a substring inside a word rather than the branch
  // naming its ticket.
  assert.equal(ticketFromBranch('wip-RAI-14-roadmap-tooling'), null);
  assert.equal(ticketFromBranch('revertRAI-14'), null);
});

test('a lowercase key is not a key', () => {
  assert.equal(ticketFromBranch('rai-14-roadmap-tooling'), null);
});

test('a key with no hyphen before the number is not a key', () => {
  assert.equal(ticketFromBranch('RAI14-roadmap-tooling'), null);
});

test('a project code carrying digits is still a key', () => {
  assert.equal(ticketFromBranch('AB2-7-something'), 'AB2-7');
});

test('a branch that merely starts with the letters of a key is not one', () => {
  assert.equal(ticketFromBranch('RAILWAY-station'), null);
});

test('a bare issue number is the key, which is how items are named now', () => {
  assert.equal(ticketFromBranch('23-roadmap-tooling'), '23');
  assert.equal(ticketFromBranch('23'), '23');
  assert.equal(ticketFromBranch('fix/23-roadmap-tooling'), '23');
});

test('a number buried in a segment is not an issue key', () => {
  // The anchors matter far more for a bare number than for RAI-14, which
  // announces itself. Without them the "2" in v2-rewrite would read as issue 2
  // and the gate would go looking for its spec.
  assert.equal(ticketFromBranch('feat/v2-rewrite'), null);
  assert.equal(ticketFromBranch('wip-23-tooling'), null);
  assert.equal(ticketFromBranch('release-2026-08-12'), null);
});

test('a legacy Jira key still names its branch, because those specs still exist', () => {
  // 21 items shipped under Jira keys and keep them. The gate has to go on
  // reading a branch named for one, or the historical specs become unreachable.
  assert.equal(ticketFromBranch('RAI-14-roadmap-tooling'), 'RAI-14');
});

test('a checkout with no branch fails as "no branch", not as a bad branch name', () => {
  // A detached HEAD is a different problem from a misnamed branch and deserves
  // a different instruction.
  const result = gateBranch(null, indexed([spec()]));
  assert.equal(result.outcome, 'no-branch');
  assert.equal(result.exitCode, 1);
});

test('a branch with no issue number passes, because it ships no tracked item', () => {
  // The gate asserts one thing: the pull request that ships an item marks that
  // item shipped. That is a statement about items, so a branch carrying none
  // has nothing to assert. It used to fail here, and with `tasks:gate` inside a
  // required check that made a one-line spec correction cost an issue, a spec
  // and a pipeline run.
  const result = gateBranch('tidy-up', indexed([spec()]));
  assert.equal(result.outcome, 'untracked');
  assert.equal(result.exitCode, 0);

  const prefixed = gateBranch('fix/some-typo', indexed([spec()]));
  assert.equal(prefixed.outcome, 'untracked');
  assert.equal(prefixed.exitCode, 0);
});

// The items every branch name below could be read as naming - both halves of
// the RAI-3/3 collision that ended the second attempt at misplaced-key
// detection, so a rebuilt one fails here rather than in CI.
const known = () =>
  indexed([
    spec(),
    spec({ file: '23-stale-page-code.md', ticket: '23' }),
    spec({ file: 'RAI-3-rename-to-raise.md', ticket: 'RAI-3', status: 'in-progress' }),
    spec({ file: '3-ambiguous-unowned-run.md', ticket: '3' }),
  ]);

test('a branch whose key is not in an anchored position passes, and that gap is known', () => {
  // The accepted gap, asserted so it is a decision rather than an oversight.
  // Telling these from an ordinary branch name was built twice and removed
  // twice - see the comment in `gateBranch`. What the gate protects against is
  // forgetting to mark an item shipped, which needs a correctly named branch
  // anyway, and a misnamed branch still goes through review.
  for (const branch of ['wip-23-tooling', '23_stale_page_code', '23/stale-page-code',
    'revertRAI-14', 'rai-14-roadmap-tooling', 'RAI-14_tooling', 'RAI-14x']) {
    const result = gateBranch(branch, known());
    assert.equal(result.outcome, 'untracked', branch);
    assert.equal(result.exitCode, 0, branch);
  }
});

test('an ordinary name carrying digits passes whatever items exist', () => {
  // Why the second mechanism went: it read these as naming an item, and the
  // set of names it broke grew with every issue filed. `3` and `RAI-3` are both
  // in `known()`, so `release/v1.2.3` and `3d-render` are the live cases.
  for (const branch of ['release-2026-08-12', 'bump-node-24', 'fix/readme-node-22',
    'release/v1.2.3', 'fix/oauth2-callback', 'fix/http-2-notes', '3d-render', 'feat/v2-rewrite']) {
    const result = gateBranch(branch, known());
    assert.equal(result.outcome, 'untracked', branch);
    assert.equal(result.exitCode, 0, branch);
  }
});

test('a legacy key and the bare issue sharing its number stay separate items', () => {
  // The collision that ended the second attempt: it reported `wip-RAI-3-x` as
  // issue 3, whose spec is shipped, so following its rename advice would have
  // turned the gate green while RAI-3 itself was never marked shipped. Nothing
  // may resolve one of these to the other.
  assert.equal(ticketFromBranch('RAI-3-rename-to-raise'), 'RAI-3');
  assert.equal(ticketFromBranch('3-ambiguous-unowned-run'), '3');

  const legacy = gateBranch('RAI-3-rename-to-raise', known());
  assert.equal(legacy.outcome, 'not-shipped');
  assert.equal(legacy.spec?.file, 'RAI-3-rename-to-raise.md');

  const bare = gateBranch('3-ambiguous-unowned-run', known());
  assert.equal(bare.outcome, 'ok');
  assert.equal(bare.spec?.file, '3-ambiguous-unowned-run.md');
});

test('the missing-spec failure asks for the spec of a tracked item, not of any branch', () => {
  // A branch shipping no tracked item needs neither an issue nor a spec, so
  // the one copy of the rule a contributor reads at the gate may not say that
  // no branch may exist without one.
  const err = renderGate(gateBranch('RAI-99-mystery', known())).err.join('\n');
  assert.ok(err.includes('Every tracked item needs one'));
  assert.ok(!err.includes('no branch may exist'));
});

test('passing without a key says so rather than passing silently', () => {
  // Silence would be indistinguishable from passing because a spec said
  // shipped, and which of the two it was is the thing worth reading.
  const rendered = text(renderGate(gateBranch('tidy-up', indexed([spec()]))));
  assert.ok(rendered.includes('tidy-up'));
  assert.ok(rendered.includes('no issue number'));
  assert.ok(rendered.includes('<issue>-<short-name>'));
});

test('an unkeyed pass goes to stdout, not to stderr with the failures', () => {
  const rendered = renderGate(gateBranch('tidy-up', indexed([spec()])));
  assert.deepEqual(rendered.err, []);
  assert.ok(rendered.out.length > 0);
});

test('a keyed branch is not relaxed at all - its spec must still say shipped', () => {
  // The whole risk of this change is that it reads as "the gate got softer".
  // It did not: everything with a key in its name is checked exactly as before.
  const result = gateBranch('7-require-no-mistakes', indexed([spec({ ticket: '7', status: 'in-progress' })]));
  assert.equal(result.outcome, 'not-shipped');
  assert.equal(result.exitCode, 1);
});

test('a branch whose key has no spec fails and names the file to create', () => {
  const result = gateBranch('RAI-99-mystery', indexed([spec()]));
  assert.equal(result.outcome, 'no-spec');
  assert.ok(text(renderGate(result)).includes('docs/tasks/RAI-99-<short-name>.md'));
});

test('a spec that is not shipped fails, and the failure quotes the lines to add', () => {
  const result = gateBranch('RAI-14-roadmap-tooling', indexed([spec({ status: 'in-progress' })]));
  assert.equal(result.outcome, 'not-shipped');
  assert.equal(result.exitCode, 1);
  const rendered = text(renderGate(result, { today: '2026-08-06' }));
  assert.ok(rendered.includes('status: shipped'));
  assert.ok(rendered.includes('shipped: 2026-08-06'));
});

test('the date in the suggested shipped line comes from the injected clock', () => {
  const result = gateBranch('RAI-14-x', indexed([spec({ ticket: 'RAI-14', status: 'backlog' })]));
  assert.ok(text(renderGate(result, { today: '2001-01-01' })).includes('shipped: 2001-01-01'));
});

test('a shipped spec passes and exits 0', () => {
  const result = gateBranch('RAI-14-roadmap-tooling', indexed([spec()]));
  assert.equal(result.outcome, 'ok');
  assert.equal(result.exitCode, 0);
  assert.ok(text(renderGate(result)).includes('marked shipped'));
});

test('a wont-do spec does not pass - shipped means shipped', () => {
  const result = gateBranch('RAI-14-roadmap-tooling', indexed([spec({ status: 'wont-do' })]));
  assert.equal(result.outcome, 'not-shipped');
});

test('the gate reads a branch name and the specs, so no credential can fail it', () => {
  // The whole point of it being disk-only: it cannot go red because a token
  // expired or Jira was slow.
  const result = gateBranch('RAI-14-roadmap-tooling', indexed([spec()]));
  assert.equal(result.exitCode, 0);
});

test('the pass line goes to stdout and every failure to stderr', () => {
  const passed = renderGate(gateBranch('RAI-14-x', indexed([spec({ ticket: 'RAI-14' })])));
  assert.ok(passed.out.length > 0);
  assert.deepEqual(passed.err, []);

  // A keyed branch whose spec is missing - `tidy-up` is no longer a failure,
  // it is the untracked pass, and asserting stderr on it would have been
  // asserting the behaviour this change removed.
  const failed = renderGate(gateBranch('99-mystery', indexed([spec()])));
  assert.deepEqual(failed.out, []);
  assert.ok(failed.err.length > 0);
});

test('a structural fault is reported by the gate too, not only by the board', () => {
  // The gate and the link check are the only roadmap commands on a pull
  // request, and a duplicate key decides which of two files the gate reads.
  const rendered = renderGateFaults([
    { code: 'duplicate-ticket', file: 'b.md', ticket: 'RAI-1', message: 'b.md: RAI-1 is taken' },
  ]);
  assert.ok(rendered.err.join('\n').includes('b.md: RAI-1 is taken'));
});

test('no faults produces no output at all', () => {
  assert.deepEqual(renderGateFaults([]), { out: [], err: [] });
});

test('the renderer writes no escape codes when colour is off', () => {
  const result = gateBranch('RAI-14-x', indexed([spec({ ticket: 'RAI-14', status: 'backlog' })]));
  const rendered = renderGate(result, { colour: false, today: '2026-08-06' });
  for (const line of [...rendered.out, ...rendered.err]) {
    assert.ok(!line.includes('\x1b['), line);
  }
});
