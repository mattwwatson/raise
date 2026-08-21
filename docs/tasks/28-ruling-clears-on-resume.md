---
issue: 28
status: shipped
size: S
depends: 25
branch: fm/raise-28-ruling-clears-on-resume
shipped: 2026-08-21
---
# 28 - A ruling that has already been answered lingers until a timer runs out

**Self-contained brief.** No prior conversation needed. Written 21/08/2026.
[docs/tasks/25-firstmate-pending-decisions.md](25-firstmate-pending-decisions.md) is the direct
predecessor and holds every measurement of firstmate's snapshot that this one relies on; nothing
is re-measured here.

---

## The problem

A firstmate ruling that has already been answered can go on showing as `Waiting on your
decision` after it stops being true.

The clearing is real and automatic. firstmate reconciles its own fold against live crew state,
so a crewmate that resumes has its ruling cleared at the source. But Raise re-reads the fleet
snapshot only when a `state/*.status` mtime moves or when `ASSERTION_MAX_AGE_MS` runs out, and
clearing a ruling that way writes no status line. On that path the ceiling is the only thing
left.

**How late it can get is not a property of any one constant**, so no figure in seconds belongs
in this file. Dispatch is driven by whichever of the mtime gate and the ceiling fires first, so
on a fleet still writing status lines the lag is bounded by `REFRESH_MS` and on a quiet one by
`ASSERTION_MAX_AGE_MS`. Quoting a number would mean picking one of those cases and going stale
the moment either constant moved.

### Observed, 21/08/2026

Two rulings showed on the board. Asked directly, firstmate said:

```
sls-129-agents-md-size      state=working  source=run-step   open_decisions=0
sls-135-help-ask-on-patrol  state=parked   source=run-step   open_decisions=1
```

The board showed **both** as waiting, and `2` on the captain's row. The crewmate had resumed and
firstmate had cleared it; Raise had not looked again. It self-healed after roughly three minutes
of visible wrongness.

Neither task had written a `resolved:` line. That is worth stating because it is also the
argument against the obvious alternative: folding the status log locally would have shown
**both** open indefinitely. firstmate's reconciliation is what cleared one of them.

## What will visibly change

A ruling leaves the board once the crewmate holding it resumes, on the next cycle the minimum
interval allows, rather than when the staleness ceiling expires. Nothing else about the page
changes: no new row, no new state word, no new chip.

## Non-goals, inherited from 25 and unchanged

- **Nothing reads transcript content.** The stat is a change detector. The snapshot still
  decides what is open, and nothing is inferred from what a transcript says. Matching prose to
  detect a ruling is forbidden by the invariant in AGENTS.md and stays forbidden; this reacts to
  *that* a file changed, never to what is in it.
- **Nothing re-implements firstmate's fold.** In the observed case a local fold would have shown
  both rulings open for ever, because neither task wrote a `resolved:` line. Consuming the
  reconciliation is the whole reason 25 reads the snapshot.
- **`ASSERTION_MAX_AGE_MS` is not tuned.** See below.

---

## What was already tried, and withdrawn

Issue 25 shortened the ceiling from five minutes to ninety seconds in response to the same
observation. **It was reverted the same day.** It ran three review rounds and produced six
findings, each fix creating the next, and the permanent background cost it set out to reduce
ended up worse than before it started - because the failure path shares the same ceiling, and
because of the gate below. Separating the two cadences then delayed recovery from *transient*
failures, so a real ruling could leave the page entirely after a momentary blip: a missing
signal, which is worse than a stale one.

The history is kept here rather than tidied away because the lever looks obviously correct and
is not. Tuning the ceiling changes only the quiet-fleet case and costs on every machine where
the snapshot is failing.

## The trap, and it decides the shape

The dispatch gate in `FirstmateDecisions.refresh` is:

```js
if (!first && !moved && !aged) return;
```

`moved` dispatches **without ever consulting `aged`**, so the staleness ceiling and every
failure interval are invisible to it. On a machine where the snapshot can never succeed while
the crew keeps appending status lines - firstmate bumping `schema`, which `SNAPSHOT_SCHEMA`
refuses by design, is the concrete route - the snapshot re-runs every `REFRESH_MS` for the life
of the process, whatever the ceiling says.

