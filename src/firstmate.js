/**
 * Which tool spawned a session's window - answered only when the tool says so
 * itself.
 *
 * firstmate runs a crew of agents on your behalf. Each crewmate is an ordinary
 * Claude Code session in a tmux window and a treehouse worktree, so it registers
 * through the same hooks as anything else and every attribute we compute - the
 * branch, the run match, the pull request, focusing - already works on it
 * unchanged. That is the problem: on a page whose whole job is *which session
 * needs me*, there was no way to tell a session you started from one something
 * else started for you.
 *
 * **This is an identification problem, and identification here has one rule:
 * positive evidence, never absence.** A crewmate has no property that only it
 * lacks - no tty, a treehouse worktree and `--dangerously-skip-permissions` in
 * argv are each equally true of a handoff worker and of a no-mistakes pipeline
 * agent. Two markers hold, and both of them are firstmate declaring itself:
 *
 *   - **crew** - `fm-spawn.sh` names each crewmate's window `fm-<id>` and then
 *     pins it with `automatic-rename off` *and* `allow-rename off`, because its
 *     own targeting is by name and treehouse would otherwise rename the window
 *     out from under it. Load-bearing for firstmate is exactly the property that
 *     makes it safe for us to key on.
 *   - **the captain** - `$FM_HOME/state/.lock` holds the pid of the harness
 *     process running firstmate, which is the same number the registry already
 *     records as `host.pid`.
 *
 * Two false positives are deliberately not taken, and either would be a defect.
 * The tmux **session** name is shared by the captain and its crew, so keying on
 * it would chip the captain as crew - and the captain's own *window* name is not
 * trustworthy either, because its `allow-rename` is on, so Claude Code can
 * retitle it and a chip that silently stops appearing is worse than one that was
 * never there. And the **working directory** is not the answer for the captain:
 * a session that merely has firstmate's source open would match it. Someone
 * fixing firstmate is not the first mate, and the lock is precisely what
 * separates running it from working on it - an editing session's pid is not in
 * it.
 *
 * One answer for both, because a secondmate goes through the same spawn path and
 * gets an `fm-<id>` window; telling them apart would mean reading firstmate's
 * private `state/<id>.meta`, a much larger commitment for a distinction nobody
 * has wanted. The field says *which tool spawned this window* rather than
 * carrying a firstmate boolean, because handoff uses the same mechanism with a
 * different prefix and is the obvious next entry.
 *
 * **Cost is part of the design.** The window name needs a `list-panes -a`, and
 * unlike the identical query in `focus/tmux.js` this one is reachable from the
 * poll loop that builds the cards. The saving grace is that the name is pinned,
 * so it is fixed for the life of the window: a pane is resolved once, when it is
 * first seen, and cached. A per-session lookup, never a per-second one. The read
 * is fired and never awaited, exactly as `lavish.js` does, so the poll loop
 * cannot stall on tmux - the chip appears on the next tick.
 *
 * Nothing here runs for a session with no tmux pane, and nothing anywhere looks
 * for firstmate itself. A machine without it has no lock and no `fm-` window,
 * which means no chip, no warning and no subprocess - the same rule no-mistakes
 * and Lavish are held to.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { socketPath, tmuxCommand } from './focus/tmux.js';

/** @typedef {import('./registry.js').Session} Session */

/**
 * The tool that spawned a session's window, when it declared itself.
 *
 * A union of one, on purpose: handoff spawns windows the same way with a
 * `handoff-` prefix, so the next entry is a value rather than a schema change.
 *
 * @typedef {'firstmate'} SpawnedBy
 */

/**
 * How long between reads of the pane table.
 *
 * Only ever reached by a pane we have never seen, so in a steady state it is
 * not reached at all. It bounds how often an unknown pane - one belonging to a
 * tmux server we cannot read, say - can ask again.
 */
export const REFRESH_MS = 3000;

/** What `fm-spawn.sh` names a crewmate's window. */
const CREW_WINDOW_PREFIX = 'fm-';

/**
 * @typedef {object} FirstmateFileAccess
 * @property {(path: string) => {size: number, mtimeMs: number}} stat
 * @property {(path: string) => string} readText
 */

/** @type {FirstmateFileAccess} */
export const defaultFirstmateAccess = {
  stat(path) {
    const info = statSync(path);
    return { size: info.size, mtimeMs: info.mtimeMs };
  },
  readText(path) {
    return readFileSync(path, 'utf8');
  },
};

