import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hasImportedSession } from '../src/focus/claude-desktop-store.js';
import { claudeDesktopSessionsDir } from '../src/config.js';

const SCRATCH = mkdtempSync(join(tmpdir(), 'nmmon-test-'));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const CLI_ID = '2205e739-08bc-4ee6-a8d4-b15204bab998';

/**
 * A store laid out the way the app lays it out: <org>/<account>/<record>.json.
 *
 * @param {string} name a directory of its own, so cases cannot see each other
 * @param {string[]} records file names to create
 */
function store(name, records) {
  const dir = join(SCRATCH, name, 'org-uuid', 'account-uuid');
  mkdirSync(dir, { recursive: true });
  for (const record of records) writeFileSync(join(dir, record), '{}');
  return join(SCRATCH, name);
}

test('a record named for our CLI session id is the mark of a previous import', () => {
  const dir = store('imported', [`local_${CLI_ID}.json`]);
  assert.equal(hasImportedSession(CLI_ID, { dir }), true);
});

test('a session the app hosts natively leaves no such record', () => {
  // This is the whole bug: the app mints its own id, so its record is named
  // local_<its own uuid> and carries our uuid only as cliSessionId inside. The
  // deep link's dedupe looks up local_<our uuid>, which is not this, so asking
  // it to resume imports a second entry over the same transcript.
  const dir = store('native', ['local_d6c8c45d-a596-49a0-8b80-67c7c4d9086e.json']);
  assert.equal(hasImportedSession(CLI_ID, { dir }), false);
});

test('a store that is not there answers no rather than throwing', () => {
  // Claude Desktop may not be installed at all. This runs behind a click, so
  // every unknown has to route to the path that cannot do damage.
  assert.equal(hasImportedSession(CLI_ID, { dir: join(SCRATCH, 'nothing-here') }), false);
});

test('a store nested differently than expected answers no', () => {
  // The layout belongs to the app and may change under us. Reading it wrong
  // must degrade to plain activation, never to a confident resume.
  const dir = join(SCRATCH, 'flat');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `local_${CLI_ID}.json`), '{}');
  assert.equal(hasImportedSession(CLI_ID, { dir }), false);
});

test('an id that is not a session id never becomes a path', () => {
  // The id is interpolated into a file name, and it arrives from a hook payload.
  const dir = store('traversal', [`local_${CLI_ID}.json`]);
  assert.equal(hasImportedSession('../../../etc/passwd', { dir }), false);
  assert.equal(hasImportedSession('', { dir }), false);
  assert.equal(hasImportedSession(null, { dir }), false);
});

test('the store path is env-overridable, so tests never read the real app', () => {
  const previous = process.env.CLAUDE_DESKTOP_HOME;
  process.env.CLAUDE_DESKTOP_HOME = '/tmp/somewhere-else';
  try {
    assert.equal(claudeDesktopSessionsDir(), '/tmp/somewhere-else');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_DESKTOP_HOME;
    else process.env.CLAUDE_DESKTOP_HOME = previous;
  }
  assert.match(claudeDesktopSessionsDir(), /claude-code-sessions$/);
});
