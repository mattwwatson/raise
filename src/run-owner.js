/**
 * Remembering which session started which pipeline run.
 *
 * Ownership is observed in the process table - `runOwnersBySession` walks a
 * live `no-mistakes axi run` up to the session that holds it - and that
 * observation is not continuously available. Two gaps make a memory necessary
 * rather than merely convenient:
 *
 *   - `axi run` *returns* at every approval gate, and does not run again until
 *     the agent answers with `axi respond`. Between the two there is no process
 *     to walk up from, and a parked run is precisely when the dashboard matters
 *     most - so without a memory the row would scatter back across every
 *     session in the repo exactly at the gate.
 *   - a run stays on the page for half an hour after it ends, by which time
 *     nothing of it is running at all.
 *
 * **Ownership does not change hands between live sessions.** Letting a later
 * sighting overwrite an earlier one would let a session that merely ran a
 * driving command near the end of a pipeline take the row off the session that
 * started it. `isRunOwnerCommand` already refuses the read-only subcommands, so
 * this is the second guard rather than the only one.
 *
 * **It is released when the owner is gone**, and only then - see `release`. An
 * owner that is no longer registered cannot be summoned to anything, so holding
 * a run for it inverts this module's own purpose: the session actually driving
 * the pipeline shows no pipeline at all, and the run renders as a row with no
 * Focus button on the one machine that could answer its gate. That is worse
 * than the scattering this exists to fix, because it is a confident wrong
 * answer rather than a vague one.
 *
 * No I/O and no clock: the run list is the lifetime, the live session list is
 * the tenancy, and both are handed in. A run that ages out of no-mistakes'
 * recency window takes its owner with it.
 */

import { matchRunForCwd } from './dashboard.js';

/** @typedef {import('./registry.js').Session} Session */
/** @typedef {import('./nm-state.js').Run} Run */

export class RunOwners {
  /** @type {Map<string, string>} run id -> session id */
  #owners = new Map();

  /**
   * Record a sighting. Ignored if this run already has a live owner.
   *
   * @param {string|null|undefined} runId
   * @param {string|null|undefined} sessionId
   */
  observe(runId, sessionId) {
    if (!runId || !sessionId) return;
    if (this.#owners.has(runId)) return;
    this.#owners.set(runId, sessionId);
  }

  /**
   * Record every sighting in one reading.
   *
   * The rule for what may be owned lives here rather than at each caller: the
   * server remembers across polls and the CLI does not, but *which* run a
   * sighting claims is the same question in both, and a future change to it
   * must not have to be made twice.
   *
   * Only an active run can be owned. A driving command seen while the newest
   * match for that directory is a finished run would otherwise claim it.
   *
   * @param {Session[]} sessions every live session
   * @param {Run[]} runs the current reading
   * @param {(session: Session) => boolean} isDriving whether the process table
   *   caught this session driving a run
   */
  observeFrom(sessions, runs, isDriving) {
    for (const session of sessions) {
      if (!isDriving(session)) continue;
      const owned = matchRunForCwd(session.cwd, runs);
      if (owned?.active) this.observe(owned.runId, session.sessionId);
    }
  }

  /**
   * Let go of runs whose owner is no longer registered.
   *
   * First observation wins only among sessions that still exist. A session ends
   * while its run is parked - the ordinary way a pipeline outlives the window
   * that started it - and whoever answers the gate next is the session a human
   * needs. Without this the dead owner kept the run forever: the new driver's
   * card showed no pipeline, and the run fell through to an unfocusable row of
   * its own.
   *
   * Must be called *before* the tick's sightings, or the new driver's sighting
   * is discarded on the very tick the old owner disappears.
   *
   * @param {Set<string>} liveSessionIds every session id in the current reading
   */
  release(liveSessionIds) {
    for (const [runId, sessionId] of this.#owners) {
      if (!liveSessionIds.has(sessionId)) this.#owners.delete(runId);
    }
  }

  /**
   * The session that started a run, or null if none was ever seen to.
   *
   * @param {string|null|undefined} runId
   * @returns {string|null}
   */
  ownerOf(runId) {
    if (!runId) return null;
    return this.#owners.get(runId) ?? null;
  }

  /**
   * Every ownership known, for `buildRows`, which is pure and takes a plain map.
   *
   * @returns {Map<string, string>}
   */
  get owners() {
    return this.#owners;
  }

  /**
   * Forget runs that are no longer in front of us.
   *
   * @param {Set<string>} liveRunIds every run id in the current reading
   */
  prune(liveRunIds) {
    for (const runId of this.#owners.keys()) {
      if (!liveRunIds.has(runId)) this.#owners.delete(runId);
    }
  }
}
