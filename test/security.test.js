import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hostAllowed,
  originAllowed,
  tokenMatches,
  checkRequest,
  extractToken,
} from '../src/security.js';

test('hostAllowed accepts loopback names on the right port', () => {
  assert.equal(hostAllowed('127.0.0.1:7717', 7717), true);
  assert.equal(hostAllowed('localhost:7717', 7717), true);
  assert.equal(hostAllowed('[::1]:7717', 7717), true);
  assert.equal(hostAllowed('127.0.0.1', 7717), true, 'a missing port is the default port');
});

test('hostAllowed rejects the DNS rebinding shapes', () => {
  // A hostile domain resolving to 127.0.0.1 still sends its own Host header.
  assert.equal(hostAllowed('evil.example.com:7717', 7717), false);
  assert.equal(hostAllowed('127.0.0.1.nip.io:7717', 7717), false);
  assert.equal(hostAllowed('localhost.evil.com:7717', 7717), false);
  assert.equal(hostAllowed('', 7717), false);
  assert.equal(hostAllowed(undefined, 7717), false);
});

test('hostAllowed rejects a mismatched port', () => {
  assert.equal(hostAllowed('127.0.0.1:9999', 7717), false);
});

test('originAllowed permits same-origin and no-origin, rejects everything else', () => {
  assert.equal(originAllowed(undefined, 7717), true, 'curl from a hook sends no Origin');
  assert.equal(originAllowed('http://127.0.0.1:7717', 7717), true);
  assert.equal(originAllowed('http://localhost:7717', 7717), true);
  assert.equal(originAllowed('http://evil.example.com', 7717), false);
  assert.equal(originAllowed('http://127.0.0.1:9999', 7717), false);
  assert.equal(originAllowed('https://127.0.0.1:7717', 7717), false);
  assert.equal(originAllowed('not a url', 7717), false);
});

test('tokenMatches is exact and type safe', () => {
  assert.equal(tokenMatches('abc123', 'abc123'), true);
  assert.equal(tokenMatches('abc123', 'abc124'), false);
  assert.equal(tokenMatches('abc', 'abc123'), false);
  assert.equal(tokenMatches(undefined, 'abc123'), false);
  assert.equal(tokenMatches(null, null), false);
});

test('extractToken prefers the header over the query string', () => {
  const url = new URL('http://127.0.0.1:7717/events?t=fromquery');
  assert.equal(extractToken({ headers: { 'x-raise-token': 'fromheader' } }, url), 'fromheader');
  assert.equal(extractToken({ headers: {} }, url), 'fromquery');
});

test('checkRequest reports the specific failure', () => {
  const url = new URL('http://127.0.0.1:7717/state');
  const opts = { token: 'secret', port: 7717 };

  assert.deepEqual(
    checkRequest({ headers: { host: 'evil.com:7717', 'x-raise-token': 'secret' } }, url, opts),
    { ok: false, status: 403, reason: 'host not allowed' },
  );
  assert.deepEqual(
    checkRequest(
      { headers: { host: '127.0.0.1:7717', origin: 'http://evil.com', 'x-raise-token': 'secret' } },
      url,
      opts,
    ),
    { ok: false, status: 403, reason: 'origin not allowed' },
  );
  assert.deepEqual(checkRequest({ headers: { host: '127.0.0.1:7717' } }, url, opts), {
    ok: false,
    status: 401,
    reason: 'bad or missing token',
  });
  assert.deepEqual(
    checkRequest({ headers: { host: '127.0.0.1:7717', 'x-raise-token': 'secret' } }, url, opts),
    { ok: true },
  );
});
