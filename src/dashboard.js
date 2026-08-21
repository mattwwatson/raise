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
 *
 * This is the busiest file in the repo and the one where a wrong answer is
 * most expensive, so the four rules that are easiest to undo by accident are
 * stated here rather than left to be found at the function that enforces them.
 *
 * **Ownership decides which run a card shows; rank is only the fallback.** See
 * `buildRows`. It used to resolve one run by `rankRun` and consult `runOwners`
 * as a *veto*, dropping the run when somebody else owned it - so ownership
 * could take a wrong run off a card and never put the right one on it, which is
 * the shape of every failure this attribution has produced. Inverting that is
 * what closed the class. Two qualifiers travel with it and are not tidying: the
 * preference holds only while the owned run is still *running*, because the
 * whole reason to prefer it is the gate it is holding open and a finished run
 * has none; and **identity still follows the session's own path**, so a session
 * that owns a run is never retitled after it.
 *
 * **The forge is the one source allowed to assert.** See `withForgeState`.
 * Everywhere else here indirect evidence may only ever *disprove* - the
 * transcript can clear a block and can never announce one - because the forge
 * is the authority on its own pull requests where the other three sources are
 * recollections of one. It settles the *state* only: which pull request a row
 * has is still the local sources' answer, and the link is never touched.
 *
 * **Three guards fail three different ways, on purpose.** `isDisplayable`
 * fails **open** - an unrecognised run status keeps its card, because a card
 * going quiet is the worst thing this page can do. `attentionFor` fails
 * **soft** - only `failed` is coloured as a failure, because being on the page
 * is knowledge and being red is a claim. `isRunOwnerCommand` (in
 * `poll-watch.js`) fails **closed** - an unrecognised driving verb refuses to
 * claim a run, because guessing puts a pipeline on the wrong card. Each fails
 * in the direction that is safe for the thing it guards. **Do not "fix" any of
 * them to match the others.**
 *
 * **A card carries the session's line and the pipeline's line, never one in
 * place of the other.** They describe two things happening at once - you talk
 * to a session while no-mistakes works for it - and the step used to win,
 * erasing what you were working on the moment a pipeline started. `Row.summary`
 * is always the session's own title; `Row.pipeline` is what no-mistakes is
 * doing. See the `Row` typedef.
 */

import { basename } from 'node:path';
import { planFocus } from './focus/index.js';
import { PR_STATE_FRESH_MS, prStateIsCurrent, pullRequestNumber } from './nm-state.js';
import { pullRequestKey } from './forge.js';

/** @typedef {import('./registry.js').Session} Session */
/** @typedef {import('./nm-state.js').Run} Run */
/** @typedef {import('./nm-state.js').PullRequest} PullRequest */
/** @typedef {import('./forge.js').ForgeReading} ForgeReading */
/** @typedef {import('./firstmate-decisions.js').Decision} Decision */
/** @typedef {import('./firstmate-decisions.js').DecisionTask} DecisionTask */

/**
 * How much a row wants a human, most urgent first.
 *
 * `review` sits directly under `blocked` because it is the same thing wearing a
 * disguise: the agent has stopped and is waiting on a person. It only looks
 * like work because the waiting happens inside a subprocess, so the hooks see a
 * busy session rather than a blocked one.
 *
 * `decision` is a firstmate crewmate stopped waiting for a ruling from you, and
 * it sits between `review` and `parked` deliberately. **Not `blocked`**: that is
 * red and belongs to a gate on the session in front of you, and nothing on this
 * page may compete with it. **Not folded into `review`**: that word means a live
 * `lavish-axi poll` and is settled by a live process, so two different facts
 * under one word would be exactly the second opinion the source ranking exists
 * to prevent. **Above `parked`**: firstmate's own crew state maps a pending
 * decision to `parked`, so it is the same category of thing - work stopped at a
 * gate - but it is stopped on *you*, where a parked no-mistakes run usually
 * answers itself within seconds.
 *
 * There is deliberately no `done`: a run that ended quietly leaves the page
 * altogether rather than settling into a state of its own - see
 * `isDisplayable`, whose condition is the exact complement of the one that
 * would have produced it.
 *
 * `untracked` is the one entry here that is **not** an attention level: it is
 * the absence of evidence for one. A session nothing has ever reported has no
 * state that can honestly be read - the four worth telling apart (finished, at a
 * permission prompt, on the sixty-second nudge, and closed an hour ago) all
 * write byte-identical transcripts - so rather than pick one it says so. Every
 * row needs a value here, since it drives the sort and the card's class, which
 * is why the absence has to be spelled rather than left null. It sorts last,
 * renders faint, and is excluded from the coloured groups on the page.
 *
 * @typedef {'blocked'|'review'|'decision'|'parked'|'failed'|'idle'|'working'|'untracked'} Attention
 */

/**
 * One line on the dashboard: a session, a run, or a session with its run
 * attached. This is the whole contract between `buildRows` and everything that
 * renders - the page, the CLI's `status`, and the SSE frames between them.
 *
 * @typedef {object} Row
 * @property {string} id stable across polls, so the page can diff on it
 * @property {'session'|'run'|'decision'|'untracked'} kind `untracked` is a
 *   session found on disk that no hook has ever reported - it carries where it
 *   is and what it was about, and deliberately nothing about what it is doing.
 *   `decision` is firstmate rulings with no row to sit on, which exists for the
 *   same reason the unattributable run card does
 * @property {string|null} sessionId null for a run with no session attached, and
 *   for an untracked session, which is not in the registry that `/focus`,
 *   `/dismiss` and `/recent` all read
 * @property {string|null} cwd
 * @property {string} title the repo name, grown into a path only on collision
 * @property {string|null} titlePath the path `title` was derived from, which is
 *   what disambiguation grows
 * @property {string|null} sessionName the name a human gave this session, in
 *   Claude Code or pi - Codex has no equivalent; null unless one was set, which
 *   is most of the time
 * @property {string|null} branch
 * @property {Attention} attention
 * @property {string} attentionLabel `attention`, in words
 * @property {string|null} message why Claude wants you; only set while blocked.
 *   The agent's own words, except for a `permission_prompt` - which Claude Code
 *   sends for a question as readily as for a tool approval, so `blockReason`
 *   replaces it with neutral wording
 * @property {import('./registry.js').SessionState|null} sessionState
 * @property {number|null} sessionStateSince
 * @property {number|null} waitingSince the moment this row's wait is measured
 *   from, or null where it is not waiting - see `waitingSinceFor`. Absolute, so
 *   a renderer that re-renders on a tick keeps counting between pushes
 * @property {number|null} waitingForMs the same wait, already elapsed, for a
 *   renderer that wants the number rather than the mark. Derived from
 *   `waitingSince` and never decided separately
 * @property {boolean} wantsYou whether this row's state means a person is the
 *   one holding it up - see `WANTS_YOU`
 * @property {boolean} dismissible whether this row is announcing a block a human
 *   may say is not owed. Only ever Claude Code's idle nudge - a permission
 *   prompt offers no control at all rather than a control that must not be used
 * @property {boolean} dismissed whether a human's dismissal is *why* this row is
 *   idle, which is narrower than a dismissal being on the record: a row red for
 *   its pipeline agent, or working because the transcript disproved the block,
 *   is quiet for a reason of its own and says nothing. Where it is true both
 *   renderers say so, since a signal quietly hidden is the same quiet staleness
 *   this page exists to avoid, wearing different clothes
 * @property {boolean} focusable whether clicking this row can do anything
 * @property {'tmux'|'tab'|'app'|'unknown'|null} hostKind where the session lives
 * @property {import('./registry.js').AgentKind|null} agentKind which agent is
 *   running it; null for a run with no session behind it
 * @property {import('./firstmate.js').SpawnedBy|null} spawnedBy which tool
 *   started this session's window, when that tool declared itself. Null for a
 *   session nobody in particular started, which is most of them
 * @property {Decision[]} decisions the firstmate rulings open on this row, in
 *   the order the fold returns them - most recently opened last. A set rather
 *   than one decision because four on a single crewmate is the ordinary case,
 *   and an empty array and the absence of the field mean the same thing: both
 *   renderers must treat them alike
 * @property {number|null} decisionsPending how many decisions are open across
 *   the whole crew, on the captain's row and no other. A count of decisions
 *   rather than of tasks, and it belongs there because the captain window is
 *   where a ruling is actually given
 * @property {string|null} decisionsLabel the marker beside the state word, or
 *   null where the state word has already said it - see `decisionsLabel`
 * @property {Run|null} run
 * @property {number|null} updatedAt
 * @property {string|null} summary what the session is working on, in Claude's
 *   own words. Never the pipeline step: the two run at once, so the step has
 *   `pipeline` below rather than taking this
 * @property {Pipeline|null} pipeline what no-mistakes is doing for this row,
 *   which is a different question from what the session is doing
 * @property {boolean} attributable whether this row is a session, or something
 *   we could not tie to one - a run, or a set of rulings. False is the whole
 *   content of the unattributable card, which exists to say so rather than to
 *   be quietly wrong
 * @property {number|null} candidateSessions how many live sessions share this
 *   run's repository; only set when `attributable` is false, to say how far the
 *   uncertainty reaches. Null on a rulings card, which has no repository and so
 *   nothing to narrow it to
 * @property {string|null} activity the tool it is running right now
 * @property {string|null} mode 'plan' and the like; null for an ordinary turn
 * @property {string|null} reviewUrl the Lavish page this row is waiting on
 * @property {PullRequest|null} pr the pull request open on this branch
 * @property {number|null} lastActivityAt epoch ms this session last wrote to
 *   its transcript, which is when it last actually did something
 */

