import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildJiraRequest,
  explainJiraFailure,
  fetchJiraIssues,
  issuesFromSearch,
  JIRA_STATUS_TO_DISK,
  MAX_PAGES,
  reconcile,
  renderValidation,
} from '../scripts/task-jira.js';

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

const issue = (over = {}) => ({
  key: 'RAI-1',
  status: 'To Do',
  summary: 'A thing that needs doing',
  isEpic: false,
  ...over,
});

const indexed = (list) => new Map(list.map((one) => [one.ticket, one]));

/** A search payload of the shape the real endpoint returns. */
const payload = (keys, over = {}) => ({
  issues: keys.map((key) => ({
    key,
    fields: {
      status: { name: 'To Do' },
      issuetype: { name: 'Task', hierarchyLevel: 0 },
      summary: `Summary of ${key}`,
    },
  })),
  isLast: true,
  ...over,
});

/** A fetch that answers from a queue of pages and records what it was asked. */
const fakeFetch = (pages) => {
  const calls = [];
  const queue = [...pages];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const next = queue.shift();
    if (next?.throws) throw new Error(next.throws);
    return {
      ok: next.ok !== false,
      status: next.status ?? 200,
      json: async () => next.body,
      text: async () => next.text ?? '',
    };
  };
  impl.calls = calls;
  return impl;
};

const env = (over = {}) => ({ JIRA_EMAIL: 'me@example.com', JIRA_TOKEN: 'secret', ...over });

test('a missing token is reported before any request is made', async () => {
  const impl = fakeFetch([]);
  const result = await fetchJiraIssues({ env: { JIRA_EMAIL: 'me@example.com' }, fetchImpl: impl });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.equal(impl.calls.length, 0);
});

test('every missing credential is named at once, not one per run', async () => {
  const result = await fetchJiraIssues({ env: {}, fetchImpl: fakeFetch([]) });
  assert.ok(result.reason.includes('JIRA_EMAIL'));
  assert.ok(result.reason.includes('JIRA_TOKEN'));
});

test('the missing-credential message never suggests exporting the token', async () => {
  // Command substitution keeps the value out of the shell history and out of
  // an agent's transcript; an `export` line burns it.
  const result = await fetchJiraIssues({ env: {}, fetchImpl: fakeFetch([]) });
  const text = result.detail.join('\n');
  assert.ok(text.includes('$(secret-get'));
  assert.ok(!/^\s*export /m.test(text));
});

test('the request goes through the api.atlassian.com gateway, where a scoped token works', () => {
  const { request } = buildJiraRequest({ email: 'me@example.com', token: 'secret' });
  assert.ok(request.url.startsWith('https://api.atlassian.com/ex/jira/'));
});

test('the credential is sent as basic auth built from the email and token', () => {
  const { request } = buildJiraRequest({ email: 'me@example.com', token: 'secret' });
  const decoded = Buffer.from(request.headers.Authorization.slice('Basic '.length), 'base64');
  assert.equal(decoded.toString(), 'me@example.com:secret');
});

test('epics are queried rather than excluded, because this repo gives an epic a spec', () => {
  // The original filtered `issuetype != Epic`, which here would report
  // RAI-1-open-source-release.md as a fault that can never be corrected.
  const { request } = buildJiraRequest({ email: 'a@b.c', token: 't', project: 'RAI' });
  const query = new URL(request.url).searchParams;
  assert.equal(query.get('jql'), 'project = RAI');
  // `fields` asks for issuetype so an epic can be recognised on the way back.
  // The JQL itself does not filter on it, which is the whole point.
  assert.ok(query.get('fields').includes('issuetype'));
});

test('a page token is carried into the next request', () => {
  const { request } = buildJiraRequest({ email: 'a@b.c', token: 't', pageToken: 'abc123' });
  assert.ok(request.url.includes('nextPageToken=abc123'));
});

test('a 401 whose body mentions scope is explained as a token lacking read:jira-work', () => {
  const detail = explainJiraFailure(401, 'Unauthorized; scope does not match', 'me@example.com');
  assert.ok(detail.join(' ').includes('read:jira-work'));
});

test('a plain 401 is explained as the email not owning the token', () => {
  // The two 401s look identical and have completely different fixes. Guessing
  // wrong costs a rotation of a perfectly healthy token.
  const detail = explainJiraFailure(401, 'Unauthorized', 'me@example.com');
  assert.ok(detail.join(' ').includes('me@example.com'));
  assert.ok(!detail.join(' ').includes('read:jira-work'));
});

