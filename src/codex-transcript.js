/**
 * Codex's rollout file, rewritten into the shape `transcript.js` already reads.
 *
 * A normaliser, deliberately not a third summariser - the same argument
 * `pi-transcript.js` makes and for the same reason. The id match that finds the
 * tool with no result yet, the whitelist behind `lastActivityAt` and all three
 * guards on a pull request sighting were each arrived at the hard way and live
 * in one place; a parallel summariser forks them, and the copy that misses the
 * next fix is the one putting a confident wrong answer on the page.
 *
 * It matters more here than it did for pi. Codex has a real approval gate and
 * **no event at all for one being answered**, so the transcript is the only
 * thing that can retire a stale block. Every rule below is load-bearing for
 * correctness, not only for the summary line.
 *
 * Measured against codex-cli 0.147.0; the capture is in
 * `docs/tasks/RAI-21-codex-sessions.md`. A rollout line looks like:
 *
 *   {"type":"response_item","timestamp":"…","ordinal":12,
 *    "payload":{"type":"custom_tool_call","name":"exec","call_id":"call_…",
 *               "input":"const r = await tools.exec_command({cmd:\"ls\"});"}}
 *
 * Four things about that shape decide everything here:
 *
 * **Every line carries a timestamp**, session metadata included. That is
 * Claude Code's `away_summary` and pi's `model_change` in a third dialect, and
 * it is why this is a whitelist of one outer type. `event_msg` is the sharp
 * edge: it *restates* the conversation - `user_message`, `agent_message`,
 * `item_completed` - with its own timestamps, so admitting it would count every
 * turn twice. Only `response_item` is the conversation.
 *
 * **A tool call is written when it is issued, not when it returns.** Measured on
 * a 25-second command: the call landed at T+1s and its output at T+12s, with
 * nothing written in between. Without that there would be no "what is it doing
 * right now" and, far worse, nothing to disprove a stale block with.
 *
 * **The `status` field on a call says `completed` from the moment it is
 * written**, while the tool is still running. It is a lie about progress and is
 * never read. The id match against the output record is the only truth.
 *
 * **Every tool goes through one `exec` tool.** 0.147.0 runs in "code mode": the
 * call's `input` is a JavaScript snippet invoking `tools.exec_command({cmd})`,
 * `tools.update_plan({…})` and friends, sometimes several in one call. So the
 * shell command has to be lifted out of the snippet - otherwise a Codex session
 * sitting in a `lavish-axi poll` is invisible, and every card reads the same
 * bare word.
 */

/**
 * Codex's tool names in the vocabulary the page already speaks.
 *
 * Mapped rather than passed through because `describeToolUse` picks a verb by
 * name and `summariseTranscript` keys on `Bash` to notice a `lavish-axi poll` -
 * the gate that outranks everything but a block.
 *
 * Only what was observed. A tool not here keeps its own name, made legible; a
 * guessed mapping would put a wrong verb on a card, which is worse than a plain
 * one.
 */
const TOOL_NAMES = {
  exec_command: 'Bash',
};

