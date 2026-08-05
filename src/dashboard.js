/**
 * Joining the two halves into what you actually look at.
 *
 * Pipeline state and session state answer different questions:
 *   - a parked run means no-mistakes stopped and wants a decision, which the
 *     agent usually answers itself within seconds
 *   - a blocked session means Claude is sitting there waiting for a human
 *
 * The second is the one worth interrupting yourself for, so it outranks
 * everything else in the ordering below.
 *
 * All pure functions: the dashboard is a projection of state, never a source
 * of it.
 */

import { basename } from 'node:path';
import { planFocus } from './focus/index.js';
import { pullRequestNumber } from './nm-state.js';

/** @typedef {import('./registry.js').Session} Session */
/** @typedef {import('./nm-state.js').Run} Run */
/** @typedef {import('./nm-state.js').PullRequest} PullRequest */

/**
 * How much a row wants a human, most urgent first.
 *
 * `review` sits directly under `blocked` because it is the same thing wearing a
 * disguise: the agent has stopped and is waiting on a person. It only looks
 * like work because the waiting happens inside a subprocess, so the hooks see a
 * busy session rather than a blocked one.
 *
 * @typedef {'blocked'|'review'|'parked'|'failed'|'idle'|'working'|'done'} Attention
 */

/**
 * One line on the dashboard: a session, a run, or a session with its run
 * attached. This is the whole contract between `buildRows` and everything that
 * renders - the page, the CLI's `status`, and the SSE frames between them.
 *
 * @typedef {object} Row
 * @property {string} id stable across polls, so the page can diff on it
 * @property {'session'|'run'} kind
 * @property {string|null} sessionId null for a run with no session attached
 * @property {string|null} cwd
 * @property {string} title the repo name, grown into a path only on collision
 * @property {string|null} titlePath the path `title` was derived from, which is
 *   what disambiguation grows
 * @property {string|null} branch
 * @property {Attention} attention
 * @property {string} attentionLabel `attention`, in words
 * @property {string|null} message why Claude wants you; only set while blocked
 * @property {import('./registry.js').SessionState|null} sessionState
 * @property {number|null} sessionStateSince
 * @property {number|null} waitingForMs how long blocked, for the "2m" column
 * @property {boolean} focusable whether clicking this row can do anything
 * @property {'tmux'|'tab'|'app'|'unknown'|null} hostKind where the session lives
 * @property {import('./registry.js').AgentKind|null} agentKind which agent is
 *   running it; null for a run with no session behind it. Named apart from
 *   `agent` below, which is the pipeline's own session folded into this row
 * @property {Run|null} run
 * @property {number|null} updatedAt
 * @property {string|null} summary what the session is working on, in Claude's
 *   own words, or the pipeline step when no-mistakes is driving
 * @property {string|null} activity the tool it is running right now
 * @property {string|null} mode 'plan' and the like; null for an ordinary turn
 * @property {string|null} reviewUrl the Lavish page this row is waiting on
 * @property {PullRequest|null} pr the pull request open on this branch
 * @property {number|null} lastActivityAt epoch ms this session last wrote to
 *   its transcript, which is when it last actually did something
 * @property {Agent|null} agent the pipeline's own Claude session, folded in
 */

/**
 * What no-mistakes' own agent is doing, shown on the row of the repo it is
 * working on rather than as a row of its own.
 *
 * `what` is never null, and that is the point. `activity` is the tool with no
 * result yet, so it goes null every time one call finishes and before the next
 * begins - which on a busy agent is most seconds. Rendering on `activity`
 * blinked the marker in and out several times a minute, which on a page you
 * leave pinned reads as the pipeline starting and stopping. Presence is decided
 * by the agent existing; only the words change.
 *
 * @typedef {object} Agent
 * @property {string} what the best description available, always something
 * @property {string|null} activity the tool it is running right now, if any
 * @property {string|null} summary what it is working on, in its own words
 * @property {import('./registry.js').SessionState|null} state
 * @property {string|null} message why it wants you, if it is blocked
 * @property {number|null} lastActivityAt
 */

/**
 * Attention levels, most urgent first. The dashboard sorts on this, and the
 * page colours on it.
 *
 * @type {Attention[]}
 */
export const ATTENTION_ORDER = [
  'blocked',
  'review',
  'parked',
  'failed',
  'idle',
  'working',
  'done',
];

const ATTENTION_LABELS = {
  blocked: 'Waiting for you',
  review: 'Waiting on your review',
  parked: 'Pipeline parked at a gate',
  failed: 'Failed',
  idle: 'Idle',
  working: 'Working',
  done: 'Done',
};

/** @param {Attention} attention */
export function attentionLabel(attention) {
  return ATTENTION_LABELS[attention] || attention;
}