/**
 * Whether a tmux window name is one firstmate gave a crewmate.
 *
 * The prefix alone is not a name, so something has to follow it: `fm-` on its
 * own is a window somebody happened to call that, not `fm-<id>`.
 *
 * @param {string|null|undefined} name
 * @returns {boolean}
 */
export function isCrewWindowName(name) {
  const text = String(name || '').trim();
  return text.startsWith(CREW_WINDOW_PREFIX) && text.length > CREW_WINDOW_PREFIX.length;
}

/**
 * Parse `list-panes -a -F '#{pane_id}\t#{window_name}'`.
 *
 * A window linked into several sessions is emitted once per session, so the
 * same pane arrives more than once - with the same name every time, a window
 * name being a property of the window rather than of whoever is looking at it.
 *
 * @param {string|null} out
 * @returns {Map<string, string>} pane id -> window name
 */
export function parsePaneWindowNames(out) {
  /** @type {Map<string, string>} */
  const names = new Map();
  for (const line of String(out || '').split('\n')) {
    if (!line.trim()) continue;
    // The name is taken as the remainder, so a tab inside one cannot eat a
    // field boundary - the same rule `parsePaneSessions` follows.
    const [paneId, ...rest] = line.split('\t');
    if (!paneId.trim() || rest.length === 0) continue;
    names.set(paneId.trim(), rest.join('\t').trim());
  }
  return names;
}

/**
 * The pid a session lock holds, or null.
 *
 * One line, all digits. Anything else is a file that happens to be called
 * `.lock` and is not firstmate's - which is the whole reason this is read
 * strictly rather than parsed leniently.
 *
 * @param {string|null|undefined} text
 * @returns {number|null}
 */
export function lockedPid(text) {
  const first = String(text || '').trim().split('\n')[0].trim();
  return /^\d+$/.test(first) ? Number(first) : null;
}

/**
 * Where firstmate keeps the lock, relative to its home - which is the session's
 * own cwd, so the path is never hardcoded.
 */
const LOCK_PATH = ['state', '.lock'];

/**
 * A lock that is there and would not read, as distinct from one that is not
 * there and one that is not firstmate's.
 *
 * The other two are *answers*. No lock is what every session but the captain's
 * returns on every tick, and a lock holding something other than a pid is
 * `lockedPid`'s documented "a file that happens to be called `.lock`" - which is
 * the whole reason it parses strictly rather than leniently. This is neither: it
 * is a reading we did not get.
 *
 * **The difference has to hold in both directions and the cost of confusing it
 * is not symmetric.** Downstream, `firstmate-decisions.js` treats "no captain"
 * as positive evidence that firstmate has gone and clears every open ruling off
 * the page. Calling an unreadable lock an answer retires rulings that are still
 * open; calling an answer unreadable suppresses the refresh for the *whole
 * machine*, because `captainReading` reports one unreadable lock across every
 * session - so a single stray `state/.lock` in somebody's checkout would leave
 * every crewmate row asserting a ruling for the life of the server process.
 */
const LOCK_UNREADABLE = Symbol('firstmate lock unreadable');

export class FirstmateWatch {
  #execAsync;
  #files;
  /**
   * One entry per tmux server, keyed by the socket path out of the `$TMUX` a
   * session reported - `socketPath`, the same value `-S` is given. Pane ids are
   * only unique within a server, so they cannot share a map; and keying on the
   * raw `$TMUX` would be one entry per *session* instead, since its trailing
   * field is the session index - a table, a rate limit and a `list-panes -a`
   * each, for one server.
   *
   * @type {Map<string, {names: Map<string, string>, at: number|null, reading: boolean}>}
   */
  #servers = new Map();
  /**
   * The lock each session directory holds, cached on the file's own mtime the
   * way `git-branch.js` caches HEAD. The stat itself is not cached: a captain's
   * lock is written by the harness *after* the session exists, so a directory
   * with no lock now may well have one on the next tick.
   *
   * @type {Map<string, {size: number, mtimeMs: number, pid: number|null}>}
   */
  #locks = new Map();

  /**
   * @param {{execAsync?: Function, files?: FirstmateFileAccess}} [deps] the
   *   runner must be asynchronous - this is reachable from the server's poll
   *   loop, where a blocking child would stall the stream and every hook post
   *   with it.
   */
  constructor({ execAsync, files = defaultFirstmateAccess } = {}) {
    this.#execAsync = execAsync;
    this.#files = files;
  }

