import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UntrackedScan,
  transcriptCwd,
  isPipelineWorktree,
  UNTRACKED_WINDOW_MS,
  SCAN_INTERVAL_MS,
} from '../src/untracked.js';
import { TAIL_BYTES, parseTranscriptTail, summariseTranscript } from '../src/transcript.js';

const NOW = 1_700_000_000_000;

/**
 * A fake filesystem: a flat map of path -> {text, mtimeMs}, with directories
 * inferred from the paths. Injected for the reason everything else here is -
 * a scan that reads the real `~/.claude/projects` is a test whose answer
 * depends on what the developer running it happens to have open.
 *
 * @param {Record<string, {text: string, mtimeMs: number}>} entries
 * @param {string[]} [missingDirs] working directories a transcript names that
 *   are no longer on disk
 */
function fakeFiles(entries, missingDirs = []) {
  const reads = { tail: 0, head: 0, list: 0 };
  const children = (dir) => {
    /** @type {Map<string, boolean>} */
    const found = new Map();
    const prefix = `${dir}/`;
    for (const path of Object.keys(entries)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) found.set(rest, false);
      else found.set(rest.slice(0, slash), true);
    }
    return found;
  };
  return {
    reads,
    files: {
      list(dir) {
        reads.list += 1;
        const found = children(dir);
        if (found.size === 0) throw new Error(`ENOENT: ${dir}`);
        return [...found].map(([name, directory]) => ({ name, directory }));
      },
      stat(path) {
        const entry = entries[path];
        if (!entry) throw new Error(`ENOENT: ${path}`);
        return { mtimeMs: entry.mtimeMs };
      },
      // Every working directory in these fixtures exists unless a test says
      // otherwise.
      directoryExists(path) {
        return !missingDirs.includes(path);
      },
      readTail(path, bytes) {
        reads.tail += 1;
        const entry = entries[path];
        if (!entry) throw new Error(`ENOENT: ${path}`);
        const start = Math.max(0, entry.text.length - bytes);
        return { text: entry.text.slice(start), partial: start > 0 };
      },
      readHead(path, bytes) {
        reads.head += 1;
        const entry = entries[path];
        if (!entry) throw new Error(`ENOENT: ${path}`);
        return entry.text.slice(0, bytes);
      },
    },
  };
}

const ROOTS = [
  { dir: '/home/.claude/projects', agent: 'claude', depth: 1 },
  { dir: '/home/.pi/agent/sessions', agent: 'pi', depth: 1 },
  { dir: '/home/.codex/sessions', agent: 'codex', depth: 3 },
];

const jsonl = (...records) => records.map((r) => `${JSON.stringify(r)}\n`).join('');

/** A Claude Code transcript: `cwd` on every conversation record, so in the tail. */
const claudeTranscript = (cwd) =>
  jsonl(
    { type: 'user', cwd, timestamp: '2026-08-11T04:19:34.697Z', message: { role: 'user', content: [] } },
    { type: 'assistant', cwd, timestamp: '2026-08-11T04:19:39.361Z', message: { role: 'assistant', content: [] } },
  );

/** A pi transcript: one `session` record on line 1, and nothing after it. */
const piTranscript = (cwd) =>
  jsonl(
    { type: 'session', version: 3, id: 'p1', timestamp: '2026-08-11T04:19:34.697Z', cwd },
    { type: 'message', id: 'm1', timestamp: '2026-08-11T04:19:39.361Z', message: { role: 'user', content: [] } },
  );

/** A Codex rollout: `payload.cwd` on the `session_meta` on line 1. */
const codexTranscript = (cwd) =>
  jsonl(
    { timestamp: '2026-08-11T04:08:24.794Z', ordinal: 0, type: 'session_meta', payload: { session_id: 'c1', cwd } },
    { timestamp: '2026-08-11T04:09:24.794Z', ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'user', content: [] } },
  );

function scan(entries, over = {}, missingDirs = []) {
  const { files, reads } = fakeFiles(entries, missingDirs);
  const scanner = new UntrackedScan({
    files,
    roots: ROOTS,
    nmHome: '/home/.no-mistakes',
    ...over,
  });
  return { scanner, reads };
}

test('all three agents are found, each from its own root', () => {
  // A stranger with Codex windows open has exactly the same empty page as one
  // with Claude Code windows open, and Codex has the sharper version of it: its
  // hooks are trust-gated, so a Codex session reports nothing at all until the
  // user approves the hook in Codex's own TUI.
  const { scanner } = scan({
    '/home/.claude/projects/-a-repo/s1.jsonl': { text: claudeTranscript('/a/repo'), mtimeMs: NOW - 1000 },
    '/home/.pi/agent/sessions/--a-other--/2026_p1.jsonl': { text: piTranscript('/a/other'), mtimeMs: NOW - 1000 },
    '/home/.codex/sessions/2026/08/11/rollout-c1.jsonl': { text: codexTranscript('/a/third'), mtimeMs: NOW - 1000 },
  });
  const found = scanner.list({ now: NOW });
  assert.deepEqual(
    found.map((f) => [f.agent, f.cwd]).sort(),
    [
      ['claude', '/a/repo'],
      ['codex', '/a/third'],
      ['pi', '/a/other'],
    ],
  );
});

