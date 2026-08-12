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

That is a statement about *items*. A branch carrying no issue number **anywhere** is not
shipping one, so there is nothing to assert and nothing being protected. That case is the new
`untracked` outcome, and it passes.

**A branch that has a key and has misplaced it is a different case, and it still fails as
`no-key`.** `wip-23-tooling`, `revertRAI-14` and `rai-14-roadmap-tooling` all carry a key-shaped
token that `BRANCH_KEY_PATTERN`'s anchors refuse, and the key being right there in the name is
what rules out the explanation the pass is for: you did not forget to track this, you misnamed
the branch. Collapsing the two would have waved through precisely the case this gate exists to
catch, so `MISPLACED_KEY_PATTERN` tells them apart - the same two key shapes, unanchored, with
a bare number still needing a hyphen in front of it so the `2` in `feat/v2-rewrite` stays a
character inside a word rather than becoming a misplaced issue 2.

**Nothing about a keyed branch changes.** Its spec must exist and must say `shipped`, exactly as
before - `wont-do` included, since an item abandoned on a branch being merged is still a
contradiction. There is a test asserting precisely that, because the whole risk of this change
is that it reads as "the gate got softer" and gets loosened further by someone who believes it.

## The trade, which is accepted rather than overlooked

Somebody could name a branch `fix/whatever` while genuinely shipping a tracked item, and slip
past. That was always true in substance: the gate has never been able to tell a deliberate
evasion from an untracked change, and it never asserted otherwise. What it protects against is
**forgetting**, and forgetting leaves the key in the branch name - which is exactly the case
that still fails.

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

## The naming failure stays, and says one more thing

`no-key`'s failure text - four lines about branch naming and what GitHub does and does not
enforce - is still reached, by the branch that has a key in the wrong place. It gains a closing
line saying that a branch with no issue number anywhere passes instead, because the reader now
has two outcomes to tell apart and the failure is where they will be standing when they need to.

## Acceptance

- A branch with no key-shaped token anywhere exits 0 and says why, on stdout.
- A branch carrying a key outside an anchored position still fails as `no-key`, with the
  branch-naming guidance.
- A keyed branch whose spec is missing or not `shipped` still fails.
- `npm run lint`, `npm test`, `npm run typecheck` green.

## Implementation notes

Shipped 12/08/2026.

**One existing test was asserting the behaviour being removed, and it needed reading rather than
deleting.** `the pass line goes to stdout and every failure to stderr` used `tidy-up` as its
example of a failure - which is now the untracked *pass*. The test's intent was sound, so its
failing case became a keyed branch with no spec (`99-mystery`); deleting it would have dropped a
real assertion about where output goes.

**One branch shape cannot be told from a misplaced key and fails.** `release-2026-08-12` is
`-2026-` in a name, which is `wip-23-tooling`'s shape exactly; nothing in the string separates
them. It fails, which is what it did before any of this, and the failure names the convention to
follow. The alternative - dropping the hyphen requirement in front of a bare number - would fail
every branch whose name contains a digit at all, and is the far larger error.

**This was the first change pushed through `no-mistakes` to a GitHub remote**, and so doubles as
the trial that [#7](https://github.com/mattwwatson/raise/issues/7) left open - whether the
pipeline can open a pull request on GitHub at all, every previous run here having gone to
Bitbucket.
