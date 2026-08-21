/**
 * The monitor server: one poller, one event stream, one page.
 *
 * Push rather than poll on the browser side (server-sent events), and a one
 * second poll of the no-mistakes database on the server side. Polling a local
 * SQLite file is effectively free, and far more stable than the daemon's
 * private socket protocol, which is undocumented and would break on upgrade.
 *
 * Three rules here are load-bearing for the one failure this product cares
 * about most - a confident indicator over state that stopped updating - and
 * each of them looks like something a later tidy-up would undo.
 *
 * **The keepalive is a named SSE `event`, never a comment.** See the timer in
 * `start`, and `public/connection.js` for the other half. `EventSource` reports
 * an error only once the connection actually *breaks*, and a connection can
 * stop carrying data long before that - a suspended laptop, a frozen server, a
 * dropped NAT entry. A comment keepalive holds the socket open and the browser
 * discards it without telling the page, so in every one of those cases the
 * dashboard sat on a green "live" dot over a snapshot that had stopped moving.
 * Liveness is positive evidence, never the absence of an error. `KEEPALIVE_MS`,
 * `POLL_INTERVAL_MS` and the page's `STALE_AFTER_MS` are tuned against each
 * other: changing one alone is a change to when the page decides it has gone
 * blind.
 *
 * **Nothing here may run a synchronous child process.** The loop polls on a one
 * second timer, pushes a stream and answers hook posts bounded at two seconds;
 * one blocking `spawnSync` stalls all three, and the dropped signal is the one
 * you cared about. `server.test.js` injects an `exec` that fails the test if it
 * is ever called - do not weaken that guard, nor the `fetch` beside it, which
 * proves a server whose `forge` block is off makes no outbound request at all.
 * Say it exactly that way. The one request this server *can* make is the forge
 * lookup, and it goes through this very injection: the `fetch` handed in here
 * reaches `ForgeState`, which the poll calls into every second. The guard passes
 * because every `scratch()` in `server.test.js` points `RAISE_HOME` at an empty
 * directory, so `watchForgeConfig()` returns disabled and `observe` returns
 * before any request - not because the poll path cannot reach the network. The
 * update check is the one that genuinely lives outside: it runs in `cli.js`'s
 * `serve` command, before this server exists.
 *
 * **A reading we did not get is not evidence**, which is why the `release` and
 * `prune` calls in the poll are each guarded on a non-empty list rather than
 * run unconditionally. An empty reading is also what a transient failure
 * returns, and acting on one would scatter a parked run back across its repo
 * permanently - a parked run has no live process left to be re-observed from.
 * The reasoning is at both call sites.
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { NoMistakesState } from './nm-state.js';
import { SessionRegistry } from './registry.js';
import { TranscriptReader, defaultFileAccess } from './transcript-reader.js';
import { GitBranch, defaultGitAccess } from './git-branch.js';
import { LavishState } from './lavish.js';
import { ForgeState } from './forge.js';
import { watchForgeConfig } from './forge-config.js';
import { PollWatch } from './poll-watch.js';
import { FirstmateWatch } from './firstmate.js';
import { CAPTAIN_UNREADABLE, FirstmateDecisions } from './firstmate-decisions.js';
import { UntrackedScan } from './untracked.js';
import { buildRows, isDismissibleBlock, summarise } from './dashboard.js';
import { BuildStamp, PUBLIC_DIR } from './build-stamp.js';
import { RunOwners } from './run-owner.js';
import { focusSession } from './focus/index.js';
import { checkRequest } from './security.js';
import { exec as defaultExec, execAsync as defaultExecAsync } from './exec.js';
import { sessionsDir, statePath, serverInfoPath, readOrCreateToken, defaultPort } from './config.js';

const POLL_INTERVAL_MS = 1000;
export const KEEPALIVE_MS = 20000;
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Write one frame to one client without ever throwing.
 *
 * A client socket can be gone before we notice - laptop sleep, a dropped
 * network, an abort racing the close handler. Writing to it emits `error` on a
 * response with no listener, which is an uncaught exception and takes the whole
 * monitor down. Since Raise is the thing that tells you a session is blocked,
 * it dying is silent: you just stop being told anything.
 *
 * @param {import('node:http').ServerResponse} client
 * @param {string} frame
 * @param {(err: Error) => void} onError called on both the sync and async failure
 * @returns {boolean} whether the write was accepted
 */