test('the working directory comes from the tail first and the head second', () => {
  // Measured: Claude Code writes `cwd` on every conversation record, so its tail
  // always has one and its head often does not - the first record carrying one
  // was 172KB in on the worst of 1,396 files on disk. pi and Codex write exactly
  // one, on line 1, and none in the tail at all, so on a rollout longer than the
  // tail window the head is the only place left to look.
  const longCodex =
    codexTranscript('/a/third') +
    jsonl({
      timestamp: '2026-08-11T05:00:00.000Z',
      ordinal: 2,
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(TAIL_BYTES) }] },
    });
  const { scanner, reads } = scan({
    '/home/.claude/projects/-a-repo/s1.jsonl': { text: claudeTranscript('/a/repo'), mtimeMs: NOW - 1000 },
    '/home/.codex/sessions/2026/08/11/rollout-c1.jsonl': { text: longCodex, mtimeMs: NOW - 1000 },
  });
  assert.deepEqual(scanner.list({ now: NOW }).map((f) => f.cwd), ['/a/repo', '/a/third']);
  assert.equal(reads.tail, 2, 'the tail is always tried');
  assert.equal(reads.head, 1, 'and only the long rollout needed the head');
});

test('a working directory is read once and remembered, but a miss is retried', () => {
  // The same rule `nm-state.js` follows for the database appearing under a
  // running monitor: a session's working directory cannot change, so a hit is
  // good forever - while caching the absence would mean never noticing a file
  // that has since written the record we were looking for.
  const entries = {
    '/home/.claude/projects/-a-repo/s1.jsonl': { text: claudeTranscript('/a/repo'), mtimeMs: NOW - 1000 },
    '/home/.claude/projects/-a-repo/s2.jsonl': { text: jsonl({ type: 'mode', mode: 'normal' }), mtimeMs: NOW - 1000 },
  };
  const { files, reads } = fakeFiles(entries);
  const scanner = new UntrackedScan({ files, roots: ROOTS, nmHome: '/home/.no-mistakes', intervalMs: 0 });

  assert.equal(scanner.list({ now: NOW }).length, 1, 'the file with no cwd yields no row');
  const afterFirst = reads.tail;
  scanner.list({ now: NOW });
  assert.equal(reads.tail, afterFirst + 1, 'only the unresolved file is read again');

  entries['/home/.claude/projects/-a-repo/s2.jsonl'].text = claudeTranscript('/a/later');
  assert.equal(scanner.list({ now: NOW }).length, 2, 'and it is picked up once it says');
});

test('a transcript older than the window is not a session anybody has open', () => {
  const { scanner } = scan({
    '/home/.claude/projects/-a-repo/fresh.jsonl': { text: claudeTranscript('/a/repo'), mtimeMs: NOW - 1000 },
    '/home/.claude/projects/-a-old/stale.jsonl': {
      text: claudeTranscript('/a/old'),
      mtimeMs: NOW - UNTRACKED_WINDOW_MS - 1,
    },
  });
  assert.deepEqual(scanner.list({ now: NOW }).map((f) => f.cwd), ['/a/repo']);
});

test('a hook record supersedes the scan, and it is rechecked on every call', () => {
  // Superseded *the instant* a hook record arrives, which is the half of this
  // that a stranger actually watches happen: they restart a session and the grey
  // row becomes a real one. Waiting for the next walk would make that take up to
  // half a minute for no reason.
  const path = '/home/.claude/projects/-a-repo/s1.jsonl';
  const { scanner, reads } = scan({ [path]: { text: claudeTranscript('/a/repo'), mtimeMs: NOW - 1000 } });
  assert.equal(scanner.list({ now: NOW }).length, 1);
  const walks = reads.list;
  assert.equal(scanner.list({ now: NOW, registeredPaths: new Set([path]) }).length, 0);
  assert.equal(reads.list, walks, 'and without walking the tree again to find out');
});

