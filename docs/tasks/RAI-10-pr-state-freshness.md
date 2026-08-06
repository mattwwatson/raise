---
ticket: RAI-10
status: backlog
size: S
depends: -
---
# RAI-10 - A merged pull request still shows an OPEN chip

**Self-contained brief.** No prior conversation needed. Written 06/08/2026.

**Investigate before fixing.** There is a strong hypothesis below, but which code path produced
the symptom is not yet established, and one of the two possible paths is *not* fixed by the
obvious change. Confirm first.

---

## The symptom

A pull request was merged. Minutes later the dashboard still rendered a `PR #11 OPEN` chip.

This is the failure mode the project exists to prevent, occurring in the project itself.
`AGENTS.md`: *"Asserting a stale state is the quiet staleness this tool exists to avoid."* Treat
it with that weight - a confident wrong chip teaches the user to stop believing the page.

---

## The hypothesis

The page gates the chip on `live` alone (`public/index.html:1122`):

```js
if (row.pr.live && row.pr.state && row.pr.state !== 'none') { ... }
```

And `live` is derived in `src/nm-state.js:709`:

```js
live: ACTIVE_STATUSES.includes(row.status),   // ACTIVE_STATUSES = ['pending', 'running']
```

So **`live` means "the run that owns this pull request is still going"** - not "this state
reading is current". The existing design guards carefully against a frozen reading from a
*finished* run, and not at all against a stale reading from a *running* one. A run still in
`pending`/`running` renders whatever `pr_state` no-mistakes last wrote, however long ago that
was.

`observedAt` - the field that would answer the question - **is already populated and already
reaches the page**. It is used only in the tooltip (`public/index.html:1132`,
*"when last checked 3d ago"*) and is never consulted when deciding to show the chip.

---

## Establish which source produced it - do this first

Three sources can produce a `PullRequest`, and they do **not** mean the same thing by
`observedAt`. This matters more than it looks:

| Source | Where | `observedAt` is | `live` is |
| --- | --- | --- | --- |
| Database query | `src/nm-state.js:706-709` | `pr_state_observed_at` - a genuine "when the state was checked" | run status in `['pending','running']` |
| `pullRequestForRun` | `src/dashboard.js:292` | **`run.updatedAt`** - when the *run* was last touched, a proxy and not an observation | `run.active` |
| `transcriptPullRequest` | `src/dashboard.js:337` | the sighting time | **always `false`** - can never render a chip, so it is not implicated |

**The trap:** a freshness gate works on the first source and is close to useless on the second,
because `run.updatedAt` advances continuously while the run progresses. A run that is actively
working would keep looking "freshly observed" no matter how long ago the pull request state was
really checked.

`pullRequestForRun` is documented as only mattering on the degraded `axi status` fallback path,
so the database source is the likely culprit - but **confirm it** rather than assuming. If the
symptom came from `pullRequestForRun`, the fix below does not solve it and the right answer is
probably to stop trusting its state at all (it has no observation time to offer), or to go
straight to the forge query in `PR-STATE-FORGE.md`.

---

## Reproduce as a test first

Per `AGENTS.md` and the user's standing preference: **reproduce the bug as a permanent test
before changing any code**, then fix what the test exposes. `dashboard.js` is pure and directly
testable - see the `run()` / `session()` factory pattern at the top of `test/dashboard.test.js`.

The case to capture: a run in `running` status, carrying a `pr_state` of `open` whose
`pr_state_observed_at` is well in the past, must not present as a confident current state.

---

## The fix

Show the state word only when the reading is **fresh**, not merely when the run is alive. This
is the same rule the liveness dot already follows: positive evidence, never the absence of
contrary evidence.

Design notes:

- **Prefer fixing this where `live` is computed rather than in the page.** The page should keep
  asking one boolean. Whether that means narrowing `live` or adding a sibling field is a
  judgement call - if `live` changes meaning, its JSDoc in `src/nm-state.js:82` and the
  `AGENTS.md` passage describing it must change with it, or the next reader is misled by a
  comment that was true once.
- **The fallback is already built.** When the chip is suppressed, the tooltip's
  *"was open, last checked N ago"* path is what should show. Do not invent a new degraded state.
- **Do not weaken the existing frozen-run guard** while adding this one. They cover different
  cases and both are needed.

### The threshold is a tuned constant - measure, do not guess

`AGENTS.md` requires flagging changes to tuned constants, and this adds one. It cannot be
picked from intuition:

- **Too tight** and the chip disappears during healthy runs, since no-mistakes only re-observes
  the pull request at certain points rather than continuously.
- **Too loose** and the bug survives.

**Measure how often `pr_state_observed_at` actually advances during a real run** and choose
against that, then record the reasoning next to the constant. Report the measurement in your
summary. If it turns out no-mistakes observes the state so rarely that no useful threshold
exists, say so - that is a real finding, and it makes the forge query the only honest fix.

---

## Constraints (from AGENTS.md, non-negotiable)

- **Pure modules stay pure.** `dashboard.js` takes the clock as a parameter; do not import it.
- **Nothing reachable from the server may run a synchronous child process.**
- **Zero runtime dependencies.**
- **Do not change the SSE frame shape or `/api` responses without updating `public/` in the
  same change** - they are one protocol.
- This fix needs **no network access and no credentials**. If you find yourself wanting either,
  you have wandered into `PR-STATE-FORGE.md`; stop and hand back.

---

## Documentation

`AGENTS.md` documents this rule at length under *"A pull request has three possible sources"*,
including the sentence *"`PullRequest.live` is what enforces that"*. If the meaning of `live`
moves, that passage moves with it. Do not delete the reasoning - amend it, since the frozen-run
case it describes is still real.

---

## Definition of done

```sh
npm test          # including the new reproducing test
npm run typecheck
```

Report: which source produced the symptom, the measured observation interval, the threshold
chosen and why.