/**
 * Whether a directory is the given path or sits inside it.
 *
 * A plain `startsWith` on the path alone would make `/work/repo-other` a match
 * for `/work/repo`, so the separator is part of the test.
 *
 * @param {string|null} dir
 * @param {string|null} path
 * @returns {boolean}
 */
function isInside(dir, path) {
  if (!dir || !path) return false;
  return dir === path || dir.startsWith(`${path}/`);
}

/**
 * Find the run belonging to a working directory.
 *
 * Sessions frequently run in worktrees nested under, or alongside, the path
 * no-mistakes registered. Longest matching prefix wins so a worktree inside a
 * repo is attributed to the worktree's own registration when it has one.
 *
 * @param {string|null} cwd
 * @param {Run[]} runs
 * @returns {Run|null}
 */
export function matchRunForCwd(cwd, runs) {
  if (!cwd) return null;
  let best = null;
  let bestLength = -1;
  for (const run of runs) {
    if (!isInside(cwd, run.repoPath)) continue;
    // Prefer the most specific repo, then an active run over a finished one,
    // then the most recent.
    const length = run.repoPath.length;
    if (
      length > bestLength ||
      (length === bestLength && rankRun(run) > rankRun(best))
    ) {
      best = run;
      bestLength = length;
    }
  }
  return best;
}

/**
 * The run a session's checkout belongs to, following a worktree's link.
 *
 * A run started from a git worktree is registered by no-mistakes against the
 * *main* checkout, because that is where a worktree's repository resolves to.
 * The session reporting itself to us is in the worktree, so the cwd prefix
 * `matchRunForCwd` needs can never match, and the run instead fell through to
 * whichever other session happened to be open on the main checkout - a Focus
 * button to a window that could not answer the pipeline's gate, while the
 * session actually driving it showed no pipeline at all. Treehouse puts every
 * session in a worktree, so this is the common case, not a corner of one.
 *
 * The link is a fallback and never an override: no-mistakes will register a
 * worktree as a repository in its own right, and that run is the more specific
 * answer - the same rule `matchRunForCwd` already applies to nesting.
 *
 * **Through the link the branch is required, and on the session's own path it
 * is not.** Every worktree of a checkout resolves to the same main checkout and
 * no-mistakes registers all of their runs against it, so the link is a
 * one-to-many edge: resolving it by `matchRunForCwd`'s ranking alone hands one
 * run to every sibling worktree, and hands each of them the parked one rather
 * than its own. A worktree exists in order to be on its own branch, and every
 * run carries the branch it is on, so that is what says which worktree's run it
 * is. On the session's own path there is nothing to disambiguate and the branch
 * must *not* narrow it - a session sitting in a checkout keeps showing that
 * repo's recent pipeline whatever branch it has since moved to.
 *
 * A worktree whose branch cannot be read - a detached HEAD, which Treehouse
 * produces routinely - therefore gets no run through the link at all. That is
 * the same failing-closed rule that stops a run reached this way lending its
 * branch: with nothing to match on, a guess would be a confident wrong answer
 * with a Focus button attached.
 *
 * `mainCheckout` and `branch` are resolved by `GitBranch.checkoutFor`, since
 * only `.git` knows the two directories are one repository, and reading it is
 * I/O this file may not do.
 *
 * @param {string|null} cwd
 * @param {string|null} mainCheckout the checkout a worktree cwd is linked to
 * @param {string|null} branch the branch the session's own checkout is on
 * @param {Run[]} runs
 * @returns {Run|null}
 */
export function matchRunForCheckout(cwd, mainCheckout, branch, runs) {
  const own = matchRunForCwd(cwd, runs);
  if (own || !branch) return own;
  return matchRunForCwd(
    mainCheckout,
    runs.filter((r) => r.branch === branch),
  );
}

/**
 * The run whose worktree a directory sits in, or null.
 *
 * no-mistakes runs its own pipeline steps as Claude sessions, in a worktree at
 * `~/.no-mistakes/worktrees/<repo-hash>/<run-id>`. Those sessions have the
 * hooks installed like any other, so they register themselves - and because the
 * worktree is nowhere near the repo, `matchRunForCwd` cannot place them. They
 * arrived on the dashboard as their own row, titled with the bare run id,
 * looking like an unrelated repo nobody had heard of.
 *
 * The run id is the last segment of that path, so the tie needs no new source:
 * a directory sitting inside a known run's worktree belongs to that run. Exact
 * segment matching against the ids we already have, never a pattern - guessing
 * at what a ULID looks like would eventually claim somebody's real directory.
 *
 * @param {string|null} cwd
 * @param {Run[]} runs
 * @returns {Run|null}
 */
export function matchRunForAgentCwd(cwd, runs) {
  if (!cwd) return null;
  const segments = new Set(String(cwd).split('/').filter(Boolean));
  for (const run of runs) {
    if (run.runId && segments.has(run.runId)) return run;
  }
  return null;
}

