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
 * @property {'tmux'|'tab'|null} hostKind
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
    if (!run.repoPath) continue;
    if (cwd !== run.repoPath && !cwd.startsWith(`${run.repoPath}/`)) continue;
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
    if (pr.branch !== branch || !pr.repoPath) continue;
    if (cwd !== pr.repoPath && !cwd.startsWith(`${pr.repoPath}/`)) continue;
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
 * @param {import('./transcript.js').TranscriptSummary|null} summary
 * @param {string|null} repoPath
 * @param {string|null} branch
 * @returns {PullRequest|null}
 */
export function transcriptPullRequest(summary, repoPath, branch) {
  const seen = summary?.pullRequest;
  if (!seen?.url || !repoPath) return null;
  const repo = basename(repoPath);
  if (!seen.slug || !repo || seen.slug.toLowerCase() !== repo.toLowerCase()) return null;
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

/**
 * Claude Code's sixty-second nudge, as opposed to a permission prompt.
 *
 * The `Notification` hook fires for two different things, and the registry
 * cannot tell them apart because they arrive as the same event: Claude wanting
 * permission for a tool, and Claude having finished its turn and waiting for
 * you to say something next. Only the message distinguishes them.
 *
 * The distinction is load-bearing. A running pipeline is grounds for
 * disbelieving the second - the session is not free, it is mid-run - and is no
 * grounds at all for disbelieving the first, because a permission prompt stops
 * everything until a human answers whether or not something else is churning
 * in the background.
 *
 * Matched narrowly and failing closed: anything unrecognised, including no
 * message at all, stays a hard block. If Claude Code rewords this, the cost is
 * the stale "waiting for you" we had before, not a swallowed permission prompt.
 *
 * @param {string|null|undefined} message
 * @returns {boolean}
 */
export function isIdleNudge(message) {
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
 */
function blockDisproved(session, summary) {
  const since = session?.stateSince;
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
 * @param {Session|{state: string, stateSince?: number, message?: string|null}|null} session
 * @param {import('./transcript.js').TranscriptSummary|null} summary
 * @param {boolean} [pipelineRunning]
 * @returns {import('./registry.js').SessionState|null}
 */
function effectiveSessionState(session, summary, pipelineRunning = false) {
  if (!session) return null;
  if (session.state === 'blocked') {
    if (blockDisproved(session, summary)) return 'working';
    if (pipelineRunning && isIdleNudge(session.message)) return 'working';
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
 * @param {{sessions: Session[], runs: Run[], now?: number,
 *          summaries?: Map<string, import('./transcript.js').TranscriptSummary>,
 *          reviewUrls?: Map<string, string|null>,
 *          branches?: Map<string, string|null>,
 *          pullRequests?: PullRequest[],
 *          pipelines?: Set<string>}} input
 * @returns {Row[]}
 */
export function buildRows({
  sessions,
  runs,
  now = Date.now(),
  summaries = new Map(),
  reviewUrls = new Map(),
  branches = new Map(),
  pullRequests = [],
  pipelines = new Set(),
}) {
  /** @type {Row[]} */
  const rows = [];
  const claimedRuns = new Set();

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
    const summary = summaries.get(session.sessionId) || null;
    const activity = summary?.activity || null;
    const title = summary?.title || null;
    agents.set(owning.runId, {
      // Falls through to a bare word rather than nothing, so the marker cannot
      // blink out between one tool call and the next.
      what: activity || title || 'working',
      activity,
      summary: title,
      state: /** @type {import('./registry.js').SessionState|null} */ (session.state ?? null),
      message: session.state === 'blocked' ? session.message || null : null,
      lastActivityAt: summary?.lastActivityAt ?? null,
    });
  }
  for (const session of human) {
    const run = matchRunForCwd(session.cwd, runs);
    if (run) claimedRuns.add(run.runId);
    const summary = summaries.get(session.sessionId) || null;
    const agent = (run && agents.get(run.runId)) || null;
    const pipelineRunning = pipelines.has(session.sessionId);
    const attention = attentionFor({ session, run, summary, agent, pipelineRunning });
    const plan = planFocus(session);
    // The checkout's own branch is the truth about where this session is. The
    // run's is a second choice: it belongs to a pipeline that may have finished
    // on a branch that has since been left behind.
    const branch = branches.get(session.sessionId) || run?.branch || null;
    rows.push({
      id: `session:${session.sessionId}`,
      kind: 'session',
      sessionId: session.sessionId,
      cwd: session.cwd,
      title: run?.repoName || basename(session.cwd || '') || 'unknown',
      // The path the title was taken from, which is what disambiguation grows.
      // For a session inside a registered repo that is the repo, not the
      // session's own directory.
      titlePath: (run?.repoName ? run.repoPath : session.cwd) || null,
      branch,
      attention,
      attentionLabel: attentionLabel(attention),
      // Everything below follows `attention`, not the raw hook state, so a
      // block the transcript has disproved cannot leave a stale "needs your
      // permission" or a waiting timer running behind a Working row.
      message:
        attention === 'blocked' ? session.message || agent?.message || null : null,
      sessionState: effectiveSessionState(session, summary, pipelineRunning),
      sessionStateSince: session.stateSince || null,
      waitingForMs:
        attention === 'blocked' || attention === 'review'
          ? now - (session.stateSince || now)
          : null,
      focusable: plan.kind !== 'unfocusable',
      hostKind: plan.kind === 'tmux' ? 'tmux' : 'tab',
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
      pr:
        (run?.prUrl ? pullRequestForRun(run) : null) ||
        matchPullRequest(session.cwd, branch, pullRequests) ||
        transcriptPullRequest(summary, run?.repoPath || session.cwd, branch),
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
