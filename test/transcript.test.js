import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTranscriptTail,
  runningToolUse,
  lavishPollTarget,
  describeToolUse,
  summariseTranscript,
  recentEvents,
  EVENT_TEXT_CHARS,
  pullRequestFromRecords,
  lastActivityAt,
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
    pullRequest: null,
  });
});

// ---------------------------------------------------------------- recentEvents

const said = (role, text, over = {}) => ({
  type: role === 'you' ? 'user' : 'assistant',
  timestamp: '2026-08-03T01:00:00.000Z',
  message: { content: [{ type: 'text', text }] },
  ...over,
});

test('recentEvents tells apart who said what', () => {
  const events = recentEvents([said('you', 'make the ramp drain'), said('claude', 'Done.')]);
  assert.deepEqual(
    events.map((e) => [e.kind, e.text]),
    [
      ['you', 'make the ramp drain'],
      ['claude', 'Done.'],
    ],
  );
});

test('recentEvents reports a tool with how it turned out, matched on id', () => {
  // Parallel tools return out of order, so the nth result is not the nth call.
  // Matching on position would attribute one tool's failure to another.
  const events = recentEvents([
    toolUse('a', 'Bash', { description: 'run the tests' }),
    toolUse('b', 'Read', { file_path: '/x/server.js' }),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b' }] } },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true }] },
    },
  ]);
  assert.deepEqual(
    events.map((e) => [e.label, e.text, e.outcome]),
    [
      ['Bash', 'run the tests', 'error'],
      ['Read', 'Reading server.js', 'ok'],
    ],
  );
});

test('a tool with no result yet is the one still running', () => {
  const events = recentEvents([toolUse('a', 'Bash', { description: 'npm test' })]);
  assert.equal(events[0].outcome, 'running');
});

test('recentEvents leaves out what a person did not say', () => {
  // Claude Code puts a lot through the user role that nobody typed: injected
  // skill text, the caveat and stdout around a slash command, and the
  // notification a finished subagent posts back. Labelling those "you" would
  // be a plain lie about who said what.
  const events = recentEvents([
    said('you', 'Base directory for this skill: /x', { isMeta: true }),
    said('you', '<command-name>/exit</command-name>'),
    said('you', '<local-command-stdout>(no content)</local-command-stdout>'),
    said('you', '<task-notification>\n<task-id>abc</task-id>'),
    said('you', 'the real thing I typed'),
  ]);
  assert.deepEqual(
    events.map((e) => e.text),
    ['the real thing I typed'],
  );
});

test("a subagent's conversation does not get attributed to the main one", () => {
  // Sidechain records share the file with the main conversation. Interleaving
  // them reads as though two conversations were one, and puts an agent's
  // prompts under the human's name.
  const events = recentEvents([
    said('you', 'a prompt to a subagent', { isSidechain: true }),
    said('claude', 'a subagent reply', { isSidechain: true }),
    said('you', 'the actual prompt'),
  ]);
  assert.deepEqual(
    events.map((e) => e.text),
    ['the actual prompt'],
  );
});

test('recentEvents leaves out thinking', () => {
  const events = recentEvents([
    {
      type: 'assistant',
      timestamp: '2026-08-03T01:00:00.000Z',
      message: { content: [{ type: 'thinking', thinking: 'a long internal monologue' }] },
    },
    said('claude', 'the reply'),
  ]);
  assert.deepEqual(
    events.map((e) => e.text),
    ['the reply'],
  );
});

test('a long entry is clipped rather than allowed to swamp the card', () => {
  const events = recentEvents([said('you', 'x'.repeat(EVENT_TEXT_CHARS + 200))]);
  assert.equal(events[0].truncated, true);
  assert.equal(events[0].text.length, EVENT_TEXT_CHARS + 1, 'the ellipsis is the extra character');
});

test('recentEvents collapses whitespace so one entry stays one line', () => {
  const events = recentEvents([said('you', '  line one\n\n   line two  ')]);
  assert.equal(events[0].text, 'line one line two');
  assert.equal(events[0].truncated, false);
});