  /**
   * Which tool spawned this session's window, or null for the ordinary case of
   * nobody in particular.
   *
   * Asking is what schedules the read that will answer the next caller, so a
   * machine with no tmux sessions never runs tmux at all. The first ask about a
   * pane therefore returns null and the chip appears a tick later, which is the
   * right trade against blocking the loop.
   *
   * @param {Session} session
   * @param {number} [now]
   * @returns {SpawnedBy|null}
   */
  spawnedBy(session, now = Date.now()) {
    if (this.#isCrew(session?.host, now)) return 'firstmate';
    if (this.#isCaptain(session)) return 'firstmate';
    return null;
  }

  /**
   * The session running firstmate itself, or null.
   *
   * Its own `cwd` is `$FM_HOME`, which is how `firstmate-decisions.js` finds
   * the fleet snapshot without a hardcoded path and without going looking for
   * firstmate on a machine that has none. It lives here because this is where
   * the lock is already read and cached: identification is this module's whole
   * job, and asking a second module to re-derive it would be two answers to one
   * question.
   *
   * @param {Session[]} sessions
   * @returns {Session|null}
   */
  captainSession(sessions) {
    return this.captainReading(sessions).session;
  }

  /**
   * The captain, and whether a null one is an answer.
   *
   * `captainSession` says who it is, which is all a one-shot command needs. The
   * monitor needs more, because it acts on the *absence* of a captain: no
   * captain among sessions we did read is what tells `firstmate-decisions.js`
   * that firstmate has gone and every open ruling should leave the page. A lock
   * that would not read reaches the same null by a different route and means
   * nothing of the kind, so it is reported separately and the caller skips the
   * refresh on it - the same way it already skips when the session list itself
   * could not be read.
   *
   * A lock read after an unreadable one still settles it: `unreadable` is only
   * true of a reading that found no captain at all.
   *
   * @param {Session[]} sessions
   * @returns {{session: Session|null, unreadable: boolean}}
   */
  captainReading(sessions) {
    let unreadable = false;
    for (const session of sessions || []) {
      const verdict = this.#captainVerdict(session);
      if (verdict === 'yes') return { session, unreadable: false };
      if (verdict === 'unreadable') unreadable = true;
    }
    return { session: null, unreadable };
  }

  /**
   * The tmux window a session's pane sits in, when we have already read it.
   *
   * Deliberately does not schedule a read of its own. `spawnedBy` is called for
   * every session on every tick and is what keeps the table warm; a second
   * scheduler here would only add a way for the two to disagree about when a
   * pane was last looked up.
   *
   * @param {Session} session
   * @returns {string|null}
   */
  windowName(session) {
    const pane = session?.host?.tmux_pane;
    if (!pane) return null;
    const server = this.#servers.get(socketPath(session.host.tmux));
    return server?.names.get(pane) ?? null;
  }

  /**
   * Read every pane table once and wait for it.
   *
   * Only for one-shot commands, where there is no loop to protect and printing
   * before the answer arrives would mean printing a wrong one. The server must
   * never call this - see `LavishState.load`.
   *
   * @param {Session[]} sessions
   * @returns {Promise<void>}
   */
  async load(sessions) {
    if (!this.#execAsync) return;
    const sockets = new Set(
      sessions.filter((s) => s?.host?.tmux_pane).map((s) => socketPath(s.host.tmux)),
    );
    await Promise.all([...sockets].map((socket) => this.#read(socket)));
  }

  /**
   * Forget directories whose sessions have gone.
   *
   * The pane tables need no equivalent: each read replaces its server's map
   * wholesale, so it is bounded by how many panes tmux actually has.
   *
   * @param {Set<string>} liveDirs
   */
  prune(liveDirs) {
    for (const dir of this.#locks.keys()) {
      if (!liveDirs.has(dir)) this.#locks.delete(dir);
    }
  }

  /**
   * @param {import('./registry.js').Host|null|undefined} host
   * @param {number} now
   */
  #isCrew(host, now) {
    const pane = host?.tmux_pane;
    if (!pane) return false;
    const socket = socketPath(host.tmux);
    const server = this.#serverFor(socket);
    const name = server.names.get(pane);
    if (name !== undefined) return isCrewWindowName(name);
    this.#refresh(socket, now);
    return false;
  }

  /**
   * The captain is the session whose own directory holds the lock, *and* whose
   * agent pid is the one in it. Both halves are required: the first alone is
   * satisfied by anybody with firstmate's source checked out.
   *
   * @param {Session} session
   */
  #isCaptain(session) {
    return this.#captainVerdict(session) === 'yes';
  }

  /**
   * Whether this session is the captain, or whether we could not tell.
   *
   * Three answers rather than two, because two of the ways this can fail to say
   * yes are not the same fact: `no` is a session with no lock in its directory
   * or a lock naming somebody else, and `unreadable` is a lock we could not
   * read. Only the first is evidence.
   *
   * @param {Session} session
   * @returns {'yes'|'no'|'unreadable'}
   */
  #captainVerdict(session) {
    const cwd = session?.cwd;
    const pid = session?.host?.pid;
    if (!cwd || !pid) return 'no';
    const locked = this.#lockPidFor(cwd);
    if (locked === LOCK_UNREADABLE) return 'unreadable';
    return locked === pid ? 'yes' : 'no';
  }

  /**
   * @param {string} cwd
   * @returns {number|null|typeof LOCK_UNREADABLE}
   */
  #lockPidFor(cwd) {
    const path = join(cwd, ...LOCK_PATH);
    let info;
    try {
      info = this.#files.stat(path);
    } catch {
      // No lock here, which is every session but one - and the one path that
      // runs for every session on every tick, so it stays a single `stat`.
      this.#locks.delete(cwd);
      return null;
    }
    const cached = this.#locks.get(cwd);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.pid;
    let text;
    try {
      text = this.#files.readText(path);
    } catch {
      // Readable a moment ago and not now, which is also where a `state/.lock`
      // *directory* lands: `stat` accepts one and the read rejects it. Not
      // cached, so the next ask retries.
      return LOCK_UNREADABLE;
    }
    // Empty is the only shape a torn read can take here, and that is a fact
    // about how firstmate writes the file rather than a guess: `bin/fm-lock.sh`
    // writes it with a single `printf '%s\n' "$me"`, so a partial read is either
    // nothing yet or a prefix of digits - and a digit prefix parses, so it never
    // reaches this branch. Not cached either, because it is expected to be over
    // by the next tick.
    if (!text || !text.trim()) return LOCK_UNREADABLE;
    // Anything else present is an answer, and cached like one. It says this is
    // not firstmate's lock, which is a stable fact about somebody else's file -
    // re-reading it every tick would cost a read per session forever, and
    // reporting it as unreadable would take the whole machine's refresh with it.
    const pid = lockedPid(text);
    this.#locks.set(cwd, { size: info.size, mtimeMs: info.mtimeMs, pid });
    return pid;
  }

  /** @param {string} socket */
  #serverFor(socket) {
    let server = this.#servers.get(socket);
    if (!server) {
      server = { names: new Map(), at: null, reading: false };
      this.#servers.set(socket, server);
    }
    return server;
  }