/**
 * Find the pull request open on a directory's branch.
 *
 * Both halves of the match are required. The path alone is not enough: a repo
 * accumulates a pull request per branch, and a worktree sitting under a repo
 * would otherwise inherit whichever one happened to be newest. Sending someone
 * to another branch's review is worse than showing no link at all - it is the
 * same rule the tmux title match and the Lavish basename fallback both follow.
 *
 * A row with no branch therefore gets no pull request, rather than a guess.
 *
 * @param {string|null} cwd
 * @param {string|null} branch
 * @param {PullRequest[]} pullRequests
 * @returns {PullRequest|null}
 */
export function matchPullRequest(cwd, branch, pullRequests) {
  if (!cwd || !branch) return null;
  let best = null;
  let bestLength = -1;
  for (const pr of pullRequests) {
    if (pr.branch !== branch) continue;
    if (!isInside(cwd, pr.repoPath)) continue;
    // Longest matching prefix, so a worktree registered in its own right beats
    // the repo it happens to live inside.
    if (pr.repoPath.length > bestLength) {
      best = pr;
      bestLength = pr.repoPath.length;
    }
  }
  return best;
}

/**
 * The pull request a run carries on its own record.
 *
 * The database query finds this one too, and with better provenance, so this
 * only ever matters on the degraded `axi status` path - where there is no
 * history to query and the run in front of us is all there is.
 *
 * @param {Run} run
 * @returns {PullRequest|null}
 */
function pullRequestForRun(run) {
  if (!run.prUrl) return null;
  return {
    url: run.prUrl,
    number: pullRequestNumber(run.prUrl),
    state: run.prState || null,
    observedAt: run.updatedAt ?? null,
    branch: run.branch,
    repoPath: run.repoPath,
    live: run.active,
  };
}

/**
 * The pull request a session's own transcript reported, if it is ours.
 *
 * The last resort, and the one that covers what the database cannot: a pull
 * request opened by hand, or on a branch no-mistakes has not run. The session
 * printed the URL itself, so the sighting is free.
 *
 * The repository in the URL has to match the checkout. A session reviewing
 * somebody else's pull request, or reading about one, mentions URLs that are
 * nothing to do with the branch in front of it - and a confident link to the
 * wrong review is the failure this whole feature has to avoid. A directory
 * whose name differs from its remote's is the price: it gets no link rather
 * than a doubtful one.
 *
 * The state is never presented as current. Unlike a live run, nothing is
 * watching this pull request - the reading is from whenever the session
 * happened to print it - so it survives only as the tooltip's "was open".
 *
 * The database is the negative authority on ownership. no-mistakes recorded
 * which branch it opened a pull request from; the transcript only inferred one
 * from the text around a URL, and a listing that mentions exactly one - a run
 * table whose other rows have no pull request yet - reads as a sighting. So a
 * URL the database knows on another branch is rejected outright, while a URL it
 * has never heard of stands, which is the entire case this source exists for.
 *
 * @param {import('./transcript.js').TranscriptSummary|null} summary
 * @param {string|null} repoPath
 * @param {string|null} branch
 * @param {PullRequest[]} [pullRequests] what no-mistakes has on record
 * @returns {PullRequest|null}
 */
export function transcriptPullRequest(summary, repoPath, branch, pullRequests = []) {
  const seen = summary?.pullRequest;
  if (!seen?.url || !repoPath) return null;
  const repo = basename(repoPath);
  if (!seen.slug || !repo || seen.slug.toLowerCase() !== repo.toLowerCase()) return null;
  for (const known of pullRequests) {
    if (!known.branch || known.branch === branch) continue;
    if (sameUrl(known.url, seen.url)) return null;
  }
  return {
    url: seen.url,
    number: seen.number,
    state: seen.state,
    observedAt: seen.observedAt,
    branch,
    repoPath,
    live: false,
  };
}

/**
 * Whether two pull request URLs are the same review.
 *
 * One side was printed by a CLI into a transcript and the other stored by
 * no-mistakes, so they agree on everything that identifies the review and can
 * still differ in a trailing slash or the case of the host.
 *
 * @param {string} a
 * @param {string} b
 */
function sameUrl(a, b) {
  const normalise = (url) => String(url).replace(/\/+$/, '').toLowerCase();
  return normalise(a) === normalise(b);
}

/** @param {Run|null} run */
function rankRun(run) {
  if (!run) return -1;
  if (run.parked) return 3;
  if (run.active) return 2;
  return (run.updatedAt || 0) / 1e13;
}

