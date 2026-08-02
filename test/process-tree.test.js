import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePsLine,
  readAncestors,
  resolveTty,
  pickAgentPid,
  looksLikeClaude,
  inspectHost,
} from '../src/process-tree.js';

/**
 * A fake process table. Keys are pids, values are `ps -o ppid=,tty=,args=`
 * lines exactly as macOS prints them, leading spaces and all.
 */
function fakeTable(rows) {
  const reads = [];
  const readProcess = (pid) => {
    reads.push(pid);
    const line = rows[pid];
    return line === undefined ? null : parsePsLine(line);
  };
  readProcess.reads = reads;
  return readProcess;
}

test('parsePsLine reads ppid, tty and the full argument vector', () => {
  const proc = parsePsLine('  1234 s003     /usr/local/bin/node /opt/cli.js --flag x');
  assert.equal(proc.ppid, 1234);
  assert.equal(proc.tty, '/dev/s003');
  assert.equal(proc.command, '/usr/local/bin/node');
  assert.equal(proc.args, '/usr/local/bin/node /opt/cli.js --flag x');
});

test('parsePsLine treats "??" as no controlling terminal', () => {
  assert.equal(parsePsLine('1 ?? /sbin/launchd').tty, null);
  assert.equal(parsePsLine(''), null);
  assert.equal(parsePsLine('not a ps line'), null);
});

test('an npm-installed Claude Code is recognised from its arguments', () => {
  // macOS truncates `ps -o comm=` to 16 characters, so the previous comm match
  // failed on both installs: npm shows as `node`, and a native binary shows as
  // a clipped path. The argument vector is the only thing that survives.
  assert.equal(
    looksLikeClaude({
      command: '/usr/local/bin/node',
      args: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --print',
    }),
    true,
  );
  assert.equal(
    looksLikeClaude({ command: '/Users/x/.local/bin/claude', args: '/Users/x/.local/bin/claude -p' }),
    true,
  );
});

test('a path that merely contains .claude is not mistaken for the agent', () => {
  assert.equal(
    looksLikeClaude({
      command: '/usr/local/bin/node',
      args: '/usr/local/bin/node /Users/x/.claude/tools/nmmon-hook.js',
    }),
    false,
  );
});

test('the pid recorded is the agent, never the shell that ran the hook', () => {
  // hook -> sh -c -> claude -> login zsh. Storing the sh pid is what made every
  // session vanish: it exits the moment the hook returns, and a record whose
  // pid is dead is pruned on the next poll.
  const readProcess = fakeTable({
    900: '800 s004 /bin/sh -c node /opt/nmmon/hooks/nmmon-hook.js',
    800: '700 s004 /usr/local/bin/node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    700: '600 s004 -zsh',
  });
  const { tty, agentPid } = inspectHost(900, { readProcess });
  assert.equal(agentPid, 800);
  assert.equal(tty, '/dev/s004');
});

test('an unrecognisable agent is found by the controlling terminal it owns', () => {
  // Repackaged or renamed, but still the nearest ancestor with a terminal once
  // the wrapper shells are excluded.
  const chain = [
    { pid: 900, command: '/bin/sh', args: '/bin/sh -c node hook.js', tty: '/dev/s004' },
    { pid: 800, command: '/opt/agent', args: '/opt/agent --serve', tty: '/dev/s004' },
    { pid: 700, command: '/bin/zsh', args: '-zsh', tty: '/dev/s004' },
  ];
  assert.equal(pickAgentPid(chain), 800);
});

test('no pid at all rather than a pid we cannot vouch for', () => {
  // Under a daemon there is no terminal anywhere and nothing looks like Claude.
  // A record with no pid is kept by the registry; a record with a wrong pid is
  // deleted, so silence is the safe answer.
  const chain = [
    { pid: 900, command: '/bin/sh', args: '/bin/sh -c node hook.js', tty: null },
    { pid: 800, command: '/bin/zsh', args: '/bin/zsh', tty: null },
    { pid: 700, command: '/usr/bin/supervisor', args: '/usr/bin/supervisor', tty: null },
  ];
  assert.equal(pickAgentPid(chain), null);
  assert.equal(pickAgentPid([]), null);
});

test('a claude with no terminal is still identified under a daemon', () => {
  const readProcess = fakeTable({
    50: '40 ?? /bin/zsh -c node hooks/nmmon-hook.js',
    40: '30 ?? /Users/x/.local/bin/claude -p --dangerously-skip-permissions',
    30: '1 ?? /usr/local/bin/no-mistakes daemon run',
  });
  const { tty, agentPid } = inspectHost(50, { readProcess });
  assert.equal(agentPid, 40);
  assert.equal(tty, null);
});

test('the walk stops at a process that has already gone', () => {
  const readProcess = fakeTable({ 900: '800 s004 /bin/sh -c hook' });
  const chain = readAncestors(900, { readProcess });
  assert.equal(chain.length, 1);
  assert.equal(pickAgentPid(chain), null);
});

test('the walk is bounded and never reaches init', () => {
  const readProcess = fakeTable({
    5: '4 ?? /bin/sh',
    4: '3 ?? /bin/sh',
    3: '2 ?? /bin/sh',
    2: '1 ?? /bin/sh',
    1: '0 ?? /sbin/launchd',
  });
  const chain = readAncestors(5, { readProcess, maxDepth: 3 });
  assert.equal(chain.length, 3);
  assert.equal(resolveTty(chain), null);
});