This is **pre-existing**. The same gate is at `598a14a`, before any of the ceiling work, and 25
does not introduce it. It is deliberately left alone here: fixing it is a change to how the
existing trigger behaves on every machine, which is its own item and its own review.

**What matters is that a new trigger must not join it.** A trigger merely OR-ed into that gate
inherits the bypass and fires regardless of any interval meant to bound it - which is exactly
how the backoff attempted on 25 came to have no effect on the one path it was written for.

---

## The shape

Re-read the snapshot when a crewmate that the standing reading calls stopped has written to its
transcript since we last looked at it.

### Why a transcript write is the right event

A crewmate stopped on a ruling writes nothing: that is what being stopped means, and it is why
the mtime gate cannot see the clearing. A crewmate that has resumed writes to its own
transcript. So the event is both exactly the one worth reacting to and free to watch - the poll
already stats every transcript it can see, once per session per tick, because
`TranscriptReader` is built on that stat.

`TranscriptReader.stamp` returns the size and mtime of the stat `read` already took on this
tick. It is a map lookup and never a syscall.

### How it answers the trap

**The trigger asks `#failures` before anything else.** While a run of failures is standing it
cannot fire at all, so the only cadence that may dispatch is `aged` - the ceiling, which is the
interval written to bound exactly that state. That is what stops it inheriting the `moved`
bypass, and it is a property of the shape rather than of any number: there is no interval for it
to defy, because in the state where an interval is meant to bound dispatch the trigger is
switched off.

The bound is not incidental. A snapshot that keeps failing reaches
`MAX_CONSECUTIVE_FAILURES` and the reading is dropped, at which point nothing is asserted and
the trigger has nothing to watch either way. Both routes end in the same place: a failing
firstmate pays the ceiling and nothing more.

### The join is the pinned window, and only that

`endpoint.target` publishes the `fm-<id>` window firstmate pinned, and `firstmate.js` reads the
same name off the tmux pane table. A match is firstmate's own declaration that this session is
that crewmate.

`dashboard.js` will also place a ruling by **worktree**, and that join is deliberately not used
here. It is a containment test that any session sitting under the path satisfies - including the
person who opened their own agent in the crewmate's checkout to read what it is asking, which is
the ordinary thing to do when a ruling appears. That session writes for as long as somebody is
looking at it. Taken as a resume it would dispatch a fourteen-second snapshot every cycle for
the whole life of a ruling that nothing had happened to.

So the trigger takes the narrow join and accepts being late on the wide one:

| | Costs |
| --- | --- |
| firing wrongly | a subprocess every cycle, for as long as the ruling is open |
| firing late | the behaviour that was already there - the ceiling |

Two panes under one pinned name are both the crewmate's window and both count, which is the same
answer `dashboard.js` gives a split crewmate window.

### Who decides what, and why it is split that way

The poll loop is the only thing that knows which sessions exist and what their transcripts look
like, so it gathers the observations: a window name and a stamp, for every session that has a
window. `FirstmateDecisions` decides which of them matter, against the reading that knows which
windows are stopped. **The caller cannot widen what the trigger watches by handing over more
observations**, and no part of the server has to know what a ruling is.

### The baseline, and when it moves

`#crew` records what the crew looked like when we last *looked*, and it moves whether or not
that look dispatched. That is the opposite of the rule `#signature` follows, and deliberately:
the status signature records the files a *reading* covers, so a tick that dispatched nothing has
covered nothing and must not consume the evidence. This one waits for no reading, and a reading
that arrives later is newer than anything written before the call that dispatched it, so there
is nothing left to re-ask about.

Three cases follow from it, all asserted:

- The **first** signature taken after a reading starts asserting is a baseline, never a resume.
  Nothing has been compared with anything yet.
- A signature we could not take - no transcript, or a stat that threw - is the absence of an
  observation, not an observation of no change. It never fires, and the stamp coming back is a
  fresh baseline rather than a write.
- A different `$FM_HOME` clears the baseline with the reading it was derived from. Kept, it
  would be compared against the next fleet's crewmates and read as a resume nobody performed.

It is computed after the minimum-interval check and never before it, so the baseline moves at
most once a cycle. A crewmate that wrote during the quiet part of one is still a change when the
next tick is allowed to look, because the stamp carries the size and the mtime rather than a
count of writes.

## What was rejected

