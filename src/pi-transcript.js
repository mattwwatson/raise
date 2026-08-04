/**
 * pi's transcript, rewritten into the shape `transcript.js` already reads.
 *
 * This module is a normaliser, deliberately not a second summariser. Everything
 * that decides what a session is doing - the id match that finds the tool with
 * no result yet, the whitelist behind `lastActivityAt`, and all three guards
 * that stop a pull request sighting being attributed to the wrong branch - was
 * arrived at the hard way and lives in exactly one place. A parallel summariser
 * for pi would fork those rules, and the half that did not get the next fix is
 * the half that puts a confident wrong answer on the page.
 *
 * So the seam is `parseTranscriptTail`: it is the only Claude-shaped thing in
 * `transcript.js`, and everything downstream of it takes plain records. Produce
 * those records and `summariseTranscript` works on pi unchanged.
 *
 * The two formats are close enough that this is mostly renaming:
 *
 *   pi  {type:'message', message:{role:'assistant', content:[{type:'toolCall',
 *        id, name, arguments}]}}
 *   cc  {type:'assistant', message:{role:'assistant', content:[{type:'tool_use',
 *        id, name, input}]}}
 *
 * Two places where it is not, and both matter:
 *
 * **Every pi entry carries a top-level timestamp**, including `model_change` and
 * `thinking_level_change`, which are written at startup and say nothing about
 * whether anyone is working. Claude Code's `system`/`away_summary` taught this
 * lesson once already - a record written *because* the human is away moved
 * `lastActivityAt` forward, disproved a real block, and rendered the waiting row
 * as "Working". The whitelist in `transcript.js` only protects us if the records
 * reaching it are honestly typed, so anything that is not the conversation is
 * dropped here rather than passed through with a timestamp attached.
 *
 * **A tool result is a `user` record**, as it is in Claude Code. That is not a
 * quirk to tidy: a returning tool is the session working, and typing it as
 * anything else would make a busy session look idle to the one rule this tool
 * exists to get right.
 */

/**
 * pi's built-in tools, in the vocabulary the page already speaks.
 *
 * Mapped rather than passed through because `describeToolUse` keys on the name
 * to pick a verb, and `summariseTranscript` keys on `Bash` to notice a
 * `lavish-axi poll` - the gate that outranks everything but a block. A pi
 * session sitting in one would otherwise be invisible.
 *
 * `find` is pi's glob, so it takes Glob's verb. `ls` has no Claude counterpart
 * and keeps its own name; `TOOL_VERBS` carries a verb for it.
 */
const TOOL_NAMES = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  find: 'Glob',
  ls: 'Ls',
};

/**
 * pi names the file it is touching `path`; Claude Code names it `file_path`,
 * and that is the key `TOOL_TARGETS` looks up to say "Reading config.js"
 * instead of the bare word "Read".
 */
const PATH_TOOLS = new Set(['Read', 'Write', 'Edit']);

/** The roles that are the conversation, and so are evidence of work. */
const CONVERSATION_ROLES = new Set(['user', 'assistant', 'toolResult', 'bashExecution']);

/** @param {string} name */
function toolName(name) {
  const known = TOOL_NAMES[name];
  if (known) return known;
  // An extension's custom tool. Capitalised so it reads as a name on the card
  // rather than as a stray lowercase word, but never guessed a verb for.
  const raw = String(name || '');
  return raw ? raw[0].toUpperCase() + raw.slice(1) : raw;
}

/** @param {string} name @param {Record<string, any>} args */
function toolInput(name, args) {
  const input = { ...(args || {}) };
  if (PATH_TOOLS.has(name) && input.path !== undefined && input.file_path === undefined) {
    input.file_path = input.path;
  }
  return input;
}

/** pi allows a bare string where Claude Code always writes blocks. */
function textBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

/** An assistant turn: text, thinking and tool calls, renamed block by block. */
function assistantContent(content) {
  const blocks = [];
  for (const block of textBlocks(content)) {
    if (block?.type === 'toolCall') {
      const name = toolName(block.name);
      blocks.push({
        type: 'tool_use',
        id: block.id,
        name,
        input: toolInput(name, block.arguments),
      });
      continue;
    }
    blocks.push(block);
  }
  return blocks;
}

/**
 * One pi entry as a record, or null if it is not the conversation.
 *
 * The types deliberately not handled are as load-bearing as the ones that are.
 * `compaction`, `branch_summary`, `custom` and `custom_message` are entries in
 * their own right on disk - machine-written housekeeping, each with a timestamp
 * - and `model_change`, `thinking_level_change` and `label` are startup or
 * bookkeeping noise. All of them fall out here. The `role` guard below covers
 * the same shapes again where they appear as messages instead, which is how the
 * in-memory union carries them; belt and braces, because getting this wrong
 * does not throw, it just quietly moves `lastActivityAt` on an idle session.
 *
 * @param {any} entry
 * @returns {object|null}
 */
export function normalisePiEntry(entry) {
  // The name a human gave this session with `/name`. pi writes no equivalent of
  // Claude Code's `ai-title` - it does not generate one - so this is the only
  // title a pi session can have, and it is rendered through the same field.
  if (entry?.type === 'session_info') {
    return entry.name ? { type: 'ai-title', aiTitle: entry.name } : null;
  }
  if (entry?.type !== 'message') return null;
  const message = entry.message;
  const role = message?.role;
  if (!CONVERSATION_ROLES.has(role)) return null;

  // The timestamp the entry carries is the one the tail is ordered by; the
  // copy inside `message` is the same reading and is left alone.
  const timestamp = entry.timestamp;

  if (role === 'assistant') {
    return {
      type: 'assistant',
      timestamp,
      message: { role: 'assistant', content: assistantContent(message.content) },
    };
  }

  if (role === 'toolResult') {
    return {
      type: 'user',
      timestamp,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: textBlocks(message.content),
            is_error: message.isError === true,
          },
        ],
      },
    };
  }

  if (role === 'bashExecution') {
    // A `!` command the human ran. Nobody else writes it, so it is activity in
    // the plainest sense, and it is shown the way pi shows it.
    return {
      type: 'user',
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: `!${message.command || ''}` }] },
    };
  }

  return {
    type: 'user',
    timestamp,
    message: { role: 'user', content: textBlocks(message.content) },
  };
}

/**
 * Parse the tail of a pi JSONL session into records `transcript.js` can read.
 *
 * The first line of a tail read is dropped for the same reason as in
 * `parseTranscriptTail`: it is almost always cut in half, and one lost record
 * at the far end of the window changes nothing.
 *
 * @param {string} text
 * @param {boolean} [partialStart] whether `text` begins mid-file
 * @returns {object[]}
 */
export function parsePiTranscriptTail(text, partialStart = true) {
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
    const record = normalisePiEntry(entry);
    if (record) records.push(record);
  }
  return records;
}
