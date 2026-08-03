import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTranscriptTail,
  runningToolUse,
  lavishPollTarget,
  describeToolUse,
  summariseTranscript,
} from '../src/transcript.js';

const jsonl = (...records) => records.map((r) => JSON.stringify(r)).join('\n');

const toolUse = (id, name, input = {}) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
});

const toolResult = (id) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id }] },
});

test('parseTranscriptTail drops the partial first line of a tail read', () => {
  // A tail read almost always lands mid-record. That fragment is not repairable
  // and must not be mistaken for a record.
  const text = `{"type":"assis\n${jsonl({ type: 'mode', mode: 'plan' })}`;
  const records = parseTranscriptTail(text, true);
  assert.deepEqual(records, [{ type: 'mode', mode: 'plan' }]);
});

test('parseTranscriptTail keeps the first line when reading from the start', () => {
  const text = jsonl({ type: 'mode', mode: 'plan' });
  assert.equal(parseTranscriptTail(text, false).length, 1);
});

test('parseTranscriptTail survives a half-written final line', () => {
  // The file is appended to live, so the last line can be caught mid-write.
  const text = `${jsonl({ type: 'mode', mode: 'normal' })}\n{"type":"ai-ti`;
  const records = parseTranscriptTail(text, false);
  assert.equal(records.length, 1);
});

test('runningToolUse finds the call that has not come back', () => {
  const records = parseTranscriptTail(
    jsonl(toolUse('a', 'Read'), toolResult('a'), toolUse('b', 'Bash', { command: 'npm test' })),
    false,
  );
  assert.deepEqual(runningToolUse(records), { name: 'Bash', input: { command: 'npm test' } });
});

test('runningToolUse returns null when every call has a result', () => {
  const records = parseTranscriptTail(jsonl(toolUse('a', 'Read'), toolResult('a')), false);
  assert.equal(runningToolUse(records), null);
});

test('runningToolUse is not fooled by results arriving out of order', () => {
  // Parallel tool calls resolve in whatever order they finish, so "the last
  // call" and "the pending call" are not the same thing.
  const records = parseTranscriptTail(
    jsonl(toolUse('a', 'Grep'), toolUse('b', 'Read'), toolResult('b')),
    false,
  );
  assert.equal(runningToolUse(records)?.name, 'Grep');
});

test('lavishPollTarget recognises a poll and ignores other lavish commands', () => {
  assert.equal(
    lavishPollTarget('lavish-axi poll /repo/.lavish/plan.html'),
    '/repo/.lavish/plan.html',
  );
  assert.equal(lavishPollTarget('lavish-axi /repo/.lavish/plan.html'), null);
  assert.equal(lavishPollTarget('lavish-axi export /repo/.lavish/plan.html'), null);
  assert.equal(lavishPollTarget('npm test'), null);
});

test('lavishPollTarget handles quoting and flags', () => {
  assert.equal(lavishPollTarget('lavish-axi poll "/a b/plan.html"'), '/a b/plan.html');
  assert.equal(lavishPollTarget("lavish-axi poll '/a b/plan.html'"), '/a b/plan.html');
  assert.equal(lavishPollTarget('lavish-axi poll --timeout 30 /repo/p.html'), '/repo/p.html');
});

test('describeToolUse names the file for file tools and the command for Bash', () => {
  assert.equal(describeToolUse({ name: 'Edit', input: { file_path: '/a/b/dashboard.js' } }), 'Editing dashboard.js');
  assert.equal(describeToolUse({ name: 'Read', input: { file_path: '/a/b/nm-state.js' } }), 'Reading nm-state.js');
  assert.equal(describeToolUse({ name: 'Bash', input: { command: 'npm test' } }), 'Running npm');
  assert.equal(describeToolUse(null), null);
});

test('describeToolUse prefers the description Bash was given', () => {
  assert.equal(
    describeToolUse({ name: 'Bash', input: { command: 'x', description: 'Run the test suite' } }),
    'Run the test suite',
  );
});

test('describeToolUse skips leading environment assignments', () => {
  // `FOO=1 npm test` is running npm, not running FOO.
  assert.equal(
    describeToolUse({ name: 'Bash', input: { command: 'MOROKU_ENV=test npm run ci' } }),
    'Running npm',
  );
});

test('summariseTranscript reads the latest title and mode, not the first', () => {
  const records = parseTranscriptTail(
    jsonl(
      { type: 'ai-title', aiTitle: 'early-guess' },
      { type: 'mode', mode: 'normal' },
      { type: 'ai-title', aiTitle: 'favicon-and-summaries' },
      { type: 'mode', mode: 'plan' },
    ),
    false,
  );
  const summary = summariseTranscript(records);
  assert.equal(summary.title, 'favicon-and-summaries');
  assert.equal(summary.mode, 'plan');
});

test('summariseTranscript surfaces a lavish poll as the file it waits on', () => {
  const records = parseTranscriptTail(
    jsonl(
      { type: 'ai-title', aiTitle: 'terrain-sea-ramp' },
      toolUse('p', 'Bash', { command: 'lavish-axi poll /repo/.lavish/terrain.html' }),
    ),
    false,
  );
  const summary = summariseTranscript(records);
  assert.equal(summary.lavishFile, '/repo/.lavish/terrain.html');
});

test('summariseTranscript does not report a lavish poll that has already returned', () => {
  // The whole point is "waiting right now". A finished poll is just history.
  const records = parseTranscriptTail(
    jsonl(toolUse('p', 'Bash', { command: 'lavish-axi poll /repo/.lavish/t.html' }), toolResult('p')),
    false,
  );
  assert.equal(summariseTranscript(records).lavishFile, null);
});

test('summariseTranscript claims nothing about an empty transcript', () => {
  assert.deepEqual(summariseTranscript([]), {
    title: null,
    mode: null,
    activity: null,
    lavishFile: null,
    lastActivityAt: null,
  });
});