test('the walk is repeated on an interval, not on every poll', () => {
  const entries = {
    '/home/.claude/projects/-a-repo/s1.jsonl': { text: claudeTranscript('/a/repo'), mtimeMs: NOW - 1000 },
  };
  const { files, reads } = fakeFiles(entries);
  const scanner = new UntrackedScan({ files, roots: ROOTS, nmHome: '/home/.no-mistakes' });
  scanner.list({ now: NOW });
  const walks = reads.list;
  scanner.list({ now: NOW + SCAN_INTERVAL_MS - 1 });
  assert.equal(reads.list, walks, 'inside the interval the last answer stands');

  entries['/home/.claude/projects/-a-repo/s2.jsonl'] = {
    text: claudeTranscript('/a/second'),
    mtimeMs: NOW - 1000,
  };
  assert.equal(scanner.list({ now: NOW + SCAN_INTERVAL_MS - 1 }).length, 1);
  // A session can become untracked while the monitor runs - a Codex hook still
  // waiting to be trusted is the standing example - so the walk does repeat.
  assert.equal(scanner.list({ now: NOW + SCAN_INTERVAL_MS }).length, 2);
});

test("no-mistakes' own pipeline agents are never rows", () => {
  // They are the dominant population of unregistered recent transcripts - 14 of
  // 16 on the machine this was measured on - and each would arrive as a card
  // titled with a bare run id that nobody can focus.
  const { scanner } = scan({
    '/home/.claude/projects/-nm-worktree/agent.jsonl': {
      text: claudeTranscript('/home/.no-mistakes/worktrees/3c92/01KZQE1X'),
      mtimeMs: NOW - 1000,
    },
    '/home/.claude/projects/-a-repo/s1.jsonl': { text: claudeTranscript('/a/repo'), mtimeMs: NOW - 1000 },
  });
  assert.deepEqual(scanner.list({ now: NOW }).map((f) => f.cwd), ['/a/repo']);
});

test('the pipeline exclusion is a path test, so a finished run is still covered', () => {
  // `matchRunForAgentCwd` is the documented way to place a pipeline agent and
  // the wrong tool here: a run that finished half an hour ago has left the runs
  // reading while its worktree transcript is still inside our window, so there
  // is no run left to match against. A path test needs none.
  assert.equal(isPipelineWorktree('/home/.no-mistakes/worktrees/ab/01K', '/home/.no-mistakes'), true);
  assert.equal(isPipelineWorktree('/home/.no-mistakes', '/home/.no-mistakes'), true);
  assert.equal(isPipelineWorktree('/home/.no-mistakes-other/repo', '/home/.no-mistakes'), false);
  assert.equal(isPipelineWorktree('/a/repo', '/home/.no-mistakes'), false);
});

test('an agent that is not installed is silence, not an error', () => {
  // The same terms no-mistakes and Lavish are held to: no warning, no
  // subprocess, and nothing on the page saying an integration is missing.
  const { scanner } = scan({
    '/home/.claude/projects/-a-repo/s1.jsonl': { text: claudeTranscript('/a/repo'), mtimeMs: NOW - 1000 },
  });
  assert.deepEqual(scanner.list({ now: NOW }).map((f) => f.agent), ['claude']);
});

test('a root with nothing in it at all yields nothing at all', () => {
  const { files } = fakeFiles({ '/elsewhere/thing.jsonl': { text: '', mtimeMs: NOW } });
  const scanner = new UntrackedScan({ files, roots: ROOTS, nmHome: '/home/.no-mistakes' });
  assert.deepEqual(scanner.list({ now: NOW }), []);
});

test('each root is walked to exactly its own depth', () => {
  // Claude Code writes a subdirectory beside some transcripts and Codex
  // partitions three levels down, so a free recursion would pick up whatever
  // either of them puts in there next.
  const { scanner } = scan({
    '/home/.claude/projects/-a-repo/nested/deep.jsonl': { text: claudeTranscript('/a/deep'), mtimeMs: NOW },
    '/home/.claude/projects/loose.jsonl': { text: claudeTranscript('/a/loose'), mtimeMs: NOW },
    '/home/.codex/sessions/2026/08/11/rollout-c1.jsonl': { text: codexTranscript('/a/third'), mtimeMs: NOW },
    '/home/.codex/sessions/2026/stray.jsonl': { text: codexTranscript('/a/stray'), mtimeMs: NOW },
  });
  assert.deepEqual(scanner.list({ now: NOW }).map((f) => f.cwd), ['/a/third']);
});

test('a file that is not JSONL, or names no absolute path, produces no row', () => {
  const { scanner } = scan({
    '/home/.claude/projects/-a-repo/notes.txt': { text: 'not a transcript', mtimeMs: NOW },
    '/home/.claude/projects/-a-repo/relative.jsonl': {
      text: jsonl({ type: 'user', cwd: 'work/repo' }),
      mtimeMs: NOW,
    },
    '/home/.claude/projects/-a-repo/broken.jsonl': { text: '{not json\n{"also', mtimeMs: NOW },
  });
  assert.deepEqual(scanner.list({ now: NOW }), []);
});

