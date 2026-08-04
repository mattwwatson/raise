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
 * **First observation wins.** A run does not change hands, and letting a later
 * sighting overwrite an earlier one would let a session that merely ran a
 * driving command near the end of a pipeline take the row off the session that
 * started it. `isRunOwnerCommand` already refuses the read-only subcommands, so
 * this is the second guard rather than the only one.
 *
 * No I/O and no clock: the run list is the lifetime, and `prune` is told what
 * still exists. A run that ages out of no-mistakes' recency window takes its
 * owner with it.
 */

export class RunOwners {
  /** @type {Map<string, string>} run id -> session id */
  #owners = new Map();

  /**
   * Record a sighting. Ignored if this run already has an owner.
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