/**
 * What no-mistakes' own agent is doing, folded into the row of the repo it is
 * working on rather than given a row of its own.
 *
 * It does not reach a renderer directly. The agent is what makes a stalled
 * pipeline turn its repo's row red and lends it the message, and it is where
 * `Pipeline.what` gets the tool in flight; the row carries those answers and not
 * the agent itself.
 *
 * `activity` is the tool with no result yet, so it goes null every time one call
 * finishes and before the next begins - which on a busy agent is most seconds.
 * A marker rendered on it blinked in and out several times a minute, reading as
 * the pipeline starting and stopping. The rule that came out of that now lives
 * on `Pipeline`: presence follows the *run* existing, and the words are allowed
 * to be missing.
 *
 * @typedef {object} Agent
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
  'decision',
  'parked',
  'failed',
  'idle',
  'working',
  'untracked',
];

const ATTENTION_LABELS = {
  blocked: 'Waiting for you',
  review: 'Waiting on your review',
  decision: 'Waiting on your decision',
  parked: 'Pipeline parked at a gate',
  failed: 'Failed',
  idle: 'Idle',
  working: 'Working',
  // Not what the session is doing - what we know about it, which is nothing.
  untracked: 'Not tracked',
};

/** @param {Attention} attention */
export function attentionLabel(attention) {
  return ATTENTION_LABELS[attention] || attention;
}

/**
 * The levels that mean a person is the one holding a row up.
 *
 * The page asks this twice - once per row for the notification, once over the
 * whole list for the tab title - and it used to answer both by writing the three
 * words out. This branch then added `decision` to each of them by hand, which is
 * the drift arriving rather than merely being possible. So the set lives here,
 * both answers come off it, and the page reads `Row.wantsYou` and
 * `summary.wantsYou` rather than restating anything.
 *
 * `parked` is not in it: a pipeline at a gate is usually answered by the agent
 * itself, and `failed` is a thing that already happened rather than a thing
 * waiting.
 *
 * @type {Set<string>}
 */
const WANTS_YOU = new Set(['blocked', 'review', 'decision']);

/**
 * The moment a row's wait is measured from, or null where it is not waiting.
 *
 * The mark rather than the elapsed figure, because the page re-renders on a tick
 * and has to keep counting between pushes - `waitingForMs` is derived from this,
 * so the two cannot answer differently. The page held its own copy of this
 * condition until it had been edited in step with this one twice, which is the
 * same reason `decisionsLabel` moved here.
 *
 * **A ruling is gated on the session's own state, not on the attention word.**
 * `stateSince` marks a state *transition*, so it is a wait only while the state
 * that set it is the state the session is still in: read while `blocked`,
 * nothing has moved it since the session entered that block. The attention word
 * carries no such guarantee, because `decision` outlives the block beneath it -
 * the captain's row takes it from a ruling it merely carries while it works
 * away, and a crewmate keeps it through the held reading after resuming. Both go
 * on transitioning, so the mark being measured against is the one the row itself
 * keeps resetting. Those rows say when they last did something instead, which is
 * worth more than a wait we would be inventing.
 *
 * @param {Attention} attention
 * @param {import('./registry.js').SessionState|null} sessionState
 * @param {number|null} stateSince
 * @param {Run|null} run
 * @returns {number|null}
 */
function waitingSinceFor(attention, sessionState, stateSince, run) {
  if (attention === 'blocked' || attention === 'review') return stateSince || null;
  if (attention === 'decision' && sessionState === 'blocked') return stateSince || null;
  return run?.parked ? run.parkedSince || null : null;
}

/**
 * The firstmate marker beside a row's state word, in the position and for the
 * reason the `dismissed` marker sits there - the marker and the state word are
 * one sentence.
 *
 * **It asks whether the state word has already said a ruling is waiting, never
 * how many there are.** The count was the wrong question, and asking it hid the
 * one thing this feature exists to show: the marker used to be suppressed at
 * exactly one ruling on the reasoning that "Waiting on your decision" says it
 * already - true only while that *is* the row's word. A crewmate with one ruling
 * and a live Lavish poll reads `review`, and one stopped at a permission prompt
 * reads `blocked`; on both the card then said nothing about the ruling at all,
 * leaving a chevron identical to every other row's as the only sign, while
 * `raise status` printed the ruling on that same row. That is the defect this
 * whole change was made to remove, one attention level over, and the page was
 * the surface telling the lie.
 *
 * One marker per row, never two. The captain's counts the whole crew and its own
 * list is a subset of that, so both would be one number explaining another.
 *
 * Computed here rather than in either renderer because there is no third place
 * for it: the page is served as static files and imports only
 * `public/connection.js`, so a shared helper cannot reach it. It lived as two
 * copies for that reason and they are exactly what drifted.
 *
 * @param {Attention} attention
 * @param {Decision[]} decisions the rulings this row itself holds
 * @param {number|null} decisionsPending the crew-wide count, captain's row only
 * @returns {string|null}
 */
