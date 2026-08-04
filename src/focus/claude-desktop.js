/**
 * Raising a session that lives in Claude Desktop rather than a terminal.
 *
 * This is deliberately not an entry in terminals.js. That interface is
 * `{sessionUuid, tty}` and a desktop session has neither: the app spawns Claude
 * Code with no controlling terminal, so there is no window for AppleScript to
 * find and nothing for the terminal adapters to match on.
 *
 * *The app cannot be asked to select a session it is already hosting.* This
 * reads as a missing feature and is worth stating plainly, because the obvious
 * link does something else entirely. `claude://resume?session=<uuid>` is an
 * **import**, and its only guard against doing it twice is
 *
 *     if (sessions.get(`local_${idFromTheUrl}`)) { unarchive and reuse }
 *
 * The app names its own sessions after a uuid it mints itself and spawns the
 * CLI with a different one - of 197 records in a real store, 189 had the two
 * disagreeing - so the id we hold is never the id that lookup wants. Resuming a
 * natively hosted session therefore imported a *second* entry over the same
 * transcript: two rows in the app's sidebar, one of them untitled, mirroring
 * each other keystroke for keystroke. There is no other route -
 * `claude://code/...` takes cloud session ids only, and is behind a flag.
 *
 * The link is not used even where that dedupe *would* fire, which is the part
 * worth keeping. A record filed under the id we hold is, by those same numbers,
 * one an earlier buggy click imported - so resuming it lands on the copy rather
 * than the session, and both such records in a real store were archived, which
 * takes the "unarchive and reuse" branch and can put a second Claude Code
 * process on the one transcript. That is the original symptom, reached by the
 * path meant to avoid it. Nothing in a record distinguishes a prior import from
 * the rare case where the app's uuid and the CLI's coincide, so there is no
 * test that could make the link safe. Raising the app is the only behaviour.
 *
 * The honest limitation, unchanged: `open` returns as soon as Launch Services
 * accepts, and the app acts on it afterwards. Its own failure paths (an expired
 * sign-in, a deleted transcript) surface as a toast in the app and never reach
 * us, so success here means "raised", never "showing what you wanted".
 */

/** @typedef {import('./index.js').FocusResult} FocusResult */

/** Claude Desktop, named the one way that cannot match another app. */
const BUNDLE_ID = 'com.anthropic.claudefordesktop';

/**
 * The app opens on whatever it had last, which is usually right and sometimes
 * is not, and a monitor that quietly leaves you looking at the wrong
 * conversation is the thing this tool is against.
 */
const PICK_IT_YOURSELF = 'Raised Claude Desktop - pick the session from its sidebar.';

/**
 * Bring Claude Desktop to the front.
 *
 * @param {Function} exec must be asynchronous; this is reachable from /focus
 * @returns {Promise<FocusResult>}
 */
export async function focusClaudeDesktop(exec) {
  try {
    await exec('open', ['-b', BUNDLE_ID], { timeoutMs: 5000 });
  } catch {
    return {
      ok: false,
      reason: 'Could not bring Claude Desktop to the front. The app may not be installed.',
      hint: `open -b ${BUNDLE_ID}`,
    };
  }
  return { ok: true, adapter: 'claude-desktop', note: PICK_IT_YOURSELF };
}