test('any other failure quotes the body it got back, truncated', () => {
  const detail = explainJiraFailure(500, 'x'.repeat(500));
  assert.ok(detail[0].length <= 300);
});

test('an HTTP failure exits 2, because that is a broken credential and not a broken repo', async () => {
  const impl = fakeFetch([{ ok: false, status: 401, text: 'Unauthorized' }]);
  const result = await fetchJiraIssues({ env: env(), fetchImpl: impl });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
});

test('a network error is a failure to ask rather than an exception', async () => {
  const impl = fakeFetch([{ throws: 'getaddrinfo ENOTFOUND' }]);
  const result = await fetchJiraIssues({ env: env(), fetchImpl: impl });
  assert.equal(result.exitCode, 2);
  assert.ok(result.detail.join(' ').includes('ENOTFOUND'));
});

test('paging follows nextPageToken to the end and returns every issue', async () => {
  const impl = fakeFetch([
    { body: payload(['RAI-1', 'RAI-2'], { isLast: false, nextPageToken: 'p2' }) },
    { body: payload(['RAI-3'], { isLast: true }) },
  ]);
  const result = await fetchJiraIssues({ env: env(), fetchImpl: impl });
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues.map((one) => one.key), ['RAI-1', 'RAI-2', 'RAI-3']);
  assert.ok(impl.calls[1].url.includes('nextPageToken=p2'));
});

test('a page Jira does not call the last one is a failure, not a short answer', async () => {
  // This endpoint returns no `total`, so a truncated read is indistinguishable
  // from a complete one - and every spec past the cut would then read as a
  // ticket that does not exist.
  const pages = Array.from({ length: MAX_PAGES }, () => ({
    body: payload(['RAI-1'], { isLast: false, nextPageToken: 'more' }),
  }));
  const result = await fetchJiraIssues({ env: env(), fetchImpl: fakeFetch(pages) });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.ok(result.reason.includes('paging'));
});

test('an epic is recognised by hierarchy level rather than by the type being called Epic', () => {
  // A Jira admin can rename the issue type; the level is structural.
  const read = issuesFromSearch({
    issues: [
      { key: 'RAI-1', fields: { status: { name: 'To Do' }, issuetype: { name: 'Initiative', hierarchyLevel: 1 } } },
    ],
    isLast: true,
  });
  assert.equal(read.issues[0].isEpic, true);
});

test('a payload carrying no hierarchy level falls back to the type name', () => {
  const read = issuesFromSearch({
    issues: [{ key: 'RAI-1', fields: { status: { name: 'To Do' }, issuetype: { name: 'Epic' } } }],
    isLast: true,
  });
  assert.equal(read.issues[0].isEpic, true);
});

test('a payload with no issues at all is read as an empty page, not as a throw', () => {
  assert.deepEqual(issuesFromSearch(null).issues, []);
  assert.deepEqual(issuesFromSearch({}).issues, []);
});

test('a spec whose Jira status maps to its own is not divergence', () => {
  const report = reconcile(indexed([spec({ status: 'backlog' })]), [issue({ status: 'To Do' })]);
  assert.deepEqual(report.diverged, []);
  assert.equal(report.exitCode, 0);
});

test('In Review maps to in-progress, a branch under review still being worked on', () => {
  assert.equal(JIRA_STATUS_TO_DISK['In Review'], 'in-progress');
  const report = reconcile(indexed([spec({ status: 'in-progress' })]), [
    issue({ status: 'In Review' }),
  ]);
  assert.deepEqual(report.diverged, []);
});

test('a spec in a different state from Jira is divergence, and divergence alone exits 0', () => {
  // Normal and often correct: disk describes what is merged here, Jira
  // describes where the workflow is.
  const report = reconcile(indexed([spec({ status: 'backlog' })]), [issue({ status: 'Done' })]);
  assert.equal(report.diverged.length, 1);
  assert.equal(report.diverged[0].jiraStatus, 'Done');
  assert.equal(report.exitCode, 0);
});

test('divergence names both states and the file it is in', () => {
  const report = reconcile(indexed([spec({ status: 'backlog' })]), [issue({ status: 'Done' })]);
  const { out } = renderValidation(report);
  const line = out.find((one) => one.includes('RAI-1'));
  assert.ok(line.includes('Done'));
  assert.ok(line.includes('backlog'));
  assert.ok(line.includes('RAI-1-thing.md'));
});