  /**
   * Read a server's pane table if the last read has aged out. Never awaited.
   *
   * Stamped when the read goes out rather than when it returns, and from the
   * caller's clock, so a slow or failing tmux cannot be retried every tick.
   *
   * @param {string} socket
   * @param {number} now
   */
  #refresh(socket, now) {
    if (!this.#execAsync) return;
    const server = this.#serverFor(socket);
    if (server.reading) return;
    if (server.at !== null && now - server.at < REFRESH_MS) return;
    server.at = now;
    this.#read(socket);
  }

  /**
   * @param {string} socket
   * @returns {Promise<void>}
   */
  #read(socket) {
    const server = this.#serverFor(socket);
    server.reading = true;
    const [cmd, args] = tmuxCommand(socket, [
      'list-panes',
      '-a',
      '-F',
      '#{pane_id}\t#{window_name}',
    ]);
    return Promise.resolve()
      .then(() => this.#execAsync(cmd, args, { timeoutMs: 5000 }))
      .then((out) => {
        const names = parsePaneWindowNames(out);
        // A reading we did not get is not evidence. tmux not being installed,
        // the server having gone away, or a socket we cannot talk to all come
        // back empty, and treating that as "no pane is crew" would drop the
        // chip off every card at once and put it back a tick later.
        if (names.size > 0) server.names = names;
      })
      .catch(() => {
        // Same rule, by the other route.
      })
      .finally(() => {
        server.reading = false;
      });
  }
}