/** Where the shell command sits inside an `exec_command` call. */
const EXEC_CALL = /\btools\s*\.\s*exec_command\s*\(/;

/** The first `tools.<name>(` in a snippet, for a call that is not a shell one. */
const ANY_TOOL_CALL = /\btools\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

/**
 * Machine-written blocks that arrive under `role: "user"`.
 *
 * Codex injects most of its preamble as `developer`, which is dropped wholesale
 * below, but `<recommended_plugins>` comes through as a user turn and is
 * indistinguishable from a typed prompt by any structural field - same role,
 * same content shape, no marker. So it is recognised by its wrapper tag, which
 * is exactly how Claude Code's `<system-reminder>` is handled.
 *
 * Named rather than generalised to "anything in angle brackets": a person can
 * legitimately open a prompt with a tag. This is what was observed, and Codex
 * will grow more - a card briefly quoting a new one is a cosmetic miss, where
 * dropping somebody's real first sentence is not.
 */
const SYNTHETIC_USER_BLOCK = /^\s*<recommended_plugins[\s>]/;

/** The roles that are the conversation. `developer` is Codex talking to itself. */
const CONVERSATION_ROLES = new Set(['user', 'assistant']);

/**
 * A tool name in the page's vocabulary.
 *
 * Codex names its tools in snake_case, which would render as a bare
 * `update_plan` on a card. Unknown ones are spaced and capitalised rather than
 * left alone or guessed a verb for - it is still the tool's real name, only
 * legible.
 *
 * @param {string} name
 * @returns {string}
 */
export function codexToolName(name) {
  const known = TOOL_NAMES[name];
  if (known) return known;
  const raw = String(name || '').replace(/_/g, ' ').trim();
  return raw ? raw[0].toUpperCase() + raw.slice(1) : raw;
}

/**
 * The value of a JavaScript string literal following `<key>:` in a snippet.
 *
 * Hand-rolled rather than parsed, because the snippet is JavaScript and there is
 * nothing in the standard library that will read it - and because getting this
 * wrong costs a slightly worse activity line, never a wrong answer about state.
 * Escapes are honoured so a command containing a quote does not truncate; all
 * three quote styles are, because the model writes whichever it likes.
 *
 * @param {string} snippet
 * @param {string} key
 * @returns {string|null}
 */
export function stringArgument(snippet, key) {
  const text = String(snippet || '');
  const match = new RegExp(`["']?\\b${key}["']?\\s*:`).exec(text);
  if (!match) return null;
  // From *after* the colon, never from the key: `{"cmd": "ls"}` quotes its key
  // too, and starting at the match would read the key back as its own value.
  const rest = text.slice(match.index + match[0].length);
  const opened = rest.search(/["'`]/);
  if (opened === -1) return null;
  const quote = rest[opened];
  let out = '';
  for (let i = opened + 1; i < rest.length; i += 1) {
    const char = rest[i];
    if (char === '\\') {
      const next = rest[i + 1];
      // Only the escapes that can appear inside a shell command are unescaped;
      // anything else keeps its backslash, which is what a shell would see.
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next === undefined ? '' : next;
      i += 1;
      continue;
    }
    if (char === quote) return out;
    out += char;
  }
  // Unterminated: the snippet was cut by the tail window. What was read is still
  // the start of the real command, which is all the card ever shows.
  return out;
}

/**
 * A code-mode `exec` call as a named tool with an input.
 *
 * A snippet can call several tools in one go - a plan update and then a command
 * - and the shell one is what a human wants to see, so it wins wherever it
 * appears. Failing that the first call names the record.
 *
 * @param {string} snippet
 * @returns {{name: string, input: Record<string, any>}}
 */
export function describeExecSnippet(snippet) {
  const text = String(snippet || '');
  if (EXEC_CALL.test(text)) {
    const command = stringArgument(text.slice(text.search(EXEC_CALL)), 'cmd');
    return { name: 'Bash', input: command ? { command } : {} };
  }
  const first = text.match(ANY_TOOL_CALL);
  if (first) return { name: codexToolName(first[1]), input: {} };
  // Not a `tools.` call at all - a bare snippet, which code mode allows. It is
  // still shell-shaped work, and naming it Bash is what makes the card say
  // something rather than nothing.
  return { name: 'Bash', input: {} };
}

/** Codex writes content as blocks; only the text in them is ever read. */
function textBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => typeof block?.text === 'string')
    .map((block) => ({ type: 'text', text: block.text }));
}

/** @param {{type: string, text: string}[]} blocks */
function joinedText(blocks) {
  return blocks.map((block) => block.text).join('\n');
}

/**
 * One rollout line as a record, or null if it is not the conversation.
 *
 * The types deliberately not handled are as load-bearing as the ones that are.
 * `session_meta`, `turn_context`, `world_state` and every `event_msg` all carry
 * timestamps and none of them is anyone speaking; `reasoning` is encrypted and
 * unreadable even if it were wanted. Getting this wrong does not throw - it
 * quietly moves `lastActivityAt` on an idle session, which is the one failure
 * this whole module exists to prevent.
 *
 * @param {any} line
 * @returns {object|null}
 */
export function normaliseCodexLine(line) {
  if (line?.type !== 'response_item') return null;
  const payload = line.payload;
  const timestamp = line.timestamp;

  if (payload?.type === 'message') {
    if (!CONVERSATION_ROLES.has(payload.role)) return null;
    const content = textBlocks(payload.content);
    if (payload.role === 'user' && SYNTHETIC_USER_BLOCK.test(joinedText(content))) return null;
    return {
      type: payload.role === 'assistant' ? 'assistant' : 'user',
      timestamp,
      message: { role: payload.role, content },
    };
  }

  if (payload?.type === 'custom_tool_call' || payload?.type === 'function_call') {
    // `function_call` carries JSON arguments under its own name; `custom_tool_call`
    // carries a code-mode snippet under the single `exec` tool, and the tool it
    // is really running is inside it.
    const described =
      payload.type === 'custom_tool_call'
        ? describeExecSnippet(payload.input)
        : { name: codexToolName(payload.name), input: parsedArguments(payload.arguments) };
    return {
      type: 'assistant',
      timestamp,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: payload.call_id, name: described.name, input: described.input },
        ],
      },
    };
  }

  if (payload?.type === 'custom_tool_call_output' || payload?.type === 'function_call_output') {
    // A returning tool is the session working, so it is a `user` record - the
    // same shape Claude Code writes and pi is normalised into.
    return {
      type: 'user',
      timestamp,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: payload.call_id,
            content: textBlocks(payload.output),
            is_error: false,
          },
        ],
      },
    };
  }

  return null;
}

/**
 * `function_call` arguments, which are JSON in a string.
 *
 * Never thrown from: a card showing a tool with no target is a smaller loss than
 * a transcript read that dies halfway and leaves a block standing.
 */
function parsedArguments(raw) {
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Parse the tail of a Codex rollout into records `transcript.js` can read.
 *
 * The first line of a tail read is dropped for the same reason as in
 * `parseTranscriptTail`: it is almost always cut in half, and one lost record at
 * the far end of the window changes nothing.
 *
 * @param {string} text
 * @param {boolean} [partialStart] whether `text` begins mid-file
 * @returns {object[]}
 */
export function parseCodexTranscriptTail(text, partialStart = true) {
  const lines = String(text || '').split('\n');
  if (partialStart) lines.shift();
  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // Half-written final line, or a record spanning the window edge.
      continue;
    }
    const record = normaliseCodexLine(entry);
    if (record) records.push(record);
  }
  return records;
}