- **Tuning `ASSERTION_MAX_AGE_MS`.** Tried on 25 and reverted the same day. See above.
- **Folding the status log locally.** Would have shown both rulings in the observed case open
  indefinitely.
- **Matching the captain's prose.** Indirect evidence asserting a human gate, closed off by the
  invariant in AGENTS.md and by 25 before it.
- **OR-ing a new condition into the gate and leaving it there.** Inherits the `moved` bypass;
  the whole of what the issue asks this item to answer.
- **Joining by worktree as well as by window.** The onlooker case above turns it into a
  permanent subprocess.
- **Firing at most once per reading.** It bounds the cost harder and it breaks the feature: the
  reconciliation is asynchronous, so a snapshot dispatched the moment a crewmate resumes can
  come back still asserting, and a trigger that had spent its one dispatch on that answer would
  then wait out the ceiling anyway - which is the case this item exists for.
- **Fixing the `moved` bypass in the same change.** It changes how the existing trigger behaves
  on every machine that runs firstmate, and this item's own trigger does not need it.

## Cost

Nothing on a machine without firstmate, which has no captain and reaches none of this.

Nothing on a fleet with no ruling open: `#crewSignature` returns null when the reading names no
stopped crewmate with a pinned window, so there is nothing to compare and nothing to dispatch.

While a ruling *is* open, one extra snapshot per `REFRESH_MS` at most, and only while the
crewmate holding it is writing. A crewmate that is genuinely stopped writes nothing, so the
steady state costs nothing; the signature moves exactly when the premise of the assertion has
stopped being true, which is the event worth a subprocess. On a live fleet `moved` is already
dispatching at that cadence off the status lines the crew is appending, so on the machines where
this could fire repeatedly it is not adding a cycle that was not already there.

## Acceptance

1. A ruling clears from the board on the next cycle the minimum interval allows after the
   crewmate resumes, rather than waiting out `ASSERTION_MAX_AGE_MS` - asserted at instants short
   of the ceiling, with a guard that fails the test if the two constants ever leave no room
   between them.
2. The trigger cannot dispatch while a run of failures is standing, so the interval bounding
   that state is not bypassed.
3. Nothing reads transcript content, nothing folds the status log, `ASSERTION_MAX_AGE_MS` is
   unchanged.
4. A session sitting in the crewmate's worktree under a different window cannot trigger a
   re-read; a crewmate with nothing open is not watched at all.
5. The poll loop actually builds the observations, names the pinned window, and sends a value
   that moves when the crewmate writes.

## Implementation notes

Shipped on `fm/raise-28-ruling-clears-on-resume`, 21/08/2026.

| Change | Where |
| --- | --- |
| `stamp(path)` - the size and mtime of the stat `read` already took | `src/transcript-reader.js` |
| `CrewObservation`, `#crew`, `#crewResumed`, `#crewSignature`, and the third argument to `refresh` | `src/firstmate-decisions.js` |
| the observations gathered in the poll loop and handed to `refresh` | `src/server.js` |

`createMonitorServer` gained one injectable dependency, `firstmateDecisions`. It is not an
outside-world dependency and would not normally be injected; it is injected because its minimum
interval is tens of seconds of **real** time and it reads the clock itself, so no test can drive
the poll loop as far as a second dispatch. Its own unit tests use an injected clock and are
therefore blind to whether anything ever calls it, which is precisely the failure the wiring
test in `server.test.js` exists to catch.

Each of the three mechanisms was verified by removing it and watching the suite go red:

| Removed | Fails |
| --- | --- |
| `!resumed` from the gate | `a crewmate that resumes is asked about again on the floor, not on the ceiling` |
| the `#failures` guard in `#crewResumed` | `a resume cannot dispatch while a run of failures is standing` |
| the third argument at the call site | `the poll hands the fleet snapshot what its crewmates transcripts look like` |

**The branch name is firstmate's rather than this repository's.** `npm run tasks:gate` reads the
key from the start of the branch name or of a path element of it, so
`fm/raise-28-ruling-clears-on-resume` reads as untracked and the gate passes without checking
this file. That is a false pass rather than a false failure; the pull request carries
`Closes #28`, which is what actually links the work. A crewmate branch that wants the gate's
check needs the number to start a path element - `fm/28-ruling-clears-on-resume`.
