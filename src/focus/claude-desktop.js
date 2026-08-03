/**
 * Raising a session that lives in Claude Desktop rather than a terminal.
 *
 * This is deliberately not an entry in terminals.js. That interface is
 * `{sessionUuid, tty}` and a desktop session has neither: the app spawns Claude
 * Code with no controlling terminal, so there is no window for AppleScript to
 * find and nothing for the terminal adapters to match on. What it does have is
 * the session id, which the app can resolve itself.
 *
 * `claude://resume?session=<uuid>` is the app's own deep link. It is idempotent
 * - a session already open is unarchived and brought to the front rather than
 * duplicated - and, unlike the `claude://code/...` links, it is not behind a
 * feature flag.
 *
 * *It is also not a no-op on the wrong session.* A session the app has never
 * seen is imported, transcript and all. That is the right behaviour for the
 * link and the wrong thing to do to a terminal session, so this must only ever
 * be reached from positive evidence that the app is already hosting it - see
 * `hostApp` in ../process-tree.js.
 *
 * The honest limitation: `open` returns as soon as Launch Services accepts the
 * URL, and the app handles it asynchronously afterwards. Its own failure paths
 * (an expired sign-in, a transcript that has been deleted) surface as a toast
 * in the app and never reach us, so success here means "handed over", not
 * "raised". The terminal adapters can do better because AppleScript answers;
 * this one cannot, and pretending otherwise would put a confident tick over an
 * error the user is looking at.
 */

/** @typedef {import('./index.js').FocusResult} FocusResult */

/**
 * The app's own handler requires a UUID and silently ignores anything else, so
 * the same shape is checked here - a refusal we can explain beats a click that
 * appears to work and does nothing.
 */
const SESSION_UUID = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

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
 * Hand a session to Claude Desktop.
 *
 * @param {Function} exec must be asynchronous; this is reachable from /focus
 * @param {{sessionId: string|null}} target
 * @returns {Promise<FocusResult>}
 */
export async function focusClaudeDesktop(exec, { sessionId }) {
  const url = resumeUrl(sessionId);
  if (!url) {
    return {
      ok: false,
      reason: 'This Claude Desktop session did not report an id that the app can open.',
    };
  }
  try {
    await exec('open', [url], { timeoutMs: 5000 });
  } catch {
    return {
      ok: false,
      reason: 'Could not hand that session to Claude Desktop. The app may not be installed.',
      hint: `open '${url}'`,
    };
  }
  return { ok: true, adapter: 'claude-desktop' };
}
