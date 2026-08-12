---
ticket: RAI-6
status: shipped
shipped: 2026-08-12
size: M
depends: RAI-2, RAI-3
branch: RAI-6-readme-RAI-7-tools-RAI-8-contribution
---
# RAI-6 - Rewrite the README for someone who has never seen this

The detailed brief for this item is **Phase 3.1** of
[`RAI-1-open-source-release.md`](RAI-1-open-source-release.md), written before the rename and
before RAI-2. Two of its six points have since been answered by RAI-2 and are not re-done here;
what follows records which, and what the other four actually turned out to need.

**This is a restructure, not a rewrite.** The README is the strongest asset in the repository
and its register - plain description of what the thing does and why it was built that way - is
what makes it worth showing anyone. Nothing below changes a sentence because a different
sentence would sell better.

## The problem, in the reader's terms

A stranger arrives, reads down, and hits things in the wrong order:

- they learn it is macOS-only for focusing **188 lines in**, after deciding they want it
- they are asked to let it merge hooks into `~/.claude/settings.json` and read their
  transcripts at line 215, and told how that is contained at line **473 of 632**
- every example is one person's machine - `hexbattle`, `moroku-skills`, `money-webapp`,
  `firstmate`, `HXB-56-residue-never-drains`, `Open Source Planning`
- the pi and Codex caveats are real and honest and live in two separate prose sections, so
  there is nowhere to answer *what do I get for the agent I actually use*

And one plain bug the rename left behind: **the install block clones
`no-mistakes-monitor.git`**, a repository that no longer exists under that name. Following the
README today fails at its first command.

## Phase 3.1, item by item

| # | Phase 3.1 said | State on pickup |
| --- | --- | --- |
| 1 | Open with the generic sentence; first screenful is what it is, the demo, the constraint, the install | Opening sentence already right (RAI-2). Constraint and install are not in the first screenful |
| 2 | Requirements shrinks; optional signals get their own section | Table exists and is good (RAI-2), but is buried inside Requirements |
| 3 | macOS-only moves up | Not done |
| 4 | Security moves up; zero runtime dependencies stated there as a trust argument | Not done |
| 5 | Strip the personal specifics | Not done |
| 6 | Add an agent support matrix | Not done |

Items 1 and 2 are therefore mostly verification. **Do not re-do the framing work RAI-2 did** -
the opening sentence, the *"Optional, and independently so"* table and the absence-is-not-
degradation paragraph are all correct and are moved rather than rewritten.

## Decisions

### The demo is RAI-9's, and this leaves it a slot rather than a placeholder

Phase 3.1 item 1 asks for the GIF in the first screenful, but [RAI-9] owns recording it and
has not been picked up. A README that shows a broken image is worse than one that shows none,
so **the existing sample-output block stays where it is and does the demo's job until there is
a recording**. The slot RAI-9 fills is directly beneath the problem paragraph and above that
block - stated here rather than left as an HTML comment in a file strangers read.

### Security sits directly after Install

*Up* is not a position. It goes immediately after the install instructions, because that is the
sentence where a stranger is asked to let this merge hooks into their settings and read their
transcripts - and an objection is answered most convincingly at the point it is raised, not two
screens later. Ahead of Install was considered and rejected: leading with containment, before
the reader has decided they want the thing, reads as defensive.

**The forge *configuration* does not travel with it.** Security is the posture - the token, the
`Host` and `Origin` allowlists, what the hook may send, and the one outbound request - and it
belongs high. The `~/.raise/config.json` recipe for turning that request on is reference
material for the small number of people who want it, and putting a JSON block and a Bitbucket
token-scope walkthrough two screens into the README would undo the compression this item is
for. Security keeps one line pointing down at it.

### Zero runtime dependencies is a trust argument, so it is stated as one

It currently appears as a parenthetical in Requirements, next to the Node version, where it
reads as a packaging detail. In Security it is doing different work: **nothing here can be
compromised through a dependency, because there are none** - and for a tool that installs hooks
into your agent and runs `osascript`, that is the load-bearing half. It stays in Requirements
too; the fact is worth both readings.

### The `Upgrading from nmmon` section is deleted

Forty lines addressed to users of a name that was never published, on a machine where
`~/.nmmon` no longer exists. It was correct and careful when it was written, and its whole
audience has migrated. The reasoning survives in [`RAI-3-rename-to-raise.md`](RAI-3-rename-to-raise.md),
which is where anyone reconstructing the rename would look; the README is not an archive.
Confirmed with Matt on pickup.

### The install block is corrected, not modernised

`git clone …/raise.git`, `cd raise`. [RAI-5] is what makes `npm i -g raise-cli` true, and it has
not shipped - so writing it now would put a documented command that does not work into the
README of a tool whose entire pitch is not asserting things it cannot stand behind. It is one
line for RAI-5 to change. Confirmed with Matt on pickup.

