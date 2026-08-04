/**
 * The pi extension that tells nmmon about this session.
 *
 * The same job as `nmmon-hook.js`, under a stricter rule. That hook is a
 * separate process: if it throws, a subprocess dies and pi's user never knows.
 * **This runs inside the agent itself**, in-process, and pi awaits event
 * handlers - so an exception here surfaces in somebody's editing loop and a
 * slow `fetch` stalls their turn. Every handler therefore catches everything
 * and the post is bounded and never awaited. A monitor that can break the agent
 * it watches is worse than no monitor.
 *
 * Two things are easier here than in the Claude Code hook, both because we are
 * inside the process rather than spawned beneath it:
 *
 *   - the agent pid is simply `process.pid`. The hook has to walk the process
 *     table to find it, since the shell that ran it exits immediately.
 *   - `tty` can still not be read directly, so the ancestor walk is kept for
 *     that alone - `resolveTty` returns the first controlling terminal at or
 *     above us, which under any terminal is the pi process itself.
 *
 * That walk is a blocking `ps` per ancestor, which is exactly what must not
 * happen in the user's editing loop, so the window identity is collected on
 * `session_start` and nowhere else. It cannot change for the life of a pi
 * process, and the registry merges `host` over the record it already holds - so
 * a later event that omits the field entirely keeps the identity captured at
 * the start rather than erasing it.
 *
 * The payload is deliberately the same shape Claude Code's hook posts. One wire
 * format means one parser on the server, one privacy boundary, and one set of
 * tests - and the boundary is unchanged: session id, cwd, transcript path,
 * event name and window identity. pi has no notification message to carry
 * because it has no permission prompt, so nothing new crosses. No prompt text,
 * no transcript content, ever.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { parsePsLine, inspectHost } from '../src/process-tree.js';

/** @typedef {import('../src/process-tree.js').ReadProcess} ReadProcess */

const TIMEOUT_MS = 2000;

/**
 * The events worth reporting, and nothing more.
 *
 * `before_agent_start` and `agent_settled` bracket each agent run, so there is
 * no gap between them for the state to be wrong in and `turn_start` would add
 * nothing - `registry.js` maps it defensively, but we never send it. The tool
 * events are deliberately left out - they fire per call, and everything they
 * would tell us is already on disk in the session file.
 */
const EVENTS = [
  'session_start',
  'before_agent_start',
  'agent_settled',
  'session_shutdown',
];

/**
 * `session_shutdown` fires for a reload as well as a real exit, and a reload
 * keeps the same session running. Removing the record there would drop a live
 * session from the page until its next event. The rest genuinely end this
 * session id: `/new`, `/resume` and `/fork` all start a different one, and the
 * pi process stays alive, so nothing else would ever clean the old record up.
 */
const KEEP_ALIVE_SHUTDOWN = new Set(['reload']);

function readServerInfo() {
  const home = process.env.NMMON_HOME || join(homedir(), '.nmmon');
  try {
    return JSON.parse(readFileSync(join(home, 'server.json'), 'utf8'));
  } catch {
    return null;
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

/**
 * The window identity, walked once per pi process.
 *
 * @param {ReadProcess} read
 */
function collectHost(read) {
  let tty = null;
  try {
    ({ tty } = inspectHost(process.pid, { readProcess: read }));
  } catch {
    // A session we cannot place is rendered as "no window" rather than as a
    // confident claim about a terminal that is not there.
  }
  return {
    term_program: process.env.TERM_PROGRAM || null,
    // pi has no equivalent of Claude Desktop - it is a terminal program - so
    // there is no application to name, and guessing one would be worse.
    app: null,
    iterm_session_id: process.env.ITERM_SESSION_ID || null,
    term_session_id: process.env.TERM_SESSION_ID || null,
    tmux: process.env.TMUX || null,
    tmux_pane: process.env.TMUX_PANE || null,
    tty,
    // The extension is the agent, so this needs no walking and cannot be wrong.
    pid: process.pid,
    hostname: process.env.HOST || null,
  };
}

/**
 * Post one event. Never throws, never awaited by pi, always bounded.
 *
 * @param {object} payload
 */
function post(payload) {
  const info = readServerInfo();
  if (!info?.port || !info?.token) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  fetch(`http://127.0.0.1:${info.port}/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nmmon-token': info.token },
    body: JSON.stringify(payload),
    signal: controller.signal,
  })
    .catch(() => {
      // Server not running, or too slow. Not our problem to report, and
      // certainly not the agent's.
    })
    .finally(() => clearTimeout(timer));
}

/**
 * The session file, as an absolute path.
 *
 * pi returns this exactly as it was given, so a relative `--session-dir` yields
 * a relative path - which the server would then resolve against its own working
 * directory and read the wrong file, or none. Observed directly while probing.
 *
 * @param {any} ctx
 * @returns {string|null}
 */
function sessionFile(ctx) {
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    return file ? resolve(String(file)) : null;
  } catch {
    return null;
  }
}

/**
 * @param {any} pi
 * @param {{readProcess?: ReadProcess}} [deps]
 *   the process table, injected so the suite never reads the real one
 */
export default function (pi, deps) {
  const read = deps?.readProcess || readProcess;
  for (const event of EVENTS) {
    pi.on(event, (payload, ctx) => {
      try {
        if (event === 'session_shutdown' && KEEP_ALIVE_SHUTDOWN.has(payload?.reason)) return;
        const sessionId = ctx?.sessionManager?.getSessionId?.() ?? null;
        // An ephemeral session (`--no-session`) has no file and no id to key
        // on, so there is nothing to show and nothing to focus back to.
        if (!sessionId) return;
        post({
          session_id: String(sessionId),
          hook_event_name: event,
          agent: 'pi',
          cwd: ctx?.cwd || process.cwd(),
          transcript_path: sessionFile(ctx),
          ...(event === 'session_start' ? { host: collectHost(read) } : {}),
        });
      } catch {
        // Nothing this module does is worth interrupting a turn for.
      }
    });
  }
}
