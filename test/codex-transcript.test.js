/**
 * Codex's rollout, normalised.
 *
 * Every fixture line here is a real one, trimmed of the bulk it carries in the
 * file - captured from codex-cli 0.147.0 on 11/08/2026 and recorded in
 * `docs/tasks/RAI-21-codex-sessions.md`. They are quoted rather than invented
 * because the whole risk in this module is being wrong about a format nobody
 * here controls, and a fixture written from the same guess as the code proves
 * only that the guess is self-consistent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCodexTranscriptTail,
  normaliseCodexLine,
  describeExecSnippet,
  stringArgument,
  codexToolName,
} from '../src/codex-transcript.js';
import { summariseTranscript, lastActivityAt, runningToolUse } from '../src/transcript.js';

/** One rollout line, with the envelope every one of them carries. */
function line(payload, timestamp = '2026-08-11T01:55:49.372Z', type = 'response_item') {
  return JSON.stringify({ type, timestamp, ordinal: 1, payload });
}

const USER = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const ASSISTANT = (text) => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text }],
  phase: 'commentary',
});

/** The real shape of a shell call in code mode: a JS snippet, not arguments. */
const EXEC_CALL = (cmd, callId = 'call_1') => ({
  type: 'custom_tool_call',
  id: 'ctc_1',
  status: 'completed',
  call_id: callId,
  name: 'exec',
  input: `const r = await tools.exec_command({cmd:"${cmd}",workdir:"/repo",yield_time_ms:10000});\ntext(r.output);\n`,
});

const EXEC_OUTPUT = (text, callId = 'call_1') => ({
  type: 'custom_tool_call_output',
  id: 'ctco_1',
  call_id: callId,
  output: [
    { type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' },
    { type: 'input_text', text },
  ],
});

/** Parse a whole-file fixture: nothing is cut, so no first line is dropped. */
function parse(lines) {
  return parseCodexTranscriptTail(lines.join('\n'), false);
}

// --------------------------------------------------------------- the envelope

test('only response_item is the conversation, because event_msg restates it', () => {
  // The trap this whole module is shaped around. Codex writes every turn twice:
  // once as a `response_item` and again as an `event_msg` carrying its own
  // timestamp. Counting both would double every turn and, far worse, would keep
  // moving `lastActivityAt` from records nobody spoke.
  const records = parse([
    line(USER('do the thing'), '2026-08-11T01:00:00.000Z'),
    line({ type: 'user_message', message: 'do the thing' }, '2026-08-11T01:00:00.100Z', 'event_msg'),
    line(ASSISTANT('on it'), '2026-08-11T01:00:01.000Z'),
    line({ type: 'agent_message', message: 'on it' }, '2026-08-11T01:00:01.100Z', 'event_msg'),
  ]);
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((r) => r.type),
    ['user', 'assistant'],
  );
});

test('session metadata carries a timestamp and is still not activity', () => {
  // `away_summary` and pi's `model_change` in a third dialect. These are written
  // at startup and say nothing about whether anyone is working, so counting one
  // would move an idle session forward and disprove a block that is real.
  const records = parse([
    line(USER('hello'), '2026-08-11T01:00:00.000Z'),
    line({ session_id: 'x', cwd: '/repo' }, '2026-08-11T02:00:00.000Z', 'session_meta'),
    line({ approval_policy: 'on-request' }, '2026-08-11T02:00:00.000Z', 'turn_context'),
    line({ full: true, state: {} }, '2026-08-11T02:00:00.000Z', 'world_state'),
    line({ type: 'token_count', info: {} }, '2026-08-11T02:00:00.000Z', 'event_msg'),
  ]);
  assert.equal(lastActivityAt(records), Date.parse('2026-08-11T01:00:00.000Z'));
});

test('a reasoning record is dropped, encrypted content and all', () => {
  const records = parse([
    line({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAAA…' }),
  ]);
  assert.deepEqual(records, []);
});

test('a half-written final line is skipped rather than throwing', () => {
  const records = parseCodexTranscriptTail(`${line(USER('hi'))}\n{"type":"response_i`, false);
  assert.equal(records.length, 1);
});

test('the first line of a tail read is dropped, since it is cut in half', () => {
  const records = parseCodexTranscriptTail([line(USER('a')), line(USER('b'))].join('\n'));
  assert.equal(records.length, 1);
  assert.equal(records[0].message.content[0].text, 'b');
});

// ------------------------------------------------------------------ the roles

test('developer turns are Codex talking to itself, not the conversation', () => {
  // Codex injects skills instructions, a multi-agent preamble and plugin
  // instructions under this role - mid-turn as well as at startup.
  const records = parse([
    line({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: '<skills_instructions>\n## Skills\n…' }],
    }),
  ]);
  assert.deepEqual(records, []);
});

