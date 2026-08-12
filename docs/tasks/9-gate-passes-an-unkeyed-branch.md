---
issue: 9
status: shipped
shipped: 2026-08-12
size: S
depends: 7
branch: 9-gate-passes-an-unkeyed-branch
---
# 9 - A one-line doc fix needs an issue, a spec and a pipeline run

`tasks:gate` runs inside the `Lint, tests and typecheck (Node 24)` job, which is a required
check on `main`. So a branch whose name carried no issue number failed a required check and
could not merge - and correcting one stale sentence in a spec cost an issue, a spec file of its
own, a branch named after it and a full pipeline run.

Ceremony larger than the change has one predictable outcome: the small true corrections stop
being made. That is a worse failure than the one the gate was guarding, and it is the failure
this codebase cares about most, since a document nobody dares correct is a document that goes
quietly stale.

## The gate was answering a question it had not been asked

It asserts exactly one thing: **the pull request that ships a tracked item must set
`status: shipped` in that item's spec**, or `main` lands with a closed issue and a file claiming
the work never started.

That is a statement about *items*. A branch naming no item **anywhere** is not shipping one, so
there is nothing to assert and nothing being protected. That case is the new `untracked`
outcome, and it passes. A branch shipping no tracked item therefore needs neither an issue nor
a spec, and AGENTS.md and the `roadmap-workflow` skill say so - both stated "no branch without a
spec file" as an absolute, which this makes false as written.

**Nothing about a keyed branch changes.** Its spec must exist and must say `shipped`, exactly as
before - `wont-do` included, since an item abandoned on a branch being merged is still a
contradiction. There is a test asserting precisely that, because the whole risk of this change
is that it reads as "the gate got softer" and gets loosened further by someone who believes it.

## The trade, which is accepted rather than overlooked

`wip-23-tooling` passes. So does `fix/whatever` on a branch genuinely shipping issue 23. **That
is a known gap and it is not closed**, and since the obvious objection is that the key is right
there in the name, the reasons it is acceptable are worth stating rather than assuming:

- **The gate's job is catching a shipped item whose spec still says `in-progress`**, and that
  needs a correctly named branch anyway. A branch it cannot read is one it was never going to
  answer for.
- **A misnamed branch still gets reviewed.** With `no-mistakes` mandated for contributions
  ([#7](https://github.com/mattwwatson/raise/issues/7)), nothing reaches `main` without a
  pipeline run and a pull request, so this is not the only thing looking.
- **It never asserted otherwise.** The gate has never been able to tell a deliberate evasion
  from an untracked change.

## Two mechanisms were built to close that gap and both were removed

This is the part worth not repeating. Both attempts were wrong, in opposite directions.

**The first matched the *shape* of a key** - the same alternatives as `BRANCH_KEY_PATTERN` with
the anchors relaxed. It could not be made to cover the separators without covering ordinary
names too: `23_stale_page_code`, `23/stale-page-code`, `RAI-14_tooling` and `RAI-14x` escaped it
while `release-2026-08-12`, `bump-node-24` and `fix/readme-node-22` tripped it. Those are the
same shape - a number at a token boundary - so no arrangement of separators separates them.

**The second asked the spec set** whether the number named a real item, `gateBranch` already
holding `byTicket`. Precise about the set and wrong about everything else:

- It failed `release/v1.2.3`, `fix/oauth2-callback`, `fix/http-2-notes` and `3d-render` on the
  bare items this repo already has, each told it "names" an issue nobody had written.
- **The surface grows.** Every issue filed turns another class of ordinary name into a failure -
  `bump-node-24` is fine only until issue 24 exists. A rule that decays as the project succeeds
  is not a rule.
- **A legacy key collides with the bare issue sharing its number.** `wip-RAI-7-x` was reported as
  issue 7, and `7-require-no-mistakes.md` is `shipped` - so following the gate's own rename advice
  would have turned it **green while RAI-7's spec still said `in-progress`**. The one thing this
  gate exists to prevent, reached through its own guidance. RAI-1/1 through RAI-4/4 and RAI-7/7
  collide today and more arrive as issue numbers climb.

The conclusion both reach is the same: **a misnamed branch is not something this can reliably
tell from an ordinary one.** So the gate gives two answers, not three, and `test/task-gate.test.js`
asserts the gap as a decision - including the RAI-3/3 collision, so a third attempt fails there
rather than in CI.

## Two things this deliberately does not do

- **It does not pass silently.** A quiet exit 0 would be indistinguishable from passing because
  a spec said shipped, and which of the two it was is the part worth reading. The untracked pass
  names the branch and restates the convention, on stdout with the other pass rather than on
  stderr with the failures.
- **It does not touch branch protection.** The obvious-looking alternative - let direct pushes
  to `main` through for `docs/tasks/` only - is not expressible on GitHub: protection applies to
  a branch, not to paths, and a ruleset's bypass list is by actor. The cost being objected to was
  the ceremony rather than the pull request, and the ceremony is the part that could actually be
  removed. `enforce_admins` stays on, so `CONTRIBUTING.md`'s claim that the rule binds the
  maintainer too stays true.

## The dead branch goes, and one surviving message was wrong

`no-key`'s failure text - four lines about branch naming and what GitHub does and does not
enforce - is unreachable once nothing produces that outcome, and AGENTS.md forbids dead code. An
unreachable failure message is the kind that gets read as live documentation of behaviour that
no longer exists.

The `no-spec` failure needed a correction of its own. It said *"Every item needs one, and no
branch may exist without it"* - the same absolute this change makes false, in the one copy of
the rule a contributor actually reads, at the moment they read it. It now says every **tracked**
item needs one.

## Acceptance

- A branch with no anchored key exits 0 and says why, on stdout - whatever digits it carries.
- A keyed branch whose spec is missing or not `shipped` still fails, and a legacy key never
  resolves to the bare issue sharing its number.
- `npm run lint`, `npm test`, `npm run typecheck` green.

## Implementation notes

Shipped 12/08/2026.

**One existing test was asserting the behaviour being removed, and it needed reading rather than
deleting.** `the pass line goes to stdout and every failure to stderr` used `tidy-up` as its
example of a failure - which is now the untracked *pass*. The test's intent was sound, so its
failing case became a keyed branch with no spec (`99-mystery`); deleting it would have dropped a
real assertion about where output goes.

**Two documents stated the old absolute and are corrected here.** AGENTS.md and the
`roadmap-workflow` skill both said "no branch without a spec file", the skill calling it the
hard rule that keeps this from drifting. Both now qualify it to tracked work and both say what
the gate can and cannot check - they are read as authoritative by future sessions, so leaving
them would have meant a session fixing a typo still believing it owed an issue and a spec, which
is the exact friction this removes.

**This was the first change pushed through `no-mistakes` to a GitHub remote**, and so doubles as
the trial that [#7](https://github.com/mattwwatson/raise/issues/7) left open - whether the
pipeline can open a pull request on GitHub at all, every previous run here having gone to
Bitbucket.
