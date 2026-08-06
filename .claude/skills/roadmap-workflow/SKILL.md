---
name: roadmap-workflow
description: How work items flow between Jira and this repo - capturing a task, picking one up, branching, committing, and marking it done. Load this BEFORE creating any RAI Jira ticket or writing, renaming or restatusing anything under docs/tasks/. Triggers - the user describes bugs, symptoms or ideas to be turned into tickets; "create a ticket", "raise these as bugs", "file these", "write the spec on disk", "add it to the backlog"; picking up or branching on a key like RAI-12; asking what to work on next, or about the roadmap, backlog, epics, or where a spec file goes.
---

# Roadmap workflow

**Jira owns ordering and state. The repo owns the specification.** Each work item is a
Jira ticket plus one spec file in `docs/tasks/` named for it. Neither half repeats the
other: the ticket says *what and why*, the file says *how*.

Project **RAI** - https://mattwwatson.atlassian.net/jira/software/c/projects/RAI/boards/6

| | Jira | `docs/tasks/<KEY>-<name>.md` |
|---|---|---|
| Holds | outline, priority, backlog rank, epic, explicit blockers, workflow state, commits and PRs | problem, decisions, architecture, `depends:`, implementation detail, acceptance |
| Audience | anyone glancing at the board | whoever builds it, and every future agent session |
| Written | once, when the shape is settled | first, and kept current as it is built |

There is no roadmap file - the board is the roadmap. Large bodies of work are Jira
**Epics**; a standalone bug or task needs no parent.

## Capturing a new task

**Write the file first. Create the ticket last.** In this order, so each artefact is
written once:

1. **Capture into a file.** Take the request, ask what is genuinely unclear, and write it
   up in `docs/tasks/` under a provisional name (`draft-<short-name>.md`). Iterate there
   while the shape is still moving - a file is cheap to rewrite, a Jira ticket is not.
2. **Once it is clear, create the Jira ticket.** The outline only: the problem in the
   reader's terms, what will visibly change, and the notable non-goal. No file paths, no
   function names, no data structures - those live in the spec.
3. **Rename the file to the key** (`RAI-15-<short-name>.md`), add its frontmatter, and
   attach a web link on the ticket pointing at the file:

   ```
   https://bitbucket.org/mattw_watson/no-mistakes-monitor/src/main/docs/tasks/RAI-15-<short-name>.md
   ```

   Link title `Spec: docs/tasks/<file>`. The URL 404s until the PR merges - that is fine
   and expected. **The repository is being renamed under [RAI-3]; this URL changes with
   it.**

The reason for the order is that a file is cheap to rewrite and a Jira ticket is not. While
the shape is still moving, moving it on disk costs nothing.

### The exception: importing a backlog whose shape is already settled

Sometimes the thinking has already happened somewhere else - a long planning conversation, a
document that has been through several rounds - and there is nothing left to iterate on. Then
creating the tickets first is honest rather than lazy, and pretending otherwise just means
writing files nobody needed.

When that applies:

- **Create the tickets, then write the specs before any branch is cut.**
- **A shared reference spec may stand in for several children.** An epic's spec carries the
  background for every item under it, and each child gets its own when it is picked up. That
  is what `RAI-1-open-source-release.md` is - it holds the reasoning behind RAI-2 through
  RAI-9, none of which need their own file until someone starts one.

**The hard rule that keeps this from drifting: no branch without a spec file.** That is the
point at which the *how* must exist, it is trivially checkable, and it stops "the spec comes
later" quietly becoming "there is no spec". If you are about to branch and the file is not
there, write it first.

Outside that exception, never open a new task by creating the ticket - the ticket is the
*last* step of capture.

## Frontmatter

Every spec file starts with it. It is the only status on disk.

```markdown
---
ticket: RAI-12
status: backlog          # backlog | in-progress | shipped | wont-do
size: M                  # S (< half a day) | M (a day-ish) | L (multi-day)
depends: RAI-10          # keys, or "-"
---
# RAI-12 - A pinned dashboard never picks up UI changes
```

In-progress and shipped items add `branch:`; shipped items add `shipped: YYYY-MM-DD`.

An **Epic** gets a spec like anything else, but has no branch of its own - its status follows
its children. A file with **no frontmatter at all** is not a work item and is skipped by the
board; there are none right now, and anything genuinely reference-shaped is better off as an
epic's spec than as a loose document.

## Working on an item

1. **Move the ticket to In Progress by hand when you pick it up.** The automation below is
   anchored on the branch, so nothing transitions until a branch is pushed - and the gap
   between starting to think about an item and pushing anything can be hours. Transitioning
   on pickup is what stops the board lying about what is being worked on.
2. **Branch off `main` as `<KEY>-<short-name>`** - e.g. `RAI-12-stale-page-code`. The key
   must be at the **start** of the branch name: the automation is anchored there, so
   `fix/RAI-12-foo` transitions nothing.
