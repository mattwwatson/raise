---
issue: 25
status: shipped
size: M
depends: -
branch: 25-firstmate-pending-decisions
shipped: 2026-08-19
---
# 25 - A firstmate ruling scrolls off the captain window and nobody notices

**Self-contained brief.** No prior conversation needed. Written 19/08/2026. Every measurement
below was taken off the live firstmate installation at `~/work/firstmate` on that date and is
reproducible with the commands quoted beside it.

---

## The problem

firstmate runs a crew of agents. When a crewmate reaches something only a human can settle - a
design choice, a review finding it will not overrule, a conflict between two instructions - it
stops and says so, and the captain surfaces that in its own window as a line asking for a ruling.

That line then scrolls. The captain keeps working on everything else, the ruling request moves
up and off the screen, and the crewmate sits stopped for as long as it takes the human to think
*hang on, what happened to that one?* and scroll back to find out.

This is precisely the sentence Raise exists for - **tell me which session is waiting for me, and
take me there** - and today Raise says nothing about it. A stopped crewmate looks like a quiet
card, which is to say it looks fine.

## What will visibly change

A crewmate with an open decision stops looking fine. Its row carries an attention state and the
decision's own summary, and the captain's row carries the count, because the captain window is
where the ruling is actually given.

## Non-goals

- **Answering a decision from Raise.** Raise reads other tools' state and does not write to it,
  and giving a local HTTP server a write path into firstmate's decisions is a change to the
  security posture rather than a feature. It is also not the problem: the problem is not
  noticing.
- **Reading firstmate's transcript.** See below - it is both forbidden here and unnecessary.
- **A firstmate integration in any broader sense.** No backlog view, no fleet dashboard, no
  second opinion about crew state. One attribute, on the rows that already exist.

---

## Why the obvious implementation is the wrong one

The obvious implementation is to tail the captain's transcript and match on the prose it prints
when it wants a ruling. That is forbidden by the invariant in AGENTS.md:

> **Indirect evidence may disprove, and may never assert.**

A prose match asserting a human gate is exactly the move the rule closes off, and the failure
mode is the expensive one: a phrase that happens to appear in ordinary conversation puts a red
card on a session that is working fine, and a wording change upstream silently removes a signal
you have learned to rely on.

It is also unnecessary, because firstmate declares the fact structurally and has done all along.

---

## The evidence

### The status log

Every crewmate has `$FM_HOME/state/<id>.status`, an append-only **event log** - one line per
wake-worthy transition, written by the crewmate about itself. Verbs are `working`,
`needs-decision`, `blocked`, `resolved`, `paused`, `done`, `failed`. Read live on 19/08/2026:

```
needs-decision: [key=eng-1776-followups] Blocker fix + 6-case regression test COMMITTED ...
resolved: [key=eng-1776-followups] Captain chose option C (clear To, member re-picks) ...
blocked: [key=eng-1776-swap-review] Everything on run 01M0CGJ0F0D7RK4W114CBZ4BT9 is now ...
needs-decision: [key=eng-1776-empty-from-conflict] Six findings now fixed and re-verified ...
```

**This is first-party declaration, not inference.** It has the same standing as the no-mistakes
database: the tool that owns the fact is the one stating it. That is what makes the feature
architecturally clean rather than an exception to be argued for.

### The fold, and why the last line is not the answer

`bin/fm-classify-lib.sh` carries `status_open_decisions`, described in its own comments as
*"the ONE authoritative statement of the status-fold contract"*. The reason it exists is the
reason a naive reader gets this wrong:

> a subsequent done/paused/working line silently masks a still-open needs-decision

So the whole stream must be folded - `needs-decision` and `blocked` **open** a keyed decision,
only `resolved` or a verified captain-held transfer **closes** one, and an unrelated later
terminal line closes nothing.

### The reconciled surface

`bin/fm-fleet-snapshot.sh --json` is a read-only command emitting schema `fm-fleet-snapshot.v1`.
Its header states the contract this item depends on:

> Human views must render this output instead of parsing state files again.

