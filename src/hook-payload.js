/**
 * What is allowed to leave an agent and reach Raise.
 *
 * The reporter runs inside somebody's live session and is handed everything the
 * agent knows about the event, which is far more than a monitor needs. Claude
 * Code's payloads carry the prompt text on `UserPromptSubmit`, the last
 * assistant message on `Stop`, and - on `PermissionRequest` - a `tool_input`,
 * which for `Write` and `Edit` is the contents of the file being written. None
 * of that has any business crossing a process boundary to be looked at by a
 * dashboard, so the reporter sends a fixed list of fields rather than the
 * payload it was given.
 *
 * **An allowlist, never a denylist.** The two failure modes are not comparable:
 * a field we forgot to allow is a feature that quietly does not work, and a
 * field we forgot to deny is somebody's source code on a socket. Claude Code
 * adds fields between releases and has no reason to tell us.
 *
 * Pure, and here rather than inside the hook, because the hook exits the
 * process by design and so cannot be imported by a test.
 */

/**
 * The fields Raise reads, and therefore the only ones worth sending.
 *
 * `host` is not among them because it is ours - the reporter works out the
 * window identity itself and adds it to the body afterwards.
 */
export const REPORTABLE_FIELDS = [
  'session_id',
  'hook_event_name',
  // Which agent sent this. Claude Code cannot say, so only pi ever sets it.
  'agent',
  'cwd',
  'transcript_path',
  // Both only present on a Notification: why the agent wants you, and which
  // kind of notification it is. See `isIdleNudge` for what the second decides.
  'message',
  'notification_type',
];

/**
 * Copy the reportable fields out of a payload, dropping everything else.
 *
 * Absent fields stay absent rather than becoming `undefined`, so the body on
 * the wire is the same shape it has always been.
 *
 * @param {Record<string, unknown>|null|undefined} payload
 * @returns {Record<string, unknown>}
 */
export function reportablePayload(payload) {
  const reportable = /** @type {Record<string, unknown>} */ ({});
  if (!payload || typeof payload !== 'object') return reportable;
  for (const field of REPORTABLE_FIELDS) {
    if (payload[field] !== undefined) reportable[field] = payload[field];
  }
  return reportable;
}

/**
 * Which agent the reporter was installed for, from `--agent <kind>`.
 *
 * The one thing a hook payload cannot tell us. Claude Code has no field for it
 * and never will; Codex has none either, and its hook *command* is the only
 * place it lets us put anything of our own - so the installation states it and
 * the payload is not consulted. Claude Code is the silent default, so an absent
 * flag returns null and the field is left off the body entirely, which keeps the
 * wire shape unchanged for every installation that predates this.
 *
 * Not validated here. `registry.js` holds the list of agents that may declare
 * themselves, because that is where the value picks a state table, and one
 * allowlist is better than two that can disagree.
 *
 * Here rather than in the hook for the same reason as everything else in this
 * module: the hook exits the process by design and so cannot be imported by a
 * test.
 *
 * @param {string[]} argv
 * @returns {string|null}
 */
export function declaredAgent(argv) {
  const at = (argv || []).indexOf('--agent');
  if (at === -1) return null;
  const value = argv[at + 1];
  // A flag with no value is a broken install, not a declaration of an agent
  // called `--dry-run`.
  return typeof value === 'string' && value && !value.startsWith('-') ? value : null;
}