### The support matrix says what each agent *can* report, and the absences carry their reason

Six rows of signal against three agents. Two of the cells are the point of the whole table, and
both are stated as the agent's design rather than as a gap here:

- **pi never says "waiting for you"**, because pi has no permission prompt - its tools simply
  run. Per Phase 0.5 this is a cleaner story than the one originally assumed, and it must not
  be papered over later by inferring a block from an idle turn.
- **A Codex row goes red and cannot say why**, because Codex has a real approval gate and no
  notification of any kind to carry a reason.

An overclaim in this table is the quiet-staleness failure this tool exists to prevent, turned
on its own documentation. Every cell is checked against `EVENT_STATES`, `PI_EVENT_STATES` and
`CODEX_EVENT_STATES` in `src/registry.js` rather than against the prose it replaces.

The table **replaces nothing**. The pi and Codex sections keep their prose, because the matrix
answers *what do I get* and they answer *how do I set it up and what will surprise me*.

### Neutral examples, chosen to still teach what they were teaching

The personal names come out, but several of the examples are load-bearing - the
`rows name themselves apart` block only makes its point if two paths genuinely collide, and the
expanded-panel sample only reads as real if the tools and their outcomes hang together. So they
are re-cast, not defanged: one plausible workspace (`payments`, `storefront`, `docs-site`), a
main checkout and a worktree of it, and branch names in both of the shapes people actually use.

## Deliberately not in scope

- **The related-tools section** - [RAI-7] owns it, and it has rules of its own that want
  checking the week it is written.
- **`CONTRIBUTING.md`, `SECURITY.md`** - [RAI-8].
- **Recording anything** - [RAI-9].
- **Marketing copy.** The tone that works is the one already there.
- **Anything under "Design decisions worth knowing" in `AGENTS.md`.** It is accurate, it is the
  most valuable content in the repository, and it is the section most at risk from a broad
  restructuring pass.

## Acceptance

- The first screenful says what it is, shows the sample, states macOS-for-focusing, and gives a
  command that works.
- `grep -nE 'hexbattle|moroku|money-webapp|HXB-|nmmon|no-mistakes-monitor' README.md` returns
  nothing.
- Every internal anchor in the README resolves after the reordering.
- `npm test`, `npm run lint`, `npm run typecheck` are untouched by this work - it is
  documentation only, so any movement in them means something has gone wrong.
- `npm run tasks:links` passes.

## Implementation notes

Landed as planned - a reorder, a support matrix and a name sweep, with the register untouched.
The README went from 632 lines to 633: forty lines of `nmmon` came out, the matrix and the
optional-signals split went in. Four things are worth recording because the plan did not predict
them.

**The install command was broken, not merely stale.** Anticipated as a rename leftover and found
to be worse: `git clone …/no-mistakes-monitor.git` names a repository that does not exist under
that name, so the very first command in the README failed for anybody who tried it. It is fixed
to `raise.git`. The wider point is that nothing in this repository's gates could have caught it -
`tasks:links` checks `docs/tasks` references and there is no check that a documented command
runs, which remains true.

**pi and Codex were miscategorised mid-restructure, by this work.** Moving the optional-signals
table out of Requirements pulled the `### pi sessions` and `### Codex sessions` subsections under
`## Optional signals` with it, which says they are integrations you can do without. They are
supported agents. Caught on a read-through rather than by any check, and fixed with a
`## Setting up Codex and pi` section of their own. Worth knowing that a heading move can change a
claim without touching a word.

**The opening lost a sentence and needed a replacement.** The old first paragraph ended *"If you
use `no-mistakes`, each session also shows what its pipeline is doing"*, which is exactly the
framing item 1 removes - but the sample block directly beneath it shows two `NO-MISTAKES` lines,
which were then unexplained on the first screenful. One line under the sample now says they are
an optional signal and that nothing else changes without it. Removing a framing sentence is not
free when the thing it framed is still on the page.

**Every claim in the matrix was checked against `src/registry.js`**, not against the prose it
replaced. `EVENT_STATES`, `PI_EVENT_STATES` and `CODEX_EVENT_STATES` are the authority for the
`blocked` rows, `CODEX_HOOK_EVENTS` for the count of five, and `HOOK_EVENTS` for the count of
six. This is the discipline the spec asked for and it is cheap; the alternative is a table that
inherits an error nobody re-reads.

**Not attempted, and still open:** the demo. [RAI-9] fills the slot directly beneath the problem
paragraph, above the sample block.

[RAI-5]: https://mattwwatson.atlassian.net/browse/RAI-5
[RAI-7]: https://mattwwatson.atlassian.net/browse/RAI-7
[RAI-8]: https://mattwwatson.atlassian.net/browse/RAI-8
[RAI-9]: https://mattwwatson.atlassian.net/browse/RAI-9
