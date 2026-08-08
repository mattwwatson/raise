/**
 * Asking the forge whether a pull request is still open.
 *
 * Every other source of pull request state is somebody's recollection. A live
 * no-mistakes run re-observes at about a two-minute cadence, so its answer is
 * bounded but never exact; once that run ends, *nothing at all* is watching, and
 * the page correctly falls back to "was open, last checked 3d ago". That last
 * case is what this is for. The forge is the authority on its own pull requests,
 * so unlike the transcript - which may only ever clear a block, never assert one
 * - a forge reading is allowed to assert, and it outranks all three sources.
 *
 * It is the only outbound network request nmmon makes, so it is off until the
 * user turns it on, and every failure is indistinguishable from it being off. No
 * credential, no `gh`, no network, a private repo, a rate limit: each of them
 * leaves the row exactly as it was before this module existed. Failures are
 * cached as well as answers, so a repository the credential cannot see is asked
 * once and then left alone rather than re-asked every minute for the rest of the
 * day.
 *
 * **Never on the poll path.** Same rule as `lavish.js`, which this follows
 * closely: `observe` both answers and schedules, the request is fired and never
 * awaited, and the page uses the last answer. A pull request seen for the first
 * time is therefore answered a tick later, which is the right trade against
 * stalling a loop that has one second to do everything.
 *
 * **GitHub goes through `gh` and only `gh`.** It authenticates itself, so nmmon
 * never holds a GitHub credential - and `gh` already reads `GH_TOKEN` and
 * `GITHUB_TOKEN` out of the environment it is handed, so a token path of our own
 * would be a second way to compute an answer `gh` was going to give anyway. It
 * is also the interface most likely to outlive a change in GitHub's own rules.
 * Bitbucket has no equivalent CLI, so it is `fetch` against the REST API with an
 * API token, which is the whole reason `forge-config.js` exists.
 */

/** How long before an open pull request is asked about again. */
export const OPEN_REFRESH_MS = 60 * 1000;

/**
 * How long a repository we could not read is left alone.
 *
 * The failures this covers are the durable kind - no credential, no `gh`, a
 * repository the token cannot see - so retrying them on the open interval would
 * be a request a minute, forever, for an answer that is not coming. Long enough
 * to be silent; short enough that fixing the credential takes effect without a
 * restart.
 */
export const FAILURE_BACKOFF_MS = 15 * 60 * 1000;

/** How long a single lookup may take before it is abandoned. */
export const LOOKUP_TIMEOUT_MS = 8000;

/**
 * A reading taken from the forge itself.
 *
 * `observedAt` is when *we* asked, and it is a genuine observation rather than a
 * proxy for one - which is the distinction RAI-10 turned on, so it is worth
 * keeping sharp. Whether it is recent enough to present is not decided here:
 * that is `PR_STATE_FRESH_MS` in `dashboard.js`, the same gate every other
 * source goes through, because a forge answer ages exactly like anybody else's.
 *
 * @typedef {object} ForgeReading
 * @property {'open'|'merged'|'closed'} state in nmmon's vocabulary, not the forge's
 * @property {number} observedAt epoch ms
 */

/**
 * A pull request URL taken apart far enough to ask about it.
 *
 * @typedef {object} ForgeTarget
 * @property {'github'|'bitbucket'} forge
 * @property {string} url the URL as given, which is what `gh` is handed
 * @property {string} workspace owner or workspace
 * @property {string} repo
 * @property {number} number
 */

/**
 * The key a reading is filed under.
 *
 * One URL reaches us from a CLI's output in a transcript and another from
 * no-mistakes' database, and they agree on everything that identifies the review
 * while still differing in a trailing slash or the case of the host. Same
 * normalisation `dashboard.js` compares two pull request URLs with, and shared
 * with it so the map can never be keyed by one rule and read by another.
 *
 * @param {string} url
 * @returns {string}
 */
export function pullRequestKey(url) {
  return String(url).replace(/\/+$/, '').toLowerCase();
}

/**
 * Which forge hosts a pull request, and its coordinates there.
 *
 * Only the two hosts we can actually answer for. A GitHub Enterprise install, a
 * self-hosted anything, or a URL we cannot parse gets null and is never asked
 * about - the fail-closed shape every other match in this codebase uses, and the
 * one that keeps an unrecognised host from becoming an outbound request to a
 * machine the user did not expect us to contact.
 *
 * @param {string|null|undefined} url
 * @returns {ForgeTarget|null}
 */
export function parseForgeUrl(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, '');

  if (host === 'github.com' || host === 'www.github.com') {
    const match = path.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
    if (!match) return null;
    return {
      forge: 'github',
      url: String(url),
      workspace: match[1],
      repo: match[2],
      number: Number(match[3]),
    };
  }
  if (host === 'bitbucket.org' || host === 'www.bitbucket.org') {
    const match = path.match(/^\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)$/);
    if (!match) return null;
    return {
      forge: 'bitbucket',
      url: String(url),
      workspace: match[1],
      repo: match[2],
      number: Number(match[3]),
    };
  }
  return null;
}