test('the one injection that arrives as a user turn is dropped by its tag', () => {
  // `<recommended_plugins>` has the same role and the same content shape as a
  // typed prompt, so there is nothing structural to tell them apart. Showing it
  // as something the human said would be a plain lie about who spoke.
  const records = parse([
    line(USER('<recommended_plugins>\nHere is a list of plugins…\n</recommended_plugins>')),
    line(USER('now do the actual work')),
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].message.content[0].text, 'now do the actual work');
});

test('a prompt that merely starts with a tag is still the human speaking', () => {
  const records = parse([line(USER('<div> is not rendering, fix it'))]);
  assert.equal(records.length, 1);
});

// ------------------------------------------------------------- the tool calls

test('a code-mode exec call becomes a Bash tool_use with the command lifted out', () => {
  // Without this every card reads the same bare word, and - the part that
  // matters - a session sitting in a `lavish-axi poll` is invisible.
  const records = parse([line(EXEC_CALL('ls package.json'))]);
  const running = runningToolUse(records);
  assert.deepEqual(running, { name: 'Bash', input: { command: 'ls package.json' } });
});

test('a call with no result yet is what the session is doing', () => {
  // Measured on a 25-second command: the call record lands when the call is
  // issued and its output eleven seconds later, with nothing in between. That
  // gap is the only thing that can disprove a stale block on Codex.
  const records = parse([line(EXEC_CALL('sleep 25 && echo slept'))]);
  assert.equal(summariseTranscript(records).activity, 'Running sleep');
});

test('the status field says completed while the tool is still running, and is not read', () => {
  // Codex writes `status: "completed"` at the moment the call is issued. It is
  // a lie about progress; the id match against the output is the only truth.
  const midFlight = parse([line({ ...EXEC_CALL('sleep 25'), status: 'completed' })]);
  assert.equal(runningToolUse(midFlight)?.name, 'Bash');

  const finished = parse([line(EXEC_CALL('sleep 25')), line(EXEC_OUTPUT('slept\n'))]);
  assert.equal(runningToolUse(finished), null);
});

test('results are matched on call_id, never on position', () => {
  const records = parse([
    line(EXEC_CALL('first', 'call_a')),
    line(EXEC_CALL('second', 'call_b')),
    line(EXEC_OUTPUT('done', 'call_b')),
  ]);
  assert.equal(runningToolUse(records)?.input.command, 'first');
});

test('a returning tool is the session working, so its output is a user record', () => {
  const records = parse([
    line(EXEC_CALL('ls'), '2026-08-11T01:00:00.000Z'),
    line(EXEC_OUTPUT('package.json\n'), '2026-08-11T01:00:05.000Z'),
  ]);
  assert.equal(records[1].type, 'user');
  assert.equal(lastActivityAt(records), Date.parse('2026-08-11T01:00:05.000Z'));
});

test('a lavish-axi poll inside a snippet is still a review gate', () => {
  // The reason the command has to be lifted out at all. A Codex session sitting
  // in a poll is waiting on a person who has lost the browser tab.
  const records = parse([line(EXEC_CALL('lavish-axi poll .lavish/plan.html'))]);
  assert.equal(summariseTranscript(records).lavishFile, '.lavish/plan.html');
});

test('a function_call is the other tool shape, with JSON arguments', () => {
  const records = parse([
    line({
      type: 'function_call',
      id: 'fc_1',
      name: 'wait',
      arguments: '{"cell_id":"1","yield_time_ms":20000}',
      call_id: 'call_w',
    }),
  ]);
  assert.deepEqual(runningToolUse(records), {
    name: 'Wait',
    input: { cell_id: '1', yield_time_ms: 20000 },
  });
});

test('unparseable function_call arguments cost a target, never a read', () => {
  const records = parse([
    line({ type: 'function_call', name: 'wait', arguments: '{not json', call_id: 'c' }),
  ]);
  assert.deepEqual(runningToolUse(records), { name: 'Wait', input: {} });
});

test('a function_call_output resolves its call the same way', () => {
  const records = parse([
    line({ type: 'function_call', name: 'wait', arguments: '{}', call_id: 'call_w' }),
    line({
      type: 'function_call_output',
      call_id: 'call_w',
      output: [{ type: 'input_text', text: 'slept\n' }],
    }),
  ]);
  assert.equal(runningToolUse(records), null);
});

// ---------------------------------------------------------- reading a snippet

