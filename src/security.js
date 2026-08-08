/**
 * Guarding a server that is bound to localhost and can focus windows.
 *
 * "It only listens on 127.0.0.1" is not a security boundary. Any page in the
 * user's browser can issue requests to localhost, and DNS rebinding can make a
 * hostile domain resolve there. Since this server takes instructions that end
 * in running osascript and tmux commands, it needs three cheap checks:
 *
 *   1. a shared token, so an attacker must have read a file on this machine
 *   2. a Host allowlist, which defeats DNS rebinding
 *   3. an Origin allowlist, so a browser page cannot post to us cross-site
 *
 * All pure, so they are tested directly rather than through a live socket.
 */

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function hostAllowed(hostHeader, port) {
  if (!hostHeader) return false;
  // Split off the port, taking care with bracketed IPv6 literals.
  const match = String(hostHeader).match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!match) return false;
  const [, hostname, hostPort] = match;
  if (!ALLOWED_HOSTNAMES.has(hostname)) return false;
  if (hostPort && Number(hostPort) !== Number(port)) return false;
  return true;
}

export function originAllowed(originHeader, port) {
  // No Origin at all is normal for same-origin navigations and for curl from a
  // hook, both of which we want to allow.
  if (!originHeader) return true;
  let url;
  try {
    url = new URL(originHeader);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  if (!ALLOWED_HOSTNAMES.has(url.hostname)) return false;
  return Number(url.port) === Number(port);
}

/** Constant-time-ish comparison; these are short hex strings from the same host. */
export function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export function extractToken(req, url) {
  const header = req.headers['x-raise-token'];
  if (typeof header === 'string' && header) return header;
  return url.searchParams.get('t') || '';
}

/**
 * Discriminated on `ok`, so a caller that checks it can reach `status` and
 * `reason` without a further guard.
 *
 * @typedef {{ok: true, status?: undefined, reason?: undefined}
 *           | {ok: false, status: number, reason: string}} CheckResult
 */

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {URL} url
 * @param {{token: string, port: number}} options
 * @returns {CheckResult}
 */
export function checkRequest(req, url, { token, port }) {
  if (!hostAllowed(req.headers.host, port)) {
    return { ok: false, status: 403, reason: 'host not allowed' };
  }
  if (!originAllowed(req.headers.origin, port)) {
    return { ok: false, status: 403, reason: 'origin not allowed' };
  }
  if (!tokenMatches(extractToken(req, url), token)) {
    return { ok: false, status: 401, reason: 'bad or missing token' };
  }
  return { ok: true };
}
