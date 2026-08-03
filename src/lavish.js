/**
 * Turning "this session is waiting on a Lavish page" into a link to that page.
 *
 * A `lavish-axi poll` blocks until the human opens the artifact and responds.
 * The session looks busy from the outside - Claude is sitting in a subprocess,
 * so the hooks report "working" - while the thing it is actually waiting for is
 * you, in a browser tab opened some time ago and since buried. That is the
 * worst case this whole tool exists to fix, and it was invisible.
 *
 * The transcript says *which artifact* is being polled. Only the URL has to
 * come from Lavish itself, and `lavish-axi` takes the better part of two
 * seconds to answer, so it is never on the poll path: the lookup is fired at
 * most once every REFRESH_MS, off to one side, and the dashboard uses whatever
 * the last answer was. A link that is a few seconds stale is worth infinitely
 * more than a poll loop that stalls.
 */

import { basename } from 'node:path';

/** How long an answer stays good enough. The URLs are stable for a session's life. */
export const REFRESH_MS = 15000;

/**
 * One open Lavish review session.
 *
 * @typedef {object} LavishSession
 * @property {string} file the artifact's path, which is what the transcript names
 * @property {string} status 'open' while it is still awaiting a response
 * @property {string} url the page to send the human to
 * @property {number} pendingPrompts feedback queued but not yet sent
 */

/**
 * Parse the `sessions[N]{...}` block `lavish-axi` prints.
 *
 * The format is the same TOON-ish shape no-mistakes uses, and this is read the
 * same deliberately narrow way: the header names its own columns, so they are
 * read from there rather than assumed positional, and a row that does not fit
 * is skipped instead of guessed at.
 *
 * @param {string} out
 * @returns {LavishSession[]}
 */
export function parseLavishSessions(out) {
  const text = String(out || '');
  // Only horizontal whitespace before the end of the line: `\s*$` would eat the
  // newline as well, and then the rows begin with an empty element.
  const header = text.match(/^sessions\[(\d+)\]\{([^}]*)\}:[ \t]*$/m);
  if (!header) return [];
  const columns = header[2].split(',').map((c) => c.trim());
  const lines = text.slice(header.index + header[0].length).split('\n');

  const sessions = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    // The block ends at the next top-level key, which is unindented.
    if (!/^\s/.test(line)) break;
    const values = splitRow(line.trim());
    if (values.length !== columns.length) continue;
    const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
    if (!row.file || !row.url) continue;
    sessions.push({
      file: row.file,
      status: row.status || 'unknown',
      url: row.url,
      pendingPrompts: Number(row.pending_prompts) || 0,
    });
  }
  return sessions;
}

/** Split a comma-separated row, respecting the quotes around the URL. */
function splitRow(line) {
  const values = [];
  let current = '';
  let quoted = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

export class LavishState {
  #execAsync;
  #sessions = [];
  /** null means never asked, which is not the same as asked long ago. */
  #at = null;
  #refreshing = false;

  /**
   * @param {{execAsync?: Function}} [deps] must be asynchronous - this is
   *   reachable from the server's poll loop, and the CLI is slow.
   */
  constructor({ execAsync } = {}) {
    this.#execAsync = execAsync;
  }

  /**
   * The URL for an artifact, or null if we have not been told about it.
   *
   * Asking implies the caller has a reason to think a poll is live, so this
   * also schedules the refresh that will answer the next caller properly. The
   * first ask after a session starts polling therefore returns null and the
   * link appears a moment later, which is the right trade against blocking.
   *
   * @param {string|null} file
   * @param {number} [now]
   * @returns {string|null}
   */
  urlFor(file, now = Date.now()) {
    this.refresh(now);
    if (!file) return null;
    const open = this.#sessions.filter((s) => s.status === 'open');
    const exact = open.find((s) => s.file === file);
    if (exact) return exact.url;

    // The transcript records the command as it was typed, and Lavish reports a
    // resolved absolute path, so the two often do not match as strings: an
    // agent may well have written `$DIR/plan.html`, `./.lavish/plan.html` or a
    // `~`. A row that says "waiting on your review" with no link to the review
    // is the one outcome this feature exists to prevent, so fall back to the
    // part of the path that survives all three.
    //
    // Only when it is unambiguous. Two repos each polling a `plan.html` is
    // entirely plausible, and sending someone to the wrong review is worse
    // than sending them to none - the same rule the tmux title match follows.
    const target = basename(file);
    const named = open.filter((s) => basename(s.file) === target);
    return named.length === 1 ? named[0].url : null;
  }

  /**
   * Kick off a refresh if the last answer has aged out. Never awaited.
   *
   * The window is stamped when the request goes out, not when it comes back,
   * and from the caller's clock rather than the wall clock. Stamping on return
   * would mix two clocks - the injected `now` for comparing, `Date.now()` for
   * recording - which reads as working and quietly isn't, since the CLI takes
   * seconds and a failure would otherwise be retried on every single poll.
   */
  refresh(now = Date.now()) {
    if (!this.#execAsync) return;
    if (this.#refreshing) return;
    if (this.#at !== null && now - this.#at < REFRESH_MS) return;
    this.#refreshing = true;
    this.#at = now;
    Promise.resolve()
      .then(() => this.#execAsync('lavish-axi', [], { timeoutMs: 5000 }))
      .then((out) => {
        this.#sessions = parseLavishSessions(out);
      })
      .catch(() => {
        // Lavish is not installed, or not running. Both mean "no links today",
        // which is a perfectly ordinary state and not worth a warning.
        this.#sessions = [];
      })
      .finally(() => {
        this.#refreshing = false;
      });
  }

  /**
   * Fetch once and wait for it.
   *
   * Only for one-shot commands, where there is no poll loop to protect and no
   * point printing before the answer arrives. The server must never call this:
   * the CLI takes seconds, and blocking the loop on it is exactly what the
   * fire-and-forget refresh above exists to avoid.
   *
   * @returns {Promise<void>}
   */
  async load() {
    if (!this.#execAsync) return;
    try {
      this.#sessions = parseLavishSessions(await this.#execAsync('lavish-axi', [], { timeoutMs: 5000 }));
    } catch {
      this.#sessions = [];
    }
    this.#at = Date.now();
  }

  /** @returns {LavishSession[]} the last known set, for tests and diagnostics */
  get sessions() {
    return this.#sessions;
  }
}
