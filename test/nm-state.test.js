import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseRun, currentStep, countFindings, parseAxiStatus } from '../src/nm-state.js';

test('currentStep prefers the running step', () => {
  const steps = [
    { step_name: 'review', status: 'completed' },
    { step_name: 'test', status: 'running' },
    { step_name: 'lint', status: 'pending' },
  ];
  assert.equal(currentStep(steps).step_name, 'test');
});

test('currentStep falls back to the last step that did anything', () => {
  const steps = [
    { step_name: 'review', status: 'completed' },
    { step_name: 'test', status: 'failed' },
    { step_name: 'lint', status: 'pending' },
  ];
  assert.equal(currentStep(steps).step_name, 'test');
});

test('currentStep handles an empty pipeline', () => {
  assert.equal(currentStep([]), null);
  assert.equal(currentStep(undefined), null);
});

test('countFindings copes with both shapes and with rubbish', () => {
  assert.equal(countFindings('[{"id":1},{"id":2}]'), 2);
  assert.equal(countFindings('{"findings":[{"id":1}]}'), 1);
  assert.equal(countFindings('not json'), 0);
  assert.equal(countFindings(null), 0);
});

test('normaliseRun converts unix seconds and flags a parked run', () => {
  const now = 1_700_000_000_000;
  const row = {
    run_id: 'r1',
    repo_path: '/Users/x/work/repo',
    branch: 'feature/x',
    status: 'running',
    awaiting_agent_since: 1_699_999_000,
    pr_url: 'https://example.com/pr/1',
    head_sha: 'abcdef1234567890',
    created_at: 1_699_998_000,
    updated_at: 1_699_999_500,
    error: null,
  };
  const run = normaliseRun(row, [{ step_name: 'review', status: 'running', findings_json: '[{}]' }], now);

  assert.equal(run.repoName, 'repo');
  assert.equal(run.active, true);
  assert.equal(run.parked, true, 'awaiting_agent_since is the gate marker');
  assert.equal(run.parkedSince, 1_699_999_000_000);
  assert.equal(run.parkedForMs, 1_000_000);
  assert.equal(run.headSha, 'abcdef12');
  assert.equal(run.step.name, 'review');
  assert.equal(run.step.findings, 1);
});

test('a finished run is never reported as parked', () => {
  // parked_ms and a leftover timestamp can outlive the run itself; only an
  // active run can actually be waiting on a gate.
  const run = normaliseRun(
    {
      run_id: 'r1',
      repo_path: '/repo',
      branch: 'main',
      status: 'completed',
      awaiting_agent_since: 1_699_999_000,
      updated_at: 1_699_999_500,
    },
    [],
  );
  assert.equal(run.active, false);
  assert.equal(run.parked, false);
});

test('normaliseRun tolerates null timestamps', () => {
  const run = normaliseRun(
    { run_id: 'r1', repo_path: '/repo', branch: 'main', status: 'pending', awaiting_agent_since: null },
    [],
  );
  assert.equal(run.parked, false);
  assert.equal(run.parkedSince, null);
  assert.equal(run.updatedAt, null);
});

test('the degraded parser reads a parked run from axi status output', () => {
  const output = `run:
  id: "01KYS6PPHSGRZHBCTZX2F2YZDJ"
  branch: fm/some-branch
  status: running
  awaiting_agent: parked 3m12s
  head: a7a5d70c
  pr: "https://github.com/o/r/pull/22"
`;
  const run = parseAxiStatus(output, '/Users/x/work/repo');
  assert.equal(run.status, 'running');
  assert.equal(run.branch, 'fm/some-branch');
  assert.equal(run.parked, true);
  assert.equal(run.prUrl, 'https://github.com/o/r/pull/22');
  assert.equal(run.degraded, true);
});

test('the degraded parser does not call a finished run parked', () => {
  const output = `run:
  id: "x"
  branch: main
  status: completed
`;
  const run = parseAxiStatus(output, '/repo');
  assert.equal(run.active, false);
  assert.equal(run.parked, false);
});

test('the degraded parser returns null for output it does not understand', () => {
  assert.equal(parseAxiStatus('', '/repo'), null);
  assert.equal(parseAxiStatus('error: not a repo', '/repo'), null);
});