Per task it gives everything needed:

```json
{
  "id": "eng-1776-transfer-wrong-destination",
  "current_state": { "state": "parked", "source": "status-log", "detail": "...", "freshness": "fresh" },
  "hints": { "pending_decision": true, "blocked_event": false,
             "open_decisions": [ { "key": "...", "verb": "needs-decision", "summary": "..." } ] },
  "endpoint": { "target": "firstmate:fm-eng-1776-transfer-wrong-destination" },
  "paths": { "worktree": { "path": "/Users/mattw/.treehouse/money-webapp-09aa4f/1/money-webapp" } },
  "pr": { "url": "https://bitbucket.org/moroku/money-webapp/pull-requests/318" }
}
```

`hints.open_decisions` is the fold above, **already reconciled against live crew state**.

### The reconciliation is the load-bearing part, and it was observed working

On 19/08/2026 the two live tasks demonstrated both halves at once:

| Task | Status log | `open_decisions` |
| --- | --- | --- |
| `eng-1776-transfer-wrong-destination` | ends on `needs-decision` | one entry, `parked` [^fork] |
| `sls-115-weekend-rule-and-solver` | carries an unclosed `needs-decision` earlier in the file | **empty**, `working · run-step · validating` |

`sls-115` is the case that matters. Something a plain reader would call an open decision has
already been answered, and `fm-crew-state.sh` knows it because the run-step is live and
supersedes the log line. A Raise that read the file itself would have shown a ruling request
that no longer exists.

