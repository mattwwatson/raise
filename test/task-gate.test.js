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

test('a checkout with no branch fails as "no branch", not as a bad branch name', () => {
  // A detached HEAD is a different problem from a misnamed branch and deserves
  // a different instruction.
  const result = gateBranch(null, indexed([spec()]));
  assert.equal(result.outcome, 'no-branch');
  assert.equal(result.exitCode, 1);
});

test('a branch with no key at all fails the gate and explains the naming rule', () => {
  const result = gateBranch('tidy-up', indexed([spec()]));
  assert.equal(result.outcome, 'no-key');
  const rendered = text(renderGate(result));
  assert.ok(rendered.includes('RAI-14-roadmap-tooling'));
  assert.ok(rendered.includes('fix/RAI-14-roadmap-tooling'));
});

test('the naming failure says this is our convention rather than a Jira constraint', () => {
  // Jira finds the key anywhere in a branch name, so nothing upstream enforces
  // this. Saying otherwise - as the original does - sends somebody looking for
  // an automation rule that was never the reason.
  const rendered = text(renderGate(gateBranch('tidy-up', indexed([spec()]))));
  assert.ok(rendered.includes('our convention'));
  assert.ok(rendered.includes('anywhere'));
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

  const failed = renderGate(gateBranch('tidy-up', indexed([spec()])));
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
