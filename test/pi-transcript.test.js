import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePiTranscriptTail, normalisePiEntry } from '../src/pi-transcript.js';
import { summariseTranscript, lastActivityAt, runningToolUse } from '../src/transcript.js';

/** One pi session entry. The shapes here are pi's, not ours. */
const entry = (message, over = {}) => ({
  type: 'message',
  id: 'e1',
  parentId: null,
  timestamp: '2026-08-04T05:18:14.000Z',
  message,
  ...over,
});

const jsonl = (...entries) => ['{"partial":"line"}', ...entries.map((e) => JSON.stringify(e))].join('\n');

test('an assistant tool call becomes a tool_use with the same id', () => {
  const records = parsePiTranscriptTail(
    jsonl(
      entry({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc_1', name: 'bash', arguments: { command: 'npm test' } }],
      }),
    ),
  );
  const [block] = records[0].message.content;
  assert.equal(block.type, 'tool_use');
  assert.equal(block.id, 'tc_1');
  assert.equal(block.name, 'Bash');
  assert.equal(block.input.command, 'npm test');
});

test('a tool result resolves the call it refers back to', () => {
  // The whole basis of "what is it doing right now" - a call with no result is
  // in flight. Matched on id, never on position.
  const records = parsePiTranscriptTail(
    jsonl(
      entry({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc_1', name: 'bash', arguments: { command: 'npm test' } }],
      }),
      entry({ role: 'toolResult', toolCallId: 'tc_1', toolName: 'bash', content: [], isError: false }),
    ),
  );
  assert.equal(runningToolUse(records), null);
});

test('the call still waiting is the one reported, whatever order results arrive in', () => {
  const records = parsePiTranscriptTail(
    jsonl(
      entry({
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc_1', name: 'read', arguments: { path: '/a/config.js' } },
          { type: 'toolCall', id: 'tc_2', name: 'bash', arguments: { command: 'sleep 30' } },
        ],
      }),
      entry({ role: 'toolResult', toolCallId: 'tc_2', toolName: 'bash', content: [], isError: false }),
    ),
  );
  assert.equal(runningToolUse(records)?.name, 'Read');
});

test('pi names the file `path`, and the card still says which file', () => {
  // `TOOL_TARGETS` looks up `file_path`. Without the rename the card reads
  // "Reading Read", which is worse than useless on a page you glance at.
  const records = parsePiTranscriptTail(
    jsonl(
      entry({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc_1', name: 'read', arguments: { path: '/a/b/config.js' } }],
      }),
    ),
  );
  assert.equal(summariseTranscript(records).activity, 'Reading config.js');
});

test('a lavish poll is still recognised through the rename', () => {
  // It only works because pi's `bash` is renamed to `Bash`; a review gate that
  // goes unnoticed is a person waiting on a browser tab they have lost.
  const records = parsePiTranscriptTail(
    jsonl(
      entry({
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'tc_1',
            name: 'bash',
            arguments: { command: 'lavish-axi poll /Users/x/work/repo/.lavish/plan.html' },
          },
        ],
      }),
    ),
  );
  assert.equal(summariseTranscript(records).lavishFile, '/Users/x/work/repo/.lavish/plan.html');
});

test('startup bookkeeping carries a timestamp and is not activity', () => {
  // The `away_summary` lesson, in pi's dialect. `model_change` and
  // `thinking_level_change` are written at startup and say nothing about
  // whether anyone is working - counting them would move `lastActivityAt` on an
  // idle session and disprove a block that is real.
  const records = parsePiTranscriptTail(
    [
      '{"partial":"line"}',
      JSON.stringify({ type: 'session', version: 3, timestamp: '2026-08-04T05:18:13.804Z' }),
      JSON.stringify({ type: 'model_change', timestamp: '2026-08-04T05:18:13.854Z', provider: 'anthropic' }),
      JSON.stringify({ type: 'thinking_level_change', timestamp: '2026-08-04T05:18:13.854Z', thinkingLevel: 'medium' }),
    ].join('\n'),
  );
  assert.deepEqual(records, []);
  assert.equal(lastActivityAt(records), null);
});

test('a compaction or branch summary is housekeeping, not the conversation', () => {
  // Both are machine-written, both carry a timestamp, and neither means a human
  // is being waited on any less.
  assert.equal(normalisePiEntry(entry({ role: 'compactionSummary', summary: 's', tokensBefore: 1 })), null);
  assert.equal(normalisePiEntry(entry({ role: 'branchSummary', summary: 's', fromId: 'x' })), null);
  assert.equal(normalisePiEntry(entry({ role: 'custom', customType: 'ext', content: 'x' })), null);
});

test('a returning tool counts as work', () => {
  // A busy session must not read as idle. Tool results are `user` records in
  // Claude Code for the same reason.
  const records = parsePiTranscriptTail(
    jsonl(entry({ role: 'toolResult', toolCallId: 'tc_1', toolName: 'bash', content: [], isError: false })),
  );
  assert.equal(lastActivityAt(records), Date.parse('2026-08-04T05:18:14.000Z'));
});

