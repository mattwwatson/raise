/**
 * What is actually running, according to the process table.
 *
 * Two questions, one `ps`: who is sitting in a review poll, and whose pipeline
 * is still going. Both exist because the transcript stops being evidence the
 * moment Claude Code backgrounds a long command, and both are answered by
 * walking a live process up to the session that owns it.
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

/**
 * Whether a command line is no-mistakes itself doing pipeline work.
 *
 * Matched on the executable, never on the string appearing anywhere in argv.
 * A session working *on* no-mistakes greps for the word, runs `npm test` in a
 * directory called no-mistakes-monitor, and passes it inside `--instructions`
 * text - all of which a substring match reads as a running pipeline, so the
 * session that is busiest talking about it would be the one wrongly marked.
 *
 * The daemon is excluded on top of that. It is not a descendant of any session
 * so the ancestor walk already drops it, but it runs permanently, and a rule
 * whose correctness depends on the walk alone is one refactor from claiming
 * every session on the machine.
 *
 * @param {string} args
 * @returns {boolean}
 */
export function isPipelineCommand(args) {
  const words = String(args || '').trim().split(/\s+/);
  const command = words[0]?.split('/').pop();
  if (command !== 'no-mistakes') return false;
  return words[1] !== 'daemon';
}

/**
 * The subcommands that start or steer a run, as opposed to reading one.
 *
 * An allowlist, and it fails the safe way round: a driving verb a later
 * no-mistakes adds is one we do not recognise, so the run goes unattributed and
 * the dashboard behaves exactly as it did before attribution existed. The other
 * mistake - reading `no-mistakes axi status` as ownership - would hand a
 * pipeline to whichever session merely glanced at it.
 */
const DRIVING_COMMANDS = new Set(['run', 'rerun', 'respond', 'abort']);

/** Subcommands that only report. Listed so they stop the scan below. */
const READING_COMMANDS = new Set(['status', 'runs', 'logs', 'stats', 'doctor', 'attach', 'help']);

/**
 * Whether a command line is a session *driving* a pipeline run, not just
 * looking at one.
 *
 * This is what settles which of several sessions open on one checkout owns the
 * run. `matchRunForCwd` cannot: it places a run by repo path, so three sessions
 * in a repo all match the same one, and the pipeline landed on all three cards
 * with a Focus button that took you to a window unable to answer the gate.
 *
 * The verb is found by scanning rather than by position, because argv puts
 * global flags before it (`no-mistakes --skip lint axi run`) and free text
 * after it - `axi run --intent "..."` carries a paragraph of English that
 * mentions plenty of these words. The real verb always precedes that text, so
 * the first recognised word wins and anything unrecognised is skipped over.
 *
 * @param {string} args
 * @returns {boolean}
 */
export function isRunOwnerCommand(args) {
  if (!isPipelineCommand(args)) return false;
  for (const word of String(args).trim().split(/\s+/).slice(1)) {
    if (word === 'axi') continue; // the agent interface, not a verb
    if (DRIVING_COMMANDS.has(word)) return true;
    if (READING_COMMANDS.has(word)) return false;
  }
  return false;
}

/**
 * Which sessions are driving a run of their own right now.
 *
 * The same ancestor walk as everything else here, so a run started by the
 * agent's own Bash tool is attributed to the session that holds that agent.
 *
 * @param {ProcessTable} table
 * @param {Set<number>} agentPids the `host.pid` of every live session
 * @returns {Set<number>} agent pids driving a run
 */
export function runOwnersBySession(table, agentPids) {
  /** @type {Set<number>} */
  const found = new Set();
  if (agentPids.size === 0) return found;
  for (const [pid, proc] of table) {
    if (!isRunOwnerCommand(proc.args)) continue;
    const owner = walkToAgent(table, pid, agentPids);
    if (owner !== null) found.add(owner);
  }
  return found;
}

/**
 * Which sessions have a live no-mistakes run under them.
 *
 * A backgrounded pipeline is what makes "Claude is waiting for your input" a
 * lie: Claude Code moves the command out of the way past its own ten minute
 * timeout, the turn ends, and sixty seconds later it fires the idle
 * notification - so the dashboard summons you to a session whose work is very
 * much still going. The process table is the ground truth the transcript
 * cannot be, because a backgrounded command writes nothing more.
 *
 * @param {ProcessTable} table
 * @param {Set<number>} agentPids the `host.pid` of every live session
 * @returns {Set<number>} agent pids with a pipeline still running
 */
export function pipelinesBySession(table, agentPids) {
  /** @type {Set<number>} */
  const found = new Set();
  if (agentPids.size === 0) return found;
  for (const [pid, proc] of table) {
    if (!isPipelineCommand(proc.args)) continue;
    const owner = walkToAgent(table, pid, agentPids);
    if (owner !== null) found.add(owner);
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
  /** @type {Set<number>} */
  #pipelines = new Set();
  /** @type {Set<number>} */
  #owners = new Set();
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
   * Whether a session has a no-mistakes run still going underneath it.
   *
   * Served from the same scan as `fileFor`, so asking both costs one `ps`.
   *
   * @param {number|null|undefined} agentPid
   * @param {Set<number>} agentPids every live session's agent pid
   * @param {number} [now]
   * @returns {boolean}
   */
  pipelineFor(agentPid, agentPids, now = Date.now()) {
    this.scan(agentPids, now);
    if (!agentPid) return false;
    return this.#pipelines.has(agentPid);
  }

  /**
   * Whether a session is driving a run rather than merely sitting in the repo
   * one is running in. Third question off the same scan.
   *
   * @param {number|null|undefined} agentPid
   * @param {Set<number>} agentPids every live session's agent pid
   * @param {number} [now]
   * @returns {boolean}
   */
  ownsRunFor(agentPid, agentPids, now = Date.now()) {
    this.scan(agentPids, now);
    if (!agentPid) return false;
    return this.#owners.has(agentPid);
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
        const table = parseProcessTable(out);
        this.#polls = pollsBySession(table, agentPids);
        this.#pipelines = pipelinesBySession(table, agentPids);
        this.#owners = runOwnersBySession(table, agentPids);
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
      const table = parseProcessTable(out);
      this.#polls = pollsBySession(table, agentPids);
      this.#pipelines = pipelinesBySession(table, agentPids);
      this.#owners = runOwnersBySession(table, agentPids);
    } catch {
      this.#polls = new Map();
      this.#pipelines = new Set();
      this.#owners = new Set();
    }
    this.#at = Date.now();
  }
}
