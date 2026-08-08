import test from 'node:test';
import assert from 'node:assert/strict';

import { reportablePayload, REPORTABLE_FIELDS } from '../src/hook-payload.js';

test('the fields Raise reads are carried through', () => {
  const payload = {
    session_id: 's1',
    hook_event_name: 'Notification',
    agent: 'pi',
    cwd: '/repo',
    transcript_path: '/t.jsonl',
    message: 'Claude needs your permission to use Bash',
    notification_type: 'permission_prompt',
  };
  assert.deepEqual(reportablePayload(payload), payload);
});

test('prompt text never leaves the session', () => {
  // UserPromptSubmit carries the whole prompt. It is the single most private
  // thing an agent handles and Raise has never had a use for it.
  const body = reportablePayload({
    session_id: 's1',
    hook_event_name: 'UserPromptSubmit',
    prompt: 'the actual thing the user typed',
    session_title: 'Fixing the parser',
  });
  assert.deepEqual(body, { session_id: 's1', hook_event_name: 'UserPromptSubmit' });
});

test("a PermissionRequest's tool_input never leaves the session", () => {
  // tool_input is the tool's arguments verbatim: the Bash command, and for
  // Write and Edit the contents of the file. This is the payload that made the
  // allowlist a precondition of listening to the event at all.
  const body = reportablePayload({
    session_id: 's1',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Write',
    tool_input: { file_path: '/repo/secrets.ts', content: 'const KEY = "sk-live-...";' },
    permission_suggestions: [{ behavior: 'allow' }],
  });
  assert.deepEqual(body, { session_id: 's1', hook_event_name: 'PermissionRequest' });
});

test("a Stop's last assistant message never leaves the session", () => {
  const body = reportablePayload({
    session_id: 's1',
    hook_event_name: 'Stop',
    last_assistant_message: 'Here is what I found in your database.',
  });
  assert.deepEqual(body, { session_id: 's1', hook_event_name: 'Stop' });
});

test('a field arriving as null is still forwarded, but a missing one stays missing', () => {
  // The distinction matters at the far end: the registry treats an explicit
  // null as "cleared" and an absent field as "keep what you had".
  const body = reportablePayload({ session_id: 's1', cwd: null });
  assert.deepEqual(body, { session_id: 's1', cwd: null });
  assert.equal('transcript_path' in body, false);
});

test('a payload that is not an object yields an empty body rather than throwing', () => {
  // This runs inside somebody's live session, where the only unacceptable
  // outcome is an exception.
  assert.deepEqual(reportablePayload(null), {});
  assert.deepEqual(reportablePayload(undefined), {});
  assert.deepEqual(reportablePayload(/** @type {any} */ ('not json')), {});
});

test('the allowlist has no field carrying conversation text', () => {
  // A guard on the list itself: the fields above are the whole boundary, so a
  // future addition that sounds like content should fail here first.
  for (const field of ['prompt', 'tool_input', 'last_assistant_message', 'transcript']) {
    assert.equal(REPORTABLE_FIELDS.includes(field), false, `${field} must not be reportable`);
  }
});
