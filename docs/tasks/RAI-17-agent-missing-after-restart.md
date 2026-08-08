---
ticket: RAI-17
status: backlog
size: S
depends: -
---
# RAI-17 - A pipeline step ran for six minutes and nothing on the card said so

**Self-contained brief.** No prior conversation needed. Written 06/08/2026.

**Investigate before changing anything.** There is a specific, cheap-to-test hypothesis below
that would make this a small fix, and a wrong guess here means building a mechanism nobody
needs. Do not start coding until Question 1 is answered.

---

## The symptom

Observed live on 06/08/2026. A no-mistakes run was in its `review` step:

```
active_steps: review, running, 3m44s, agent_pid 38815
```

The agent was alive and working. No session was registered for it - nothing under
`~/.raise/sessions/` had a `cwd` inside that run's worktree - so nothing was folded onto the
repository's card and the page said nothing about what the pipeline was doing.

**A second run was going at the same time, and its agent *had* registered.** Same machine, same
configuration, same repository, overlapping in time. That is the part that makes this a bug
rather than a design gap: the two behaved differently.

---

## What is already established

Read from the source and the live machine, not assumed:

1. **Pipeline steps run Claude Code.** `~/.no-mistakes/config.yaml` has `agent: claude`, so a
   step's agent is the same binary Raise installs its hooks into. "It was a different agent
   backend" is ruled out - and both runs used the same one.

2. **A step with no agent at all is a separate, understood case, and is not this.** The `ci`
   step reports an empty `agent_pid` because the CI monitor runs *inside the no-mistakes
   daemon* with no Claude session anywhere. PR #13 handled that by rendering
   `step.lastActivity` on the pipeline line. This item is about a step that genuinely **has** an
   agent that Raise cannot see.

3. **Registration happens on `SessionStart` and is never retried.** `HOOK_EVENTS` in
   `src/hooks.js` is `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `Notification`,
   `Stop`, `SessionEnd`. The hook posts to the port recorded in `server.json`; if that post
   does not land, nothing re-registers the session until the *next* event fires.

4. **A pipeline agent has almost no next event.** Nothing types at it, so there is no
   `UserPromptSubmit` - the event a human session would re-register on within seconds.
   `PermissionRequest` and `Notification` only fire if it blocks. So across a long autonomous
   step its events are `SessionStart` at the beginning and `Stop` at the end, and **nothing in
   between**.

5. **The monitor was restarted several times that day.** Its recorded pid changed repeatedly
   while these runs were in flight.

---

## Question 1 - answer this first, it decides everything

**Did the agent's `SessionStart` post fail because the monitor was down or on a different port
at that moment?**

Points 3, 4 and 5 compose into a complete explanation: an agent that starts while the monitor
is unavailable is invisible for the *entire* step, because its first event is lost and its next
one is the end of the turn - up to twenty minutes later.

- **If that is the cause**, this generalises well beyond pipeline agents and is worth fixing
  properly: *any* session that starts while the monitor is down is missing until its next hook
  event. A human notices within one prompt; an autonomous agent does not.
- **If it is not** - if the monitor was demonstrably up and reachable throughout - then
  something about daemon-spawned agents is different and Question 2 applies.

How to find out: this is reproducible on purpose rather than by waiting. Stop the monitor,
start a no-mistakes run, restart the monitor while a `review` or `test` step is running, and
watch whether the agent ever appears. The hook exits 0 silently by design, so **check whether
it has anywhere to report a failed post to** before assuming its silence means success.

---

## Question 2 - only if Question 1 comes back clean

Then compare the two agents directly. The difference is not the agent binary (point 1), so
look at what else could differ between two steps of two runs on one machine:

- the environment the daemon captured for each - `~/CLAUDE.md` records that the no-mistakes
  daemon builds its environment from a **non-interactive login shell**, which does not source
  `.zshrc`, and that this has silently broken daemon-side configuration before
- whether both agents saw the same `~/.claude/settings.json`, and therefore the same hooks
- whether the session file was written and then **pruned**: `SessionRegistry` drops sessions
  whose recorded pid is no longer alive, so a mismatch between the pid the hook reports and the
  pid still running would look identical to never having registered

---

## If Question 1 is confirmed, what the fix should and should not do

- **Do not poll for agents.** Scanning for unregistered Claude processes and adopting them
  guesses at identity, and this codebase's whole posture is that a confident wrong attribution
  is worse than a missing one.
- **Prefer making registration recoverable over making it reliable.** A hook that retries a
  failed post is a hook that can block, and `AGENTS.md` is absolute that the hook must never
  block and must always exit 0 within its timeout - it runs inside somebody's live session.
- **The cheapest honest fix may be on the monitor's side**: a session it has never heard of is
  one it could learn about from evidence it already gathers, without the hook changing at all.
  The process table is already scanned every three seconds for other reasons.
- Whatever is chosen, **a session that cannot be placed must not be invented**. Same rule as the
  unattributable run card: say what is known, admit what is not.

---

## Why this matters more than it looks

Raise exists to answer *which session needs me*. A pipeline agent that hits a permission prompt
while unregistered is a **blocked agent nobody can see** - `AGENTS.md` is explicit that a
blocked pipeline agent must turn the repository's row red, because the pipeline has stalled and
only a human can free it. If the agent never registered, that signal cannot fire at all.

So the visible symptom is a missing marker, and the real cost is a missed block.

---

## Reproduce as a test first

Per `AGENTS.md` and Matt's standing preference. If the cause is a lost `SessionStart`, that is
testable against a live server on an ephemeral port with a scratch `RAISE_HOME` - see the
existing pattern in `test/server.test.js`, which already stops and starts a monitor and asserts
on what the registry holds afterwards.

---

## Constraints (from AGENTS.md, non-negotiable)

- **The hook runs inside a live session.** Every path exits 0, quietly, within `TIMEOUT_MS`. A
  monitor that can break Claude Code is worse than no monitor.
- **Nothing reachable from the server may run a synchronous child process.**
- **The hook payload is a strict allowlist** (`src/hook-payload.js`). If a fix seems to need a
  new field, stop and ask - widening it is the user's decision, not the implementer's.
- Zero runtime dependencies.
- `npm test`, `npm run typecheck` and `npm run lint` all pass.

---

## Definition of done

```sh
npm test
npm run typecheck
npm run lint
```

Report the answer to Question 1 explicitly, even if the fix turns out to be small - it is the
part worth writing down, because the next person to see a missing agent will start here.