[^fork]: One entry is this checkout under-reporting - upstream's fold returns four. See
    [A task has several open decisions at once](#a-task-has-several-open-decisions-at-once-and-our-firstmate-fork-hides-that).

**That is quiet staleness inverted - a confident stale alarm** - and it is worse here than a
missing signal, because the whole product is the claim that a red row means something. This is
the single strongest argument for consuming the snapshot rather than re-implementing the fold.

### Finding `$FM_HOME`, without looking for firstmate

Already solved. `src/firstmate.js` identifies the captain as the session whose own `cwd` holds
`state/.lock` containing that session's agent pid - both halves required, because the first
alone matches anyone with firstmate's source checked out. **That session's `cwd` is
`$FM_HOME`.** Verified live: the lock held pid `33021`, a running `claude`.

So the path is never hardcoded, and the rule holds that a machine without firstmate has no lock,
no `fm-` window, no chip, no warning and no subprocess.

### Attributing a decision to a row

Two independent joins, both direct:

- `endpoint.target` is `firstmate:fm-<id>`, and Raise already keys crewmates on that pinned
  `fm-` window name in `src/firstmate.js`.
- `paths.worktree.path` is the crewmate's checkout, joinable against `Session.cwd`.

Where neither resolves, the existing invariant applies without amendment: **an attribute we
cannot place belongs to nobody.** The decision is not sprayed across candidate rows; it stays as
a count on the captain's row, which is the one row that is certainly correct.

---

## Cost, and the one real problem

Measured 19/08/2026, warm, on this machine:

```
$ time bash bin/fm-fleet-snapshot.sh --json > /tmp/fm.json
0.24s user 0.18s system 11% cpu 3.513 total
223232 bytes
```

**3.5s wall and 223KB is far outside the 1s poll**, and nothing reachable from the server may
block. Three mitigations, applied together:

1. **mtime-gate the run.** Re-run only when a `state/*.status` mtime moves. This is Raise's
   established pattern - `transcript-reader.js` caches on mtime, `git-branch.js` caches HEAD,
   `firstmate.js` caches the lock. Status files move on the order of minutes, so in a steady
   state the command does not run at all.
2. **Fire and never await**, exactly as `firstmate.js` and `lavish.js` do their lookups, so the
   poll loop cannot stall on bash. The card updates on the next tick.
3. **Floor the cadence** at a `REFRESH_MS` in the tens of seconds, stamped when the read goes
   out rather than when it returns, so a slow or failing snapshot is not retried every tick.

`load()` waits for the answer for one-shot CLI commands only, per the `LavishState.load` rule.

**If that is still too heavy, the fix belongs upstream, not here.** A `--decisions-only` mode
skipping the secondmate home walk is a small firstmate change and the right place for it. Do not
respond to the cost by re-implementing the fold in JavaScript: it is roughly forty pure lines,
but it duplicates somebody else's contract and, more importantly, drops the run-step
reconciliation that `sls-115` shows is the honest half.

---

## A task has several open decisions at once, and our firstmate fork hides that

This was nearly written up as an upstream bug. It is not one - it is our checkout being behind,
and the difference matters because it changes what gets built.

`fm-classify-lib.sh` documents the key token as sitting **before** the colon. Every crew line on
disk writes it **after**:

```
needs-decision: [key=eng-1776-followups] Blocker fix + 6-case regression test COMMITTED ...
```

In the copy at `~/work/firstmate` (`origin` = `mattwwatson/firstmate`, 115 commits behind
`upstream` = `kunchenguid/firstmate` as of 19/08/2026) `_fm_decision_key` reads only the text
before the colon, so it never matches and every decision folds onto the key `default`.

**Upstream fixed this, citing their issue #2109.** The current `fm-classify-lib.sh` accepts a
complete token at the head of the note as an equivalent position, precisely because *"that
misplaced-colon shape is common real worker output whose stated key must never silently collapse
into the shared `default` bucket"*. Both positions yield the same key; a token deeper inside the
note stays prose; a malformed slug is rejected rather than rewritten to `default`.

Run against the same status file, the two folds disagree about the size of the problem:

| Fold | Open decisions on `eng-1776` |
| --- | --- |
| our fork | 1 - `default`, the most recent line |
| `upstream/main` | **4** - `eng-1776-review-gate`, `eng-1776-finally-confirmed`, `eng-1776-paymentview-ticket` (all `needs-decision`) and `eng-1776-swap-review` (`blocked`) |

**So one decision per row is the wrong shape.** Four rulings pending on a single crewmate is the
ordinary case, not an edge one, and building for one and generalising later would mean the first
version quietly showed a quarter of what was waiting - the exact failure this item exists to fix,
reintroduced by the fix.

Two consequences, both settled here:

- **Raise renders a set, never a single decision**, and it never truncates silently. If the
  panel has to bound the list, it says how many it did not show.
- **Nothing is worked around and nothing is patched locally.** A local fix to
  `fm-classify-lib.sh` is a divergence from upstream we would then carry forever. Syncing the
  fork is the whole of the fix, it is somebody else's repository, and it is not a prerequisite:
  against an unsynced fork this feature is correct and merely under-reports, which is why it can
  be built now.

---

## Architecture

A new module, because `src/firstmate.js` owns *identification* and this owns *state*, and mixing
them would put a subprocess behind a function whose whole cost model is a cached pane lookup.

| Module | Holds |
| --- | --- |
| `src/firstmate-decisions.js` | the snapshot read, its mtime gate and cache, and the parse of `tasks[]` into our shape |

Rules it inherits and must not break:

- **`execAsync` is injected**, never imported, and defaulted at the edge in `server.js` and
  `cli.js`. `server.test.js`'s guard that no firstmate subprocess runs on a machine without one
  must be extended, not weakened.
- **Their shape and ours stay distinct.** `SnapshotTask` is firstmate's schema; `Decision` is
  what we speak. The typedefs live here, and the normalising boundary stays visible.
- **A reading we did not get is not evidence.** A failed or empty snapshot keeps the previous
  answer, the way `firstmate.js` keeps its pane table. Decisions are not cleared because bash
  exited non-zero.
- **`prune` on sessions going away**, guarded on a non-empty reading, per the poll's existing
  `release`/`prune` rule.

`dashboard.js` gains the join and two row fields:

- `Row.decisions` - the open decisions on a crewmate's own row, each with its key, verb and
  summary, in the order the fold returns them (most recently opened last). An empty array and
  the absence of the field mean the same thing and the renderers must treat them alike.
- `Row.decisionsPending` - a count of decisions, not of tasks, on the captain's row only.

## The attention level

`ATTENTION_ORDER` is `blocked > review > parked > failed > idle > working`.

**A firstmate decision ranks between `review` and `parked`, as its own level `decision`.**

- Not `blocked`: that is red and belongs to a gate on the session you are looking at. The UI
  rules are explicit that nothing may compete with it.
- Not folded into `review`: `review` means a live `lavish-axi poll` and is settled by a live
  process. Two different facts under one word is the second-opinion failure the source ranking
  exists to prevent.
- Above `parked`: firstmate's own `fm-crew-state.sh` maps `needs-decision` to `parked`, so this
  is the same category of thing - work stopped at a gate - but it is stopped on **you**, where a
  parked no-mistakes run may clear itself.

It takes the same colour family as `review`, which is what "a human gate wearing work clothes"
already means on this page. Re-read `ATTENTION_ORDER` and the `:root` blocks when building it,
and add the variable to **both** colour-scheme blocks or neither.

## Where the text goes

The card carries the session line and the pipeline line and may not carry a third stacked block
- *"if a card ever has room for only one of them, the answer is not to choose, it is that the
card is doing too much"*. A sub-card is that third block by another name.

So: the state word says a decision is open and how many, and the summaries go in the **expanded
panel**, which already exists as the place detail is pulled per session on a click. Four
summaries are four list items there and one word on the card. The captain's row gets the
count beside its state word, in the same position and for the same reason the `dismissed` marker
sits there - the count and the state are one sentence.

`raise status` prints the same words. The page and the CLI are one protocol, and a row explained
on one and bare on the other is the two disagreeing about the same session.

---

## Acceptance

- A crewmate with an open decision shows the `decision` attention state, sorts above `parked`,
  and lists every open decision's summary in its expanded panel.
- A crewmate with four open decisions says four, and shows four. Asserted against a fixture
  built from the `eng-1776` reading above, which is the case that makes this non-hypothetical.
- A crewmate whose decision has been superseded by a live run-step shows nothing - the
  `sls-115` case, asserted directly against a fixture built from the snapshot above.
- The captain's row carries the count and remains focusable.
- A decision joining to no live session appears once, on the captain's row, and is not attached
  to any candidate crewmate.
- A machine with no firstmate runs no snapshot subprocess, shows no chip and prints no warning.
  Asserted in `server.test.js` beside the existing `lavish-axi` and `no-mistakes` guards.
- A failing or empty snapshot leaves the previous reading in place.
- The poll loop never awaits the snapshot; `server.test.js`'s synchronous-exec guard still holds.
- `npm test`, `npm run lint` and `npm run typecheck` green.

---

## Implementation notes

Built 19/08/2026. Three pieces: one new module that reads firstmate's own answer, one join in
`dashboard.js`, and one attention level rendered by both renderers.

**`src/firstmate-decisions.js`** runs `bash $FM_HOME/bin/fm-fleet-snapshot.sh --json` and
reduces `tasks[]` to `{id, window, worktree, decisions[]}`. `$FM_HOME` is the captain session's
own `cwd`, so nothing is hardcoded and nothing goes looking; `FirstmateWatch` grew
`captainSession(sessions)` for it, because identification is that module's job and asking a
second module to re-derive it would be two answers to one question.

`parseSnapshot` returns `null` for a reading we did not get and `[]` for a reading of nothing,
and the caller treats them differently: `null` keeps the previous answer, `[]` replaces it. That
distinction matters in both directions - a failed command must not take every ruling off
the page at once, and a fleet that genuinely drained to nothing must not leave its last
decisions standing for ever. The schema id is checked exactly, and a schema we have not read
counts as `null`: `open_decisions` being *reconciled* is a property of this version, and a later
one could keep the field and move that work elsewhere.

**The cost gate is four rules, not the three the brief above prescribes.** The snapshot was
re-measured at **13.7s** on the day it was built, against the 3.5s recorded above - same machine,
same command, four times the cost - so the gating matters more than it looked. The three
prescribed rules are all there: re-run only when a `state/*.status` mtime moves, fire and never
await, and hold a minimum `REFRESH_MS` (30s) between reads, stamped when one goes out.

The fourth is `ASSERTION_MAX_AGE_MS`, and it exists because **the mtime gate cannot see the
reconciliation**. A decision clears when the crew resumes past it, and the crew resuming is a
live run-step or a busy pane - neither of which touches a status file. A gate on file mtimes
alone could therefore hold a ruling request that had already been answered, which is the
confident stale alarm this item's own evidence warns about. So a reading that is *asserting*
something is re-taken after five minutes even if nothing moved; a reading asserting nothing
never is, because opening a decision always writes a status line. Cheap where it does not
matter, honest where it does.

`FM_SNAPSHOT_SECONDMATES=0` was measured as an alternative to a `--decisions-only` mode, since
it is a supported bound the script validates and defaults itself. It saves 0.9s of 14.6s - the
secondmate home walk is not where the time goes - so it was not adopted, and no firstmate change
was made or asked for.

**`raise status` waits, and that is a visible cost.** `load()` blocks, per the `LavishState.load`
rule: a one-shot command has no later tick and printing before the answer arrives would mean
printing a wrong one. So on a machine running firstmate the command takes about as long as the
snapshot does, which the README now says out loud. The alternative - a CLI that quietly shows
less than the page - breaks the rule that the two are one protocol, which is a worse trade.

**`dashboard.js`** gained `matchDecisionTask` and three inputs (`decisions`, `windowNames`,
`captainSessionId`). Both joins in the brief are implemented, window name first: it is
firstmate's own published endpoint and an exact match, where the worktree is a path containment
test. Either join finding more than one task places nothing, and the decision stays with the
captain. `Row.decisions` carries what a row holds; `Row.decisionsPending` is the crew total and
is set on the captain's row alone.

**The captain gets `decision` attention when it is holding unplaceable rulings**, which the
brief did not spell out. One rule drives both rows - `decisions.length > 0` - and the reason is
the item's own premise: a ruling request whose crewmate window has gone would otherwise be a
number on a quiet card, which is the signal scrolling off the window again by another route. The
count itself never colours anything.

**`ATTENTION_ORDER` gained `decision` between `review` and `parked`**, and `summarise` gained a
count, so the tab title, the header pill and the desktop notification all treat a ruling as
something waiting on a person. Leaving those out would have meant a state that is only visible
once you are already looking at the page, on a page built to be glanced at.

**The colour is a distinct value in the same family as `review`** - `#9333ea` light, `#d8b4fe`
dark, against review's `#7839ee` and `#b692f6` - checked side by side in a browser in both
schemes. Same family because both are a human gate; not the same value because they are two
different facts and a reader who cannot tell them apart has one word doing the work of two.

**One real defect was found only by looking at the page**, and it is worth the sentence: the
panel's list item was first called `.decision`, which every attention level also is as
`.card.decision`, `.bar.decision`, `.state.decision` and `.pill.decision`. Equal specificity,
later in the sheet, so it silently won every property those four rules do not restate - the
header pill lost its padding and the decision card lost half its height, with nothing in the
markup or the tests to show for it. It is `.decision-item` now, and AGENTS.md carries the rule.

**Fixtures.** `test/fixtures/fm-fleet-snapshot.js` keeps the shape of a real reading from
`~/work/firstmate` and none of its content. The shape is what the tests are evidence for - one
task carrying four open decisions, three `needs-decision` and one `blocked` in the order the fold
returns them, and a second task whose decisions the reconciliation had already cleared - and that
is what was taken. The task ids, the decision keys and the four summaries are invented: the words
were written about somebody else's engagement and this repository is public. The file's own header
records that, and records the sweep that found them. The four decisions were reproduced by running
upstream's fold against the real status file rather than assumed. Nothing local was patched: this
checkout's `_fm_decision_key` still collapses a task's decisions onto `default`, which
under-reports and is correct as far as it goes.