function decisionsLabel(attention, decisions, decisionsPending) {
  if (decisionsPending) return `${decisionsPending} across the crew`;
  if (decisions.length === 0) return null;
  if (decisions.length === 1 && attention === 'decision') return null;
  return `${decisions.length} open`;
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
 * **The branch is required on both paths.** Every worktree of a checkout
 * resolves to the same main checkout and no-mistakes registers all of their
 * runs against it, so the link is a one-to-many edge: resolving it by
 * `matchRunForCwd`'s ranking alone hands one run to every sibling worktree, and
 * hands each of them the parked one rather than its own. A worktree exists in
 * order to be on its own branch, and every run carries the branch it is on, so
 * that is what says whose run it is.
 *
 * This used to stop at the link, on the rule that a session sitting in a
 * checkout keeps showing that repo's recent pipeline whatever branch it has
 * since moved to. That rule is gone: it put a live pipeline from somebody
 * else's branch on an idle `main` card, with a Focus button to a window that
 * could not answer its gate. A run is an attribute of the session driving it,
 * and a checkout that has moved to another branch has finished with it.
 *
 * A checkout whose branch cannot be read - a detached HEAD, which Treehouse
 * produces routinely - therefore gets no run at all. With nothing to match on, a
 * guess would be a confident wrong answer with a Focus button attached, and the
 * run is better shown on the unattributable card that says so.
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
  if (!branch) return null;
  const mine = runs.filter((r) => r.branch === branch);
  return matchRunForCwd(cwd, mine) || matchRunForCwd(
    mainCheckout,
    mine,
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
 * This is the *first* source a session card tries, not a fallback: the runs
 * query carries `pr_url` and `pr_state` too, so any card with a matched run
 * takes its pull request from here. It was documented as mattering only on the
 * degraded `axi status` path, and that comment is what hid RAI-10 - the source
 * least equipped to say how fresh its state was is the one the page usually
 * showed.
 *
 * `observedAt` used to be `run.updatedAt`, which is when the *run* was last
 * touched. That is a proxy and a bad one: it advances every time the run does
 * anything at all, so a pull request nobody had looked at for hours still
 * looked freshly observed. It is the run's own `pr_state_observed_at` now, and
 * null when there is none - see `prStateIsCurrent`.
 *
 * @param {Run} run
 * @param {number} now
 * @returns {PullRequest|null}
 */
function pullRequestForRun(run, now) {
  if (!run.prUrl) return null;
  return {
    url: run.prUrl,
    number: pullRequestNumber(run.prUrl),
    state: run.prState || null,
    observedAt: run.prStateObservedAt ?? null,
    branch: run.branch,
    repoPath: run.repoPath,
    current: prStateIsCurrent(run.status, run.prStateObservedAt ?? null, now),
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
    current: false,
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
  return pullRequestKey(a) === pullRequestKey(b);
}

/**
 * Let the forge overrule whatever the three local sources concluded.
 *
 * This is the one place a source is allowed to *assert* rather than only
 * disprove, and the reason is that the forge is the authority on its own pull
 * requests where everything else here is a recollection of one. So it replaces
 * the state outright when it has a reading, and does nothing at all when it has
 * none - no credential, no `gh`, no network and a rate limit all arrive here as
 * an absent reading, which is what makes the feature invisible when it is off.
 *
 * The link is never touched. It is the one thing the local sources are as good
 * at, and the row keeps it in every case.
 *
 * **A disagreement with no-mistakes is not surfaced, because there is nothing
 * in it to say.** It means one thing only - no-mistakes' reading is older -
 * which `observedAt` already records. One answer per fact: a page that argues
 * with itself teaches you to stop believing it, which is the same failure as a
 * confident wrong chip, and this codebase refuses a second opinion everywhere
 * else it has been tempted.
 *
 * **A forge reading ages exactly like anybody else's**, with one exception and
 * one guard, and both come from the same sentence: freshness exists because an
 * answer can change. It goes through the same `PR_STATE_FRESH_MS` gate the
 * database does, so a lookup that stops answering - the network gone, the
 * machine asleep - stops asserting within five minutes and the row falls back to
 * "was open, last checked". Without that, "the forge wins" would quietly become
 * "the forge's last answer wins forever", which is RAI-10 again with a new
 * source.
 *
 * **`merged` is the exception, because it cannot un-merge.** `forge.js` never
 * asks again once it has that answer, so its `observedAt` is the one reading
 * here that is frozen by design - and aged through the ordinary gate it would be
 * the one immutable fact guaranteed to expire, taking the MERGED chip off the
 * row five minutes later and leaving it off for the rest of the day.
 *
 * **The guard is that this may never leave a row *less* current than it found
 * it.** A stale forge reading beside a local source somebody is still actively
 * re-observing - a live no-mistakes run polls its `ci` step every couple of
 * minutes - would be the forge making the page worse than the source it
 * outranks, which is the whole argument for this feature inverted. Outranking is
 * for deciding between two answers, not for replacing an answer with silence, so
 * where the forge has nothing current to say and a local source does, the local
 * reading stands.
 *
 * @param {PullRequest|null} pr
 * @param {Map<string, ForgeReading>} forgeStates
 * @param {number} now
 * @returns {PullRequest|null}
 */
function withForgeState(pr, forgeStates, now) {
  if (!pr || forgeStates.size === 0) return pr;
  const reading = forgeStates.get(pullRequestKey(pr.url));
  if (!reading) return pr;
  const current = reading.state === 'merged' || now - reading.observedAt <= PR_STATE_FRESH_MS;
  if (!current && pr.current) return pr;
  return { ...pr, state: reading.state, observedAt: reading.observedAt, current };
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
 * field, or whose record was written before Raise read it. Both paths fail
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
 * What Claude Code calls a dialog waiting on a human, whatever the dialog is.
 */
const PERMISSION_PROMPT_TYPE = 'permission_prompt';

/**
 * What a block reads as when Claude Code cannot say what it is really asking.
 *
 * Deliberately the same sentence shape as the message it replaces, with the
 * specific claim swapped for the general one that is true either way: a human
 * is needed, and the session is waiting on them.
 */
const NEEDS_RESPONSE = 'Claude needs your response';

/**
 * Why a blocked session wants you, said only as precisely as we actually know.
 *
 * Claude Code sends `permission_prompt` for *every* dialog it puts in front of
 * a human, and the message with it is one shared constant - so a question with
 * options, such as a no-mistakes review gate, arrives claiming "Claude needs
 * your permission". The state is right and the reason is a confident, specific
 * falsehood, which is the one thing this page may not do.
 *
 * Nothing on the wire can separate the two. Captured live from Claude Code
 * 2.1.226 with a control, an `AskUserQuestion` and a real `Bash` approval
 * produce byte-identical `Notification` payloads; only `tool_name` on the
 * earlier `PermissionRequest` differs, and that field is not ours to have - see
 * the hook payload's allowlist and RAI-11's spec for the decision. The
 * transcript cannot stand in either: a pending tool's record is not flushed to
 * disk while its dialog is open.
 *
 * So the honest answer is the vague one, and **only for the value that is
 * ambiguous**. A kind Claude Code *can* distinguish keeps the words it earned -
 * `idle_prompt` is already told apart by `isIdleNudge` and reads as it always
 * did. Flattening every message would trade one wrong answer for a page that
 * says less about the cases it had right.
 *
 * Fails closed exactly as `isIdleNudge` does: an absent or unrecognised type is
 * passed through untouched, so a reporter too old to send the field, or a
 * record written before this existed, reads precisely as it did before.
 *
 * @param {string|null|undefined} message
 * @param {string|null|undefined} [notificationType]
 * @returns {string|null}
 */
export function blockReason(message, notificationType) {
  if (notificationType === PERMISSION_PROMPT_TYPE) return NEEDS_RESPONSE;
  return message || null;
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
 * Whether a recorded block is one a human has already said is not owed.
 *
 * The comparison is against `blockAnnouncedAt` and it is an equality, not a
 * "since". A dismissal answers **one announcement**: the moment a hook says
 * blocked again - a permission prompt above all - the announced time moves, the
 * two stop agreeing, and the row is red with nothing further to do. That is the
 * property that makes this safe, and it is why the key may never become
 * `stateSince`, which does not move while the state is unchanged and would make
 * a dismissal permanent.
 *
 * @param {{blockAnnouncedAt?: number|null, dismissedBlockAt?: number|null}|null} session
 * @returns {boolean}
 */
function blockDismissed(session) {
  const announced = session?.blockAnnouncedAt;
  return !!announced && session?.dismissedBlockAt === announced;
}

/**
 * Whether this session's block is one the page may offer to dismiss.
 *
 * **Only the idle nudge.** A session stopped at a permission prompt genuinely
 * cannot proceed without a human, so dismissing it would hide something that
 * matters rather than something that does not - and `isIdleNudge` already tells
 * them apart and fails closed, so a notification type we do not recognise is
 * offered no control at all. That is the affordance rule doing its usual work
 * from the other end: never render a control whose *working* is the wrong
 * outcome.
 *
 * Deliberately false for a block already dismissed - the row is not red, so
 * there is nothing to answer - and for a block held by a folded pipeline agent
 * rather than by this session, which is why the caller passes the session's own
 * effective state rather than the row's attention.
 *
 * @param {Session|{state?: string, message?: string|null,
 *          notificationType?: string|null, blockAnnouncedAt?: number|null,
 *          dismissedBlockAt?: number|null}|null} session
 * @returns {boolean}
 */
export function isDismissibleBlock(session) {
  if (!session || session.state !== 'blocked') return false;
  if (!session.blockAnnouncedAt) return false;
  if (blockDismissed(session)) return false;
  return isIdleNudge(session.message, session.notificationType);
}

/**
 * Whether this session's recorded block should defer to an open firstmate ruling.
 *
 * A crewmate that has asked for a ruling has stopped, and a stopped Claude Code
 * session is exactly what produces the sixty-second nudge - so the nudge is the
 * symptom and the ruling is the cause. Where both are present the ruling is the
 * answer worth giving, and everything the block would otherwise have put on the
 * row defers to it: the attention level in `attentionFor`, and in `buildRows`
 * the nudge's own wording and the `Not for me` control.
 *
 * **Three callers, one definition, and the condition rather than the winning
 * attention word.** `attention !== 'decision'` looks like the same test and is
 * only an exact one while `decision` is the level that happens to win. It was
 * not: a ruling row also carrying a live Lavish poll falls past `blocked`,
 * lands on `review`, and the proxy then reads true - so the row kept a control
 * promising to quieten it and could not, which is the affordance rule broken in
 * the same place this rule exists to protect. Reordering the levels or adding
 * one would detach the two row fields from the rule again with nothing failing,
 * and that is the ordering defect this whole change was made to remove, one
 * layer up. Ask the condition.
 *
 * A permission prompt is never deferred: `isIdleNudge` fails closed, so an
 * unrecognised notification type stays a hard block, and a gate only that window
 * can clear is not something a ruling elsewhere may quieten.
 *
 * @param {{message?: string|null, notificationType?: string|null}|null} session
 * @param {number} decisions the open rulings joined to this row
 * @returns {boolean}
 */
function blockDefersToRuling(session, decisions) {
  return decisions > 0 && isIdleNudge(session?.message, session?.notificationType);
}

/**
 * Whether a dismissal is the thing keeping this session quiet.
 *
 * This is the dismissal branch of `effectiveSessionState` on its own, because
 * two questions hang off it and only one of them is the state. The other is
 * whether the row may *say* it was dismissed, and that word is only true while
 * the dismissal is what the row is showing: a stronger answer above it - the
 * transcript's disproof, a live pipeline - means the row is quiet for a reason
 * of its own and the dismissal is not what a reader is looking at.
 *
 * @param {Session|{state?: string, stateSince?: number,
 *          blockAnnouncedAt?: number|null, dismissedBlockAt?: number|null,
 *          message?: string|null, notificationType?: string|null}|null} session
 * @param {import('./transcript.js').TranscriptSummary|null} summary
 * @param {boolean} [pipelineRunning]
 * @returns {boolean}
 */
function blockDismissalInEffect(session, summary, pipelineRunning = false) {
  if (!session || session.state !== 'blocked') return false;
  if (blockDisproved(session, summary)) return false;
  if (pipelineRunning) return false;
  if (!isIdleNudge(session.message, session.notificationType)) return false;
  return blockDismissed(session);
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
 * A dismissal is the third and strongest source, and the only one that is not
 * inference: a human looked at the row and said nothing is owed. It lands on
 * `idle` rather than `working` because that is what an answered nudge leaves
 * behind - the turn ended and nobody has typed since, which is idle in the
 * page's own words. It answers the nudge and nothing else, held to `isIdleNudge`
 * a second time here so that a dismissal recorded by any future caller still
 * cannot reach a permission prompt.
 *
 * @param {Session|{state: string, stateSince?: number,
 *          blockAnnouncedAt?: number|null, dismissedBlockAt?: number|null,
 *          message?: string|null, notificationType?: string|null}|null} session
 * @param {import('./transcript.js').TranscriptSummary|null} summary
 * @param {boolean} [pipelineRunning]
 * @returns {import('./registry.js').SessionState|null}
 */
function effectiveSessionState(session, summary, pipelineRunning = false) {
  if (!session) return null;
  if (session.state === 'blocked') {
    if (blockDisproved(session, summary)) return 'working';
    if (pipelineRunning && isIdleNudge(session.message, session.notificationType)) {
      return 'working';
    }
    if (blockDismissalInEffect(session, summary, pipelineRunning)) return 'idle';
  }
  return /** @type {import('./registry.js').SessionState|null} */ (session.state ?? null);
}

/**
 * The terminal statuses that mean nothing is waiting on you.
 *
 * `completed` is a run that passed and `cancelled` is one you stopped, so in
 * both cases the answer is known and the card has nothing left to say. These
 * two leave the page, and every other status stays on it - see `isDisplayable`.
 *
 * The word is what decides it, and deliberately not whether the run carries an
 * error: every `cancelled` run in the real database has one, so reading that
 * instead would call a run you stopped a failure and put it back on the page.
 */
const FINISHED_QUIETLY = new Set(['completed', 'cancelled']);

/**
 * The firstmate task a session is, or null.
 *
 * Two independent joins, tried in that order, and both are firstmate's own
 * declaration rather than an inference of ours. The **window name** comes off
 * `endpoint.target` and is the same pinned `fm-<id>` this codebase already keys
 * crewmates on, so it is the more direct of the two. The **worktree** is the
 * checkout firstmate spawned the crewmate into, matched against the session's
 * own `cwd`.
 *
 * Either join finding more than one task means we cannot say which, and the
 * existing invariant applies without amendment: **an attribute we cannot place
 * belongs to nobody.** It is not sprayed across the candidates - shown on every
 * task that might own it, it is false on all but one with no way to tell which,
 * and a line you learn to distrust on one card is one you distrust everywhere.
 * The decision stays with the captain instead, which is the one row that is
 * certainly right about it.
 *
 * **This is one half of that invariant and cannot be the other.** It is handed
 * a single session, so it can only see a session matching several tasks; the
 * mirror case - several sessions matching one task - is only visible once every
 * session has been asked, and is guarded in `buildRows` where that is true.
 *
 * **Which join answered is returned with the answer, because the ranking has to
 * survive that second guard.** The window name is an exact match against a name
 * firstmate pinned; the worktree is a containment test that any session sitting
 * under the path satisfies, the person who opened their own agent in there to
 * see what the crewmate is asking included. Told only *that* two sessions
 * matched, `buildRows` would have to treat those as equal evidence and place
 * nothing - which loses the one row firstmate itself named, in exactly the
 * situation where somebody is looking into a stopped crewmate.
 *
 * @param {Session} session
 * @param {string|null} windowName the tmux window this session's pane sits in
 * @param {DecisionTask[]} tasks
 * @returns {{task: DecisionTask, by: 'window'|'worktree'}|null}
 */
export function matchDecisionTask(session, windowName, tasks) {
  if (!tasks || tasks.length === 0) return null;
  if (windowName) {
    const named = tasks.filter((task) => task.window && task.window === windowName);
    if (named.length === 1) return { task: named[0], by: 'window' };
    if (named.length > 1) return null;
  }
  const inside = tasks.filter((task) => isInside(session?.cwd || null, task.worktree));
  return inside.length === 1 ? { task: inside[0], by: 'worktree' } : null;
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
 * **Only `failed` is coloured as a failure, and that is a softer rule than the
 * one deciding what stays on the page.** `isDisplayable` keeps a run whose
 * status we do not recognise, because a card going quiet is the worst thing
 * here; this refuses to call it failed, because being visible is knowledge and
 * being red is a claim. A word we have never seen could be a new ending
 * (`errored`, `timed_out`) or a new *running* state (`queued`, `waiting`) -
 * `ACTIVE_STATUSES` is an allowlist, so an unknown one is not active either -
 * and red that sometimes means nothing is wrong is how this page stops being
 * believed. It reads as `working`: shown, uncommitted, and ranked below every
 * session that actually wants a human.
 *
 * An open firstmate decision is checked here rather than being disproved
 * anywhere: firstmate has already reconciled its own fold against live crew
 * state, so a decision the crew has moved past is absent from the reading
 * rather than present and stale. Nothing in this file second-guesses that -
 * the tool that owns the fact is the one stating it.
 *
 * `session` carries `message` and `notificationType` because the ruling rule
 * below has to tell Claude Code's idle nudge from a permission prompt, which is
 * what those two fields settle - the same pair `effectiveSessionState` reads for
 * the same distinction.
 *
 * @param {{session: Session|{state: string, message?: string|null,
 *            notificationType?: string|null}|null, run: Run|null,
 *          summary?: import('./transcript.js').TranscriptSummary|null,
 *          agent?: Agent|null, pipelineRunning?: boolean,
 *          decisions?: number}} input
 * @returns {Attention}
 */
export function attentionFor({
  session,
  run,
  summary = null,
  agent = null,
  pipelineRunning = false,
  decisions = 0,
}) {
  const state = effectiveSessionState(session, summary, pipelineRunning);
  // **An open ruling outranks the idle nudge, and never a permission prompt.**
  // Letting the nudge win says "Waiting for you", which is true and useless: the
  // row is holding the specific answer and refusing to give it, and the reader
  // has to go and ask somebody what the row meant. That is the failure this whole
  // feature exists to remove, reintroduced one level up. Observed on the first
  // hand-test of it. The reason it is asked as a condition, and what defers with
  // it, are at `blockDefersToRuling`; a folded pipeline agent's block below is a
  // real gate and still wins.
  if (state === 'blocked' && !blockDefersToRuling(session, decisions)) return 'blocked';
  if (agent?.state === 'blocked') return 'blocked';
  if (session && summary?.lavishFile) return 'review';
  if (decisions > 0) return 'decision';
  if (run?.parked) return 'parked';
  if (run && !run.active && run.status === 'failed') return 'failed';
  if (run?.active) return 'working';
  if (state === 'working') return 'working';
  if (state === 'idle') return 'idle';
  if (run) return 'working';
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
 * `spawnedBy` arrives the same way for the same reason: knowing that firstmate
 * started a session means reading a tmux pane table and a pid file, neither of
 * which this file may touch. Empty for every session nobody in particular
 * started, which is most of them.
 *
 * `mainCheckouts` is the same arrangement again: reading a worktree's `.git` to
 * find the checkout it is linked to is filesystem work, and the answer is what
 * places a run started from a worktree. Empty for every session that is not in
 * one, which is the ordinary case outside Treehouse. It comes off the same
 * `.git` read as `branches`, which is not only a saving: through the link the
 * branch is what picks which of that checkout's runs belongs to this worktree.
 *
 * `decisions`, `windowNames` and `captainSessionId` are that arrangement once
 * more. Reading firstmate's fleet snapshot is a subprocess taking tens of
 * seconds, and the window a pane sits in is a tmux query - neither belongs in a
 * pure file, and the captain is identified by a pid file this cannot open
 * either. All three are empty on a machine with no firstmate, where this
 * behaves exactly as it did before any of it existed.
 *
 * `untracked` arrives the same way again: finding a transcript nothing has
 * reported means walking three directory trees, which is filesystem work. Its
 * entries are keyed into `summaries`, `branches` and `mainCheckouts` by their
 * transcript path rather than by a session id - a session id is
 * `[A-Za-z0-9_-]{1,128}` and a path contains `/`, so the two key spaces cannot
 * collide, and reusing the maps means the transcript cache, the `.git` cache and
 * both prunes work on these rows unchanged.
 *
 * @param {{sessions: Session[], runs: Run[], now?: number,
 *          summaries?: Map<string, import('./transcript.js').TranscriptSummary>,
 *          reviewUrls?: Map<string, string|null>,
 *          branches?: Map<string, string|null>,
 *          mainCheckouts?: Map<string, string|null>,
 *          pullRequests?: PullRequest[],
 *          pipelines?: Set<string>,
 *          runOwners?: Map<string, string>,
 *          forgeStates?: Map<string, ForgeReading>,
 *          untracked?: import('./untracked.js').UntrackedSession[],
 *          spawnedBy?: Map<string, import('./firstmate.js').SpawnedBy|null>,
 *          decisions?: DecisionTask[],
 *          windowNames?: Map<string, string|null>,
 *          captainSessionId?: string|null}} input
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
  forgeStates = new Map(),
  untracked = [],
  spawnedBy = new Map(),
  decisions = [],
  windowNames = new Map(),
  captainSessionId = null,
}) {
  /** @type {Row[]} */
  const rows = [];
  const claimedRuns = new Set();

  // The *live* run each session owns, inverted out of the ownership map and
  // resolved against this reading, because a card shows the run its session is
  // answering for whenever we know which that is. Ownership used only as a veto
  // could take a wrong run off a card and never put the right one on it, which
  // is the shape of every failure this attribution has produced.
  //
  // Only while it is still running, though, and the reason is the same one that
  // makes the preference right in the first place: the owned run is the one
  // whose gate this session can reach, and a finished run has no gate. An
  // ownership outlives its run - `prune` holds it for the half hour the run
  // stays in the reading - so without this a stale one would hide a live or
  // parked run in the same checkout behind a completed one, which is this
  // branch's own failure reintroduced from the other side. `run.parked` implies
  // `run.active`, so a parked run is still preferred: it is precisely the case
  // with a gate waiting.
  //
  // A session can hold more than one, having driven a second while the first
  // was still going, so rank picks between them exactly as it does for a
  // session that owns nothing.
  /** @type {Map<string, Run>} */
  const ownedRuns = new Map();
  for (const run of runs) {
    if (!run.active) continue;
    const owner = runOwners.get(run.runId);
    if (!owner) continue;
    const best = ownedRuns.get(owner);
    if (!best || rankRun(run) > rankRun(best)) ownedRuns.set(owner, run);
  }

  // The pipeline's own sessions are folded into the row of the repo they are
  // working on, never given one of their own: two `tidepool` rows, one of
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
      activity,
      summary: title,
      state,
      message: state === 'blocked' ? blockReason(session.message, session.notificationType) : null,
      lastActivityAt: summary?.lastActivityAt ?? null,
    });
  }
  // Which crewmate each open firstmate decision belongs to, resolved once so
  // that the captain's row can be given whatever is left over. A decision we
  // could not place is not dropped and not sprayed across candidates: it goes
  // to the captain, who is where a ruling is given whoever it is about, and is
  // therefore the one row that cannot be wrong about it.
  //
  // **The ambiguity has two directions and both are guarded.**
  // `matchDecisionTask` answers the first - one session matching several tasks
  // cannot say which task it is - and it can only ever see one session, so the
  // second is resolved here: several sessions matching the same task cannot say
  // which session owns it. That happens without anything going wrong, because
  // `isInside` is a containment test: a person opening their own agent in a
  // crewmate's worktree, a session in a subdirectory of it, or a crewmate that
  // has restarted before its old registry entry was pruned all sit under the
  // one task path, and a split crewmate window puts two panes under the one
  // pinned name. Placing it on each of them would be the same false attribute
  // on all but one, with no way to tell which.
  //
  // **The two joins are ranked, and the ranking is what decides "cannot say".**
  // Ambiguity is only ambiguity between claims of equal weight. An exact match
  // on the name firstmate pinned and an incidental match on a path the claimant
  // merely sits under are not equal, so a lone window claimant takes the task
  // over any number of worktree ones - otherwise a person opening their own
  // agent inside a crewmate's checkout, which is what you do when you want to
  // see what it is asking, would silently quieten the crewmate's own row. Two
  // claims of the *same* kind stay unplaceable, and the better evidence being
  // ambiguous does not promote the weaker: two window claimants leave the task
  // with the captain even if one session also matched by worktree.
  /** @type {Map<string, {task: DecisionTask, window: string[], worktree: string[]}>} */
  const taskClaims = new Map();
  for (const session of human) {
    const claim = matchDecisionTask(
      session,
      windowNames.get(session.sessionId) || null,
      decisions,
    );
    if (!claim) continue;
    // Claimed on the *match*, not on there being something to show. It makes no
    // visible difference today, a task with nothing open contributing nothing to
    // the captain either way - it is written this way because "this task belongs
    // to that row" is the fact being recorded, and reading it off what the task
    // happens to hold would go wrong the first time a task carried anything else.
    let entry = taskClaims.get(claim.task.id);
    if (!entry) {
      entry = { task: claim.task, window: [], worktree: [] };
      taskClaims.set(claim.task.id, entry);
    }
    entry[claim.by].push(session.sessionId);
  }
  /** @type {Map<string, Decision[]>} */
  const sessionDecisions = new Map();
  /** @type {Set<string>} */
  const placedTasks = new Set();
  for (const { task, window, worktree } of taskClaims.values()) {
    const claimants = window.length > 0 ? window : worktree;
    // A task two claimants of one kind could own is placed on neither, and falls
    // to the captain by the same route a task nothing claimed does - counted
    // once, dropped never.
    if (claimants.length !== 1) continue;
    placedTasks.add(task.id);
    if (task.decisions.length > 0) sessionDecisions.set(claimants[0], task.decisions);
  }
  const unplacedDecisions = decisions
    .filter((task) => !placedTasks.has(task.id))
    .flatMap((task) => task.decisions);
  // Decisions, not tasks. Four rulings on one crewmate is the ordinary case, and
  // a count of tasks would say "1" over four things waiting.
  const decisionsPending = decisions.reduce((total, task) => total + task.decisions.length, 0);

  for (const session of human) {
    // A matched run answers two different questions, and they are resolved
    // separately because narrowing one of them must never narrow the other.
    //
    // **Identity** - the repo's name and the path a title grows from - is what
    // the session's own directory sits in, and nothing about a pipeline may
    // move it. `matchRunForCwd` places a run by repo path alone, so every
    // session open on a checkout finds the same registration and every card on
    // that checkout is named alike. Resolving it through the branch-gated match
    // instead coupled the name of a card to which runs happened to be in the
    // reading: a session in a subdirectory retitled itself from `repo` to
    // `packages/api` and back as runs came and went, and the pull request its
    // transcript reported was dropped, the slug guard comparing the URL's repo
    // against that subdirectory's name.
    //
    // **State** is exclusive, and that is what the branch narrows: three
    // sessions in one repo each carried the pipeline's step and its parked
    // gate, and each offered a Focus button to a window that could not answer
    // it.
    //
    // `runOwners` is what the process table saw: the session with a live
    // `no-mistakes axi run` underneath it, and when it names a *running* run for
    // this session that is the run the card shows. Rank is the fallback for a
    // session that owns nothing live, and there it still narrows and never
    // widens - a run somebody else was observed to own is taken off this card,
    // and a run nobody was observed to own is shown once, on a card of its own
    // that says we could not place it.
    //
    // A session owning a run on a branch its checkout has since left therefore
    // shows that run, while it is still going, rather than the repo's newest.
    // That is the point: it is the run this session is answering for, and the
    // only one whose gate it can reach.
    //
    // The checkout's own branch is resolved first because it is not only shown:
    // through a worktree's link it is what says which of the checkout's runs is
    // this worktree's, all of them being registered against the one path.
    const mainCheckout = mainCheckouts.get(session.sessionId) || null;
    const checkoutBranch = branches.get(session.sessionId) || null;
    const identityRepo = matchRunForCwd(session.cwd, runs);
    const checkoutRun = matchRunForCheckout(session.cwd, mainCheckout, checkoutBranch, runs);
    const owned = ownedRuns.get(session.sessionId) || null;
    const owner = checkoutRun ? runOwners.get(checkoutRun.runId) || null : null;
    const matched = owned || (!owner || owner === session.sessionId ? checkoutRun : null);
    // Claimed on the match rather than on what is shown, so a run this session
    // owns but has finished with cannot reappear as an unattributable card: it
    // was attributed, it is simply over.
    if (matched) claimedRuns.add(matched.runId);
    const run = matched && isDisplayable(matched) ? matched : null;
    const summary = summaries.get(session.sessionId) || null;
    const agent = (run && agents.get(run.runId)) || null;
    const pipelineRunning = pipelines.has(session.sessionId);
    // The captain carries what nobody else could be given, so that a ruling
    // request whose crewmate window has gone is still readable somewhere rather
    // than being a number with nothing behind it.
    const isCaptain = session.sessionId === captainSessionId;
    const rowDecisions = [
      ...(sessionDecisions.get(session.sessionId) || []),
      ...(isCaptain ? unplacedDecisions : []),
    ];
    const attention = attentionFor({
      session,
      run,
      summary,
      agent,
      pipelineRunning,
      decisions: rowDecisions.length,
    });
    const sessionState = effectiveSessionState(session, summary, pipelineRunning);
    const rowWaitingSince = waitingSinceFor(attention, sessionState, session.stateSince, run);
    const plan = planFocus(session);
    // The checkout's own branch, and nothing else. A run used to be able to
    // lend its branch to a session sitting in its repo, for a checkout whose
    // `.git` could not be read - but a run is now matched *on* the branch, so
    // there is no run to borrow from in exactly the case the fallback existed
    // for. Keeping it would have been a line that could never run.
    //
    // It is load-bearing beyond the label: the pull request is gated on it, so
    // a borrowed branch was a borrowed review link. Nothing is the right answer
    // when the checkout will not say.
    const branch = checkoutBranch;
    rows.push({
      id: `session:${session.sessionId}`,
      kind: 'session',
      sessionId: session.sessionId,
      cwd: session.cwd,
      // Identity follows the repo the session is in, never the run it owns or
      // the branch it is on. A bystander session titled after its own
      // subdirectory would stop looking like the same checkout as the one
      // running the pipeline.
      title: identityRepo?.repoName || basename(session.cwd || '') || 'unknown',
      // The path the title was taken from, which is what disambiguation grows.
      // For a session inside a registered repo that is the repo, not the
      // session's own directory - but only when the session really is inside
      // it. A worktree session is matched to a checkout it does not live in, so
      // borrowing that path would give it and the checkout the same anchor, and
      // disambiguation would have nothing left to grow: the `1/` and `2/` that
      // name a Treehouse tree would vanish from the page.
      titlePath:
        (identityRepo?.repoName && isInside(session.cwd, identityRepo.repoPath)
          ? identityRepo.repoPath
          : session.cwd) || null,
      // What the human called it, which is the only thing that tells apart two
      // sessions on the same repo and the same branch. Deliberately not fed to
      // `disambiguateTitles`: that grows a path until two *places* differ, and a
      // name that happens to be unique must not stop it.
      sessionName: summary?.sessionName || null,
      branch,
      attention,
      attentionLabel: attentionLabel(attention),
      // Everything below follows the effective state, not the raw hook state,
      // so a block the transcript has disproved cannot leave a stale "needs
      // your permission" or a waiting timer running behind a Working row. The
      // registry keeps a message for as long as it holds the block, so reading
      // it off a row blocked by its *agent* would caption the agent's block
      // with the human's granted prompt.
      // `blockReason` rather than the raw message: Claude Code describes every
      // dialog as a permission prompt, so the specific claim is only safe to
      // repeat for the kinds it can actually tell apart. The agent's message
      // has already been through it where it was built.
      // Suppressed where the block defers to a ruling even though the session's
      // own state is still `blocked`: the nudge's generic wording beside the
      // ruling is a second, weaker answer to a question the row has already
      // answered, and the ruling's own words are in the panel. One answer per
      // fact.
      message:
        (sessionState === 'blocked' && !blockDefersToRuling(session, rowDecisions.length)
          ? blockReason(session.message, session.notificationType)
          : null) ||
        (attention === 'blocked' ? agent?.message : null) ||
        null,
      sessionState,
      sessionStateSince: session.stateSince || null,
      waitingSince: rowWaitingSince,
      waitingForMs: rowWaitingSince === null ? null : now - rowWaitingSince,
      wantsYou: WANTS_YOU.has(attention),
      // Offered only while this session's *own* block is what makes the row red.
      // A row blocked by its folded pipeline agent reads the same on the page
      // and is not this session's to answer, so the effective state is checked
      // rather than the attention.
      // Never where the block defers to a ruling. The nudge underneath it is
      // dismissible, but a ruling cannot be dismissed from here - answering one
      // is firstmate's, and Raise does not write to it - so a control that looks
      // like it would quieten this row and cannot is the affordance rule broken
      // exactly where it matters most.
      dismissible:
        sessionState === 'blocked' &&
        !blockDefersToRuling(session, rowDecisions.length) &&
        isDismissibleBlock(session),
      // Said out loud on an idle row, because the difference between "nothing is
      // waiting" and "I told it to stop saying so" is exactly the difference
      // this page cannot afford to blur. It is that sentence and nothing else,
      // so it is the row's answer only while the dismissal is what quietened it:
      // beside a red "Waiting for you" - a folded pipeline agent's block, which
      // is not this session's to answer - or beside "Working", where the
      // transcript disproved the block and the dismissal never came into it, the
      // word would blur the same difference from the other side.
      dismissed: attention === 'idle' && blockDismissalInEffect(session, summary, pipelineRunning),
      focusable: plan.kind !== 'unfocusable',
      hostKind: hostKindFor(plan),
      // A record written before pi was supported carries no agent, and only
      // Claude Code sessions existed then.
      agentKind: session.agent || 'claude',
      // Positive evidence or nothing. A session we were not told about is one
      // nobody in particular started, which is the ordinary case and gets no
      // claim made about it either way.
      spawnedBy: spawnedBy.get(session.sessionId) || null,
      // First-party declaration, so it is shown as given: firstmate reconciles
      // its own fold against live crew state, and nothing here second-guesses
      // the result in either direction.
      decisions: rowDecisions,
      // The whole crew's total, and only here. It is beside the state word
      // rather than colouring the row, for the same reason the `dismissed`
      // marker is: it explains what is waiting, it does not claim this window
      // is the one that stopped.
      decisionsPending: isCaptain ? decisionsPending : null,
      decisionsLabel: decisionsLabel(attention, rowDecisions, isCaptain ? decisionsPending : null),
      run: run || null,
      updatedAt: session.updatedAt || null,
      // What the *session* is about, always - never the pipeline step. The step
      // used to replace this whenever a run was attached, on the reasoning that
      // it says what is being done to the repo where the title only says what
      // the conversation is about. Both are true and they are concurrent: you
      // talk to a session while no-mistakes runs for it, so the moment the
      // pipeline started you lost sight of what you had been doing. The
      // pipeline gets `pipeline` below and a line of its own.
      summary: summary?.title || null,
      pipeline: pipelineFor(run, agent),
      // A session card is always attributable - it *is* the attribution.
      attributable: true,
      candidateSessions: null,
      // On a review row the running tool *is* the waiting - "Running lavish-axi"
      // next to "Waiting on your review" reads as work in progress, which is
      // the one impression this state exists to correct.
      //
      // **`decision` is missing here on purpose, and is not the same omission as
      // the two the ruling change had to fix.** That reasoning does not carry: a
      // crewmate stopped on a ruling is in the position a `blocked` session is
      // in, and a `blocked` row shows its activity - a stopped crewmate usually
      // has no tool in flight to show anyway, so adding it here would only ever
      // remove a line. Do not complete the set.
      activity: attention === 'review' ? null : summary?.activity || null,
      // 'normal' is the absence of a mode, and saying so on every card would be
      // noise on the one thing this page has to keep scannable.
      mode: summary?.mode && summary.mode !== 'normal' ? summary.mode : null,
      reviewUrl: reviewUrls.get(session.sessionId) || null,
      // Three sources, most trustworthy first. A run still going is being
      // watched right now - for as long as something is actually looking, which
      // is `prStateIsCurrent`'s job to check rather than something the run's
      // status settles. The database's history is branch verified but frozen.
      // The transcript is neither, and is the only one that sees a pull request
      // no-mistakes never opened - which is common enough that leaving it out
      // means no link at all on plain Claude work.
      //
      // The run's own pull request has to clear the same branch check as the
      // other two, and it is kept even though a run is now matched *on* the
      // branch and so can no longer be on another one. It costs nothing, it is
      // the last line of defence on the source with the most to lose from being
      // wrong - a row disagreeing with itself, `main` beside another branch's
      // review - and it stops a later change to the match quietly re-opening
      // that link.
      //
      // A pull request belongs to the branch, not to whoever started the run,
      // so the two branch-verified sources stay on every session in the
      // checkout. Only the first is the run's own to lend, and only its owner
      // may take it.
      //
      // The transcript's is checked against the repo the session is *in*, which
      // is why it takes `identityRepo`: the slug guard compares the repository
      // in the URL against this path's basename, so handing it a run match that
      // a branch could take away would drop a real review link every time the
      // pipeline was on another branch.
      //
      // The forge, when it has been asked and answered, overrules whichever of
      // the four won - see `withForgeState`. It is applied here rather than
      // being a fifth entry in the chain because it settles the *state* of a
      // pull request the chain has already identified, and identifying one is
      // still these three sources' job.
      pr: withForgeState(
        (run?.prUrl && run.branch === branch ? pullRequestForRun(run, now) : null) ||
          matchPullRequest(session.cwd, branch, pullRequests) ||
          matchPullRequest(mainCheckout, branch, pullRequests) ||
          transcriptPullRequest(
            summary,
            identityRepo?.repoPath || session.cwd,
            branch,
            pullRequests,
          ),
        forgeStates,
        now,
      ),
      lastActivityAt: summary?.lastActivityAt ?? null,
    });
  }

  // A run we could not tie to any session. Someone ran no-mistakes by hand, the
  // session that started it has gone, or nothing was running to trace it to -
  // `axi run` returns at every gate, so a parked run has no process to walk up
  // from, and `raise status` has no ownership memory at all.
  //
  // This is the one card on the page that is not a session, and it earns that
  // by admitting what it does not know. The alternative was showing the run on
  // every session in its repo, which under a session-centric model is a *false
  // attribute* on all but one of them - and you cannot tell which is the real
  // one, so all it does is teach you to distrust the pipeline line everywhere.
  // Shown once, marked, and it says how many windows it might belong to.
  //
  // The count is of sessions sharing the *logical* repo, not the path: with
  // Treehouse, `work/repo`, `1/repo` and `2/repo` are one repository, which is
  // exactly what `mainCheckouts` resolves.
  for (const run of runs) {
    if (claimedRuns.has(run.runId)) continue;
    if (!isDisplayable(run)) continue;
    const candidateSessions = human.filter(
      (s) =>
        isInside(s.cwd, run.repoPath) ||
        isInside(mainCheckouts.get(s.sessionId) || null, run.repoPath),
    ).length;
    const agent = agents.get(run.runId) || null;
    const attention = attentionFor({ session: null, run, agent });
    const runWaitingSince = waitingSinceFor(attention, null, null, run);
    rows.push({
      id: `run:${run.runId}`,
      kind: 'run',
      sessionId: null,
      cwd: run.repoPath,
      title: run.repoName,
      titlePath: run.repoPath || null,
      // Nobody named this: there is no session behind it to have been named.
      sessionName: null,
      branch: run.branch,
      attention,
      attentionLabel: attentionLabel(attention),
      message: attention === 'blocked' ? agent?.message || null : null,
      sessionState: null,
      sessionStateSince: null,
      waitingSince: runWaitingSince,
      waitingForMs: runWaitingSince === null ? null : now - runWaitingSince,
      wantsYou: WANTS_YOU.has(attention),
      // No session behind it, so no announcement anybody could answer.
      dismissible: false,
      dismissed: false,
      focusable: false,
      hostKind: null,
      agentKind: null,
      // No session, so no window for anybody to have spawned.
      spawnedBy: null,
      // A firstmate decision belongs to a crewmate's session or to the captain's
      // - never to a pipeline run, which is a different tool's business.
      decisions: [],
      decisionsPending: null,
      decisionsLabel: null,
      run,
      updatedAt: run.updatedAt || null,
      // No session, so nothing to say about one. What the pipeline is doing goes
      // on `pipeline`, exactly as it does for a session card.
      summary: null,
      pipeline: pipelineFor(run, agent),
      // The whole point of this card: it is here *because* we could not place
      // it, and it must say so rather than looking like a session you failed to
      // notice. The page turns these two into the explanation on the card.
      attributable: false,
      candidateSessions,
      activity: null,
      mode: null,
      reviewUrl: null,
      pr: withForgeState(
        pullRequestForRun(run, now) || matchPullRequest(run.repoPath, run.branch, pullRequests),
        forgeStates,
        now,
      ),
      // The pipeline's agent has a transcript even when nobody else here does,
      // so it is a better account of when this last moved than the run's own
      // clock, which only ticks when a step changes.
      lastActivityAt: agent?.lastActivityAt ?? run.updatedAt ?? null,
    });
  }

  // A session found on disk that nothing has ever reported - almost always one
  // that was already running when the hooks were installed. Without these the
  // first page a stranger sees is blank, which reads as a tool that does not
  // work rather than as a tool waiting to be told about anything.
  //
  // It carries where it is, what a human called it, what it was about and when
  // it last wrote, and **nothing about what it is doing**. There is no honest
  // answer to that: finished, stopped at a permission prompt, sitting on the
  // sixty-second nudge and closed an hour ago all write the same transcript, so
  // a state word here would be a one-in-four guess presented as a fact. Even
  // `working` is unsafe - a dangling tool call is what a session killed mid-tool
  // leaves behind for ever, and the pid probe that saves every other row from
  // that is a thing only a hook reports.
  //
  // It claims no run either, in either direction. Ownership comes from walking
  // the process table up to `host.pid`, which this session by definition has
  // none of, so attaching a pipeline here would be rank standing in for
  // evidence - and it would put a parked gate on a card nobody can focus. A run
  // no session can be shown to own already has a card that says so.
  for (const session of untracked) {
    const summary = summaries.get(session.key) || null;
    rows.push({
      id: `untracked:${session.key}`,
      kind: 'untracked',
      // Nothing in the registry to focus, dismiss or expand, and every one of
      // those endpoints reads the registry. Null keeps the page's existing
      // affordance rules right without a single new condition.
      sessionId: null,
      cwd: session.cwd,
      // Its own directory, always: matching a run would be attributing one.
      title: basename(session.cwd) || 'unknown',
      titlePath: session.cwd,
      // Identity rather than state, and the only thing telling two of these
      // apart on one repo.
      sessionName: summary?.sessionName || null,
      branch: branches.get(session.key) || null,
      attention: 'untracked',
      attentionLabel: attentionLabel('untracked'),
      message: null,
      sessionState: null,
      sessionStateSince: null,
      waitingSince: null,
      waitingForMs: null,
      wantsYou: WANTS_YOU.has('untracked'),
      dismissible: false,
      dismissed: false,
      focusable: false,
      // Not `unknown`, which the page renders as "no window". This session
      // almost certainly has one; we simply have no handle on it, and saying
      // otherwise would be the confident wrong claim `HOST_LABELS` dropped its
      // fallback to avoid. No chip at all is the honest answer.
      hostKind: null,
      agentKind: session.agent,
      spawnedBy: null,
      // Placing a decision here would be attributing one, which is the whole of
      // what an untracked row refuses to do.
      decisions: [],
      decisionsPending: null,
      decisionsLabel: null,
      run: null,
      updatedAt: session.lastSeenAt,
      // Past tense and safe. Null for pi and Codex, neither of which writes a
      // title of any kind, exactly as on their tracked cards.
      summary: summary?.title || null,
      pipeline: null,
      // It *is* attributed - to itself. This is a session, not a run we failed
      // to place, and the page's unattributable section is not where it goes.
      attributable: true,
      candidateSessions: null,
      // Deliberately absent, both of them: "Running Bash" and "plan" are claims
      // about right now, and beside "restart this session to track it" they
      // contradict the row they sit on.
      activity: null,
      mode: null,
      reviewUrl: null,
      // Honest, and beside the point. Every extra attribute invites this row to
      // be read as a tracked one, which is the opposite of what it is for.
      pr: null,
      lastActivityAt: summary?.lastActivityAt ?? session.lastSeenAt,
    });
  }

  // Rulings that had nowhere to go, on a card that says so.
  //
  // The captain's row carries the remainder whenever there is one, because the
  // captain is where a ruling is given whoever it is about. There is not always
  // one: the reading is held for a bounded run of ticks in which firstmate's own
  // lock will not read, and in those the captain cannot be identified even
  // though its session is very likely still on the page. Until this existed the
  // remainder went to no row and was counted nowhere - the set silently bounded,
  // which is the one thing this feature may never do to a decision.
  //
  // So it follows the unattributable run, which exists for exactly this: an
  // attribute we cannot place belongs to nobody *and says so*. It carries every
  // ruling rather than a count of them, because a count with nothing behind it
  // is the same omission wearing a number.
  if (unplacedDecisions.length > 0 && !human.some((s) => s.sessionId === captainSessionId)) {
    rows.push({
      id: 'decisions:unplaced',
      kind: 'decision',
      sessionId: null,
      cwd: null,
      title: 'Rulings waiting',
      titlePath: null,
      sessionName: null,
      branch: null,
      attention: 'decision',
      attentionLabel: attentionLabel('decision'),
      message: null,
      sessionState: null,
      sessionStateSince: null,
      waitingSince: null,
      waitingForMs: null,
      wantsYou: WANTS_YOU.has('decision'),
      // No session announced these, so there is nothing anybody could answer.
      dismissible: false,
      dismissed: false,
      focusable: false,
      hostKind: null,
      agentKind: null,
      spawnedBy: null,
      decisions: unplacedDecisions,
      // The crew-wide count belongs to the captain's row and to no other, and
      // this is not it. Its own list is what it holds, and that is what it says.
      decisionsPending: null,
      decisionsLabel: decisionsLabel('decision', unplacedDecisions, null),
      run: null,
      updatedAt: null,
      summary: null,
      pipeline: null,
      // The whole point of this card, and the same boolean the run card uses:
      // it is here *because* we could not place it.
      attributable: false,
      // No repository, so there is no set of sessions to narrow it to. The run
      // card can say "probably one of your three on this repo"; this cannot, and
      // guessing would be the confident wrong claim the card exists to avoid.
      candidateSessions: null,
      activity: null,
      mode: null,
      reviewUrl: null,
      pr: null,
      lastActivityAt: null,
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

/**
 * What no-mistakes is doing for a session, as one line.
 *
 * A session and its pipeline run at the same time, so the card carries both and
 * this is the pipeline's half. It exists because "step ci" alone is the same
 * five characters whether the pipeline is rebasing your pull request, waiting
 * on a check, or idling - and the thing that says which was already on the row
 * and being thrown away.
 *
 * Three sources, most specific first, because no-mistakes works in three
 * different shapes:
 *
 *   - a step running a Claude agent (review, test) reports through the folded
 *     agent, whose `activity` is the tool in flight
 *   - the CI monitor runs *inside the no-mistakes daemon* with no agent session
 *     at all, and reports only through `step.lastActivity`
 *   - a parked step has neither, and the step name plus the state word on the
 *     line above already say everything there is
 *
 * `what` may be null and the line still renders, because **presence follows the
 * run existing, never the activity**. `Agent.activity` goes null between every
 * pair of tool calls, so a marker rendered on it blinked in and out several
 * times a minute, reading as the pipeline stopping and starting. The same trap
 * applies here and the same rule avoids it.
 *
 * `step.lastActivity` arrives prefixed, and the set of prefixes is no-mistakes'
 * to grow - so `stepActivity` reads it as an allowlist rather than trying to
 * enumerate it.
 *
 * @typedef {object} Pipeline
 * @property {string} step which step is running
 * @property {string|null} what what it is doing right now, if it says
 */

/**
 * @param {Run|null} run
 * @param {Agent|null} agent
 * @returns {Pipeline|null}
 */
function pipelineFor(run, agent) {
  if (!run?.step?.name) return null;
  return {
    step: run.step.name,
    what: agent?.activity || stepActivity(run.step.lastActivity) || null,
  };
}

/**
 * The prefixes on `step.lastActivity` worth putting on a card, and what they
 * are worth saying as.
 *
 * `log:` is a line the step printed and the prefix is pure transport noise.
 * `step failed:` is why a run failed, and a failed run is the one finished run
 * the page deliberately keeps - so dropping it left the card that must not go
 * quiet showing a step name and nothing else, with the reason sitting on the
 * row unread. The word is kept because without it "push to upstream: exit
 * status 1" reads as something the step is doing rather than how it ended.
 *
 * `status:` is deliberately absent: it restates the step status the line above
 * is already showing.
 */
const STEP_ACTIVITY_PREFIXES = [
  { prefix: 'log:', keep: false },
  { prefix: 'step failed:', keep: true },
];

/**
 * The readable half of a step's `lastActivity`, or null.
 *
 * An allowlist, and the shape matters more than the entries: no-mistakes owns
 * this vocabulary and adds to it, so a prefix we do not recognise is dropped
 * rather than shown raw. That is what stops its transport noise reaching a card.
 *
 * @param {string|null|undefined} lastActivity
 * @returns {string|null}
 */
function stepActivity(lastActivity) {
  const text = String(lastActivity || '').trim();
  for (const { prefix, keep } of STEP_ACTIVITY_PREFIXES) {
    if (!text.startsWith(prefix)) continue;
    const rest = text.slice(prefix.length).trim();
    if (!rest) return null;
    return keep ? `${prefix} ${rest}` : rest;
  }
  return null;
}

/**
 * Whether a run is still worth a place on the page.
 *
 * This replaced a thirty-minute recency window, which kept every finished run
 * around on the theory that a repo's recent pipeline is context. Under a
 * session-centric model it is not: a run that passed is finished business, and
 * the branch requirement means a card only ever shows a run for the branch it
 * is on - so switching away is already how you say you are done with it.
 *
 * A run that ended **badly** is the exception, and the reason there is a rule
 * here rather than a bare `run.active`. Failure is unfinished business, and it
 * is precisely the moment the card must not go quiet. It needs no timer of its
 * own: it stops showing when the checkout leaves its branch, which is the same
 * signal.
 *
 * So the quiet statuses are named and everything else shows. **This fails open,
 * which is the opposite polarity to `isRunOwnerCommand`, and deliberately so.**
 * A driving verb we do not recognise must not claim ownership of a run, because
 * the cost of guessing is a pipeline on the wrong card. A status we do not
 * recognise must not hide a run, because the cost of guessing is the one card
 * that must not go quiet vanishing in silence. Each fails the safe way for what
 * it guards, and matching them up would break one of them.
 *
 * Staying on the page is as far as it goes: `attentionFor` reads an
 * unrecognised status as `working` rather than `failed`, so this decides that
 * the run is *shown* and does not decide what it is shown as.
 *
 * @param {Run} run
 * @returns {boolean}
 */
function isDisplayable(run) {
  return run.active || !FINISHED_QUIETLY.has(String(run.status));
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
 * Which kinds of row sort above which, whatever state either is in.
 *
 * An unattributable run sorts below every session - including when it is parked,
 * which normally outranks working. The page ranks by who you can go and help,
 * and that card cannot take you to anyone: it has no window behind it. Letting a
 * gate nobody can answer sit above a session you could act on inverts the one
 * thing the ordering is for.
 *
 * An untracked session sorts below even that. The unplaceable run may still have
 * a gate somebody has to answer; an untracked row is, by construction, waiting
 * on nothing we can name.
 *
 * Rulings we could not place sit between the two, above the run for the one
 * reason that separates them: a ruling is by definition a person's to give,
 * where a run we cannot place may be working away perfectly well. Both are still
 * below every session, because neither can take you anywhere.
 */
const KIND_ORDER = { session: 0, decision: 1, run: 2, untracked: 3 };

/**
 * @param {Row[]} rows
 * @returns {Row[]}
 */
export function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const byKind = (KIND_ORDER[a.kind] ?? 0) - (KIND_ORDER[b.kind] ?? 0);
    if (byKind !== 0) return byKind;
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
  // Rows, like every other count here, and not the number of decisions on them:
  // this is what the tab title and the pills are built from, and those answer
  // "how many things want me", which is a question about sessions.
  const decision = rows.filter((r) => r.attention === 'decision').length;
  const parked = rows.filter((r) => r.attention === 'parked').length;
  const failed = rows.filter((r) => r.attention === 'failed').length;
  // The tab title's number, off the same set each row's own `wantsYou` comes
  // from, so the count and the rows behind it cannot say different things about
  // who is waiting. Asked of the attention rather than of the flag, so a caller
  // holding only the attention still gets an answer.
  const wantsYou = rows.filter((r) => WANTS_YOU.has(r.attention)).length;
  return { blocked, review, decision, parked, failed, wantsYou, total: rows.length };
}