/**
 * How far past a recorded block the transcript must run before the block is
 * disbelieved.
 *
 * The `Notification` hook and the tool call that triggered it are written at
 * almost the same moment, in no guaranteed order, so a couple of seconds of
 * slack keeps a real permission prompt from being cleared by its own arrival.
 */
const BLOCK_DISPROVED_AFTER_MS = 3000;

/** What Claude Code calls the nudge it sends after sixty idle seconds. */
const IDLE_NUDGE_TYPE = 'idle_prompt';

/**
 * Claude Code's sixty-second nudge, as opposed to a permission prompt.
 *
 * The `Notification` hook fires for two different things, and the registry
 * cannot tell them apart because they arrive as the same event: Claude wanting
 * permission for a tool, and Claude having finished its turn and waiting for
 * you to say something next.
 *
 * The distinction is load-bearing. A running pipeline is grounds for
 * disbelieving the second - the session is not free, it is mid-run - and is no
 * grounds at all for disbelieving the first, because a permission prompt stops
 * everything until a human answers whether or not something else is churning
 * in the background.
 *
 * **Claude Code says which one it is, so ask rather than infer.** The payload
 * carries a `notification_type` - `idle_prompt` for the nudge,
 * `permission_prompt` for a real prompt - and when it is there it settles the
 * question outright. A type we do not recognise is new rather than missing, so
 * it stays a hard block and the message underneath is never consulted: falling
 * back there would be guessing with the answer already in hand.
 *
 * The message is the fallback for a session whose Claude Code predates the
 * field, or whose record was written before nmmon read it. Both paths fail
 * closed - anything unrecognised, including no message at all, is a block -
 * because the cost of a stale "waiting for you" is a row you distrust, and the
 * cost of the other mistake is a swallowed permission prompt.
 *
 * @param {string|null|undefined} message
 * @param {string|null|undefined} [notificationType]
 * @returns {boolean}
 */
export function isIdleNudge(message, notificationType) {
  if (notificationType) return notificationType === IDLE_NUDGE_TYPE;
  return /waiting for your input/i.test(String(message || ''));
}

/**
 * Whether a session recorded as blocked has demonstrably carried on since.
 *
 * The hooks announce that Claude wants permission and then go quiet until the
 * turn ends - `Notification` fires, and the next event is `Stop`, which may be
 * many minutes later. So granting permission leaves the session reading
 * "Waiting for you" for the whole rest of the turn, and the one signal this
 * tool exists to give is wrong for most of the time it is displayed. A false
 * "waiting for you" is worse than a missing one: it is what teaches you to
 * stop believing the page.
 *
 * A session writing records is self-evidently not sitting waiting for a human,
 * so the transcript settles it. Only ever used to *clear* a block, never to
 * assert one - a transcript that cannot be read leaves the hooks' answer
 * standing.
 *
 * Measured from when the block was last *announced*, not from when the session
 * entered the state. A permission prompt is reported twice, six to twelve
 * seconds apart, and `stateSince` deliberately keeps the earlier of the two so
 * the waiting timer says how long you have kept it waiting. Anchoring the
 * disproof there as well would hand every permission block that much extra
 * tolerance - a transcript write four seconds after Claude asked, while the
 * prompt is still open, would clear a block that is still entirely real. A
 * record written before this anchor existed falls back to `stateSince` and
 * behaves as it always did.
 */
function blockDisproved(session, summary) {
  const since = session?.blockAnnouncedAt ?? session?.stateSince;
  const last = summary?.lastActivityAt;
  if (!since || !last) return false;
  return last - since > BLOCK_DISPROVED_AFTER_MS;
}

/**
 * The session's state once the transcript has had its say.
 *
 * A disproved block becomes `working` rather than falling through to `idle`:
 * a session that is writing records is running, and calling that idle would
 * trade one wrong answer for another.
 *
 * A running pipeline disproves a block the same way, and for a stricter reason:
 * the transcript is silent evidence, whereas a live process is the work itself.
 * It only ever answers the idle nudge - see `isIdleNudge`.
 *
 * @param {Session|{state: string, stateSince?: number,
 *          blockAnnouncedAt?: number|null, message?: string|null,
 *          notificationType?: string|null}|null} session
 * @param {import('./transcript.js').TranscriptSummary|null} summary
 * @param {boolean} [pipelineRunning]
 * @returns {import('./registry.js').SessionState|null}
 */
function effectiveSessionState(session, summary, pipelineRunning = false) {
  if (!session) return null;
  if (session.state === 'blocked') {
    if (blockDisproved(session, summary)) return 'working';
    if (pipelineRunning && isIdleNudge(session.message, session.notificationType)) return 'working';
  }
  return /** @type {import('./registry.js').SessionState|null} */ (session.state ?? null);
}

