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

**A branch that names an item and has misplaced it is a different case, and it still fails as
`no-key`.** `wip-23-tooling`, `revertRAI-14` and `rai-14-roadmap-tooling` all carry a key
`BRANCH_KEY_PATTERN`'s anchors refuse, and the key being right there in the name is what rules
out the explanation the pass is for: you did not forget to track this, you misnamed the branch.
Collapsing the two would have waved through precisely the case this gate exists to catch.

## Which of the two it is comes from the spec set, not from the shape of the name

The first attempt at telling them apart was a second, looser regex - the same key shapes with
the anchors relaxed - and it does not work. *Looks like a key* and *is a key* are different
questions, and only the second one has an answer:

| | |
| --- | --- |
| must fail | `wip-23-tooling`, `23_stale_page_code`, `23/stale-page-code`, `RAI-14_tooling`, `RAI-14x` |
| must pass | `release-2026-08-12`, `bump-node-24`, `fix/readme-node-22` |

Those two rows are the same shape - a number at a token boundary - so no arrangement of
separators separates them. Each widening that admitted a real misnaming failed an ordinary
branch, and the wrong-separator case is the likeliest real typo of the lot: `23_stale_page_code`
is a correctly *positioned* key that the gate simply cannot read.

`gateBranch` is already holding `byTicket`, the set of items that exist, so `misplacedKey` asks
it. A branch names an item when it contains that item's key with the number intact - `RAI-14`
case-insensitively, since `rai-14-roadmap-tooling` is a misnaming rather than an unrelated
change, and a bare `23` bounded so it is not a slice of `2026`. Nothing is guessed and no
separator is enumerated. 2026, 24 and 22 name no item; 23 and RAI-14 do.

**The residue is real and is the honest version of the trade.** `feat/v2-rewrite` is an ordinary
branch until issue 2 exists - which on this repo it now does - at which point nothing in the name
says which of the two it meant and it is read as a misnaming. Same for `fix/typo-on-line-9` while
issue 9 exists. Each is a rename away from passing and the failure says so, where the
shape-matching version got that same case wrong for names carrying no key at all, and told the
reader to go looking for an issue number they had never written. `BRANCH_KEY_PATTERN` still
refuses to read `v2` as issue 2 outright: the branch is told to rename, never handed issue 2's
spec.

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

## The naming failure stays, and names the item

`no-key`'s failure text - four lines about branch naming and what GitHub does and does not
enforce - is still reached, by the branch that names an item in the wrong place. It gains two
things. It **names the item**, which the gate now knows and could not know while the answer came
from a shape: *branch "wip-23-tooling" names 23, but not where the convention puts it*, followed
by the rename to make. And it closes by saying that a branch naming no tracked item passes
instead, because the reader now has two outcomes to tell apart and the failure is where they
will be standing when they need to.

That is also what makes the line true of every branch that reaches it. The shape-matching
version asserted "carries an issue number" on `bump-node-24`, which carries nothing of the sort.

## Acceptance

- A branch naming no known item anywhere exits 0 and says why, on stdout.
- A branch naming a known item outside an anchored position fails as `no-key`, names the item,
  and gives the branch-naming guidance.
- A digit-bearing name matching no item passes.
- A keyed branch whose spec is missing or not `shipped` still fails.
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