test('recentEvents returns the newest entries, oldest first', () => {
  const events = recentEvents(
    [1, 2, 3, 4, 5].map((n) => said('claude', 'reply ' + n)),
    2,
  );
  assert.deepEqual(
    events.map((e) => e.text),
    ['reply 4', 'reply 5'],
  );
});

test('recentEvents carries the timestamp, and copes without one', () => {
  const events = recentEvents([
    said('claude', 'stamped'),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'unstamped' }] } },
  ]);
  assert.equal(events[0].at, Date.parse('2026-08-03T01:00:00.000Z'));
  assert.equal(events[1].at, null);
});

test('recentEvents claims nothing about an empty transcript', () => {
  assert.deepEqual(recentEvents([]), []);
});

// ------------------------------------------------------- pull request sightings

test('a PR the session opened is found, with the state printed beside it', () => {
  // The real shape: a CLI tool result carrying the URL and the state together.
  // This is a genuine observation with a timestamp, unlike the database's,
  // which freezes the moment its run ends.
  const found = pullRequestFromRecords([
    {
      type: 'user',
      timestamp: '2026-08-03T03:27:57.000Z',
      message: {
        content: [
          {
            type: 'tool_result',
            content:
              'PR #40: https://bitbucket.org/mattw_watson/hexbattle/pull-requests/40\nstate=OPEN title=HXB-63',
          },
        ],
      },
    },
  ]);
  assert.equal(found.url, 'https://bitbucket.org/mattw_watson/hexbattle/pull-requests/40');
  assert.equal(found.number, 40);
  assert.equal(found.slug, 'hexbattle');
  assert.equal(found.state, 'open');
  assert.equal(found.observedAt, Date.parse('2026-08-03T03:27:57.000Z'));
});

test('a PR mentioned in prose counts too, and GitHub is read the same way', () => {
  const found = pullRequestFromRecords([
    {
      type: 'assistant',
      timestamp: '2026-08-03T03:29:22.000Z',
      message: {
        content: [
          {
            type: 'text',
            text: 'Pushed and PR opened: **[firstmate #22](https://github.com/mattwwatson/firstmate/pull/22)** - 17 commits.',
          },
        ],
      },
    },
  ]);
  assert.equal(found.number, 22);
  assert.equal(found.slug, 'firstmate');
  assert.equal(found.state, null, 'prose said nothing about the state, so neither do we');
});

test('the newest sighting wins, since a session can touch several', () => {
  const at = (n) => `2026-08-03T0${n}:00:00.000Z`;
  const found = pullRequestFromRecords([
    { type: 'assistant', timestamp: at(1), message: { content: [{ type: 'text', text: 'https://github.com/x/repo/pull/1' }] } },
    { type: 'assistant', timestamp: at(2), message: { content: [{ type: 'text', text: 'https://github.com/x/repo/pull/2' }] } },
  ]);
  assert.equal(found.number, 2);
});

test('a state from some other record is not attached to this URL', () => {
  // `state=MERGED` three records earlier is about something else entirely.
  const found = pullRequestFromRecords([
    { type: 'assistant', timestamp: '2026-08-03T01:00:00.000Z', message: { content: [{ type: 'text', text: 'state=MERGED' }] } },
    { type: 'assistant', timestamp: '2026-08-03T02:00:00.000Z', message: { content: [{ type: 'text', text: 'https://github.com/x/repo/pull/5' }] } },
  ]);
  assert.equal(found.state, null);
});

test('a transcript with no pull request in it says so', () => {
  assert.equal(pullRequestFromRecords([]), null);
  assert.equal(
    pullRequestFromRecords([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'https://example.com/docs' }] } },
    ]),
    null,
  );
});