/**
 * Decide the single attention level for a row.
 *
 * A session polling a Lavish artifact outranks everything except an outright
 * permission prompt: it has stopped, and only a human can restart it. It is
 * checked before `run.parked` for the same reason `blocked` is - a parked
 * pipeline usually answers itself, and a person waiting on a review does not.
 *
 * A blocked pipeline agent counts as blocked too. Folding those sessions into
 * this row is what stops the dashboard growing a second card per repo, but it
 * must not swallow the one signal the tool exists to give: an agent sitting on
 * a permission prompt has stalled the pipeline and only a human can free it.
 *
 * @param {{session: Session|{state: string}|null, run: Run|null,
 *          summary?: import('./transcript.js').TranscriptSummary|null,
 *          agent?: Agent|null, pipelineRunning?: boolean}} input
 * @returns {Attention}
 */
export function attentionFor({
  session,
  run,
  summary = null,
  agent = null,
  pipelineRunning = false,
}) {
  const state = effectiveSessionState(session, summary, pipelineRunning);
  if (state === 'blocked') return 'blocked';
  if (agent?.state === 'blocked') return 'blocked';
  if (session && summary?.lavishFile) return 'review';
  if (run?.parked) return 'parked';
  if (run && !run.active && (run.status === 'failed' || run.error)) return 'failed';
  if (run?.active) return 'working';
  if (state === 'working') return 'working';
  if (state === 'idle') return 'idle';
  if (run && !run.active) return 'done';
  return 'idle';
}

/**
 * Build the rows the page renders.
 *
 * `summaries`, `reviewUrls` and `branches` are looked up rather than passed in
 * per session so that reading transcripts, reading `.git` and asking Lavish for
 * links stay outside this file - it is pure, and all three touch the filesystem
 * or a subprocess.
 *
 * `runOwners` comes from the process table, for the same reason: knowing which
 * session launched a pipeline means walking live processes, which this file may
 * not do.
 *
 * `mainCheckouts` is the same arrangement again: reading a worktree's `.git` to
 * find the checkout it is linked to is filesystem work, and the answer is what
 * places a run started from a worktree. Empty for every session that is not in
 * one, which is the ordinary case outside Treehouse. It comes off the same
 * `.git` read as `branches`, which is not only a saving: through the link the
 * branch is what picks which of that checkout's runs belongs to this worktree.
 *
 * @param {{sessions: Session[], runs: Run[], now?: number,
 *          summaries?: Map<string, import('./transcript.js').TranscriptSummary>,
 *          reviewUrls?: Map<string, string|null>,
 *          branches?: Map<string, string|null>,
 *          mainCheckouts?: Map<string, string|null>,
 *          pullRequests?: PullRequest[],
 *          pipelines?: Set<string>,
 *          runOwners?: Map<string, string>}} input
 * @returns {Row[]}
 */
