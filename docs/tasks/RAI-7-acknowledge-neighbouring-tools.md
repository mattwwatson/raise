---
ticket: RAI-7
status: shipped
shipped: 2026-08-12
size: S
depends: RAI-6
branch: RAI-6-readme-for-a-stranger
---
# RAI-7 - Acknowledge the neighbouring tools

One README section. The draft shape and the three rules it has to follow are **Phase 3.3** of
[`RAI-1-open-source-release.md`](RAI-1-open-source-release.md); this file records what checking
the neighbours actually turned up, which is not what that draft assumed.

## It shares RAI-6's branch, deliberately, and that has two costs

Both items rewrite `README.md`, and this section slots into the structure RAI-6 builds - written
against the old layout it would simply conflict. Matt asked for them together on
`RAI-6-readme-for-a-stranger`. The roadmap rule prefers one branch per item, so the two things
that stop working are recorded here rather than discovered later:

- **Jira's automation keys off the branch name**, so nothing transitions RAI-7. It was moved to
  In Progress by hand and must be moved to Done by hand.
- **`npm run tasks:gate` checks the branch's own key only**, so nothing enforces this file
  saying `shipped`. Both keys go in the PR title so both link.

## The rule that did the work

> Do not claim a neighbour lacks something without checking it that week.

This is not ceremony, and it paid for itself on the first check. The private competitive read of
**04/08/2026** recorded that no attention mechanism could be found in Switchboard at all - which,
under the original draft, would have become a public claim. Its README on **12/08/2026** lists
*"Status Notifications - In-app alerts when a session is waiting for permission approval or user
input"*.

Eight days. A confident wrong statement about someone else's project is the same failure mode as
a confident wrong row, and this one would have been published under a pitch of not asserting what
we cannot stand behind.

**Every claim in the section is therefore a positive one, sourced from the neighbour's own
current README or documentation, and the section says when it was checked.** That date is not
decoration - it is the same move the product makes with *"was open, last checked 3d ago"*, and it
is the only honest way to publish a statement about software that changes weekly.

## What the check found: Anthropic ships this too

**`claude agents`** - Agent View - is in Claude Code itself, a research preview, verified against
**2.1.228** on 12/08/2026. Its own description is *"one screen for all your background sessions:
what's running, what needs your input, and what's done"*, with a **Needs input** group that
explicitly covers permission decisions.

That is a version of this product's whole sentence, shipped first-party, and neither the epic nor
this ticket had accounted for it. It goes in the section, first, on Matt's call. Omitting the
first-party answer while listing two third-party ones is the exact evasion the ticket exists to
avoid, and it is the first thing any reader will raise.

Two differences, both read out of the documentation rather than assumed, and **neither stated in
the README as something Agent View lacks**:

- *"Interactive sessions you have open in other terminals don't appear until you background
  them."* Those sessions are this product's entire population.
- *"Press `Enter` or `→` on a selected row to attach. Agent view is replaced by the full
  interactive session."* It takes over the terminal it runs in; it does not raise the window a
  session is already living in. Claude Code only - no Codex, no pi, no Desktop.

The section says what Raise is for and lets the reader draw that conclusion, which is both within
the rules and more convincing than making the comparison ourselves.

### Second-order finding, deliberately not acted on here

`claude agents --json` prints **interactive** sessions as well as background ones, with
`waiting` / `busy` / `idle` statuses and a cwd - a first-party session inventory that needs no
hooks and no transcript scan. Run on this machine on 12/08/2026 it returned 7 sessions across
four checkouts, correctly marking one in this repo as `waiting`.

That is potentially interesting to `src/registry.js` and to RAI-4's untracked scan - it would see
sessions that predate the hooks, which is the problem RAI-4 exists for, and report a state those
deliberately quiet rows cannot honestly claim.

**Recorded as a note, and deliberately not raised as a ticket** - Matt's call on 12/08/2026, to
wait for more evidence rather than open work on a research preview. Four things anyone revisiting
it has to answer first, none of which the finding itself settles:

