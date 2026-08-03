/**
 * What a Claude session is actually doing, read from its own transcript.
 *
 * The hooks say whether Claude is blocked, working or idle. They cannot say
 * what it is working *on*, and "Working" across four repos tells you nothing
 * about which one to look at. no-mistakes fills that gap when a pipeline is
 * running - the step name - but most sessions are just Claude, and those had
 * nothing.
 *
 * Claude Code already writes what we need into its transcript, so nothing here
 * is inferred from prose:
 *
 *   ai-title    a generated name for the session, refreshed as it goes
 *   mode        normal, plan, and so on
 *   tool_use    every tool call, with the id its result later refers back to
 *
 * The last tool_use with no matching tool_result is the one running *now* -
 * that is the whole trick, and it is what makes the difference between "this
 * session used Bash at some point" and "this session is sitting in a Bash
 * command right now".
 *
 * Everything here is pure: it takes text and returns a summary. Reading the
 * file is the caller's problem, because the file is 2MB and growing and only
 * the tail is ever worth touching.
 */

/**
 * A tool call as the transcript records it. The input is whatever that
 * particular tool takes, so it is only ever read defensively.
 *
 * @typedef {{name: string, input: Record<string, any>}} ToolUse
 */

/**
 * A short description of where a session is at.
 *
 * @typedef {object} TranscriptSummary
 * @property {string|null} title Claude's own name for the session
 * @property {string|null} mode 'normal', 'plan', ... null when never recorded
 * @property {string|null} activity what it is doing right now, in words, or
 *   null when it is between tools - thinking, or writing a reply
 * @property {string|null} lavishFile the artifact it is blocked on, when the
 *   running tool is a `lavish-axi poll`
 * @property {number|null} lastActivityAt epoch ms of the newest record, which
 *   is when this session last did anything at all
 */

/**
 * How much of the end of a transcript to read.
 *
 * The records we want sit within ~30KB of the end in practice, across sessions
 * of every length, because Claude Code rewrites the title and mode on each
 * turn. 128KB is four times that: enough headroom for a long tool-heavy stretch
 * without ever reading a whole multi-megabyte file.
 */
export const TAIL_BYTES = 128 * 1024;

/**
 * Parse the tail of a JSONL transcript.
 *
 * The first line of a tail read is almost always cut in half, so it is dropped
 * rather than repaired - one lost record at the far end of the window changes
 * nothing. Later unparseable lines are skipped too: the file is appended to
 * live, so the final line can be half-written at the moment we read it.
 *
 * @param {string} text
 * @param {boolean} [partialStart] whether `text` begins mid-file
 * @returns {object[]}
 */
export function parseTranscriptTail(text, partialStart = true) {
  const lines = String(text || '').split('\n');
  if (partialStart) lines.shift();
  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Half-written final line, or a record spanning the window edge.
    }
  }
  return records;
}

/** The most recent value of a field carried by a given record type. */
function lastOf(records, type, field) {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    if (records[i]?.type === type && records[i][field]) return records[i][field];
  }
  return null;
}

function contentBlocks(record) {
  const content = record?.message?.content;
  return Array.isArray(content) ? content : [];
}

/**
 * The tool call that has not come back yet, which is what the session is doing.
 *
 * Results can arrive out of order relative to the calls that produced them when
 * several tools run at once, so this collects every resolved id first rather
 * than assuming the last call is the pending one.
 *
 * @param {object[]} records
 * @returns {ToolUse|null}
 */
export function runningToolUse(records) {
  const resolved = new Set();
  const uses = [];
  for (const record of records) {
    for (const block of contentBlocks(record)) {
      if (block?.type === 'tool_use') uses.push(block);
      if (block?.type === 'tool_result' && block.tool_use_id) resolved.add(block.tool_use_id);
    }
  }
  for (let i = uses.length - 1; i >= 0; i -= 1) {
    if (!resolved.has(uses[i].id)) {
      return { name: uses[i].name, input: uses[i].input || {} };
    }
  }
  return null;
}