/**
 * A forge's word for a state, in ours.
 *
 * Neither forge speaks nmmon's vocabulary: GitHub says OPEN, CLOSED or MERGED,
 * and Bitbucket says OPEN, MERGED, DECLINED or SUPERSEDED. Both fold onto the
 * three words the page already renders. A word neither of them is documented to
 * produce returns null and the reading is discarded, rather than being passed
 * through to a page that would render it as a state chip nobody can interpret.
 *
 * @param {string|null|undefined} raw
 * @returns {'open'|'merged'|'closed'|null}
 */
export function normaliseForgeState(raw) {
  switch (String(raw || '').toUpperCase()) {
    case 'OPEN':
      return 'open';
    case 'MERGED':
      return 'merged';
    // A declined Bitbucket pull request and a superseded one are both closed
    // without merging, which is what `closed` means here and on GitHub.
    case 'CLOSED':
    case 'DECLINED':
    case 'SUPERSEDED':
      return 'closed';
    default:
      return null;
  }
}

/**
 * The state of the pull requests currently on the page, from the forges that
 * host them.
 *
 * Holds one reading per pull request and decides when each may be asked about
 * again. Nothing here blocks: `observe` schedules and returns.
 */
export class ForgeState {
  #execAsync;
  #fetch;
  #config;
  /** @type {Map<string, ForgeReading>} */
  #readings = new Map();
  /** When each key may next be asked about. Covers answers and failures alike. */
  #nextAskAt = new Map();
  /** @type {Set<string>} */
  #inFlight = new Set();
  /** Live requests, so the one-shot CLI has something to wait on. */
  /** @type {Promise<void>[]} */
  #pending = [];

  /**
   * @param {{execAsync?: Function, fetch?: Function,
   *          config?: import('./forge-config.js').ForgeConfig}} [deps] both
   *   runners are injected and defaulted at the edge, so the suite asserts on
   *   the command and the request that *would* have gone out without either
   *   happening. A config that is not `enabled` makes every method a no-op.
   */
  constructor({ execAsync, fetch, config } = {}) {
    this.#execAsync = execAsync;
    this.#fetch = fetch;
    this.#config = config || { enabled: false, bitbucket: null, problem: null };
  }

  /** @returns {boolean} whether anything here will ever make a request */
  get enabled() {
    return this.#config.enabled === true;
  }

  /** @returns {Map<string, ForgeReading>} what to hand `buildRows` */
  get readings() {
    return this.#readings;
  }

