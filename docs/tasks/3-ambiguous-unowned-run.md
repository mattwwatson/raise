---
issue: 3
status: backlog
size: S
depends: -
---
# 3 - Two sessions on one branch both claim the same pipeline

**Self-contained brief.** No prior conversation needed. Written 06/08/2026.

Recorded during the review of **PR #13** (`fix/own-path-run-branch-match`, "make a session the
unit and no-mistakes an attribute of one"), which fixed the neighbouring case and deliberately
left this one. Read that PR's `AGENTS.md` changes first - the vocabulary below comes from them.

---

## The symptom

Two Claude sessions open on the same checkout, on the same branch. One of them started a
no-mistakes run; the other is doing something unrelated. Nobody was observed starting it.

**Both cards show the pipeline** - the same step, the same parked gate, the same `Focus ↗`.
One of those two buttons goes to a window that cannot answer the gate, and nothing on the page
says which.

This is the last surviving instance of a failure the rest of PR #13 removed. That branch
narrowed run matching by branch, which fixed the case where an *idle `main` card* claimed
somebody else's live pipeline. Two sessions genuinely on the same branch in the same repository
cannot be separated that way - there is no field left that differs.

---

## What is already established

1. **Ownership is the real answer, and it is observed, not derived.** `src/poll-watch.js`
   walks a live `no-mistakes axi run` up to the session that launched it. When that sighting
   exists, `RunOwners` remembers it and the run appears on exactly one card. This case is only
   ever reached when the sighting never happened.

2. **There are three ordinary ways for it not to have happened**, all documented in `AGENTS.md`:
   - `axi run` **returns at every approval gate** and does not run again until the agent answers,
     so a parked run has no process to walk up from - and parked is exactly when the dashboard
     matters most
   - the monitor was restarted after the run began, so it never saw the process
   - `raise status` is one-shot and has **no `RunOwners` memory at all**, so it is *always* in
     this state

3. **Showing it on every matching session is the current, deliberate degradation.** The rule in
   `AGENTS.md` is that ownership narrows and never widens: a run nobody was seen to own stays on
   every session it could belong to.

4. **The alternative was considered during PR #13 and rejected.** Sending every unowned run to
   the unattributable card would strip the pipeline off the *ordinary single-session card*
   whenever ownership is unknown - which, per point 2, is routine. That is a worse trade: it
   would make the common case worse to fix the rare one.

---

## The proposal worth trying first

The rejection in point 4 assumed an all-or-nothing choice. There is a middle that was not
considered at the time, and it is cheap:

> **Count the sessions the run could belong to. If exactly one, show it there. If more than
> one, show none of them and let the unattributable card carry it.**

That keeps the common case exactly as it is today - one session on a branch, unowned run, card
shows the pipeline, nothing lost - while the genuinely ambiguous case stops making a claim it
cannot support. The unattributable card already exists, already sorts last, already says
*"Not traceable to a session - probably one of your N on this repo"*, and already counts
candidate sessions. This is arguably what that count was for.

**Before building it, confirm the count is the right one.** The card's existing count is of
sessions sharing the *logical repository* (worktrees resolved to their main checkout). The
count needed here is narrower: sessions that would actually match this run, which is repository
**and branch**. Those are different numbers and using the wrong one would either hide a run
unnecessarily or fail to hide it.

---

## What this must not change

- **A session that owns a run keeps it.** Ownership, when observed, still wins outright. This
  only concerns runs with no owner.
- **The single-session case must keep its pipeline.** This is the whole reason the simpler fix
  was rejected. If the change cannot preserve it, it should not ship - say so and stop.
- **Do not reach for tty.** It was raised and dismissed: no-mistakes records nothing about the
  terminal a run was started from, so there is nothing to match against. Process ancestry is
  the discriminator and it already exists; this item is about what to do when it is absent.
- **Do not weaken the branch requirement** added in PR #13.

---

## Reproduce as a test first

Per `AGENTS.md` and Matt's standing preference. `dashboard.js` is pure; see the `run()` /
`session()` factories and the `build()` helper at the top of `test/dashboard.test.js`, and the
existing tests around unowned runs and the unattributable card for the shape.

The two cases that define the change:

- two sessions, one repository, one branch, unowned run - neither card shows it, and it appears
  once as unattributable
- **one** session, same setup - the card still shows it, and no unattributable row is emitted

The second is the regression guard and matters more than the first.

---

## Worth knowing before deciding it is worth doing

This may be a **wont-do**, and that is a legitimate outcome. The ambiguity is real but narrow:
it needs two sessions on one branch in one checkout *and* no observed ownership. Weigh it
against the fact that the unattributable card is itself a compromise - it tells you a pipeline
exists and cannot tell you whose it is, which for a single-session repository is strictly less
useful than the slightly-wrong answer it replaces.

If it is not worth building, set `status: wont-do` and record why here. That is more valuable
than leaving it open, because the next person to notice two identical cards will otherwise
rediscover the whole argument.

---

## Constraints (from AGENTS.md, non-negotiable)

- **Pure modules stay pure.** `dashboard.js` and `run-owner.js` take what they need as
  parameters; they do not read the filesystem or shell out.
- **Ownership narrows and never widens.** Any change here must keep that direction.
- Zero runtime dependencies.
- `npm test`, `npm run typecheck` and `npm run lint` all pass.

---

## Definition of done

```sh
npm test
npm run typecheck
npm run lint
```

Report which count was used - repository, or repository and branch - and confirm the
single-session case still shows its pipeline.
