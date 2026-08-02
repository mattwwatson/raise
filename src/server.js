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
import { buildRows, summarise } from './dashboard.js';
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
} = {}) {
  const registry = new SessionRegistry({ dir: sessionsPath });
  const nmState = new NoMistakesState({ dbPath, exec, execAsync });
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
    const { runs, source, warning } = nmState.read({ candidateDirs });
    const rows = buildRows({ sessions, runs });
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
    if (req.method === 'POST' && url.pathname === '/focus') {
      // /focus now waits on osascript and tmux, so the client has plenty of
      // time to walk away. A write to its dead socket must not surface as an
      // unhandled rejection and kill the monitor.
      handleFocus(req, res).catch(() => endQuietly(res));
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
          for (const client of [...clients]) send(client, frame);
        }, keepaliveMs);
        resolve(info);
      });
    });
  }

  function stop() {
    clearInterval(pollTimer);
    clearInterval(keepaliveTimer);
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
