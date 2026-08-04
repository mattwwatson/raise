/**
 * Asking Claude Desktop, from its own files, whether resuming a session is safe.
 *
 * The app files every session it hosts under
 * `claude-code-sessions/<org>/<account>/local_<id>.json`, and the `<id>` there
 * is the app's *own* uuid - the CLI session it spawns gets a different one,
 * recorded inside as `cliSessionId`. That asymmetry is the whole reason this
 * module exists, because the `claude://resume` deep link is an import whose
 * only dedupe is:
 *
 *     if (sessions.get(`local_${idFromTheUrl}`)) { unarchive and reuse }
 *
 * We can only pass the CLI uuid, so for a natively hosted session that lookup
 * misses and the app imports a second entry over the same transcript. The one
 * case where it hits is a session some earlier import already filed under
 * `local_<cliUuid>` - and the *presence of that file name* is exactly that
 * condition, which is why nothing here opens a file. (They are ~130 KB each and
 * there are hundreds; the name is the whole answer.)
 *
 * Every unknown answers `false`, because false routes to raising the app, which
 * cannot duplicate anything. This is read behind a click, so the fallback has to
 * be the harmless one rather than the informative one.
 */

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { claudeDesktopSessionsDir } from '../config.js';

/**
 * The id is interpolated into a file name and arrives from a hook payload, so
 * it is checked for shape before it is ever treated as one.
 */
const SESSION_UUID = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

/** How the app names a record it imported from a CLI session. */
const IMPORTED_PREFIX = 'local_';

/**
 * Has the app already imported this CLI session under an id of its own?
 *
 * True means `claude://resume` will unarchive that entry rather than make
 * another. False means it would import - or that we could not tell.
 *
 * @param {string|null|undefined} sessionId the CLI session id, as the hook reports it
 * @param {{dir?: string}} [options]
 * @returns {boolean}
 */
export function hasImportedSession(sessionId, { dir = claudeDesktopSessionsDir() } = {}) {
  if (!SESSION_UUID.test(String(sessionId || ''))) return false;
  const record = `${IMPORTED_PREFIX}${sessionId}.json`;
  // Two levels, both named after ids we have no way to know: the organisation
  // and the signed-in account. Walking them is cheaper than guessing, and an
  // unexpected depth simply finds nothing.
  for (const org of readDir(dir)) {
    for (const account of readDir(join(dir, org))) {
      if (existsSync(join(dir, org, account, record))) return true;
    }
  }
  return false;
}

/** @param {string} path @returns {string[]} */
function readDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // Not installed, not readable, not a directory - all the same answer.
    return [];
  }
}