export function buildRows({
  sessions,
  runs,
  now = Date.now(),
  summaries = new Map(),
  reviewUrls = new Map(),
  branches = new Map(),
  mainCheckouts = new Map(),
  pullRequests = [],
  pipelines = new Set(),
  runOwners = new Map(),
}) {
  /** @type {Row[]} */
  const rows = [];
  const claimedRuns = new Set();

  // Which run each session owns, inverted out of the ownership map and resolved
  // against this reading, because a card shows the run its session is answering
  // for whenever we know which that is. Ownership used only as a veto could
  // take a wrong run off a card and never put the right one on it, which is the
  // shape of every failure this attribution has produced.
  //
  // A session can hold more than one - it drove a run that has since finished
  // and is still in the window, then drove another - so rank picks between
  // them, exactly as it does for a session that owns nothing.
  /** @type {Map<string, Run>} */
  const ownedRuns = new Map();
  for (const run of runs) {
    const owner = runOwners.get(run.runId);
    if (!owner) continue;
    const best = ownedRuns.get(owner);
    if (!best || rankRun(run) > rankRun(best)) ownedRuns.set(owner, run);
  }

  // The pipeline's own sessions are folded into the row of the repo they are
  // working on, never given one of their own: two `hexbattle` rows, one of
  // which you cannot act on, is worse than one row that says what the pipeline
  // is up to. They are pulled out first so the loop below never sees them.
  /** @type {Map<string, Agent>} */
  const agents = new Map();
  /** @type {Session[]} */
  const human = [];
  for (const session of sessions) {
    const owning = matchRunForAgentCwd(session.cwd, runs);
    if (!owning) {
      human.push(session);
      continue;
    }
    // Sessions arrive newest first, and one pipeline step's agent is still
    // registered while the next one starts, so the first seen is the current
    // one. Letting a later write win would show the outgoing agent's activity
    // and, worse, could hide a newly blocked agent behind an older calm one.
    if (agents.has(owning.runId)) continue;
    const summary = summaries.get(session.sessionId) || null;
    const activity = summary?.activity || null;
    const title = summary?.title || null;
    // An agent's block is disproved exactly as a human session's is. It is the
    // same hook silence - nothing fires between the permission prompt and the
    // end of the turn - and here it pins the whole repo's row red rather than
    // just its own.
    const state = effectiveSessionState(session, summary, pipelines.has(session.sessionId));
    agents.set(owning.runId, {
      // Falls through to a bare word rather than nothing, so the marker cannot
      // blink out between one tool call and the next.
      what: activity || title || 'working',
      activity,
      summary: title,
      state,
      message: state === 'blocked' ? session.message || null : null,
      lastActivityAt: summary?.lastActivityAt ?? null,
    });
  }
  for (const session of human) {
    // A matched run answers two different questions, and only one of them is
    // shared. `matchRunForCwd` places a run by repo path alone, so every
    // session open on a checkout matches the same one - which is right for
    // *identity* (the repo's name, the path a title grows from) and wrong for
    // *state*: three sessions in one repo each carried the pipeline's step and
    // its parked gate, and each offered a Focus button to a window that could
    // not answer it.
    //
    // `runOwners` is what the process table saw: the session with a live
    // `no-mistakes axi run` underneath it, and when it names a run for this
    // session that is the run the card shows. Rank is the fallback for a
    // session that owns nothing, and there it still narrows and never widens -
    // a run nobody was observed to own stays on every session in its repo,
    // exactly as before, because an unattributed pipeline is better shown three
    // times than not at all.
    //
    // A session owning a run on a branch its checkout has since left therefore
    // shows that run rather than the repo's newest. That is the point: it is the
    // run this session is answering for, and the only one whose gate it can
    // reach.
    //
    // The checkout's own branch is resolved first because it is not only shown:
    // through a worktree's link it is what says which of the checkout's runs is
    // this worktree's, all of them being registered against the one path.
    const mainCheckout = mainCheckouts.get(session.sessionId) || null;
    const checkoutBranch = branches.get(session.sessionId) || null;
    const repo = matchRunForCheckout(session.cwd, mainCheckout, checkoutBranch, runs);
    const owned = ownedRuns.get(session.sessionId) || null;
    const owner = repo ? runOwners.get(repo.runId) || null : null;
    const run = owned || (!owner || owner === session.sessionId ? repo : null);
    if (run) claimedRuns.add(run.runId);
    const summary = summaries.get(session.sessionId) || null;
    const agent = (run && agents.get(run.runId)) || null;
    const pipelineRunning = pipelines.has(session.sessionId);
    const attention = attentionFor({ session, run, summary, agent, pipelineRunning });
    const sessionState = effectiveSessionState(session, summary, pipelineRunning);
    const plan = planFocus(session);
    // The checkout's own branch is the truth about where this session is. The
    // run's is a second choice: it belongs to a pipeline that may have finished
    // on a branch that has since been left behind.
    //
    // And it is not offered at all when the run was reached through a
    // worktree's link, because there the two are known to differ - a worktree
    // exists to be on another branch. A detached checkout, whose own branch is
    // legitimately null, took its sibling worktree's branch name the moment the
    // link let it match that run, and would then have been handed that branch's
    // pull request on top. The one place a run may lend a branch is a session
    // sitting in the run's own repo.
    const branch =
      checkoutBranch || (isInside(session.cwd, repo?.repoPath) ? repo?.branch : null) || null;
    rows.push({
      id: `session:${session.sessionId}`,
      kind: 'session',
      sessionId: session.sessionId,
      cwd: session.cwd,
      // Identity follows the repo the session is in, never the run it owns. A
      // bystander session titled after its own subdirectory would stop looking
      // like the same checkout as the one running the pipeline.
      title: repo?.repoName || basename(session.cwd || '') || 'unknown',
      // The path the title was taken from, which is what disambiguation grows.
      // For a session inside a registered repo that is the repo, not the
      // session's own directory - but only when the session really is inside
      // it. A worktree session is matched to a checkout it does not live in, so
      // borrowing that path would give it and the checkout the same anchor, and
      // disambiguation would have nothing left to grow: the `1/` and `2/` that
      // name a Treehouse tree would vanish from the page.
      titlePath:
        (repo?.repoName && isInside(session.cwd, repo.repoPath)
          ? repo.repoPath
          : session.cwd) || null,
      branch,
      attention,
      attentionLabel: attentionLabel(attention),
      // Everything below follows the effective state, not the raw hook state,
      // so a block the transcript has disproved cannot leave a stale "needs
      // your permission" or a waiting timer running behind a Working row. The
      // registry keeps a message for as long as it holds the block, so reading
      // it off a row blocked by its *agent* would caption the agent's block
      // with the human's granted prompt.
      message:
        (sessionState === 'blocked' ? session.message : null) ||
        (attention === 'blocked' ? agent?.message : null) ||
        null,
      sessionState,
      sessionStateSince: session.stateSince || null,
      waitingForMs:
        attention === 'blocked' || attention === 'review'
          ? now - (session.stateSince || now)
          : null,
      focusable: plan.kind !== 'unfocusable',
      hostKind: hostKindFor(plan),
      // A record written before pi was supported carries no agent, and only
      // Claude Code sessions existed then.
      agentKind: session.agent || 'claude',
      run: run || null,
      updatedAt: session.updatedAt || null,
      // The pipeline step is the better summary when there is one: it says what
      // is being done to the repo, where the transcript title says what the
      // conversation is about.
      summary: run?.step?.name ? `step ${run.step.name}` : summary?.title || null,
      // On a review row the running tool *is* the waiting - "Running lavish-axi"
      // next to "Waiting on your review" reads as work in progress, which is
      // the one impression this state exists to correct.
      activity: attention === 'review' ? null : summary?.activity || null,
      // 'normal' is the absence of a mode, and saying so on every card would be
      // noise on the one thing this page has to keep scannable.
      mode: summary?.mode && summary.mode !== 'normal' ? summary.mode : null,
      reviewUrl: reviewUrls.get(session.sessionId) || null,
      // Three sources, most trustworthy first. A live run is being watched
      // right now, so its state is real. The database's history is branch
      // verified but frozen. The transcript is neither, and is the only one
      // that sees a pull request no-mistakes never opened - which is common
      // enough that leaving it out means no link at all on plain Claude work.
      //
      // The run's own pull request has to clear the same branch check as the
      // other two, for the reason given above `branch`: `matchRunForCwd` places
      // a run by repo path alone, so a finished run keeps matching this session
      // for half an hour after the checkout has moved on, and handed over a
      // link to the branch it ended on. The row then disagreed with itself -
      // `main` beside another branch's review - which is exactly the confident
      // wrong link the whole feature is built to avoid.
      //
      // A pull request belongs to the branch, not to whoever started the run,
      // so the two branch-verified sources stay on every session in the
      // checkout. Only the first is the run's own to lend, and only its owner
      // may take it.
      pr:
        (run?.prUrl && run.branch === branch ? pullRequestForRun(run) : null) ||
        matchPullRequest(session.cwd, branch, pullRequests) ||
        matchPullRequest(mainCheckout, branch, pullRequests) ||
        transcriptPullRequest(summary, repo?.repoPath || session.cwd, branch, pullRequests),
      lastActivityAt: summary?.lastActivityAt ?? null,
      agent,
    });
  }

  // Runs with no Claude session attached: someone ran no-mistakes by hand, or
  // the session ended while the pipeline carried on. Still worth showing, just
  // not focusable.
  for (const run of runs) {
    if (claimedRuns.has(run.runId)) continue;
    if (!run.active && !isRecent(run, now)) continue;
    const agent = agents.get(run.runId) || null;
    const attention = attentionFor({ session: null, run, agent });
    rows.push({
      id: `run:${run.runId}`,
      kind: 'run',
      sessionId: null,
      cwd: run.repoPath,
      title: run.repoName,
      titlePath: run.repoPath || null,
      branch: run.branch,
      attention,
      attentionLabel: attentionLabel(attention),
      message: attention === 'blocked' ? agent?.message || null : null,
      sessionState: null,
      sessionStateSince: null,
      waitingForMs: null,
      focusable: false,
      hostKind: null,
      agentKind: null,
      run,
      updatedAt: run.updatedAt || null,
      summary: run.step?.name ? `step ${run.step.name}` : null,
      activity: null,
      mode: null,
      reviewUrl: null,
      pr: pullRequestForRun(run) || matchPullRequest(run.repoPath, run.branch, pullRequests),
      // The pipeline's agent has a transcript even when nobody else here does,
      // so it is a better account of when this last moved than the run's own
      // clock, which only ticks when a step changes.
      lastActivityAt: agent?.lastActivityAt ?? run.updatedAt ?? null,
      agent,
    });
  }

  return sortRows(disambiguateTitles(rows));
}

