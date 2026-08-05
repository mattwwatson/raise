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
 *   ai-title      a generated name for the session, refreshed as it goes
 *   custom-title  the name a human gave it, with `/rename`
 *   mode          normal, plan, and so on
 *   tool_use      every tool call, with the id its result later refers back to
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
 * @property {string|null} sessionName the name a human gave the session -
 *   `/rename` in Claude Code, `/name` in pi - which is a statement of intent
 *   rather than a guess at one
 * @property {string|null} mode 'normal', 'plan', ... null when never recorded
 * @property {string|null} activity what it is doing right now, in words, or
 *   null when it is between tools - thinking, or writing a reply
 * @property {string|null} lavishFile the artifact it is blocked on, when the
 *   running tool is a `lavish-axi poll`
 * @property {number|null} lastActivityAt epoch ms of the newest record, which
 *   is when this session last did anything at all
 * @property {TranscriptPullRequest|null} pullRequest a pull request this
 *   session was seen to open or talk about
 */

/**
 * A pull request sighted in a transcript.
 *
 * The no-mistakes database is the better source when it has one, but it only
 * knows about pull requests its own pipeline opened. A session that ran
 * `gh pr create`, or whose pipeline run predates the branch, leaves no trace
 * there at all - and that is not rare. Meanwhile the session itself printed the
 * URL, and often the state beside it, into a file we are already reading.
 *
 * `slug` is carried rather than resolved here because this module does not know
 * which repo the session is in. The caller matches it, and rejects a URL
 * belonging to some other project the session merely discussed.
 *
 * @typedef {object} TranscriptPullRequest
 * @property {string} url
 * @property {number|null} number
 * @property {string|null} slug the repository the URL points at
 * @property {string|null} state lower-cased, when the same block reported one
 * @property {number|null} observedAt epoch ms the sighting was written
 */

/**
 * How much of the end of a transcript to read.
 *
 * The records we want sit within ~30KB of the end in practice, across sessions
 * of every length, because Claude Code rewrites the title and mode on each
 * turn. 128KB is four times that: enough headroom for a long tool-heavy stretch
 * without ever reading a whole multi-megabyte file.
 *
 * The session name rides on that same guarantee rather than having one of its
 * own. `/rename` writes its `custom-title` record once, near the start of a long
 * session - far outside this window - but Claude Code re-appends it with every
 * `ai-title` flush, within a few hundred bytes of one. Measured on a 1.3MB
 * transcript: flushes every ~40KB, worst gap 59KB, and a `custom-title` beside
 * each of the three since the rename. It is a fact about Claude Code, not about
 * us: if the name ever stops appearing on a card whose title still updates,
 * that re-appending is what changed.
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
  // Claude Code has no such tool; pi does. This table is the page's display
  // vocabulary rather than any one agent's tool list, so a verb here costs
  // nothing and stops a real tool rendering as a bare lowercase word.
  Ls: 'Listing',
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
 * The record types that are the conversation itself, and so are work.
 *
 * A whitelist rather than a denylist, and deliberately so. Claude Code keeps
 * adding ancillary timestamped records around the conversation - `system`,
 * `attachment`, `file-history-delta`, `permission-mode` all appeared after this
 * module was first written - whereas the conversation being assistant turns and
 * user turns is the stable shape of a transcript. A denylist has to be right
 * about every type that will ever exist; this only has to be right about the
 * two that always will.
 */
const ACTIVITY_TYPES = new Set(['assistant', 'user']);

/**
 * When the session last did anything, from the newest record that is work.
 *
 * This is what lets a stale "waiting for you" be disproved. The hooks announce
 * that Claude wants permission and then say nothing more until the turn ends,
 * so a granted prompt leaves the session reading as blocked for as long as the
 * rest of the turn takes. The transcript, meanwhile, carries straight on - and
 * a session writing records is self-evidently not sitting waiting for a human.
 *
 * Which makes *what counts as a record* load-bearing, and it is narrower than
 * "has a timestamp". Claude Code writes `system`/`away_summary` entries while
 * the human is away - written *because* nothing is happening - and counting
 * those moved this forward on an idle session, disproved a real block, and
 * rendered the session as "Working". That is this tool's one signal inverted:
 * the row that wanted you looked like the row that did not. Observed at 199s
 * and 191s into a quiet stretch.
 *
 * @param {object[]} records
 * @returns {number|null}
 */
export function lastActivityAt(records) {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = /** @type {{timestamp?: string, type?: string}} */ (records[i]);
    if (!ACTIVITY_TYPES.has(record?.type)) continue;
    const stamp = Date.parse(record?.timestamp ?? '');
    if (Number.isFinite(stamp)) return stamp;
  }
  return null;
}

/**
 * One line of the recent history a card can be expanded to show.
 *
 * @typedef {object} TranscriptEvent
 * @property {number|null} at epoch ms, from the record's own timestamp
 * @property {'you'|'agent'|'tool'} kind who or what produced it. `agent` rather
 *   than `claude` because more than one agent writes these transcripts now, and
 *   the page renders this string: a pi session's replies labelled "claude"
 *   would be a small confident lie in the one place conversation text appears
 * @property {string|null} label the tool's name, for a `tool`
 * @property {string} text what to show, already truncated
 * @property {boolean} truncated whether `text` had more after it
 * @property {'ok'|'error'|'running'|null} outcome for a `tool`, from the
 *   result that referred back to it
 */