test('pi allows a bare string where Claude Code always writes blocks', () => {
  const records = parsePiTranscriptTail(jsonl(entry({ role: 'user', content: 'just text' })));
  assert.deepEqual(records[0].message.content, [{ type: 'text', text: 'just text' }]);
});

test('a `!` command the human ran is activity', () => {
  const records = parsePiTranscriptTail(
    jsonl(entry({ role: 'bashExecution', command: 'git status', output: '', exitCode: 0 })),
  );
  assert.equal(records[0].message.content[0].text, '!git status');
  assert.ok(lastActivityAt(records));
});

test('an extension"s custom tool is named, never given a borrowed verb', () => {
  const records = parsePiTranscriptTail(
    jsonl(
      entry({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc_1', name: 'deploy_thing', arguments: {} }],
      }),
    ),
  );
  assert.equal(summariseTranscript(records).activity, 'Deploy_thing');
});

test('a tool call that carries no arguments at all still normalises', () => {
  // A nullary tool writes no `arguments` key, so the rename spreads nothing.
  // That is a no-op in an object literal rather than a throw, which is why the
  // `|| {}` guard that used to stand here was dead - but the case it was
  // guarding is real, so it is asserted rather than assumed.
  const records = parsePiTranscriptTail(
    jsonl(
      entry({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc_1', name: 'deploy_thing' }],
      }),
    ),
  );
  const [block] = records[0].message.content;
  assert.deepEqual(block.input, {});
  assert.equal(summariseTranscript(records).activity, 'Deploy_thing');
});

test('pi generates no title, and the summary invents nothing', () => {
  // Claude Code writes `ai-title`; pi does not generate one at all. The row
  // falls back to the directory name, which is honest.
  const records = parsePiTranscriptTail(jsonl(entry({ role: 'user', content: 'do a thing' })));
  const summary = summariseTranscript(records);
  assert.equal(summary.title, null);
  assert.equal(summary.mode, null);
  // And nothing invents a name for a session nobody named either.
  assert.equal(summary.sessionName, null);
});

test('a name the human gave the session lands where Claude Code`s does', () => {
  // pi`s `/name` and Claude Code`s `/rename` are the same act, so they must
  // reach the same field - otherwise the one concept renders in two places
  // depending on which agent wrote the transcript. It is not a title: pi
  // generates none, and `title` stays null rather than borrowing this.
  const records = parsePiTranscriptTail(
    [
      '{"partial":"line"}',
      JSON.stringify({ type: 'session_info', id: 'k', timestamp: '2026-08-04T05:00:00.000Z', name: 'Refactor auth' }),
    ].join('\n'),
  );
  const summary = summariseTranscript(records);
  assert.equal(summary.sessionName, 'Refactor auth');
  assert.equal(summary.title, null);
});

test('renaming a session takes the newer name', () => {
  const records = parsePiTranscriptTail(
    [
      '{"partial":"line"}',
      JSON.stringify({ type: 'session_info', timestamp: '2026-08-04T05:00:00.000Z', name: 'First' }),
      JSON.stringify({ type: 'session_info', timestamp: '2026-08-04T05:10:00.000Z', name: 'Second' }),
    ].join('\n'),
  );
  assert.equal(summariseTranscript(records).sessionName, 'Second');
});

test('a name is not evidence that anything happened', () => {
  // `session_info` carries a timestamp like every other pi entry, and clearing
  // a name is something a human does while the session sits idle.
  const records = parsePiTranscriptTail(
    [
      '{"partial":"line"}',
      JSON.stringify({ type: 'session_info', timestamp: '2026-08-04T05:00:00.000Z', name: 'A name' }),
    ].join('\n'),
  );
  assert.equal(lastActivityAt(records), null);
});

test('housekeeping entries are dropped in the form they are written on disk', () => {
  // These are top-level entry types in the file, not message roles - the roles
  // are how the in-memory union carries them. Both are guarded; this is the
  // shape that actually reaches us.
  const records = parsePiTranscriptTail(
    [
      '{"partial":"line"}',
      JSON.stringify({ type: 'compaction', timestamp: '2026-08-04T05:00:00.000Z', summary: 's', tokensBefore: 9 }),
      JSON.stringify({ type: 'branch_summary', timestamp: '2026-08-04T05:01:00.000Z', fromId: 'x', summary: 's' }),
      JSON.stringify({ type: 'custom', timestamp: '2026-08-04T05:02:00.000Z', customType: 'ext', data: {} }),
      JSON.stringify({ type: 'custom_message', timestamp: '2026-08-04T05:03:00.000Z', customType: 'ext', content: 'x' }),
      JSON.stringify({ type: 'label', timestamp: '2026-08-04T05:04:00.000Z', targetId: 'a', label: 'checkpoint' }),
    ].join('\n'),
  );
  assert.deepEqual(records, []);
  assert.equal(lastActivityAt(records), null);
});

test('a half-written final line is skipped, not fatal', () => {
  const text = jsonl(entry({ role: 'user', content: 'hello' })) + '\n{"type":"mess';
  const records = parsePiTranscriptTail(text);
  assert.equal(records.length, 1);
});

test('a whole-file read keeps its first line', () => {
  const text = JSON.stringify(entry({ role: 'user', content: 'first' }));
  assert.equal(parsePiTranscriptTail(text, false).length, 1);
});