/**
 * Where the session lives, in the page's words.
 *
 * An unfocusable session used to say "tab", on the reasoning that it probably
 * is one and we simply cannot find it. That was an assertion dressed as a
 * default: a Claude Desktop session whose host went unrecognised plans as
 * unfocusable too, and the page then labelled it a terminal tab with complete
 * confidence. It says "unknown" now, which is the only thing we know.
 *
 * @param {import('./focus/index.js').FocusPlan} plan
 * @returns {'tmux'|'tab'|'app'|'unknown'}
 */
function hostKindFor(plan) {
  if (plan.kind === 'tmux') return 'tmux';
  if (plan.kind === 'app') return 'app';
  if (plan.kind === 'tab') return 'tab';
  return 'unknown';
}

/** @param {Run} run */
function isRecent(run, now, windowMs = 30 * 60 * 1000) {
  return run.updatedAt != null && now - run.updatedAt < windowMs;
}

/**
 * Beyond this a title has stopped being a label and become a path. Two
 * directories that agree on their last eight segments are indistinguishable in
 * a one-line card either way.
 */
const MAX_TITLE_SEGMENTS = 8;

function pathSegments(path) {
  return String(path).split('/').filter(Boolean);
}

function suffixTitle(segments, depth) {
  return segments.slice(Math.max(0, segments.length - depth)).join('/');
}