- it is **Claude Code only**, so it can only ever be a fourth source beside the hooks, never a
  replacement for them
- `--json` on a **research preview** is not a stable contract, which is the same objection that
  put `nm-state.js` on no-mistakes' SQLite file rather than its daemon socket
- it is a **subprocess**, so it cannot go near the one-second poll loop, and spawning per tick for
  a binary that may be absent is what the `absent` mode exists to prevent
- it carries **no window identity**, so it cannot make a row focusable - which is the thing that
  makes an untracked row untracked

## The copy, and what each claim rests on

| Named | Credited with | Source, checked 12/08/2026 |
| --- | --- | --- |
| `claude agents` | one screen for background sessions; dispatches as well as watches; nothing to install | [Agent View docs](https://code.claude.com/docs/en/agent-view), and `claude agents --help` on 2.1.228 |
| Switchboard | full-text search across every past session; runs on Linux and Windows too | its README - *"Find any session by what was discussed, not just when it happened"*; `.dmg`, `.exe`, `.AppImage`, `.deb` installers |
| signalbox | five agents including pi; an iOS app; a remote hub joining several machines onto one board | its README - *"Cursor, Claude Code, Codex, OpenCode, pi and more"*, TestFlight, *"forward events from multiple machines to one board"* |

Both third-party repositories were confirmed unarchived and recently pushed (Switchboard
04/08/2026, signalbox 10/08/2026).

**signalbox describes itself as early-stage and experimental. That is not repeated**, because
quoting someone's own hedge back at them in your README is a deficiency claim wearing a citation.

## Deliberately not done

- **No table, no "unlike", no feature-gap claim**, per the ticket. The section is four short
  paragraphs and ends on one sentence about this tool.
- **Nothing from the private competitive read is used**, and nothing in it may be - it is a dated
  teardown of two named projects, it breaks the rules this section is held to, and the whole
  reason it is untracked is that it must never enter git history. The public section is built
  only from what the neighbours currently say about themselves.
- **No claim to be better at anything.** Where this tool differs, the section says what it does,
  not what they do not.

## Acceptance

- Every neighbour is named, linked, and credited with something real.
- No sentence in the section asserts an absence in anyone else's tool.
- The check date is on the page.
- `npm run tasks:links` passes; `npm test`, `npm run lint` and `npm run typecheck` are untouched,
  this being documentation only.

## Implementation notes

Four short paragraphs and a date line, after Troubleshooting and before Development. The writing
took minutes; the checking is what this ticket actually was, and it changed the output twice.

**The section names three tools where the ticket assumed two.** `claude agents` was not in the
epic, this ticket or anybody's plan - it surfaced from a single search run to confirm no obvious
neighbour was being omitted, which is the check that nearly did not happen because two neighbours
were already named and the section looked complete. A related-tools section that omits the
first-party answer is the evasion the ticket exists to prevent, and it would have been the first
comment on any launch post.

**Verified rather than read about**, because a search snippet is not evidence. `claude agents
--json` was run against the installed 2.1.228 and returned seven sessions across four checkouts,
correctly marking one in this repository as `waiting`. The two differences the section leans on -
that the list is background sessions until you background an interactive one, and that attaching
replaces agent view rather than raising an external window - are quoted from the documentation,
and neither is stated in the README as something Agent View lacks.

**The Switchboard correction is the whole argument for the rule**, and it is recorded above
rather than here because it is the reasoning, not the outcome: eight days between a private note
saying no attention mechanism could be found and a README advertising exactly that. Nothing from
that private read reached the page.

**The date line was not asked for and is the one addition beyond the ticket.** It exists because
this section is a claim about software that changes weekly, and the product's own answer to that
problem is `observedAt` and *"was open, last checked 3d ago"*. A README that states when it
checked is the same idea applied to itself. It also gives the next person a reason to re-check
rather than assuming the words are current.

**Placement** is the conventional tail slot, chosen over putting it early: a reader who wants an
archive is sent on their way either way, and the tail is where people look for it.