test('a table of past runs is a listing, not a sighting', () => {
  // Verbatim from a real transcript: the no-mistakes skill injects a summary of
  // the last ten runs, each row carrying its own pull request. Taking the first
  // URL out of that put an unrelated PR from another branch on the card - the
  // exact "confident link to the wrong review" this must never do.
  const table = [
    'repo: /Users/mattw/work/hexbattle',
    'current_branch: HXB-63-front-of-house',
    'runs[10]{id,branch,status,head,pr}:',
    '  "01KYS2X5M2TF78NE5DAQ6TXPRK",HXB-58-last-player-standing-wins,completed,6b37f6e1,"https://bitbucket.org/mattw_watson/hexbattle/pull-requests/36"',
    '  "01KYRQTXT5K0CV7Q8N",HXB-57-netgame-fog-unwired,completed,aa11bb22,"https://bitbucket.org/mattw_watson/hexbattle/pull-requests/34"',
  ].join('\n');
  const records = [
    {
      type: 'user',
      timestamp: '2026-08-03T05:27:47.000Z',
      message: { content: [{ type: 'text', text: table }] },
    },
  ];
  assert.equal(pullRequestFromRecords(records, 'HXB-63-front-of-house'), null);
});

test('but a row of that table for our own branch is exactly the answer', () => {
  const table = [
    'runs[2]{id,branch,status,head,pr}:',
    '  "01A",HXB-58-last-player-standing-wins,completed,6b37f6e1,"https://bitbucket.org/x/hexbattle/pull-requests/36"',
    '  "01B",HXB-63-front-of-house,completed,cc33dd44,"https://bitbucket.org/x/hexbattle/pull-requests/40"',
  ].join('\n');
  const found = pullRequestFromRecords(
    [{ type: 'user', timestamp: '2026-08-03T05:27:47.000Z', message: { content: [{ type: 'text', text: table }] } }],
    'HXB-63-front-of-house',
  );
  assert.equal(found.number, 40);
});

test('a lone pull request in a record is taken even with no branch named', () => {
  // The "PR opened" case: one URL, and the branch is not on the same line.
  const found = pullRequestFromRecords(
    [
      {
        type: 'user',
        timestamp: '2026-08-03T03:27:57.000Z',
        message: {
          content: [
            {
              type: 'tool_result',
              content: 'PR #40: https://bitbucket.org/x/hexbattle/pull-requests/40\nstate=OPEN title=HXB-63',
            },
          ],
        },
      },
    ],
    'HXB-63-front-of-house',
  );
  assert.equal(found.number, 40);
  assert.equal(found.state, 'open');
});

test('an away summary is not evidence that a session is working', () => {
  // Claude Code writes `system`/`away_summary` records precisely BECAUSE the
  // human is away, and they carry a timestamp. Counting them moved
  // lastActivityAt forward on a session doing nothing, which then disproved a
  // real block and rendered an idle session as "Working" - the one signal this
  // tool exists to give, inverted. Observed live at 199s and 191s into a quiet
  // stretch.
  const records = [
    { type: 'assistant', timestamp: '2026-08-03T06:26:30.000Z', message: { content: [{ type: 'text', text: 'done' }] } },
    { type: 'system', subtype: 'away_summary', timestamp: '2026-08-03T06:29:49.000Z' },
  ];
  assert.equal(lastActivityAt(records), Date.parse('2026-08-03T06:26:30.000Z'));
});

test('lastActivityAt counts the conversation, and only the conversation', () => {
  // A whitelist of assistant/user rather than a denylist of the metadata types,
  // because the conversation is the stable shape of a transcript while the
  // ancillary types keep being added - away_summary, file-history-delta,
  // attachment and permission-mode all arrived after this code was written.
  const at = '2026-08-03T07:00:00.000Z';
  assert.equal(lastActivityAt([{ type: 'assistant', timestamp: at, message: { content: [] } }]), Date.parse(at));
  assert.equal(lastActivityAt([{ type: 'user', timestamp: at, message: { content: [] } }]), Date.parse(at));
  for (const type of ['system', 'file-history-delta', 'attachment', 'permission-mode']) {
    assert.equal(lastActivityAt([{ type, timestamp: at }]), null, `${type} is not activity`);
  }
});

test('a granted permission is still disproved by the work that follows', () => {
  // The case blockDisproved exists for must keep working: Claude carries on
  // writing assistant records after the prompt is answered.
  const records = [
    { type: 'assistant', timestamp: '2026-08-03T06:00:00.000Z', message: { content: [] } },
    { type: 'assistant', timestamp: '2026-08-03T06:05:00.000Z', message: { content: [] } },
  ];
  assert.equal(lastActivityAt(records), Date.parse('2026-08-03T06:05:00.000Z'));
});