test('a wont-do spec is never divergent, because Jira has no such state', () => {
  const report = reconcile(indexed([spec({ status: 'wont-do' })]), [issue({ status: 'To Do' })]);
  assert.deepEqual(report.diverged, []);
});

test('an epic spec is never divergent, because an epic status follows its children', () => {
  // RAI-1 reads To Do in Jira and in-progress on disk right now, and both are
  // right. Comparing them would make that permanent noise.
  const report = reconcile(indexed([spec({ status: 'in-progress' })]), [
    issue({ status: 'To Do', isEpic: true }),
  ]);
  assert.deepEqual(report.diverged, []);
  assert.equal(report.exemptEpics, 1);
});

test('a spec whose ticket does not exist in Jira is a fault and exits 1', () => {
  const report = reconcile(indexed([spec({ ticket: 'RAI-99' })]), [issue()]);
  assert.deepEqual(report.faults.map((one) => one.code), ['no-jira-issue']);
  assert.equal(report.exitCode, 1);
});

test('a Jira issue with no spec file is an orphan, reported and not faulted', () => {
  const report = reconcile(indexed([]), [issue({ key: 'RAI-4' })]);
  assert.deepEqual(report.orphans, [{ key: 'RAI-4', isEpic: false }]);
  assert.equal(report.exitCode, 0);
});

test('orphans are sorted by ticket number, not left in the order Jira answered', () => {
  // Jira answers newest first, so an unsorted list reads backwards against the
  // board printed above it.
  const report = reconcile(indexed([]), [
    issue({ key: 'RAI-9' }),
    issue({ key: 'RAI-10' }),
    issue({ key: 'RAI-4' }),
  ]);
  assert.deepEqual(report.orphans.map((one) => one.key), ['RAI-4', 'RAI-9', 'RAI-10']);
});

test('the orphan line says why an orphan is expected rather than implying a gap', () => {
  const report = reconcile(indexed([]), [issue({ key: 'RAI-4' })]);
  const { out } = renderValidation(report);
  assert.ok(out.join('\n').includes('need no spec'));
});

test('an orphaned epic is marked as one, because an epic gets a spec like anything else', () => {
  // An epic's children need no spec until picked up, which is why orphans are
  // never a fault - but the epic itself is expected to have one, so an epic
  // sitting in that list is the more notable entry rather than the less.
  const report = reconcile(indexed([]), [
    issue({ key: 'RAI-4' }),
    issue({ key: 'RAI-20', isEpic: true }),
  ]);
  const { out } = renderValidation(report);
  const line = out.find((one) => one.includes('with no spec file'));
  assert.ok(line.includes('RAI-20 (epic)'));
  assert.ok(!line.includes('RAI-4 (epic)'));
  assert.equal(report.exitCode, 0);
});

test('a Jira status we have never seen is reported as unmapped rather than as divergence', () => {
  // Fails soft on purpose: a word we have not seen is new, not wrong.
  const report = reconcile(indexed([spec({ status: 'backlog' })]), [issue({ status: 'Blocked' })]);
  assert.deepEqual(report.diverged, []);
  assert.deepEqual(report.unmapped, [{ key: 'RAI-1', jiraStatus: 'Blocked' }]);
  assert.equal(report.exitCode, 0);
});

test('the report says how many specs were checked against how many issues', () => {
  const report = reconcile(indexed([spec()]), [issue(), issue({ key: 'RAI-4' })]);
  const { out } = renderValidation(report);
  assert.ok(out[0].includes('1 specs against 2 Jira issues'));
});

test('a clean reconciliation says so rather than printing nothing', () => {
  const report = reconcile(indexed([spec()]), [issue()]);
  const { out } = renderValidation(report);
  assert.ok(out.join('\n').includes('every item matches Jira'));
});

test('faults go to stderr while the report itself stays on stdout', () => {
  const report = reconcile(indexed([spec({ ticket: 'RAI-99' })]), []);
  const { out, err } = renderValidation(report);
  assert.ok(err.join('\n').includes('RAI-99'));
  assert.ok(out.join('\n').includes('validate'));
});

test('the renderer writes no escape codes when colour is off', () => {
  const report = reconcile(indexed([spec({ status: 'backlog' })]), [issue({ status: 'Done' })]);
  const { out, err } = renderValidation(report, { colour: false });
  for (const line of [...out, ...err]) assert.ok(!line.includes('\x1b['), line);
});