test('the shell call wins wherever it sits in a snippet with several calls', () => {
  // Real shape: a plan update and a command issued in one call. The command is
  // what a human wants to see.
  const described = describeExecSnippet(
    'const p = await tools.update_plan({plan:[{step:"a",status:"in_progress"}]});\n' +
      'const r = await tools.exec_command({cmd:"sed -n \'1,5p\' package.json",workdir:"/repo"});\n',
  );
  assert.deepEqual(described, { name: 'Bash', input: { command: "sed -n '1,5p' package.json" } });
});

test('a snippet with no shell call is named after the tool it does call', () => {
  const described = describeExecSnippet('const p = await tools.update_plan({explanation:"done"});');
  assert.deepEqual(described, { name: 'Update plan', input: {} });
});

test('a snippet calling nothing recognisable still names something', () => {
  // Code mode allows a bare snippet. Saying nothing at all would leave the card
  // blank for a session that is plainly working.
  assert.deepEqual(describeExecSnippet('1 + 1'), { name: 'Bash', input: {} });
});

test('a command containing a quote is not truncated at it', () => {
  assert.equal(
    stringArgument(String.raw`{cmd:"git commit -m \"fix: the thing\"",workdir:"/repo"}`, 'cmd'),
    'git commit -m "fix: the thing"',
  );
});

test('all three quote styles are read, because the model picks freely', () => {
  assert.equal(stringArgument("{cmd:'ls -la'}", 'cmd'), 'ls -la');
  assert.equal(stringArgument('{cmd:`ls -la`}', 'cmd'), 'ls -la');
  assert.equal(stringArgument('{"cmd": "ls -la"}', 'cmd'), 'ls -la');
});

test('a command cut off by the tail window keeps the part that was read', () => {
  assert.equal(stringArgument('{cmd:"npm run build && npm te', 'cmd'), 'npm run build && npm te');
});

test('an absent key says so rather than reading the next string along', () => {
  assert.equal(stringArgument('{workdir:"/repo"}', 'cmd'), null);
});

test('only the shell tool is mapped; the rest keep their own names, made legible', () => {
  assert.equal(codexToolName('exec_command'), 'Bash');
  assert.equal(codexToolName('update_plan'), 'Update plan');
  assert.equal(codexToolName(''), '');
});

// ----------------------------------------------------------------- the whole

test('a whole turn summarises the way the other two agents do', () => {
  const records = parse([
    line({ session_id: 'x' }, '2026-08-11T01:00:00.000Z', 'session_meta'),
    line(
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '<skills_instructions>…' }],
      },
      '2026-08-11T01:00:00.000Z',
    ),
    line(USER('run the tests'), '2026-08-11T01:00:01.000Z'),
    line(ASSISTANT('Running them now.'), '2026-08-11T01:00:02.000Z'),
    line(EXEC_CALL('npm test'), '2026-08-11T01:00:03.000Z'),
  ]);
  const summary = summariseTranscript(records);
  assert.equal(summary.activity, 'Running npm');
  assert.equal(summary.lastActivityAt, Date.parse('2026-08-11T01:00:03.000Z'));
  // Codex writes no title of any kind - `threads.title` in its own database is
  // the first user message verbatim - so a Codex card is carried by its
  // activity line, exactly as a pi card is.
  assert.equal(summary.title, null);
  assert.equal(summary.sessionName, null);
});

test('a pull request the session reported is found, with the same guards', () => {
  const records = parse([
    line(EXEC_CALL('gh pr create', 'call_p')),
    line(
      EXEC_OUTPUT('https://github.com/acme/raise/pull/42\nstate=OPEN\n', 'call_p'),
      '2026-08-11T01:00:05.000Z',
    ),
  ]);
  const { pullRequest } = summariseTranscript(records, 'RAI-21-codex-sessions');
  assert.equal(pullRequest.url, 'https://github.com/acme/raise/pull/42');
  assert.equal(pullRequest.slug, 'raise');
  assert.equal(pullRequest.state, 'open');
});

test('a listing of several pull requests is worth nothing here too', () => {
  const records = parse([
    line(
      EXEC_OUTPUT(
        'https://github.com/acme/raise/pull/1\nhttps://github.com/acme/raise/pull/2\n',
        'call_p',
      ),
    ),
  ]);
  assert.equal(summariseTranscript(records, 'some-branch').pullRequest, null);
});

test('a line that is not an object claims nothing', () => {
  assert.equal(normaliseCodexLine(null), null);
  assert.equal(normaliseCodexLine({ type: 'response_item' }), null);
  assert.equal(normaliseCodexLine({ type: 'response_item', payload: { type: 'unknown' } }), null);
});
