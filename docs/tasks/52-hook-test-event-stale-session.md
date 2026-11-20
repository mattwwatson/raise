---
issue: 52
status: shipped
size: S
depends: -
branch: fm/raise-52-hook-test-event-stale-session
shipped: 2026-11-20
---
# 52 - A hook event run by hand creates a 'Waiting for you' session that never clears and opens the wrong tab

**Self-contained brief.** No prior conversation needed. Written 20/11/2026.

## What and why

Running the reporter by hand with a made-up event, from inside a running Claude Code session's
Bash tool:

```sh
echo '{"hook_event_name":"Notification","session_id":"test","cwd":"/tmp"}' \
  | node "$(npm root -g)/raise-cli/hooks/raise-hook.js"
```

stored `~/.raise/sessions/test.json` as a real session. The page showed a session named `tmp`
reading **Waiting for you**, with no history, and focusing it raised the tab of the session
that ran the command. It stayed until that session exited - over nine hours, observed - or the
file was deleted by hand.

Three things combined:

- the reporter accepts any payload with a `session_id` and requires nothing else;
- `collectHost()` walks up from its parent to the nearest agent process, so a hand-run hook
  records the *calling* session's pid, tty and terminal id;
- pruning removes a session only when its pid is dead, and that pid belongs to a live agent.

## Decisions

The issue offered three fixes.

**1. Ignore events whose session has no transcript - rejected.** Claude Code always sends
`transcript_path`, Claude Desktop runs the same Claude Code and sends it too, and Codex's
captured payloads carry it on every event (see `RAI-21-codex-sessions.md`). pi does not always:
`pi --no-session` builds an in-memory `SessionManager` that still creates a session id but has
no file, so the extension posts `transcript_path: null` on every event. Measured against the
installed `@earendil-works/pi-coding-agent`'s `dist/core/session-manager.js`: `newSession()`
assigns `createSessionId()` unconditionally and sets a session file only when `persist` is true,
and `SessionManager.inMemory()` passes `persist: false`. Requiring a transcript would have
dropped those sessions, which are real.

**2. One agent process, one session - chosen, in a narrower form than the issue sketched.**
When a record arrives whose agent pid is already held by another stored session:

- a session **without** a transcript yields - it is refused and nothing is written;
- a session **with** a transcript clears any transcriptless session off its pid;
- two sessions that **both** have transcripts are both kept, exactly as before.

The issue's version was "the older one, or the one without a transcript, is stale". The
older-loses half was left out on evidence: Claude Code's experimental in-process agent teams
report each teammate under its own session id from the lead's process, so newest-wins would
make teammates take turns removing each other on every event. Which of two transcript-bearing
sessions is stale cannot be told from a pid.

**3. `raise doctor` lists and removes transcriptless sessions - out of scope.** Option 2 closes
the reported repro without it. Left as a follow-up.

## Deliberately not covered

- **A hand-made payload that invents a `transcript_path`.** It is kept beside the real session,
  as it was before. Catching it needs newest-wins, which is the agent-teams regression above.
- **A hand-run hook with no agent above it** - a plain terminal, not an agent's Bash tool. The
  walk finds no agent, the record has no pid, and there is nothing to conflict on; it is kept
  for the fourteen days any pidless record is. Option 3 is the answer to both.

## Acceptance

- The issue's command, run through the real reporter from inside a Claude Code session against
  a scratch `RAISE_HOME`, writes no `test.json` and `raise status` lists only the real session.
- A record the bug already wrote is removed by the real session's next event.
- `pi --no-session` sessions keep their rows.
- Two transcript-bearing sessions on one pid are both kept.

## Implementation notes

- The rule is `#settlePidConflict` in `src/registry.js`, called from `record()` before the
  write. A refused event returns null, the same as a terminal one, and removes any record the
  refused id had already stored - the upgrade path for a `test.json` written before the fix.
- The server still answers the hook `204`: the reporter has nowhere to report a refusal.
- Several server and CLI tests registered transcriptless sessions on the test process's own pid
  for convenience. Those fixtures now carry a transcript path, as a real Claude Code event does,
  or put the second session on `process.ppid` where the captain's missing transcript is the
  thing under test.
- Regression tests: the registry cases in `test/registry.test.js`, and an end-to-end case
  against a live server in `test/server.test.js`.