3. **Set `status: in-progress` and `branch:`** in the spec file.
4. **Flesh the spec out before writing code** - problem, decisions with their reasoning,
   what is deliberately *not* being built. Record decisions as they are taken; a decision
   that lives only in the diff is one a future session will undo.
5. **Start every commit message you write by hand with the key**: `RAI-12: state the build
   the page loaded with`. That is what links the commit to the ticket. The no-mistakes
   pipeline generates its own subjects (`no-mistakes(review): …`) which will not carry the
   key - that is fine, because the branch name drives both the linking and the transitions.
6. **Put the key in the PR title.**
7. **In the PR, set the spec's `status: shipped` and `shipped: <date>`**, and add the
   `## Implementation notes` section. Merging sets Jira; only the PR can set the file.

Never write a commit hash into the spec - you cannot know the merge commit from inside it,
and Jira's development panel already holds every commit, branch and PR for the ticket.

### Prerequisite: the Jira automation is not set up yet

RAI is a new project. The branch-driven transitions described here - **To Do → In Progress**
on branch creation, **In Review** on opening a PR, **Done** on merge - mirror the rules in
the HXB project and **have to be created in RAI before they will fire**.

Until they are, transition tickets by hand at each step. Everything else in this workflow -
the branch naming, the key in commit subjects, the spec frontmatter - is unaffected and
should be followed exactly as written, because it is what the automation will key off once
it exists.

### Mentioning another item's key moves that item

Spec filenames contain their Jira key, so writing `docs/tasks/RAI-10-pr-state-freshness.md`
in a commit message or PR description **mentions RAI-10 to Jira**. Automation transitions
what it sees mentioned, so an unrelated backlog item can be dragged along by a commit that
merely referenced its file.

The guard is on the Jira side - the transition rules are conditioned on the **branch name**
(`^{{issue.key}}-`), not on the mention, so only the item whose branch it is can move. The
mention still *links* the commit, which is wanted.

- **Only your own ticket's key goes in the subject line.**
- **Naming another item's spec file in the body is fine** - it links, it must not
  transition. If an item unexpectedly changes status, check this first.

The *diff* is not parsed - renaming fifty spec files moves nothing. Only text in commit
messages, branch names and PR title/description is read.

## Tooling

**There is none yet, deliberately.** [RAI-14] covers porting hexbattle's board-from-disk,
Jira reconciliation, link check and CI gate - about 400 lines, no dependencies. It was
ticketed rather than built so the workflow could start immediately.

Until then the conventions are enforced by reading. The one that matters most and has no
guard: **the PR that ships an item must set `status: shipped` in its spec**, or `main`
lands with a ticket marked Done and a file claiming the work never started.

## What to work on next

Read the **[RAI backlog](https://mattwwatson.atlassian.net/jira/software/c/projects/RAI/boards/6)**,
top down. It is the priority order; the repo does not encode one and must not start.

Then read the spec before committing to it:

- **An explicit `is blocked by` link in Jira wins over everything.** Those are set
  deliberately, usually by Matt.
- **`depends:` in the spec file is the implementation view** - what must exist before this
  can be built, and therefore what can safely run in parallel. Advisory.
- **Ready is not the same as safe to run concurrently.** Two independent items can still
  want the same file. Read what each actually touches before running them in parallel.

Known interactions to watch, all independent in substance and conflicting in the file:

- **`src/dashboard.js`** is the busy one - **RAI-10** (pull request state freshness), **RAI-11**
  (a question reported as a permission prompt), **RAI-15** (a card renames itself) and
  **RAI-16** (two sessions claiming one pipeline) all change it. RAI-15 and RAI-16 sit closest
  together: both are about how a row is matched to a run, and RAI-15 moves the identity match
  out of that code entirely, so whichever lands second should re-read the other's spec rather
  than assume its own still describes the file.
- **RAI-17** (a pipeline agent that never registers) is the exception - it lives in
  `src/registry.js`, `src/server.js` and the hooks, so it can run alongside any of the above.

Add to this list as more are found.

## The rules that make this work

- **One item, one branch, one ticket, one file.** A tightly related batch may share a
  branch; prefer not to.
- **Nothing edits a shared ordered list.** Status changes touch only the item's own file,
  so two branches never conflict over the roadmap itself.
- **Jira issues the numbers**, so two branches can create work items at the same time
  without colliding. Never hand-mint an id.
- **A user-facing change ships its test in the same PR**, and updates `README.md` if it
  alters a documented flow.
- **Both gates pass before anything is done**: `npm test` and `npm run typecheck`, plus
  `npm run lint`. See AGENTS.md.

[RAI-3]: https://mattwwatson.atlassian.net/browse/RAI-3
[RAI-14]: https://mattwwatson.atlassian.net/browse/RAI-14