test('a working directory that is no longer there produces no row', () => {
  // `GitBranch` walks up from whatever it is handed until something answers to
  // `.git`, so a deleted worktree takes the branch of some ancestor repo - and
  // on a machine where `$HOME` is itself a checkout, that is every deleted path.
  // Seen while eyeballing the manual run: a card for a directory that does not
  // exist, confidently labelled `master`. A row may know nothing; it may not
  // name the wrong branch.
  const { scanner } = scan({
    '/home/.claude/projects/-a-gone/s1.jsonl': { text: claudeTranscript('/a/deleted'), mtimeMs: NOW },
    '/home/.claude/projects/-a-repo/s2.jsonl': { text: claudeTranscript('/a/repo'), mtimeMs: NOW },
  }, {}, ['/a/deleted']);
  assert.deepEqual(scanner.list({ now: NOW }).map((f) => f.cwd), ['/a/repo']);
});

test('transcriptCwd takes the newest absolute path and ignores anything else', () => {
  assert.equal(transcriptCwd([{ cwd: '/first' }, { cwd: '/second' }]), '/second');
  assert.equal(transcriptCwd([{ cwd: '/first' }, { type: 'mode' }]), '/first');
  assert.equal(transcriptCwd([{ payload: { cwd: '/meta' } }]), '/meta');
  assert.equal(transcriptCwd([{ cwd: 'relative' }, { cwd: 42 }, { cwd: null }]), null);
  assert.equal(transcriptCwd([]), null);
});

test('a quiet transcript cannot tell a finished turn from a session waiting on a human', () => {
  /*
   * This is the measurement that decided the whole shape of an untracked row,
   * and it is a test rather than a paragraph because the day it stops being
   * true is the day this design should be revisited.
   *
   * Three things a reader would want told apart, as they actually appear on
   * disk. Read live from the registry on 11/08/2026: a session recorded
   * `blocked`/`idle_prompt` ended `user(tool_result) → assistant(text) →
   * system → system`, and a session recorded `working` in another repo ended
   * the same way. And per RAI-11's capture, Claude Code does not flush a pending
   * `tool_use` until the tool resolves - two dialogs confirmed open on screen,
   * absent from the file 30s and 46s later - so a session stopped at a
   * permission prompt writes nothing about it either.
   *
   * So there is no state word an untracked row could choose that is not a
   * one-in-four guess presented as a fact.
   */
  // The turn ended: the last tool returned and Claude replied.
  const finishedTurn = parseTranscriptTail(
    jsonl(
      { type: 'user', timestamp: '2026-08-11T04:19:34.697Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
      { type: 'assistant', timestamp: '2026-08-11T04:19:46.981Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ),
    false,
  );
  // Sixty seconds later, the idle nudge fired. It is a timer inside Claude Code
  // and it writes nothing, so the file has not changed.
  const onIdleNudge = parseTranscriptTail(
    jsonl(
      { type: 'user', timestamp: '2026-08-11T04:19:34.697Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
      { type: 'assistant', timestamp: '2026-08-11T04:19:46.981Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ),
    false,
  );
  // A permission dialog is open on screen for the *next* tool. Per RAI-11 the
  // pending `tool_use` is not flushed until the tool resolves, so it is not
  // here. If Claude Code ever starts flushing eagerly this fixture gains a
  // record, this assertion fails, and that is the signal to revisit the design
  // rather than to change the fixture back.
  const atPermissionPrompt = parseTranscriptTail(
    jsonl(
      { type: 'user', timestamp: '2026-08-11T04:19:34.697Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
      { type: 'assistant', timestamp: '2026-08-11T04:19:46.981Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ),
    false,
  );

  const summaries = [finishedTurn, onIdleNudge, atPermissionPrompt].map((r) =>
    summariseTranscript(r, 'main'),
  );
  for (const summary of summaries) {
    assert.equal(summary.activity, null, 'nothing is in flight in any of the three');
  }
  assert.deepEqual(summaries[0], summaries[1], 'finished and nudged are one file');
  assert.deepEqual(summaries[0], summaries[2], 'and so is stopped at a permission prompt');
});

test('a dangling tool call is not evidence of a session that is still alive', () => {
  /*
   * The one signature that *does* stand out - a `tool_use` with no result - is
   * also exactly what a session killed mid-tool leaves behind for ever. Every
   * other row on this page survives that because `registry.list` probes
   * `host.pid`; an untracked row has no pid by definition, a pid being something
   * only a hook reports. So `working` is not the safe fallback either.
   */
  const killedMidTool = parseTranscriptTail(
    jsonl(
      { type: 'assistant', timestamp: '2026-08-11T04:19:39.361Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 600' } }] } },
    ),
    false,
  );
  const summary = summariseTranscript(killedMidTool, 'main');
  assert.equal(summary.activity, 'Running sleep', 'it reads as busy...');
  // ...and would read exactly the same an hour after the window closed, which is
  // why an untracked row does not carry `activity` at all. See `buildRows`.
});
