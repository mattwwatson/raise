import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseProcessTable, pollsBySession, PollWatch } from '../src/poll-watch.js';

// The real chain, taken from a live session: the poll, the shell Claude Code
// spawned to run it, and the agent itself - which is the pid the registry
// already stores for focusing.
const PS = `
86739 86737 node /opt/homebrew/bin/lavish-axi poll /repo/.lavish/plan.html
86737 73146 /bin/zsh -c eval 'lavish-axi poll /repo/.lavish/plan.html 2>&1 | tail -40'
73146 73085 claude
73085 29202 -zsh
29202     1 tmux -CC new -s firstmate
  501     1 /usr/libexec/somethingelse
`;

test('parseProcessTable reads pid, ppid and the full argument vector', () => {
  const table = parseProcessTable(PS);
  assert.equal(table.size, 6);
  assert.equal(table.get(86739).ppid, 86737);
  assert.match(table.get(73146).args, /^claude$/);
});

test('parseProcessTable ignores anything that is not a process line', () => {
  const table = parseProcessTable('  PID  PPID ARGS\nnot a process\n\n 12 1 real\n');
  assert.equal(table.size, 1);
  assert.equal(table.get(12).args, 'real');
});

test('a poll is attributed to the session that launched it', () => {
  const polls = pollsBySession(parseProcessTable(PS), new Set([73146]));
  assert.deepEqual([...polls], [[73146, '/repo/.lavish/plan.html']]);
});

test('the poll and its wrapping shell collapse to one entry', () => {
  // Both carry the command in argv, so the same poll is seen twice.
  const polls = pollsBySession(parseProcessTable(PS), new Set([73146]));
  assert.equal(polls.size, 1);
});

test('a poll belonging to no known session is ignored', () => {
  // Someone polling by hand in a terminal is not a Claude session, and there
  // is no row to attach it to.
  const polls = pollsBySession(parseProcessTable(PS), new Set([99999]));
  assert.equal(polls.size, 0);
});

test('no sessions means no work at all', () => {
  assert.equal(pollsBySession(parseProcessTable(PS), new Set()).size, 0);
});

test('two sessions polling at once are told apart', () => {
  const ps = `
100 101 node /x/lavish-axi poll /a/.lavish/one.html
101 200 /bin/zsh -c run
200   1 claude
300 301 node /x/lavish-axi poll /b/.lavish/two.html
301 400 /bin/zsh -c run
400   1 claude
`;
  const polls = pollsBySession(parseProcessTable(ps), new Set([200, 400]));
  assert.equal(polls.get(200), '/a/.lavish/one.html');
  assert.equal(polls.get(400), '/b/.lavish/two.html');
});

test('a process chain that never reaches a session stops rather than looping', () => {
  // A cycle cannot happen in a real process table, but a truncated or racing
  // read can produce one, and a walk that never terminates takes the server
  // with it.
  const ps = `
10 11 node lavish-axi poll /a/.lavish/x.html
11 10 /bin/zsh -c run
`;
  assert.equal(pollsBySession(parseProcessTable(ps), new Set([999])).size, 0);
});

const execReturning = (out, calls = []) =>
  async function execAsync(command, args) {
    calls.push([command, ...args]);
    return out;
  };

test('PollWatch answers from the scan once it lands', async () => {
  const calls = [];
  const watch = new PollWatch({ execAsync: execReturning(PS, calls) });
  const pids = new Set([73146]);

  assert.equal(watch.fileFor(73146, pids, 1000), null, 'first ask only schedules');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['ps', '-eo', 'pid=,ppid=,args=']]);
  assert.equal(watch.fileFor(73146, pids, 1000), '/repo/.lavish/plan.html');
});

test('ps is not run again inside the refresh window', async () => {
  const calls = [];
  const watch = new PollWatch({ execAsync: execReturning(PS, calls) });
  const pids = new Set([73146]);
  watch.fileFor(73146, pids, 1000);
  await new Promise((resolve) => setImmediate(resolve));

  for (let i = 0; i < 30; i += 1) watch.fileFor(73146, pids, 1000 + i * 50);
  assert.equal(calls.length, 1, 'a 1s poll loop must not run ps every tick');
});

test('a process table that cannot be read keeps the last answer', async () => {
  // Losing the ability to run ps is not evidence that every review just ended.
  let fail = false;
  const watch = new PollWatch({
    async execAsync() {
      if (fail) throw new Error('ps: cannot allocate');
      return PS;
    },
  });
  const pids = new Set([73146]);
  watch.fileFor(73146, pids, 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(watch.fileFor(73146, pids, 1000), '/repo/.lavish/plan.html');

  fail = true;
  watch.fileFor(73146, pids, 99000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(watch.fileFor(73146, pids, 99000), '/repo/.lavish/plan.html');
});

test('load scans once and waits, for one-shot commands', async () => {
  const watch = new PollWatch({ execAsync: execReturning(PS) });
  await watch.load(new Set([73146]));
  assert.equal(watch.fileFor(73146, new Set([73146]), 1000), '/repo/.lavish/plan.html');
});

test('no exec runner at all is a supported configuration', () => {
  const watch = new PollWatch({});
  assert.equal(watch.fileFor(73146, new Set([73146]), 1000), null);
});
