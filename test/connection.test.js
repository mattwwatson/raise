/**
 * The rule that decides whether the page is telling you the truth.
 *
 * Reproduces, without a browser, the failure that prompted it: a server frozen
 * with SIGSTOP keeps its socket open, EventSource never fires an error, and the
 * page sat on a green "live" dot for as long as you cared to watch. The clock
 * is injected precisely so that minute is a few microseconds here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createConnectionWatch,
  connectionLabel,
  KEEPALIVE_MS,
  STALE_AFTER_MS,
  RECONNECT_GRACE_MS,
} from '../public/connection.js';

/** A clock you can shove forwards. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('a fresh watch is connecting, not live', () => {
  // The header used to be hard-coded to "live" in the markup, so the page
  // claimed a working connection before it had received a single byte.
  const watch = createConnectionWatch({ now: clock().now });
  assert.equal(watch.status(), 'connecting');
  assert.equal(connectionLabel('connecting', 0).tone, 'wait', 'and it does not look healthy yet');
});

test('any frame from the server counts as proof of life', () => {
  const c = clock();
  const watch = createConnectionWatch({ now: c.now });
  watch.noteMessage();
  assert.equal(watch.status(), 'live');
  c.advance(STALE_AFTER_MS - 1);
  assert.equal(watch.status(), 'live', 'still inside the window');
});

test('silence past the stale window is stale, with no error to prompt it', () => {
  // The whole point: nothing happens here except time passing. A frozen server
  // or a suspended laptop produces exactly this - no error, no close, no data.
  const c = clock();
  const watch = createConnectionWatch({ now: c.now });
  watch.noteMessage();
  c.advance(STALE_AFTER_MS + 1);
  assert.equal(watch.status(), 'stale');
});

test('the stale window survives one missed keepalive but not three', () => {
  // Tight enough to catch a dead server quickly, loose enough that a single
  // late keepalive does not flicker the indicator and train you to ignore it.
  assert.ok(STALE_AFTER_MS > KEEPALIVE_MS * 2, 'one dropped keepalive must not read as stale');
  assert.ok(STALE_AFTER_MS < KEEPALIVE_MS * 3, 'three misses is already too long to be lying');
});

test('a keepalive rescues a connection that was about to go stale', () => {
  const c = clock();
  const watch = createConnectionWatch({ now: c.now });
  watch.noteMessage();
  c.advance(STALE_AFTER_MS - 100);
  watch.noteMessage(); // the ping lands
  c.advance(STALE_AFTER_MS - 100);
  assert.equal(watch.status(), 'live');
});

test('a reported error is down immediately, and a later frame clears it', () => {
  const c = clock();
  const watch = createConnectionWatch({ now: c.now });
  watch.noteMessage();
  watch.noteError();
  assert.equal(watch.status(), 'down');
  watch.noteMessage();
  assert.equal(watch.status(), 'live', 'a reconnect that succeeds is live again');
});

test('reopening the socket is not evidence of anything', () => {
  // Caught in the browser against a SIGSTOPped server. The first version
  // cleared the last-contact clock on reconnect, so the page dropped back to a
  // green "connecting" and sat there indefinitely - the frozen server happily
  // accepted the new connection and then said nothing, exactly as it had on the
  // old one. Reopening a socket proves the OS will accept a connection, not
  // that anyone is home.
  const c = clock();
  const watch = createConnectionWatch({ now: c.now });
  watch.noteMessage();
  c.advance(STALE_AFTER_MS + 1);
  assert.equal(watch.status(), 'stale');

  watch.noteReconnect();
  assert.equal(watch.status(), 'stale', 'still stale: nothing has been received');
  c.advance(RECONNECT_GRACE_MS + 1);
  assert.equal(watch.status(), 'stale');

  watch.noteMessage();
  assert.equal(watch.status(), 'live', 'only an actual frame clears it');
});

test('a reconnect gets a grace period, then another go', () => {
  // Without the grace period a frozen server means a fresh EventSource every
  // five seconds forever; without the retry, one failed reconnect and the page
  // never tries again.
  const c = clock();
  const watch = createConnectionWatch({ now: c.now });
  watch.noteMessage();
  c.advance(STALE_AFTER_MS + 1);
  assert.equal(watch.shouldReconnect(), true, 'stale with no attempt yet');

  watch.noteReconnect();
  assert.equal(watch.shouldReconnect(), false, 'give the new socket a chance');
  c.advance(RECONNECT_GRACE_MS - 100);
  assert.equal(watch.shouldReconnect(), false);
  c.advance(200);
  assert.equal(watch.shouldReconnect(), true, 'that one produced nothing either');
});

test('a live or broken connection is never force-reconnected', () => {
  // 'down' is EventSource retrying on its own; racing it just churns sockets.
  const c = clock();
  const watch = createConnectionWatch({ now: c.now });
  watch.noteMessage();
  assert.equal(watch.shouldReconnect(), false, 'live');

  c.advance(STALE_AFTER_MS + 1);
  watch.noteError();
  assert.equal(watch.status(), 'down');
  assert.equal(watch.shouldReconnect(), false, 'leave EventSource to it');
});

test('a first load that never connects is not force-reconnected either', () => {
  const c = clock();
  const watch = createConnectionWatch({ now: c.now });
  c.advance(STALE_AFTER_MS * 10);
  assert.equal(watch.status(), 'connecting');
  assert.equal(watch.shouldReconnect(), false);
});

test('quietForMs is how long the page has been showing unconfirmed state', () => {
  const c = clock();
  const watch = createConnectionWatch({ now: c.now });
  assert.equal(watch.quietForMs(), 0);
  watch.noteMessage();
  c.advance(90_000);
  assert.equal(watch.quietForMs(), 90_000);
});

test('the stale label says how long, because the page still looks normal', () => {
  assert.deepEqual(connectionLabel('live', 0), { text: 'live', tone: 'ok' });
  assert.deepEqual(connectionLabel('down', 0), { text: 'reconnecting', tone: 'bad' });
  assert.deepEqual(connectionLabel('stale', 55_000), { text: 'no response for 55s', tone: 'bad' });
  assert.deepEqual(connectionLabel('stale', 300_000), { text: 'no response for 5m', tone: 'bad' });
});

test('only a healthy connection reads as healthy', () => {
  // The tone drives the dot colour and whether the rows are dimmed, so this is
  // the single place that decides whether the page looks trustworthy.
  const tone = (status) => connectionLabel(status, 60_000).tone;
  assert.equal(tone('live'), 'ok');
  for (const status of ['connecting', 'stale', 'down']) {
    assert.notEqual(tone(status), 'ok', `${status} must not look live`);
  }
});

test('a custom stale window is honoured', () => {
  const c = clock();
  const watch = createConnectionWatch({ now: c.now, staleAfterMs: 100 });
  watch.noteMessage();
  c.advance(101);
  assert.equal(watch.status(), 'stale');
});
