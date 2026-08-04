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
 * CLI with a different one, so the id we hold is never the id that lookup wants.
 * Resuming a natively hosted session therefore imported a *second* entry over
 * the same transcript: two rows in the app's sidebar, one of them untitled,
 * mirroring each other keystroke for keystroke. There is no other route -
 * `claude://code/...` takes cloud session ids only, and is behind a flag.
 *
 * So the default is to raise the app and say so. The deep link is used only
 * where the app's own store proves that dedupe will fire - see
 * ./claude-desktop-store.js - and the caller decides that, so this module stays
 * free of the filesystem.
 *
 * The honest limitation, unchanged: `open` returns as soon as Launch Services
 * accepts, and the app acts on it afterwards. Its own failure paths (an expired
 * sign-in, a deleted transcript) surface as a toast in the app and never reach
 * us, so success here means "raised", never "showing what you wanted".
 */

/** @typedef {import('./index.js').FocusResult} FocusResult */

/**
 * The app's own handler requires a UUID and silently ignores anything else, so
 * the same shape is checked here - a refusal we can explain beats a click that
 * appears to work and does nothing.
 */
const SESSION_UUID = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

/** Claude Desktop, named the one way that cannot match another app. */
const BUNDLE_ID = 'com.anthropic.claudefordesktop';

/**
 * Said on the imprecise path only. The app opens on whatever it had last, which
 * is usually right and sometimes is not, and a monitor that quietly leaves you
 * looking at the wrong conversation is the thing this tool is against.
 */
const PICK_IT_YOURSELF = 'Raised Claude Desktop - pick the session from its sidebar.';

/**
 * The deep link that opens a session, or null if the id cannot be one.
 *
 * @param {string|null|undefined} sessionId
 * @returns {string|null}
 */
export function resumeUrl(sessionId) {
  if (!SESSION_UUID.test(String(sessionId || ''))) return null;
  return `claude://resume?session=${sessionId}`;
}

/**
 * Bring Claude Desktop to the front, on the session itself where that is safe.
 *
 * @param {Function} exec must be asynchronous; this is reachable from /focus
 * @param {{sessionId: string|null, imported?: boolean}} target `imported` is
 *   positive evidence that the app already holds this session under an id of
 *   its own, which is the only condition under which resuming it is not a copy.
 * @returns {Promise<FocusResult>}
 */
export async function focusClaudeDesktop(exec, { sessionId, imported = false }) {
  const url = imported ? resumeUrl(sessionId) : null;
  const args = url ? [url] : ['-b', BUNDLE_ID];
  try {
    await exec('open', args, { timeoutMs: 5000 });
  } catch {
    return {
      ok: false,
      reason: 'Could not bring Claude Desktop to the front. The app may not be installed.',
      hint: `open ${url ? `'${url}'` : `-b ${BUNDLE_ID}`}`,
    };
  }
  return url
    ? { ok: true, adapter: 'claude-desktop' }
    : { ok: true, adapter: 'claude-desktop', note: PICK_IT_YOURSELF };
}