/**
 * How much of any one entry to keep.
 *
 * The expando is a glance at what has been happening, not a transcript reader.
 * A single pasted stack trace would otherwise push everything else off the
 * card, and the page has no scroll region per entry.
 */
export const EVENT_TEXT_CHARS = 300;

/** How many entries the expando shows, newest last. */
export const RECENT_EVENT_LIMIT = 12;

/**
 * Records that are addressed to Claude but were not typed by a human.
 *
 * Claude Code puts a lot through the `user` role that no person wrote: skill
 * text injected at invocation, the caveat blocks around a slash command, the
 * command's own stdout, and the notification a finished subagent posts back.
 * Showing those as "you" would be a plain lie about who said what, and they
 * are also the bulkiest records in the file.
 */
const SYNTHETIC_USER_TEXT = /^\s*<(command-name|command-message|local-command-|task-notification|system-reminder)/;

/**
 * The user's own words, or null if this record is not a person speaking.
 *
 * @param {{type?: string, isSidechain?: boolean, isMeta?: boolean,
 *          message?: {content?: unknown}}} record
 * @returns {string|null}
 */
function humanPrompt(record) {
  if (record?.type !== 'user') return null;
  // A subagent's conversation is recorded in the same file as the main one.
  // Interleaving it would attribute an agent's prompts to the human and make
  // the timeline read as though two conversations were one.
  if (record.isSidechain || record.isMeta) return null;
  const content = record?.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((block) => block?.type === 'text')
            .map((block) => block.text)
            .join('\n')
        : '';
  const trimmed = String(text || '').trim();
  if (!trimmed || SYNTHETIC_USER_TEXT.test(trimmed)) return null;
  return trimmed;
}

/** @param {string} text */
function clip(text) {
  const collapsed = String(text).replace(/\s+/g, ' ').trim();
  return collapsed.length > EVENT_TEXT_CHARS
    ? { text: `${collapsed.slice(0, EVENT_TEXT_CHARS)}…`, truncated: true }
    : { text: collapsed, truncated: false };
}

/**
 * How a tool call turned out, keyed by the id its result refers back to.
 *
 * Matched on id, never on position - the same rule `runningToolUse` follows,
 * and for the same reason: parallel tools return out of order, so the nth
 * result is not the nth call.
 *
 * @param {object[]} records
 * @returns {Map<string, 'ok'|'error'>}
 */
function toolOutcomes(records) {
  /** @type {Map<string, 'ok'|'error'>} */
  const outcomes = new Map();
  for (const record of records) {
    for (const block of contentBlocks(record)) {
      if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
      outcomes.set(block.tool_use_id, block.is_error ? 'error' : 'ok');
    }
  }
  return outcomes;
}

/**
 * The last few things that happened, oldest first.
 *
 * This is the one place nmmon shows conversation rather than a reading taken
 * from it, and it stays on the machine that wrote it: the server reads a local
 * file and renders it on the user's own dashboard, on request, for one session
 * at a time. It is never pushed, never summarised into the hook payload, and
 * never leaves the process boundary it was read in.
 *
 * `thinking` blocks are left out. They are the bulkiest thing in the file and
 * the least useful for the question the expando answers, which is "what has
 * this session been doing, and do I need to go and look at it".
 *
 * @param {object[]} records
 * @param {number} [limit]
 * @returns {TranscriptEvent[]}
 */
export function recentEvents(records, limit = RECENT_EVENT_LIMIT) {
  const outcomes = toolOutcomes(records);
  /** @type {TranscriptEvent[]} */
  const events = [];

  for (const raw of records) {
    const record = /** @type {{timestamp?: string, type?: string, isSidechain?: boolean}} */ (raw);
    const at = Date.parse(record?.timestamp ?? '');
    const stamp = Number.isFinite(at) ? at : null;

    const prompt = humanPrompt(record);
    if (prompt) {
      events.push({ kind: 'you', at: stamp, label: null, outcome: null, ...clip(prompt) });
      continue;
    }
    if (record?.type !== 'assistant' || record.isSidechain) continue;

    for (const block of contentBlocks(record)) {
      if (block?.type === 'text' && String(block.text || '').trim()) {
        events.push({ kind: 'agent', at: stamp, label: null, outcome: null, ...clip(block.text) });
      } else if (block?.type === 'tool_use') {
        events.push({
          kind: 'tool',
          at: stamp,
          label: block.name || 'tool',
          // No result yet means this is the one still running, which is the
          // same signal the activity line on the card is built from.
          outcome: outcomes.get(block.id) || 'running',
          ...clip(describeToolUse({ name: block.name, input: block.input || {} }) || block.name || ''),
        });
      }
    }
  }

  return events.slice(-limit);
}

/**
 * A pull request URL on either host, with the repo it belongs to.
 *
 * Bitbucket writes `/pull-requests/40` and GitHub `/pull/22`, and both put the
 * repository in the segment immediately before that - which is the only part
 * that makes the URL attributable to a checkout.
 */
