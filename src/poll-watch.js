/**
 * Who is sitting in a review poll, according to the process table.
 *
 * The transcript can say a session is polling a Lavish artifact, and it is
 * right up until the moment something resolves the tool call for a reason
 * other than the poll finishing. Claude Code's own tool timeout does exactly
 * that: past ten minutes it moves the command to the background and writes a
 * `tool_result`, so the transcript reads as though the poll returned while the
 * process is still very much running and the human gate is still open.
 *
 * A review that takes a person longer than ten minutes is not an edge case, it
 * is the normal one - so on the transcript alone the row quietly reverts to
 * "Working" precisely when it matters most. That is the failure this whole
 * tool exists to prevent, so the poll is confirmed against ground truth: a
 * live `lavish-axi poll` process *is* the gate.
 *
 * Attribution is the ancestor walk in process-tree.js in reverse. A poll is
 * launched by the agent, so walking up from the poll lands on the pid the
 * session already recorded for focusing. Nothing new has to be captured.
 *
 * As a bonus the path here comes from argv, already expanded - unlike the
 * transcript, which records the command as it was typed.
 */

import { lavishPollTarget } from './transcript.js';

/** How long a scan of the process table stays good enough. */
export const REFRESH_MS = 3000;

/** Far more than the four or five levels a real chain has. */
const MAX_DEPTH = 12;

/**
 * @typedef {Map<number, {ppid: number, args: string}>} ProcessTable
 */

/**
 * Parse `ps -eo pid=,ppid=,args=`.
 *
 * @param {string} text
 * @returns {ProcessTable}
 */
export function parseProcessTable(text) {
  /** @type {ProcessTable} */
  const table = new Map();
  for (const line of String(text || '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    table.set(Number(match[1]), { ppid: Number(match[2]), args: match[3] });
  }
  return table;
}

/**
 * Which sessions are blocked on which artifact.
 *
 * Both the poll itself and the shell that launched it carry the command in
 * their argv, so the same poll is usually seen twice. They walk up to the same
 * session, and keying the result by session collapses them.
 *
 * @param {ProcessTable} table
 * @param {Set<number>} agentPids the `host.pid` of every live session
 * @returns {Map<number, string>} agent pid -> artifact path
 */
export function pollsBySession(table, agentPids) {
  /** @type {Map<number, string>} */
  const found = new Map();
  if (agentPids.size === 0) return found;

  for (const [pid, proc] of table) {
    const file = lavishPollTarget(proc.args);
    if (!file) continue;
    const owner = walkToAgent(table, pid, agentPids);
    if (owner !== null && !found.has(owner)) found.set(owner, file);
  }
  return found;
}

/** The nearest ancestor that is a known session's agent, or null. */
function walkToAgent(table, startPid, agentPids) {
  let pid = startPid;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (agentPids.has(pid)) return pid;
    const proc = table.get(pid);
    if (!proc || proc.ppid <= 1) return null;
    pid = proc.ppid;
  }
  return null;
}

export class PollWatch {
  #execAsync;
  /** @type {Map<number, string>} */
  #polls = new Map();
  /** null means never scanned, which is not the same as scanned long ago. */
  #at = null;
  #scanning = false;

  /**
   * @param {{execAsync?: Function}} [deps] must be asynchronous; this is
   *   reachable from the server's poll loop.
   */
  constructor({ execAsync } = {}) {
    this.#execAsync = execAsync;
  }

  /**
   * The artifact a session is blocked on, or null.
   *
   * Like the Lavish lookup, asking is what schedules the next scan, so a
   * machine with no sessions never runs `ps` at all.
   *
   * @param {number|null|undefined} agentPid
   * @param {Set<number>} agentPids every live session's agent pid
   * @param {number} [now]
   * @returns {string|null}
   */
  fileFor(agentPid, agentPids, now = Date.now()) {
    this.scan(agentPids, now);
    if (!agentPid) return null;
    return this.#polls.get(agentPid) || null;
  }

  /**
   * Rescan if the last one has aged out. Never awaited.
   *
   * Stamped when the scan goes out rather than when it returns, and from the
   * caller's clock, so a slow or failing `ps` cannot be retried on every tick.
   */
  scan(agentPids, now = Date.now()) {
    if (!this.#execAsync || agentPids.size === 0) return;
    if (this.#scanning) return;
    if (this.#at !== null && now - this.#at < REFRESH_MS) return;
    this.#scanning = true;
    this.#at = now;
    Promise.resolve()
      .then(() => this.#execAsync('ps', ['-eo', 'pid=,ppid=,args='], { timeoutMs: 5000 }))
      .then((out) => {
        this.#polls = pollsBySession(parseProcessTable(out), agentPids);
      })
      .catch(() => {
        // A process table we could not read is not evidence of anything. Keep
        // the last answer rather than claiming every review just ended.
      })
      .finally(() => {
        this.#scanning = false;
      });
  }

  /** Scan once and wait for it. One-shot commands only - see LavishState.load. */
  async load(agentPids) {
    if (!this.#execAsync || agentPids.size === 0) return;
    try {
      const out = await this.#execAsync('ps', ['-eo', 'pid=,ppid=,args='], { timeoutMs: 5000 });
      this.#polls = pollsBySession(parseProcessTable(out), agentPids);
    } catch {
      this.#polls = new Map();
    }
    this.#at = Date.now();
  }
}
