/**
 * The monitor server: one poller, one event stream, one page.
 *
 * Push rather than poll on the browser side (server-sent events), and a one
 * second poll of the no-mistakes database on the server side. Polling a local
 * SQLite file is effectively free, and far more stable than the daemon's
 * private socket protocol, which is undocumented and would break on upgrade.
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { NoMistakesState } from './nm-state.js';
import { SessionRegistry } from './registry.js';
import { TranscriptReader, defaultFileAccess } from './transcript-reader.js';
import { GitBranch, defaultGitAccess } from './git-branch.js';
import { LavishState } from './lavish.js';
import { PollWatch } from './poll-watch.js';
import { FirstmateWatch } from './firstmate.js';
import { buildRows, isDismissibleBlock, summarise } from './dashboard.js';
import { RunOwners } from './run-owner.js';
import { focusSession } from './focus/index.js';
import { checkRequest } from './security.js';
import { exec as defaultExec, execAsync as defaultExecAsync } from './exec.js';
import { sessionsDir, statePath, serverInfoPath, readOrCreateToken, defaultPort } from './config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');

const POLL_INTERVAL_MS = 1000;
export const KEEPALIVE_MS = 20000;
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Write one frame to one client without ever throwing.
 *
 * A client socket can be gone before we notice - laptop sleep, a dropped
 * network, an abort racing the close handler. Writing to it emits `error` on a
 * response with no listener, which is an uncaught exception and takes the whole
 * monitor down. Since nmmon is the thing that tells you a session is blocked,
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
 * `sessionStateSince`/`parkedSince` instead, so nothing is lost by ignoring
 * them here. Any future elapsed field belongs in this set.
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
  dbPath = statePath(),
  sessionsPath = sessionsDir(),
  keepaliveMs = KEEPALIVE_MS,
  transcriptFiles = defaultFileAccess,
  gitFiles = defaultGitAccess,
} = {}) {
  const registry = new SessionRegistry({ dir: sessionsPath });
  const nmState = new NoMistakesState({ dbPath, exec, execAsync });
  const transcripts = new TranscriptReader({ files: transcriptFiles });
  const branches = new GitBranch({ files: gitFiles });
  const lavish = new LavishState({ execAsync });
  const polls = new PollWatch({ execAsync });
  // Reads a tmux pane name once per pane and a pid file once per lock change,
  // so it costs a `list-panes` only when a window we have never seen turns up.
  const firstmate = new FirstmateWatch({ execAsync, files: gitFiles });
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
    const sessions = registry.list();
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
    transcripts.prune(new Set(sessions.map((s) => s.transcriptPath).filter(Boolean)));
    branches.prune(new Set(candidateDirs));
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
      spawnedBy,
    });
    return {
      rows,
      summary: summarise(rows),
      source,
      warning,
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

    // Unauthenticated liveness probe, so `nmmon doctor` can tell "not running"
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
    let html;
    try {
      html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
    } catch {
      res.writeHead(500).end('page missing');
      return;
    }
    // The page needs the token to open the event stream and to focus.
    html = html.replace('__NMMON_TOKEN__', pageToken);
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
      source = readFileSync(join(PUBLIC_DIR, 'connection.js'), 'utf8');
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
    // Leaving server.json behind is not just a stale URL in `nmmon open`: every
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