/**
 * The artifact a `lavish-axi poll` is waiting on, or null.
 *
 * A poll blocks until the human opens the page and sends feedback, so a session
 * sitting in one is not working at all - it is waiting on you, in a browser tab
 * you have probably lost. The file is the handle Lavish itself keys on.
 *
 * The artifact is found by looking for the HTML file rather than by counting
 * arguments, because a flag that takes a value (`--timeout 30`) makes position
 * meaningless - and picking the wrong token yields a link to nothing.
 *
 * @param {string} command
 * @returns {string|null}
 */
export function lavishPollTarget(command) {
  const text = String(command || '');
  const poll = text.match(/lavish-axi\s+poll\b/);
  if (!poll) return null;
  const rest = text.slice(poll.index + poll[0].length);
  const match = rest.match(/"([^"]+\.html)"|'([^']+\.html)'|(\S+\.html)\b/);
  if (!match) return null;
  return match[1] || match[2] || match[3];
}

/** File-touching tools worth naming their target in the summary. */
const TOOL_TARGETS = {
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
};

const TOOL_VERBS = {
  Read: 'Reading',
  Edit: 'Editing',
  Write: 'Writing',
  NotebookEdit: 'Editing',
  Grep: 'Searching',
  Glob: 'Searching',
  Bash: 'Running',
  Task: 'Running an agent',
  WebFetch: 'Fetching',
  WebSearch: 'Searching the web',
};

/**
 * Put a running tool into words, short enough for a one-line card.
 *
 * @param {ToolUse|null} use
 * @returns {string|null}
 */
export function describeToolUse(use) {
  if (!use) return null;
  const { name, input } = use;
  const targetField = TOOL_TARGETS[name];
  if (targetField && input[targetField]) {
    return `${TOOL_VERBS[name]} ${basenameOf(input[targetField])}`;
  }
  if (name === 'Bash' && input.description) return String(input.description);
  if (name === 'Bash' && input.command) return `Running ${firstWord(input.command)}`;
  const verb = TOOL_VERBS[name];
  return verb ? `${verb} ${name === 'Task' ? '' : name}`.trim() : name;
}

function basenameOf(path) {
  const parts = String(path).split('/');
  return parts[parts.length - 1] || String(path);
}

/** The command being run, without its arguments or leading assignments. */
function firstWord(command) {
  const words = String(command).trim().split(/\s+/);
  for (const word of words) {
    if (!word.includes('=')) return basenameOf(word);
  }
  return basenameOf(words[0] || '');
}

/**
 * When the session last did anything, from the newest timestamped record.
 *
 * This is what lets a stale "waiting for you" be disproved. The hooks announce
 * that Claude wants permission and then say nothing more until the turn ends,
 * so a granted prompt leaves the session reading as blocked for as long as the
 * rest of the turn takes. The transcript, meanwhile, carries straight on - and
 * a session writing records is self-evidently not sitting waiting for a human.
 *
 * @param {object[]} records
 * @returns {number|null}
 */
export function lastActivityAt(records) {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = /** @type {{timestamp?: string}} */ (records[i]);
    const stamp = Date.parse(record?.timestamp ?? '');
    if (Number.isFinite(stamp)) return stamp;
  }
  return null;
}

/**
 * Summarise a parsed transcript tail.
 *
 * @param {object[]} records
 * @returns {TranscriptSummary}
 */
export function summariseTranscript(records) {
  const running = runningToolUse(records);
  const lavishFile =
    running?.name === 'Bash' ? lavishPollTarget(running.input?.command) : null;
  return {
    title: lastOf(records, 'ai-title', 'aiTitle'),
    mode: lastOf(records, 'mode', 'mode'),
    activity: describeToolUse(running),
    lavishFile,
    lastActivityAt: lastActivityAt(records),
  };
}

/** A summary that claims nothing, for a session with no readable transcript. */
export const EMPTY_SUMMARY = Object.freeze({
  title: null,
  mode: null,
  activity: null,
  lavishFile: null,
  lastActivityAt: null,
});
