---
ticket: RAI-10
status: shipped
size: S
depends: -
branch: RAI-10-stale-pr-chip
shipped: 2026-08-06
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

---

## Implementation notes

### Which source produced it: `pullRequestForRun`, and the brief's table was wrong about why

The brief expected the database-query source, on the strength of `pullRequestForRun`'s own
comment - *"this only ever matters on the degraded `axi status` path"*. **That comment is
false.** `RUNS_QUERY` selects `pr_url` and `pr_state`, so `run.prUrl` is populated on the
ordinary database path, and `buildRows` puts `pullRequestForRun` **first** in the chain
(`dashboard.js:840`, and again on the unattributed-run row at `:911`). Any card with a matched
run carrying a pull request was showing *that* source, not the branch-verified one.

Which makes the trap the brief warned about the live case rather than the hypothetical one:
that source reported `run.updatedAt` as `observedAt`, and `updated_at` is bumped by every write
the run makes. The source most likely to be on a card was the one a freshness gate could not
see. Fixing this needed both halves - carry the real column, *then* gate on it.

### The observation cadence: measured at **≤112s**, and it stops without the run stopping

All figures from the live database (`~/.no-mistakes/state.sqlite`, 46 runs recorded with
`pr_state = 'open'`, read-only).

- **The column is a genuine observation, refreshed on every poll, not stamped once at PR
  creation.** Proof: `pr_state_observed_at` runs up to **45 hours** later than the `pr` step
  that opened the pull request, on runs whose state is still `open`. no-mistakes writes it with
  `UPDATE runs SET pr_state = ?, pr_state_observed_at = ?, updated_at = ? WHERE id = ?`.
- **Cadence.** The 43 runs whose last write was a cancel or a failure sample "time since the
  last observation" without bias, because when a human cancels is uncorrelated with the poll
  phase: median **64s**, p90 **110s**, max **112s**. Consistent with a ~2 minute poll.
- **The failure the gate exists for.** Two runs (`01KY4P345S7ZGSK17QV64CPGTE`,
  `01KY4PAZZHT0DVAB702YN7ANC5`) were last observed at the *same second* - 2026-07-22T13:45:13Z,
  a daemon restart - and then sat in the `ci` step, status `running`, for a further **7h23m**
  carrying `open`. `live` was true throughout. That window is unbounded, and it is what put a
  confident `OPEN` chip over a merged pull request.

**Threshold: `PR_STATE_FRESH_MS = 5 minutes`**, 2.7x the measured worst healthy case. It cannot
fire during a healthy run, and it catches a dead monitor within five minutes. The measurement
is recorded in the comment beside the constant, per the brief.

### `live` became `current`, rather than gaining a sibling

The brief left this as a judgement call. `live` names a fact about the *run*, and the bug is
precisely that fact being read as a fact about the *reading* - so keeping the name preserves
the confusion that caused it. `PullRequest.current` now means one thing: `state` may be
presented as the state now. Renaming rather than adding also keeps the page asking one boolean
and leaves nothing unread crossing the SSE frame.

`prStateIsCurrent(status, observedAt, now)` in `nm-state.js` is the single rule, used by both
`normalisePullRequest` and `pullRequestForRun`. It **fails closed** - a run with no observation
time is not current - because showing the state word is a claim, and the degraded `axi status`
path has no observation to offer. The frozen-run guard is unchanged and still required; this
adds the second half rather than replacing the first.

### RAI-13: it goes ahead, with a narrower remit

The brief's branch - *"if no useful threshold exists, that is a real finding and makes querying
the forge the only honest fix"* - **did not fire.** A useful threshold does exist, by a
comfortable margin (5 min against a 112s worst case), so this was fixable with no network and
no credentials, exactly as scoped.

But it does not make [RAI-13](RAI-13-pr-state-from-forge.md) unnecessary, and the residual is
worth stating precisely:

- **A freshness gate bounds the lie to the observation cadence; it cannot remove it.** For up
  to ~2 minutes between a merge and no-mistakes noticing, the reading is honestly fresh and
  honestly wrong. Nothing on disk can close that.
- **It says nothing at all about a pull request nobody is monitoring.** Once the run finishes -
  or for a pull request opened by hand - there is no observer, so the honest answer is now
  silence rather than a stale word. The page has a link and a "was open, last checked 3d ago"
  tooltip, and no way to find out.

So RAI-13 changes from *the only honest fix* to *the source that is authoritative when nothing
is watching*. That is a smaller and better-defined job than the brief assumed, and it is still
worth doing.
