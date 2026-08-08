/**
 * Asking a port whether Raise is behind it.
 *
 * `server.json` records where the monitor was last started, which is not the
 * same question as where it is now: a server killed with SIGKILL never runs its
 * shutdown, so the record outlives it, and a server started under a different
 * RAISE_HOME holds the port while leaving no record at all. Both states read as
 * "not running" to anything that only looks at the file, which is how you end
 * up with `doctor` reporting nothing is running and `serve` failing to bind the
 * same port a second later.
 *
 * `/health` is the answer to the live question, and is deliberately the one
 * route that needs no token.
 */

const DEFAULT_TIMEOUT_MS = 500;

/**
 * Is there a Raise on this port right now?
 *
 * Anything can be listening on a local port, including something that answers
 * 200 with JSON of its own, so a response only counts when it has the exact
 * shape `/health` produces. Wrong-but-plausible is worse than nothing here: it
 * would have us tell the user to `kill` a pid belonging to an unrelated program.
 *
 * @param {number} port
 * @param {{timeoutMs?: number, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{pid: number} | null>} null for anything that is not Raise
 */
export async function probeHealth(port, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (body?.ok !== true || !Number.isInteger(body.pid)) return null;
    return { pid: body.pid };
  } catch {
    // Refused, timed out, not JSON: all of them mean "no Raise here".
    return null;
  } finally {
    clearTimeout(timer);
  }
}
