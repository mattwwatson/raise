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

/**
 * Attention levels, most urgent first. The dashboard sorts on this, and the
 * page colours on it.
 */
export const ATTENTION_ORDER = ['blocked', 'parked', 'failed', 'idle', 'working', 'done'];

const ATTENTION_LABELS = {
  blocked: 'Waiting for you',
  parked: 'Pipeline parked at a gate',
  failed: 'Failed',
  idle: 'Idle',
  working: 'Working',
  done: 'Done',
};

export function attentionLabel(attention) {
  return ATTENTION_LABELS[attention] || attention;
}

/**
 * Find the run belonging to a working directory.
 *
 * Sessions frequently run in worktrees nested under, or alongside, the path
 * no-mistakes registered. Longest matching prefix wins so a worktree inside a
 * repo is attributed to the worktree's own registration when it has one.
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

function rankRun(run) {
  if (!run) return -1;
  if (run.parked) return 3;
  if (run.active) return 2;
  return (run.updatedAt || 0) / 1e13;
}

/** Decide the single attention level for a row. */
export function attentionFor({ session, run }) {
  if (session?.state === 'blocked') return 'blocked';
  if (run?.parked) return 'parked';
  if (run && !run.active && (run.status === 'failed' || run.error)) return 'failed';
  if (run?.active) return 'working';
  if (session?.state === 'working') return 'working';
  if (session?.state === 'idle') return 'idle';
  if (run && !run.active) return 'done';
  return 'idle';
}

/**
 * Build the rows the page renders.
 *
 * @param {{sessions: object[], runs: object[], now?: number}} input
 * @returns {object[]}
 */
export function buildRows({ sessions, runs, now = Date.now() }) {
  const rows = [];
  const claimedRuns = new Set();

  for (const session of sessions) {
    const run = matchRunForCwd(session.cwd, runs);
    if (run) claimedRuns.add(run.runId);
    const attention = attentionFor({ session, run });
    const plan = planFocus(session);
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
      branch: run?.branch || null,
      attention,
      attentionLabel: attentionLabel(attention),
      message: session.message || null,
      sessionState: session.state,
      sessionStateSince: session.stateSince || null,
      waitingForMs: session.state === 'blocked' ? now - (session.stateSince || now) : null,
      focusable: plan.kind !== 'unfocusable',
      hostKind: plan.kind === 'tmux' ? 'tmux' : 'tab',
      run: run || null,
      updatedAt: session.updatedAt || null,
    });
  }

  // Runs with no Claude session attached: someone ran no-mistakes by hand, or
  // the session ended while the pipeline carried on. Still worth showing, just
  // not focusable.
  for (const run of runs) {
    if (claimedRuns.has(run.runId)) continue;
    if (!run.active && !isRecent(run, now)) continue;
    const attention = attentionFor({ session: null, run });
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
      message: null,
      sessionState: null,
      sessionStateSince: null,
      waitingForMs: null,
      focusable: false,
      hostKind: null,
      run,
      updatedAt: run.updatedAt || null,
    });
  }

  return sortRows(disambiguateTitles(rows));
}

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
 */
export function disambiguateTitles(rows) {
  const anchor = (row) => row.titlePath || row.cwd;
  /** @type {Map<string, object[]>} */
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

export function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const byAttention =
      ATTENTION_ORDER.indexOf(a.attention) - ATTENTION_ORDER.indexOf(b.attention);
    if (byAttention !== 0) return byAttention;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

/** A one-line summary for the browser tab title and notifications. */
export function summarise(rows) {
  const blocked = rows.filter((r) => r.attention === 'blocked').length;
  const parked = rows.filter((r) => r.attention === 'parked').length;
  const failed = rows.filter((r) => r.attention === 'failed').length;
  return { blocked, parked, failed, total: rows.length };
}
