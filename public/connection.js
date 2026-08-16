/**
 * Deciding whether the monitor is still there.
 *
 * The page cannot answer this from the socket alone. `EventSource` only reports
 * an error once the connection actually breaks, and a connection can stop
 * carrying data long before that: a suspended laptop, a frozen server, a NAT
 * table that dropped the flow. In every one of those the socket stays open, no
 * error fires, and the page goes on showing a green "live" dot over a snapshot
 * that stopped updating - which is the worst possible failure for a tool whose
 * entire job is telling you something needs you.
 *
 * So liveness is positive evidence, never the absence of an error: the server
 * sends a `ping` event on a fixed interval, and silence past a couple of those
 * means stale until proven otherwise.
 *
 * No DOM and no timers in here - the clock is injected - so the rule can be
 * tested directly instead of by watching a browser for a minute.
 */

/** Matches the server's keepalive interval. */
export const KEEPALIVE_MS = 20000;

/**
 * Two missed keepalives plus room for a slow one. Tighter than this and an
 * ordinary scheduling hiccup flickers the indicator, which trains you to
 * ignore it.
 */
export const STALE_AFTER_MS = 50000;

/**
 * How long a forced reconnect gets to produce its first frame before we give up
 * and force another. The server pushes a state frame the instant a stream
 * opens, so this only has to cover a slow one.
 */
export const RECONNECT_GRACE_MS = 15000;

/**
 * @typedef {'connecting' | 'live' | 'stale' | 'down'} ConnectionStatus
 *   connecting - first load, nothing received yet
 *   live       - a frame arrived within the stale window
 *   stale      - out of contact; whatever is on screen is unconfirmed
 *   down       - the socket broke and EventSource is retrying
 */

/**
 * @param {{staleAfterMs?: number, reconnectGraceMs?: number, now?: () => number}} [options]
 */
export function createConnectionWatch({
  staleAfterMs = STALE_AFTER_MS,
  reconnectGraceMs = RECONNECT_GRACE_MS,
  now = Date.now,
} = {}) {
  let lastMessageAt = null;
  let broken = false;
  let reconnectingSince = null;

  return {
    /** Any frame from the server, `state` or `ping` alike, is proof of life. */
    noteMessage() {
      lastMessageAt = now();
      broken = false;
      reconnectingSince = null;
    },

    /** EventSource told us the connection failed. */
    noteError() {
      broken = true;
    },

    /**
     * A fresh socket has been opened in place of a stale one.
     *
     * Deliberately does *not* clear the last-contact clock. Reopening a socket
     * proves nothing - a frozen server accepts the connection and then says
     * nothing at all - and an earlier version reset it here, so the page
     * dropped back to a healthy-looking "connecting" and sat there. Time out of
     * contact is measured from the last frame actually received, whatever we
     * have done to the socket since.
     */
    noteReconnect() {
      broken = false;
      reconnectingSince = now();
    },

    /** @returns {number | null} */
    lastMessageAt: () => lastMessageAt,

    /** @returns {number} how long the page has been showing state it cannot confirm */
    quietForMs: () => (lastMessageAt === null ? 0 : Math.max(0, now() - lastMessageAt)),

    /** @returns {ConnectionStatus} */
    status() {
      if (broken) return 'down';
      if (lastMessageAt === null) return 'connecting';
      return now() - lastMessageAt > staleAfterMs ? 'stale' : 'live';
    },

    /**
     * Should the page tear the socket down and open a new one?
     *
     * Only for a stale connection: `down` is EventSource's own business and it
     * is already retrying. The grace period stops a frozen server turning into
     * a reconnect every five seconds.
     */
    shouldReconnect() {
      if (broken || lastMessageAt === null) return false;
      if (now() - lastMessageAt <= staleAfterMs) return false;
      return reconnectingSince === null || now() - reconnectingSince > reconnectGraceMs;
    },
  };
}

/**
 * Whether this tab is still running the page the server is serving.
 *
 * The same idea as the watch above, applied to code rather than data. A pinned
 * tab loads its HTML and JavaScript once and lives for days; when the server
 * restarts with new code the stream quietly reopens and the tab carries on
 * rendering with what it downloaded, ignoring every new field that arrives. So
 * the server stamps each page with the build it was served and states the build
 * it is serving on every state frame, and this compares the two.
 *
 * **A frame that carries no stamp says nothing, and never clears a mismatch
 * already known.** That is the load-bearing rule here and it is the liveness
 * dot's own: positive evidence, never the absence of a signal. An older server
 * - one that predates this field entirely - sends frames with nothing in them,
 * and must not thereby make a perfectly current page announce itself stale.
 * Silence is not disagreement.
 *
 * Deliberately *not* sticky beyond that. A server that goes back to the build
 * this tab holds - a branch switched back, an upgrade rolled back - genuinely
 * agrees with it again, and there is nothing left to reload for. Only a stamp
 * the server actually stated may change the answer, in either direction.
 *
 * No clock in here: the rule has no time in it. Being out of date is not a thing
 * that ages.
 *
 * @param {unknown} loaded the stamp baked into this page when it was served
 */
export function createBuildWatch(loaded) {
  const own = knownStamp(loaded);
  /** @type {string | null} the last build the server actually stated */
  let served = null;

  return {
    /**
     * Whatever the state frame said, which may well be nothing.
     *
     * @param {unknown} stamp
     */
    noteServed(stamp) {
      const said = knownStamp(stamp);
      if (said !== null) served = said;
    },

    /** @returns {string | null} */
    loaded: () => own,

    /** @returns {string | null} */
    served: () => served,

    /**
     * @returns {boolean} whether reloading would actually get you newer code.
     *   False whenever either side is unknown - an unanswerable question is not
     *   a yes.
     */
    isStale: () => own !== null && served !== null && served !== own,
  };
}

/**
 * A stamp we can actually compare, or null for anything we cannot.
 *
 * The empty string is what `servePage` substitutes when it could not read the
 * page to hash it, so it means "no answer" exactly as an absent field does and
 * must not be allowed to differ from a real stamp.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function knownStamp(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * How the header should read for a status.
 *
 * "stale" has to say more than the others, because it is the one state where
 * the page still looks perfectly normal and is not - so it reports how long it
 * has been lying to you.
 *
 * @param {ConnectionStatus} status
 * @param {number} quietForMs
 * @returns {{text: string, tone: 'ok' | 'wait' | 'bad'}}
 */
export function connectionLabel(status, quietForMs) {
  if (status === 'live') return { text: 'live', tone: 'ok' };
  if (status === 'connecting') return { text: 'connecting', tone: 'wait' };
  if (status === 'down') return { text: 'reconnecting', tone: 'bad' };
  const seconds = Math.round(quietForMs / 1000);
  const quiet = seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
  return { text: `no response for ${quiet}`, tone: 'bad' };
}
