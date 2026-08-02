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

  return sortRows(rows);
}

function isRecent(run, now, windowMs = 30 * 60 * 1000) {
  return run.updatedAt != null && now - run.updatedAt < windowMs;
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