const PR_URL = /https?:\/\/[^\s"'<>()\\]*?\/([^\s"'<>()\\/]+)\/(?:pull-requests|pull)\/(\d+)/g;

/** `state=OPEN`, `state: merged` - however the CLI that printed it phrased it. */
const PR_STATE = /\bstate[=:]\s*"?([A-Za-z]+)/;

/** Every scrap of text a record carries, tool results and prose alike. */
function recordText(record) {
  const content = record?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block?.text === 'string') parts.push(block.text);
    else if (typeof block?.content === 'string') parts.push(block.content);
    else if (Array.isArray(block?.content)) {
      for (const inner of block.content) {
        if (typeof inner?.text === 'string') parts.push(inner.text);
      }
    }
  }
  return parts.join('\n');
}

/** One URL found in a record, with the line it sat on. */
function urlsIn(text) {
  const found = [];
  for (const line of String(text).split('\n')) {
    PR_URL.lastIndex = 0;
    let match;
    while ((match = PR_URL.exec(line)) !== null) {
      found.push({ url: match[0], slug: match[1], number: Number(match[2]), line });
    }
  }
  return found;
}

/**
 * The pull request a single record is talking about, if it is talking about one.
 *
 * The distinction that matters is between a record *reporting* a pull request
 * and one *listing* several. The no-mistakes skill injects a table of the last
 * ten runs, every row carrying a different branch and a different pull request;
 * taking the first URL out of that put an unrelated review on the card, which
 * is the worst thing this feature can do.
 *
 * So: a URL on a line naming our branch is ours, whatever else is in the
 * record - that is a table row about us, and it is the best evidence available.
 * Failing that, a record mentioning exactly one pull request is reporting it.
 * A record mentioning several and none of them on our branch is a listing, and
 * is worth nothing.
 *
 * @param {string} text
 * @param {string|null} branch
 * @returns {{url: string, slug: string, number: number, state: string|null}|null}
 */
function pullRequestInText(text, branch) {
  const found = urlsIn(text);
  if (found.length === 0) return null;

  if (branch) {
    const ours = found.find((hit) => hit.line.includes(branch));
    if (ours) {
      const state = ours.line.match(PR_STATE);
      return { ...ours, state: state ? state[1].toLowerCase() : null };
    }
  }

  // The same URL written twice - a markdown link and its label - is still one
  // pull request. More than one distinct URL and nothing tying any of them to
  // us means we cannot say which is ours, so we say nothing.
  const distinct = new Set(found.map((hit) => hit.url));
  if (distinct.size !== 1) return null;
  const state = text.match(PR_STATE);
  return { ...found[0], state: state ? state[1].toLowerCase() : null };
}

/**
 * The most recent pull request this session was seen to report.
 *
 * Newest first, because a session can touch several over its life and the
 * latest is the one it is on.
 *
 * Bounded by the tail window like everything else here, so a session that opens
 * a pull request and then works for another 128KB loses the sighting. That is
 * the honest limit of reading a fixed tail, and it fails by forgetting rather
 * than by inventing.
 *
 * @param {object[]} records
 * @param {string|null} [branch] the branch the session is on, which is what
 *   makes a row of a listing attributable
 * @returns {TranscriptPullRequest|null}
 */
export function pullRequestFromRecords(records, branch = null) {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = /** @type {{timestamp?: string}} */ (records[i]);
    const text = recordText(record);
    if (!text) continue;
    const hit = pullRequestInText(text, branch);
    if (!hit) continue;
    const at = Date.parse(record?.timestamp ?? '');
    return {
      url: hit.url,
      number: hit.number,
      slug: hit.slug,
      state: hit.state,
      observedAt: Number.isFinite(at) ? at : null,
    };
  }
  return null;
}

/**
 * Summarise a parsed transcript tail.
 *
 * @param {object[]} records
 * @param {string|null} [branch] the session's branch, which is what lets a
 *   pull request sighting be attributed rather than guessed at
 * @returns {TranscriptSummary}
 */
export function summariseTranscript(records, branch = null) {
  const running = runningToolUse(records);
  const lavishFile =
    running?.name === 'Bash' ? lavishPollTarget(running.input?.command) : null;
  return {
    title: lastOf(records, 'ai-title', 'aiTitle'),
    // Not proof that `/rename` was typed - a fork writes "<name> (fork)" and a
    // resumed session carries its name forward - but all three are the name
    // Claude Code itself displays, which is the thing worth showing.
    sessionName: lastOf(records, 'custom-title', 'customTitle'),
    mode: lastOf(records, 'mode', 'mode'),
    activity: describeToolUse(running),
    lavishFile,
    lastActivityAt: lastActivityAt(records),
    pullRequest: pullRequestFromRecords(records, branch),
  };
}

/** A summary that claims nothing, for a session with no readable transcript. */
export const EMPTY_SUMMARY = Object.freeze({
  title: null,
  sessionName: null,
  mode: null,
  activity: null,
  lavishFile: null,
  lastActivityAt: null,
  pullRequest: null,
});
