#!/usr/bin/env node
/**
 * The Claude Code hook that tells Raise about this session.
 *
 * Two hard rules, because this runs inside somebody's editing loop:
 *
 *   1. Never fail. A monitor that can break Claude Code is worse than no
 *      monitor, so every path exits 0 and stays quiet.
 *   2. Never block. The whole thing is bounded by a short timeout; if the
 *      server is not running we simply do nothing.
 *
 * It also captures the window identity, which is the part that makes focusing
 * possible. Note that `tty` cannot be used here: hooks receive their payload on
 * stdin, so stdin is a pipe, not a terminal. The controlling terminal is read
 * from the process table instead.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { parsePsLine, inspectHost } from '../src/process-tree.js';
import { reportablePayload } from '../src/hook-payload.js';

const TIMEOUT_MS = 2000;

function quietExit() {
  process.exit(0);
}

function readServerInfo() {
  const home = process.env.RAISE_HOME || join(homedir(), '.raise');
  try {
    return JSON.parse(readFileSync(join(home, 'server.json'), 'utf8'));
  } catch {
    return null;
  }
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** One process, read from the process table. Null if it has already gone. */
function readProcess(pid) {
  let line;
  try {
    line = execFileSync('ps', ['-o', 'ppid=,tty=,args=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1000,
    });
  } catch {
    return null;
  }
  return parsePsLine(line);
}

function collectHost() {
  const { tty, agentPid, app } = inspectHost(process.ppid, { readProcess });
  return {
    term_program: process.env.TERM_PROGRAM || null,
    // Which application is hosting this session, when it is not a terminal.
    // Read from the process tree rather than the environment because Claude
    // Desktop sets none of the variables below - that absence is the whole
    // problem, and it is not something a session can be identified by.
    app,
    // iTerm2 gives every split and tab a stable UUID, which survives the tab
    // being dragged to another window. Best identifier available.
    iterm_session_id: process.env.ITERM_SESSION_ID || null,
    term_session_id: process.env.TERM_SESSION_ID || null,
    // Inside tmux these two are what matter; the host terminal is resolved at
    // focus time because the session can be reattached elsewhere.
    tmux: process.env.TMUX || null,
    tmux_pane: process.env.TMUX_PANE || null,
    tty,
    // Only ever the agent itself. The shell that runs this hook exits the
    // instant it returns, and a session recorded against a dead pid is pruned.
    pid: agentPid,
    hostname: process.env.HOST || null,
  };
}

async function main() {
  const info = readServerInfo();
  if (!info?.port || !info?.token) quietExit();

  let payload;
  try {
    payload = JSON.parse(readStdin() || '{}');
  } catch {
    quietExit();
  }
  if (!payload?.session_id) quietExit();

  // Never the payload itself. What Claude Code hands a hook includes prompt
  // text, assistant messages and, on a PermissionRequest, the contents of the
  // file it wants to write - see `src/hook-payload.js`.
  const body = { ...reportablePayload(payload), host: collectHost() };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    await fetch(`http://127.0.0.1:${info.port}/event`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-raise-token': info.token,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // Server not running, or too slow. Not our problem to report.
  } finally {
    clearTimeout(timer);
  }
  quietExit();
}

main().catch(quietExit);