/**
 * Give each path the shortest trailing run of segments that tells it apart from
 * the rest of the group.
 *
 * Depths are decided per path, not for the group as a whole: a path that is
 * already unique with one parent does not get lengthened because two others
 * needed two. A path with no segments left to add is taken as final - it has
 * said everything it can - and any deeper title necessarily has more segments,
 * so it can never collide with one.
 *
 * @param {string[]} paths distinct directory paths
 * @returns {Map<string, string>} path -> title
 */
export function shortestUniqueTitles(paths) {
  const segments = new Map(paths.map((path) => [path, pathSegments(path)]));
  const deepest = Math.min(
    MAX_TITLE_SEGMENTS,
    Math.max(...paths.map((path) => segments.get(path).length)),
  );
  const resolved = new Map();
  let pending = [...paths];

  for (let depth = 2; depth <= deepest && pending.length > 0; depth += 1) {
    const candidates = new Map(pending.map((path) => [path, suffixTitle(segments.get(path), depth)]));
    const counts = new Map();
    for (const title of [...candidates.values(), ...resolved.values()]) {
      counts.set(title, (counts.get(title) || 0) + 1);
    }
    const unresolved = [];
    for (const path of pending) {
      const title = candidates.get(path);
      if (counts.get(title) === 1 || segments.get(path).length <= depth) {
        resolved.set(path, title);
      } else {
        unresolved.push(path);
      }
    }
    pending = unresolved;
  }

  // Anything still ambiguous at the cap gets the longest title allowed. Rare
  // enough to be worth accepting rather than growing the card without limit.
  for (const path of pending) resolved.set(path, suffixTitle(segments.get(path), deepest));
  return resolved;
}

/**
 * Pull apart rows that would otherwise render under the same name.
 *
 * A title is a basename, so a repo, its worktrees and any second clone all show
 * as the same word - `/Users/x/work/thing` and `/Users/x/.trees/ab12/thing`
 * are both "thing", and the page becomes a guessing game about which card is
 * which.
 *
 * Growing happens on `titlePath`, the path the title was derived from, so the
 * original name always survives as the tail of the longer one. A session inside
 * a registered repo is titled after the repo, so it grows the repo's path and
 * not its own subdirectory.
 *
 * Rows sharing that path are genuinely the same place and keep the same title;
 * extending the path could not separate them and only adds noise - branch and
 * state already do. Only distinct paths are disambiguated.
 *
 * @param {Row[]} rows
 * @returns {Row[]}
 */
export function disambiguateTitles(rows) {
  /** @param {Row} row */
  const anchor = (row) => row.titlePath || row.cwd;
  /** @type {Map<string, Row[]>} */
  const groups = new Map();
  for (const row of rows) {
    if (!anchor(row)) continue;
    const group = groups.get(row.title);
    if (group) group.push(row);
    else groups.set(row.title, [row]);
  }

  /** @type {Map<string, string>} row id -> replacement title */
  const overrides = new Map();
  for (const group of groups.values()) {
    const paths = [...new Set(group.map(anchor))];
    if (paths.length < 2) continue;
    const titles = shortestUniqueTitles(paths);
    for (const row of group) overrides.set(row.id, titles.get(anchor(row)));
  }
  if (overrides.size === 0) return rows;
  return rows.map((row) => (overrides.has(row.id) ? { ...row, title: overrides.get(row.id) } : row));
}

/**
 * @param {Row[]} rows
 * @returns {Row[]}
 */
export function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const byAttention =
      ATTENTION_ORDER.indexOf(a.attention) - ATTENTION_ORDER.indexOf(b.attention);
    if (byAttention !== 0) return byAttention;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

/**
 * A one-line summary for the browser tab title and notifications.
 *
 * @param {Row[]} rows
 */
export function summarise(rows) {
  const blocked = rows.filter((r) => r.attention === 'blocked').length;
  const review = rows.filter((r) => r.attention === 'review').length;
  const parked = rows.filter((r) => r.attention === 'parked').length;
  const failed = rows.filter((r) => r.attention === 'failed').length;
  return { blocked, review, parked, failed, total: rows.length };
}