  /**
   * Note which pull requests are on the page, and refresh the ones that are due.
   *
   * Never awaited, and never throws. Asking is what schedules, exactly as it is
   * in `lavish.js`: the caller has a pull request in front of it, which is the
   * only evidence that it is worth a request at all.
   *
   * The window is stamped when the request goes out rather than when it comes
   * back. Stamping on return would let a slow or hanging lookup be re-fired on
   * every poll, which is the one way this could become a request per second.
   *
   * @param {Iterable<string>} urls every pull request URL currently rendered
   * @param {number} [now]
   */
  observe(urls, now = Date.now()) {
    if (!this.enabled) return;
    const wanted = new Set();
    for (const url of urls) {
      const target = parseForgeUrl(url);
      if (!target) continue;
      const key = pullRequestKey(target.url);
      wanted.add(key);
      if (this.#inFlight.has(key)) continue;
      const due = this.#nextAskAt.get(key);
      if (due !== undefined && now < due) continue;
      this.#start(target, key, now);
    }
    // A pull request that has left the page is forgotten, so the maps are the
    // size of what is rendered rather than of everything ever seen. It costs one
    // request to learn it again if it comes back, which it does not, because a
    // row keeps its link for as long as the branch is checked out.
    for (const key of this.#readings.keys()) if (!wanted.has(key)) this.#readings.delete(key);
    for (const key of this.#nextAskAt.keys()) if (!wanted.has(key)) this.#nextAskAt.delete(key);
  }

  /**
   * Ask about everything due, and wait for the answers.
   *
   * For `nmmon status` and nothing else - it is one shot, so there is no next
   * tick for an answer to arrive on, and no poll loop to protect. The server
   * must never call this.
   *
   * @param {Iterable<string>} urls
   * @param {number} [now]
   * @returns {Promise<void>}
   */
  async load(urls, now = Date.now()) {
    if (!this.enabled) return;
    this.observe(urls, now);
    await this.settle();
  }

  /** @returns {Promise<void>} resolves once nothing is in flight */
  async settle() {
    while (this.#pending.length > 0) {
      const running = this.#pending.splice(0, this.#pending.length);
      await Promise.allSettled(running);
    }
  }

  /**
   * @param {ForgeTarget} target
   * @param {string} key
   * @param {number} now
   */
  #start(target, key, now) {
    this.#inFlight.add(key);
    this.#nextAskAt.set(key, now + OPEN_REFRESH_MS);
    const request = Promise.resolve()
      .then(() => this.#lookup(target))
      .then((state) => {
        if (!state) {
          // Reached the forge and could not make sense of the answer, which is
          // the same to us as not reaching it: say nothing.
          this.#fail(key, now);
          return;
        }
        // Stamped when the request went out, from the caller's clock, exactly as
        // `lavish.js` stamps its window - and for the same reason. Reading
        // `Date.now()` here would mix the injected clock with the wall clock,
        // which reads as working and quietly is not. It also understates the
        // reading's freshness by however long the request took, which is the
        // safe direction for a field that decides whether we may assert.
        this.#readings.set(key, { state, observedAt: now });
        // A merged pull request does not un-merge, so there is nothing left to
        // ask. A closed one can be reopened, so it keeps the ordinary interval -
        // showing `closed` over a reopened review would be exactly the quiet
        // staleness this feature exists to remove, and one request a minute for
        // a rare case is not worth being clever about.
        if (state === 'merged') this.#nextAskAt.set(key, Number.POSITIVE_INFINITY);
      })
      .catch(() => {
        this.#fail(key, now);
      })
      .finally(() => {
        this.#inFlight.delete(key);
      });
    this.#pending.push(request);
  }

  /**
   * A lookup that did not answer.
   *
   * The previous reading goes, rather than being kept and left to age out. It
   * would age out - the freshness gate in `dashboard.js` catches it within five
   * minutes either way - but a reading we can no longer confirm is exactly the
   * thing this page is built not to assert, and dropping it means the row falls
   * back to the sources that never went away.
   *
   * @param {string} key
   * @param {number} now the clock the request was dispatched on, never the wall
   *   clock - see the note beside the reading's own timestamp
   */
  #fail(key, now) {
    this.#readings.delete(key);
    this.#nextAskAt.set(key, now + FAILURE_BACKOFF_MS);
  }

  /**
   * @param {ForgeTarget} target
   * @returns {Promise<'open'|'merged'|'closed'|null>}
   */
  async #lookup(target) {
    if (target.forge === 'github') return this.#lookupGitHub(target);
    return this.#lookupBitbucket(target);
  }

  /**
   * `gh` is handed the URL, so it needs no checkout and no working directory of
   * its own - which matters, because the session whose row this is may be in a
   * worktree, a subdirectory, or gone.
   *
   * `gh` requires authentication even for a public pull request: with no login
   * and no token it exits 4 saying so. That is a rejected promise here and
   * therefore a silent no-answer, which is the correct reading of "this user has
   * not set `gh` up" - it is not our business to tell them so.
   *
   * @param {ForgeTarget} target
   */
  async #lookupGitHub(target) {
    if (!this.#execAsync) return null;
    const out = await this.#execAsync(
      'gh',
      ['pr', 'view', target.url, '--json', 'state'],
      { timeoutMs: LOOKUP_TIMEOUT_MS },
    );
    return normaliseForgeState(JSON.parse(out)?.state);
  }

  /**
   * Bitbucket has no `gh`, so this is the REST API with an API token.
   *
   * Basic auth over the Atlassian account email and the token: app passwords,
   * which needed only the one value, were removed on 28/07/2026. `fields=state`
   * asks for the one field we read - a pull request record is otherwise several
   * kilobytes of description, participants and diff links, none of which has any
   * business crossing the network for this.
   *
   * The scope this needs is `read:pullrequest:bitbucket` and nothing else, which
   * Atlassian documents as *not* implying `read:repository:bitbucket` - so a
   * token minted for nmmon cannot read the user's source code.
   *
   * @param {ForgeTarget} target
   */
  async #lookupBitbucket(target) {
    const credential = this.#config.bitbucket;
    if (!this.#fetch || !credential) return null;
    const endpoint =
      `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(target.workspace)}` +
      `/${encodeURIComponent(target.repo)}/pullrequests/${target.number}?fields=state`;
    const auth = Buffer.from(`${credential.email}:${credential.token}`).toString('base64');
    const response = await this.#fetch(endpoint, {
      headers: { authorization: `Basic ${auth}`, accept: 'application/json' },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    // 401, 403, 404 and 429 all mean the same thing on this page: we do not know.
    // None of them is worth a distinct behaviour, and none of them is worth
    // telling the user about on a row - the backoff is what stops it repeating.
    if (!response.ok) return null;
    const body = await response.json();
    return normaliseForgeState(body?.state);
  }
}