export function writeFrame(client, frame, onError) {
  try {
    client.write(frame, (err) => {
      if (err) onError(err);
    });
    return true;
  } catch (err) {
    onError(err);
    return false;
  }
}

/**
 * Fields derived from the current clock rather than from state.
 *
 * They move every tick even when nothing has happened, so including them in the
 * change comparison means a blocked session or a parked run - precisely the
 * states this tool exists for - pushes a full frame and a full DOM rebuild once
 * a second, forever. The page renders elapsed time from the absolute
 * `waitingSince` instead - which is where the row already decided *whether* it
 * is waiting, so nothing is lost by ignoring the elapsed pair here. Any future
 * elapsed field belongs in this set.
 */
const VOLATILE_FIELDS = new Set(['generatedAt', 'waitingForMs', 'parkedForMs']);

/**
 * Serialise a snapshot for change detection only, never for the wire.
 *
 * @param {object} payload
 * @returns {string}
 */
export function stableJson(payload) {
  return JSON.stringify(payload, (key, value) => (VOLATILE_FIELDS.has(key) ? undefined : value));
}

export function createMonitorServer({
  port = defaultPort(),
  token = readOrCreateToken(),
  exec = defaultExec,
  execAsync = defaultExecAsync,
  // Injected for the same reason `exec` is, and guarded the same way: the suite
  // passes one that fails the test if it is ever called, which is what proves a
  // server whose `forge` block is off makes no outbound request at all. It
  // proves that and not more - this is the fetch `ForgeState` is built with
  // below, so an enabled forge reaches the network through here, from the poll.
  fetch = globalThis.fetch,
  // A reader rather than a reading: `~/.raise/config.json` changes under a
  // running server - `raise enable` in another terminal, or the user editing it
  // by hand - so an answer captured here would leave `raise doctor` reporting an
  // opt-in this server never saw until somebody restarted it. Costs a `stat` a
  // second - see `watchForgeConfig`. Tests pass a fixed config, accepted too.
  forgeConfig = watchForgeConfig(),
  dbPath = statePath(),
  sessionsPath = sessionsDir(),
  keepaliveMs = KEEPALIVE_MS,
  transcriptFiles = defaultFileAccess,
  gitFiles = defaultGitAccess,
  // Injected whole rather than as a file access object, because the suite needs
  // to point it at fixture roots as often as it needs to stub the reads.
  untrackedScan = new UntrackedScan(),
  // The directory `servePage` and `serveModule` hand files out of, and the
  // directory the build is computed over - one value, because those two being
  // the same directory is the whole of the stamp's guarantee. A test can point
  // the pair at a copy of `public/` and edit it, which is how `server.test.js`
  // asks whether every file the server hands out actually moves the build.
  publicDir = PUBLIC_DIR,
  // Injected whole for the same reason, and one more: the alternative to
  // driving the stamp from a test is a test that edits the product's own page
  // on the developer's disk to make the served build change.
  buildStamp = new BuildStamp({ dir: publicDir }),
} = {}) {
  const registry = new SessionRegistry({ dir: sessionsPath });
  const nmState = new NoMistakesState({ dbPath, exec, execAsync });
  const transcripts = new TranscriptReader({ files: transcriptFiles });
  const branches = new GitBranch({ files: gitFiles });
  const lavish = new LavishState({ execAsync });
  // Off unless `~/.raise/config.json` turns it on, and inert rather than absent
  // when it is off: every method returns immediately and the readings map stays
  // empty, so `buildRows` behaves exactly as it did before this existed.
  const forge = new ForgeState({ execAsync, fetch, config: forgeConfig });
  const polls = new PollWatch({ execAsync });
  // Reads a tmux pane name once per pane and a pid file once per lock change,
  // so it costs a `list-panes` only when a window we have never seen turns up.
  const firstmate = new FirstmateWatch({ execAsync, files: gitFiles });
  // Gated twice over: nothing runs unless a captain session is on the page, and
  // then only when a crewmate has written to its own event log since the last
  // reading. So a machine with no firstmate never spawns it, and a machine with
  // an idle fleet spawns it once.
  const firstmateDecisions = new FirstmateDecisions({ execAsync });
  // Outlives a poll on purpose: `axi run` returns at every gate, so the process
  // that proves ownership is absent for exactly as long as the run is parked.
  const runOwners = new RunOwners();
  const probe = nmState.probe();

  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();
  let lastPayloadJson = '';
  let pollTimer = null;
  let keepaliveTimer = null;
  let writtenInfoPath = null;

  function snapshot() {
    // `read` rather than `list` because one caller below acts on the *absence*
    // of a session and an empty array alone cannot say whether that absence was
    // read or merely returned - see `SessionRegistry.read`.
    const { sessions, readable: sessionsReadable } = registry.read();
    const candidateDirs = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];
    const { runs, pullRequests, source, warning } = nmState.read({ candidateDirs });

    const agentPids = new Set(sessions.map((s) => s.host?.pid).filter(Boolean));
    // Whose run it is, off the same scan the poll gate and the pipeline check
    // use. Several sessions can be open on one checkout, and only the one
    // driving the pipeline should carry it - the others cannot answer its gate,
    // so summoning anyone to them is a wrong answer with a Focus button
    // attached. Departed owners let go first, or a new driver's sighting would
    // be discarded on the very tick the old owner disappeared.
    //
    // Guarded on a non-empty reading, exactly as the prune below is: an empty
    // session list is not evidence that every owner departed, it is also what
    // `registry.list()` returns when `readdirSync` on the sessions directory
    // throws - a transient filesystem error rather than a real absence. Letting
    // one of those release everything would scatter a parked run back across
    // its repo, the failure this memory exists to prevent, and a parked run has
    // no live process to be re-observed from. Skipping the release costs
    // nothing when the list is legitimately empty: there are no session rows
    // for ownership to affect on such a tick, and prune still retires the entry
    // once the run leaves the reading.
    if (sessions.length > 0) runOwners.release(new Set(sessions.map((s) => s.sessionId)));
    // One `.git` resolution per session, up here because ownership is recorded
    // before anything else needs either answer: a session driving a pipeline
    // from a worktree can only be tied to that run through the link, and the
    // branch is what says which of the checkout's runs is this worktree's.
    // Both come off the same read and the same mtime check, so this is one stat
    // per session on the happy path, not two.
    const sessionBranches = new Map();
    const mainCheckouts = new Map();
    for (const session of sessions) {
      const { branch, mainCheckout } = branches.checkoutFor(session.cwd);
      sessionBranches.set(session.sessionId, branch);
      mainCheckouts.set(session.sessionId, mainCheckout);
    }
    runOwners.observeFrom(
      sessions,
      runs,
      (s) => polls.ownsRunFor(s.host?.pid, agentPids),
      mainCheckouts,
      sessionBranches,
    );

    const summaries = new Map();
    const reviewUrls = new Map();
    /** Which tool started each session's window, when the tool said so. */
    const spawnedBy = new Map();
    /**
     * The tmux window each session's pane sits in, which is how a firstmate
     * decision finds its crewmate: `endpoint.target` names the same pinned
     * `fm-<id>` window. Off the table `spawnedBy` already keeps warm, so this
     * costs a map lookup and no query of its own.
     */
    const windowNames = new Map();
    /** Sessions with a no-mistakes run still going underneath them. */
    const pipelines = new Set();
    for (const session of sessions) {
      // Already resolved above, and resolved before the transcript is read
      // because the branch is what decides which pull request in the tail
      // belongs to this session.
      const branch = sessionBranches.get(session.sessionId) || null;
      const read = transcripts.read(session.transcriptPath, branch, session.agent);
      // Cached per pane and per lock, so this is a map lookup on all but the
      // first tick a session is seen.
      spawnedBy.set(session.sessionId, firstmate.spawnedBy(session));
      windowNames.set(session.sessionId, firstmate.windowName(session));
      // The process table is the authority on whether a poll is still running.
      // A transcript can say the poll returned when only the tool call did -
      // Claude Code backgrounds anything past its own timeout, and a review
      // that takes a person more than ten minutes is the normal case.
      const polledFile = polls.fileFor(session.host?.pid, agentPids);
      // Same scan, second question: a backgrounded pipeline is what makes
      // Claude Code's "waiting for your input" a lie.
      if (polls.pipelineFor(session.host?.pid, agentPids)) pipelines.add(session.sessionId);
      const summary = polledFile ? { ...read, lavishFile: polledFile } : read;
      summaries.set(session.sessionId, summary);
      // Only ask Lavish about sessions that say they are polling it. Asking is
      // what schedules the refresh, so a machine with no reviews in flight
      // never runs the CLI at all.
      if (summary.lavishFile) {
        reviewUrls.set(session.sessionId, lavish.urlFor(summary.lavishFile));
      }
    }

    // The captain runs firstmate, and its own working directory is `$FM_HOME` -
    // so finding it is also what schedules the fleet snapshot. A machine
    // without firstmate has no lock holding a live session's pid, so there is
    // no captain, nothing is scheduled and no subprocess runs. Never awaited:
    // the command is bash walking a fleet and takes tens of seconds, where this
    // loop has one.
    //
    // No captain among sessions we did read is positive evidence that firstmate
    // has gone, and clears every ruling off the page. What decides the answer
    // here is only ever whether a reading was *obtained*, never what went wrong
    // when one was not.
    //
    // **An empty session list is an answer, and only a directory we could not
    // read is not.** `list` returns the same empty array for both, which is why
    // this reads through `registry.read` instead - the two are separable there
    // and nowhere after it. Getting the split wrong is costly in both
    // directions, which is what stops them being collapsed again. Take an empty
    // list for a failed read, and quitting every agent at the end of the day
    // with `raise serve` still running leaves a *Rulings waiting* card carrying
    // four rulings, a tab title claiming somebody is waiting, and a desktop
    // notification for a firstmate that has exited - for a quarter of an hour,
    // until the ceiling counts it out. Take a failed read for an empty list, and
    // a momentary filesystem error clears rulings that are still open.
    //
    // **A lock we could not read is the other non-answer**, and it is asked
    // about *one directory at a time*. The question is only "has the captain
    // gone", and the sole lock that can answer it is the one at the home the
    // standing reading came from - no other session was ever the captain, so no
    // other session's lock speaks to it. Asked across every session instead, a
    // single stray `state/.lock` in an unrelated checkout would suppress this
    // refresh for the whole machine. With no reading in hand there is no
    // assertion to protect, so the answer is a plain no.
    //
    // Three answers, one call, and the call is always made. All this decides is
    // *which* answer; what a non-answer costs is decided in one place, on one
    // counter, over there - which is what bounds how long a hold can last.
    const captain = firstmate.captainSession(sessions);
    firstmateDecisions.refresh(
      captain
        ? captain.cwd
        : !sessionsReadable || firstmate.lockUnreadableAt(firstmateDecisions.home)
          ? CAPTAIN_UNREADABLE
          : null,
    );

    // Sessions nothing has ever reported, so the first page a stranger sees is
    // not blank. Deduped against the registry on every tick rather than at scan
    // time, so a session that restarts loses its untracked row on the next poll
    // - and against the sessions we watched end, which are not unreported and
    // have nothing to restart.
    //
    // They ride the same three maps as a registered session, keyed by transcript
    // path instead of session id, which is what lets the `.git` cache, the
    // transcript cache and both prunes serve them with no second mechanism.
    // Deliberately *not* added to `candidateDirs`: that list is what the degraded
    // `axi status` path spawns a process per entry for, and these rows carry no
    // run at all.
    const untracked = untrackedScan.list({
      registeredPaths: registry.reportedPaths(sessions),
    });
    for (const found of untracked) {
      const { branch, mainCheckout } = branches.checkoutFor(found.cwd);
      sessionBranches.set(found.key, branch);
      mainCheckouts.set(found.key, mainCheckout);
      summaries.set(found.key, transcripts.read(found.transcriptPath, branch, found.agent));
    }

    transcripts.prune(
      new Set([
        ...sessions.map((s) => s.transcriptPath).filter(Boolean),
        ...untracked.map((u) => u.transcriptPath),
      ]),
    );
    branches.prune(new Set([...candidateDirs, ...untracked.map((u) => u.cwd)]));
    firstmate.prune(new Set(candidateDirs));
    // An empty reading is not evidence that every run ended - it is what the
    // degraded `axi status` path returns from its cache before the first
    // non-blocking call has warmed it. Pruning on that would forget every
    // ownership in one tick, and a parked run has no live process to be
    // re-observed from, so it would scatter back across its repo for the rest
    // of its life. Same rule PollWatch applies to a `ps` it could not read: a
    // reading we did not get is not evidence of anything. A few stale entries
    // until a real reading arrives is the cheap side of the trade.
    if (runs.length > 0) runOwners.prune(new Set(runs.map((r) => r.runId)));

    const rows = buildRows({
      sessions,
      runs,
      summaries,
      reviewUrls,
      branches: sessionBranches,
      mainCheckouts,
      pullRequests,
      pipelines,
      runOwners: runOwners.owners,
      forgeStates: forge.readings,
      untracked,
      spawnedBy,
      decisions: firstmateDecisions.tasks,
      windowNames,
      captainSessionId: captain?.sessionId || null,
    });
    // Asking is what schedules the next answer, the same arrangement `lavish.js`
    // uses: the rows are what say which pull requests are worth a request, so
    // the set is whatever is actually rendered rather than everything the
    // database remembers. A URL seen for the first time is answered on a later
    // tick, and nothing here is awaited - this loop has one second to do
    // everything and a network round trip does not fit in it.
    forge.observe(rows.map((row) => row.pr?.url).filter(Boolean));
    return {
      rows,
      summary: summarise(rows),
      source,
      warning,
      // Which build of the page this server is serving, so a tab pinned for a
      // week can tell it is rendering with code that has since been replaced.
      // It rides here rather than on the `ping` because the state frame is
      // delivered at both the moments this can change: `openStream` pushes one
      // unconditionally, so a restart - which is a reconnect - is answered at
      // once, where the keepalive is a single server-wide interval and a client
      // can wait a full `KEEPALIVE_MS` for its first. And an edit under a
      // running server moves this value, which moves `stableJson`, which
      // broadcasts - so the change announces itself through the machinery that
      // is already here. Constant otherwise, so it costs no extra frames.
      build: buildStamp.current(),
      generatedAt: Date.now(),
    };
  }

  /** Last resort for a request whose handler failed after the socket died. */
  function endQuietly(res) {
    try {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('request failed');
    } catch {
      // The socket is gone, which is why we are here.
    }
  }

  function dropClient(client) {
    clients.delete(client);
    try {
      client.end();
    } catch {
      // Already gone; that is the whole reason we are here.
    }
  }

  function send(client, frame) {
    writeFrame(client, frame, () => dropClient(client));
  }

  function broadcast(force = false) {
    const payload = snapshot();
    const json = stableJson(payload);
    if (!force && json === lastPayloadJson) return;
    lastPayloadJson = json;
    const frame = `event: state\ndata: ${JSON.stringify(payload)}\n\n`;
    // The copy is the point: `send` drops a client that fails to write, which
    // deletes from `clients` while this loop is walking it.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const client of [...clients]) {
      send(client, frame);
    }
  }

  const server = createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://127.0.0.1:${port}`);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }

    // Unauthenticated liveness probe, so `raise doctor` can tell "not running"
    // from "running but I have the wrong token". Reveals nothing.
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }

    const check = checkRequest(req, url, { token, port });
    if (!check.ok) {
      res.writeHead(check.status, { 'content-type': 'text/plain' });
      res.end(check.reason);
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      servePage(res, token);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/connection.js') {
      serveModule(res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      openStream(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/event') {
      handleHookEvent(req, res).catch(() => endQuietly(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/dismiss') {
      handleDismiss(req, res).catch(() => endQuietly(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/focus') {
      // /focus now waits on osascript and tmux, so the client has plenty of
      // time to walk away. A write to its dead socket must not surface as an
      // unhandled rejection and kill the monitor.
      handleFocus(req, res).catch(() => endQuietly(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/recent') {
      serveRecent(res, url.searchParams.get('session'));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(snapshot()));
      return;
    }

    res.writeHead(404).end('not found');
  });

  function servePage(res, pageToken) {
    // Stamped into the bytes the tab receives, so it knows what it *loaded*
    // with rather than what it was first *told*. Those differ: a page loaded
    // during a restart can take its HTML from one build and its first frame
    // from the next, and a tab that only remembered the first stamp it was sent
    // would agree with the server forever while running superseded code.
    //
    // Taken *before* the bytes, because the stamp and the page are two separate
    // reads and an upgrade or an in-place edit can land between them. Stamped
    // after, that window hands this tab the old page carrying the new build's
    // number, and it agrees with the server for as long as it stays open -
    // permanent quiet staleness, which is the thing this exists to prevent.
    // Stamped first, the same race resolves the other way: a current page
    // carrying the previous stamp says it is behind, and a reload settles it.
    //
    // An unreadable build substitutes the empty string rather than leaving the
    // placeholder in place, because a literal `__RAISE_BUILD__` would compare
    // unequal to every real stamp and put an out-of-date notice on a page that
    // is perfectly current. `createBuildWatch` reads the empty string as no
    // answer, exactly as it reads an absent field.
    const build = buildStamp.current() ?? '';
    let html;
    try {
      html = readFileSync(join(publicDir, 'index.html'), 'utf8');
    } catch {
      res.writeHead(500).end('page missing');
      return;
    }
    // The page needs the token to open the event stream and to focus.
    html = html.replace('__RAISE_TOKEN__', pageToken);
    html = html.replace('__RAISE_BUILD__', build);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // Nothing external, ever. 'self' is here only so the page can import
      // /connection.js; it does not widen anything beyond this origin.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
      'referrer-policy': 'no-referrer',
    });
    res.end(html);
  }

  /**
   * The one script the page loads rather than inlines.
   *
   * It is a fixed filename, never anything derived from the request, so there
   * is no path for a traversal to take. The page imports it with the token
   * attached, which keeps "everything but /health needs the token" true.
   */
  function serveModule(res) {
    let source;
    try {
      source = readFileSync(join(publicDir, 'connection.js'), 'utf8');
    } catch {
      res.writeHead(500).end('module missing');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(source);
  }

  /**
   * The recent history of one session, for a card someone has expanded.
   *
   * Pulled rather than pushed, and one session at a time. Putting this in the
   * state frame would mean every session's history in every frame, to every
   * open page, once a second - and a full DOM rebuild each time - to render
   * something that is collapsed on all of them nearly all of the time.
   *
   * The transcript path comes from the registry, keyed by session id, so no
   * request can ask this server to read a path of its own choosing.
   */
  function serveRecent(res, sessionId) {
    const record = sessionId ? registry.get(sessionId) : null;
    if (!record) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'that session is no longer registered' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(
      JSON.stringify({
        ok: true,
        sessionId: record.sessionId,
        events: transcripts.events(record.transcriptPath, undefined, record.agent),
      }),
    );
  }

  function openStream(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    clients.add(res);
    // A destroyed socket must never reach the process as an uncaught error.
    res.on('error', () => dropClient(res));
    req.on('error', () => dropClient(res));
    req.on('close', () => {
      clients.delete(res);
    });
    send(res, ': connected\n\n');
    send(res, `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handleHookEvent(req, res) {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end(`bad payload: ${err.message}`);
      return;
    }
    try {
      registry.record(payload);
    } catch (err) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end(err.message);
      return;
    }
    // A hook event is exactly the moment something changed, so push at once
    // rather than waiting up to a second for the next poll.
    broadcast(true);
    res.writeHead(204).end();
  }

  /**
   * A human saying this "Waiting for you" is not owed.
   *
   * The eligibility check is repeated here rather than trusted from the page.
   * The page decides whether to *offer* the control; a request arriving anyway -
   * a stale tab whose row went from a nudge to a real permission prompt between
   * the render and the click - must be refused, because the whole safety of the
   * feature is that only an idle nudge can ever be dismissed.
   */
  async function handleDismiss(req, res) {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400).end('bad payload');
      return;
    }
    const record = registry.get(payload.sessionId);
    if (!record) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'that session is no longer registered' }));
      return;
    }
    if (!isDismissibleBlock(record)) {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          reason: 'that session is not waiting on an idle nudge any more',
        }),
      );
      return;
    }
    registry.dismissBlock(record.sessionId);
    // The row changes the instant it is clicked, exactly as a hook event does.
    broadcast(true);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  async function handleFocus(req, res) {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400).end('bad payload');
      return;
    }
    const record = registry.get(payload.sessionId);
    if (!record) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'that session is no longer registered' }));
      return;
    }
    // execAsync, never exec: focusing shells out to osascript and tmux, and a
    // synchronous child here would stall the poll timer, every open event
    // stream and every hook post along with it.
    let result;
    try {
      result = await focusSession(record, { exec: execAsync });
    } catch (err) {
      result = { ok: false, reason: `Could not focus that session: ${err.message}` };
    }
    res.writeHead(result.ok ? 200 : 409, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        const info = { port, token, pid: process.pid, startedAt: Date.now() };
        writtenInfoPath = serverInfoPath();
        writeFileSync(writtenInfoPath, JSON.stringify(info, null, 2), { mode: 0o600 });
        pollTimer = setInterval(() => broadcast(false), POLL_INTERVAL_MS);
        // A named event, not an SSE comment. EventSource discards comments
        // without telling the page, so a comment keepalive holds the socket
        // open and proves nothing to the only party that needs convincing: with
        // one, a server that freezes or whose connection stalls leaves the page
        // showing a green "live" dot over state that stopped updating. The page
        // watches for these and goes stale when they stop arriving.
        keepaliveTimer = setInterval(() => {
          const frame = `event: ping\ndata: ${Date.now()}\n\n`;
          // Copied for the same reason as in `broadcast`: `send` can drop a
          // client mid-loop, and a dead connection is exactly what this finds.
          // oxlint-disable-next-line unicorn/no-useless-spread
          for (const client of [...clients]) send(client, frame);
        }, keepaliveMs);
        resolve(info);
      });
    });
  }

  function stop() {
    clearInterval(pollTimer);
    clearInterval(keepaliveTimer);
    // `dropClient` deletes from `clients`, so this one is deleting from the
    // collection it iterates on every single pass rather than only on failure.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const client of [...clients]) dropClient(client);
    clients.clear();
    nmState.close();
    // Leaving server.json behind is not just a stale URL in `raise open`: every
    // hook keeps posting the session id, cwd, transcript path and the token to
    // whatever binds this port next.
    if (writtenInfoPath) {
      try {
        unlinkSync(writtenInfoPath);
      } catch {
        // Never written, or already cleaned up.
      }
      writtenInfoPath = null;
    }
    return new Promise((resolve) => server.close(resolve));
  }

  return { server, start, stop, snapshot, probe, url: () => `http://127.0.0.1:${port}/?t=${token}` };
}
