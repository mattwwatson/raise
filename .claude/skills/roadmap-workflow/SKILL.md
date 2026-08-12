---
name: roadmap-workflow
description: How work items flow between GitHub issues and this repo - capturing a task, picking one up, branching, committing, and marking it done. Load this BEFORE creating any issue or writing, renaming or restatusing anything under docs/tasks/. Triggers - the user describes bugs, symptoms or ideas to be turned into issues; "create a ticket", "raise these as bugs", "file these", "write the spec on disk", "add it to the backlog"; picking up or branching on an issue number, or on a legacy key like RAI-12; asking what to work on next, or about the roadmap, backlog, epics, or where a spec file goes.
---

# Roadmap workflow

**GitHub issues own ordering and state. The repo owns the specification.** Each work item is
an issue plus one spec file in `docs/tasks/` named for it. Neither half repeats the other:
the issue says *what and why*, the file says *how*.

Board - https://github.com/mattwwatson/raise/issues

| | The issue | `docs/tasks/<KEY>-<name>.md` |
|---|---|---|
| Holds | outline, labels, backlog order, open/closed, the pull requests that touched it | problem, decisions, architecture, `depends:`, implementation detail, acceptance |
| Audience | anyone glancing at the tracker, including a stranger | whoever builds it, and every future agent session |
| Written | once, when the shape is settled | first, and kept current as it is built |

There is no roadmap file - the issue list is the roadmap. Large bodies of work get an issue
that names its children; a standalone bug or task needs no parent.

## Two key namespaces, and why you must not tidy them

Work was tracked in a private Jira until 12/08/2026. Those 21 items are keyed **`RAI-12`** and
keep those keys forever. Everything since is keyed by its **GitHub issue number**, `23`.

- `docs/tasks/RAI-13-pr-state-from-forge.md` - frontmatter `ticket: RAI-13`
- `docs/tasks/<issue>-<short-name>.md` - frontmatter `issue: 23`

**Do not renumber the old ones.** It would rewrite the record of what those items were called
while they were being built, and every cross-reference between specs with it - and the numbers
would collide anyway, since GitHub issues start at 1 where `RAI-1` is the open-source epic.
`RAI-12` and `12` are different strings and cannot collide, which is exactly what lets both
live in one directory.

A spec carries **one** of `issue:` or `ticket:`, never both. Both is one item with two
identities, and nothing downstream could say which of them a branch or a `depends:` meant.

## `main` is protected, and not every change is a work item

**You cannot push to `main`.** It requires a pull request and two green CI jobs, enforced for
administrators as well - so `git push origin main` is refused, and that is deliberate rather
than a misconfiguration to work around.

**A change that ships no tracked item needs no issue and no spec.** Correcting a stale sentence,
fixing a typo, updating a link: name the branch anything without a leading issue number, and the
roadmap gate passes it as `untracked`. Four commands, and the last one merges it the moment CI
goes green:

```sh
git switch -c fix/<short-name>
git commit -am "fix: <what>"
gh pr create --fill
gh pr merge --auto --squash
```

That is the whole path. No issue, no spec file, no `## Implementation notes`. Everything below
about capturing and picking up applies to **tracked work** - something worth an issue, a spec
and a record of why.

**Code should go through the pipeline**, which opens the pull request for you:

```sh
git push no-mistakes <branch>
```

It runs review, tests, lint and docs first, and a check reports whether a pull request carried
its signature. That check is **not required and does not block a merge** - see
[docs/tasks/7-require-no-mistakes.md](../../../docs/tasks/7-require-no-mistakes.md) for why
requiring it was tried and reversed. Use it for anything that is not a one-line correction.

## Capturing a new task

**Write the file first. Create the issue last.** In this order, so each artefact is written
once:

1. **Capture into a file.** Take the request, ask what is genuinely unclear, and write it up
   in `docs/tasks/` under a provisional name (`draft-<short-name>.md`). Iterate there while
   the shape is still moving - a file is cheap to rewrite, an issue other people are reading
   is not.
2. **Once it is clear, create the issue.** The outline only: the problem in the reader's
   terms, what will visibly change, and the notable non-goal. No file paths, no function
   names, no data structures - those live in the spec.

   ```sh
   gh issue create --repo mattwwatson/raise --title '...' --body '...'
   ```

3. **Rename the file to the issue number** (`23-<short-name>.md`) and add its frontmatter.
   Then link the spec **from the issue body**, as an ordinary Markdown link:

   ```
   Spec: [docs/tasks/23-<short-name>.md](https://github.com/mattwwatson/raise/blob/main/docs/tasks/23-<short-name>.md)
   ```

   The URL 404s until the pull request merges - that is fine and expected.

   > **This replaces Jira's "web link" attachments, and it is a simplification worth
   > knowing.** Those were a separate API object that had to be created, updated and kept in
   > step with a filename, and an audit on 12/08/2026 found all 14 of them broken: 13 named
   > the pre-rename repository slug, and every one pointed into a private repository no
   > reader could open. The convention never once produced a link somebody could follow. A
   > line in the issue body is the same information with nothing to keep in sync.

   **The link follows the spec, not the issue.** An item captured without a spec - see the
   exception below - correctly has no link until somebody picks it up. Add it in the same
   pass that writes the file.

The reason for the order is that a file is cheap to rewrite and an issue is not. While the
shape is still moving, moving it on disk costs nothing.

### The exception: importing a backlog whose shape is already settled

Sometimes the thinking has already happened somewhere else - a long planning conversation, a
document that has been through several rounds - and there is nothing left to iterate on. Then
creating the issues first is honest rather than lazy, and pretending otherwise just means
writing files nobody needed.

When that applies:

- **Create the issues, then write the specs before any branch is cut.**
- **A shared reference spec may stand in for several children.** A large item's spec carries
  the background for everything under it, and each child gets its own when it is picked up.
  That is what `RAI-1-open-source-release.md` is - it holds the reasoning behind RAI-2 through
  RAI-9, none of which needed their own file until someone started one.

**The hard rule that keeps this from drifting: no branch shipping a tracked item without its
spec file.** That is the point at which the *how* must exist, and it stops "the spec comes
later" quietly becoming "there is no spec". If you are about to branch on an item and the file
is not there, write it first.

**A branch shipping no tracked item needs neither an issue nor a spec** - a typo, a stale
sentence, a one-line correction. That is not a loophole to reach for, it is the case the
ceremony was never for: an issue, a spec, a branch named after it and a pipeline run is larger
than the change, and the predictable result is that the correction stops being made. `tasks:gate`
checks the first rule and can only check it when the branch says which item it means; see
**Tooling** below for what that does and does not catch.

Outside that exception, never open a new task by creating the issue - the issue is the *last*
step of capture.

## Frontmatter

Every spec file starts with it. It is the only status on disk.

```markdown
---
issue: 23
status: backlog          # backlog | in-progress | shipped | wont-do
size: M                  # S (< half a day) | M (a day-ish) | L (multi-day)
depends: 21              # keys, or "-"
---
# 23 - A pinned dashboard never picks up UI changes
```

Legacy items read `ticket: RAI-12` in place of `issue:` and are otherwise identical.

In-progress and shipped items add `branch:`; shipped items add `shipped: YYYY-MM-DD`.

A large item gets a spec like anything else, but has no branch of its own - its status follows
its children. A file with **no frontmatter at all** is not a work item and is skipped by the
board; anything genuinely reference-shaped is better off as a parent item's spec than as a
loose document.

## Working on an item

1. **Move the item to In Progress on the board when you pick it up** - before the branch,
   before the spec edit, first thing. The board's Status field runs Todo → In Progress → In
   Review → Done, and this is the **only** one of those transitions a human has to make: the
   other two are project workflows keyed off a linked pull request (step 6). GitHub has no
   signal for *somebody started*, so an item left in Todo is indistinguishable from one nobody
   has touched. Assign the issue to yourself in the same pass - the status says the work is
   live, the assignee says whose it is. The spec's `status: in-progress` is the authoritative
   copy on disk; do not invent a label taxonomy on top of either.
2. **Branch off `main` as `<ISSUE>-<short-name>`** - e.g. `23-stale-page-code`.

   GitHub links a branch to its issue from the **pull request**, not from the branch name, so
   `wip-23-stale-page-code` would upset nothing upstream. This is our convention, so that a
   branch list can be scanned by issue: the number starts the branch name or a path element of
   it - `23-stale-page-code` or `fix/23-stale-page-code`, never `wip-23-stale-page-code`.
   **`npm run tasks:gate` does not enforce this, and cannot.** A branch whose key is not in an
   anchored position simply reads as untracked and passes - telling that from an ordinary name
   was built twice and removed twice, so do not expect the gate to catch it and do not try to
   make it. Getting the name right is on you.

   The anchoring matters more than it did for `RAI-12`, which announced itself. A bare number
   does not, so `feat/v2-rewrite` deliberately does **not** name issue 2.
3. **Set `status: in-progress` and `branch:`** in the spec file.
4. **Flesh the spec out before writing code** - problem, decisions with their reasoning, what
   is deliberately *not* being built. Record decisions as they are taken; a decision that
   lives only in the diff is one a future session will undo.
5. **Start every commit message you write by hand with the key**: `23: state the build the
   page loaded with`. The no-mistakes pipeline generates its own subjects
   (`no-mistakes(review): …`) which will not carry it - that is fine, because the pull request
   is what links the work to the issue.
6. **Put `Closes #23` in the pull request description.** It is what *links* the pull request to
   the issue, and that link is what the rest of the automation runs on: the item moves itself
   to In Review when the pull request is linked and to Done when it merges, and the issue
   closes with it. A plain `#23` with no keyword is not a link - it reads the same to a person
   and does nothing. (Linking the issue from the pull request's Development panel works too,
   but the keyword is the one that survives being written down.)

   > **The pipeline writes the pull request body itself, so this line does not survive
   > `git push no-mistakes`.** Issue 9 shipped in a merged pull request and stayed open,
   > because nothing put a closing keyword in a body `no-mistakes` had authored; issue 15 did
   > the same and sat in Todo through its own shipping. Either add it to the body afterwards
   > with `gh pr edit --body`, or close the issue by hand and say which pull request shipped
   > it - closing by hand does land the item in Done. Check after merging; the failure is
   > silent and looks exactly like an item nobody finished.
7. **In the PR, set the spec's `status: shipped` and `shipped: <date>`**, and add the
   `## Implementation notes` section. Merging closes the issue; only the PR can set the file.

Never write a commit hash into the spec - you cannot know the merge commit from inside it, and
the issue's own timeline already holds every commit and pull request that touched it.

### Mentioning another item's number moves that item

`Closes #21` in a pull request description closes issue 21, wherever it appears in the text
and whatever the branch is called. Unlike Jira's branch-anchored rules, **there is no guard**:
GitHub reads the keyword and acts on it.

- **Only your own issue gets a closing keyword.**
- **To reference another item without closing it, write it as a plain link or as `#21`
  without a keyword** - `see #21` links and closes nothing. The keywords that close are
  `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved`.
- **Naming another item's spec file is always safe** - a path is not an issue reference.

If an item unexpectedly closes, a keyword in a pull request body is the first thing to check.

## Tooling

Four commands, in `scripts/`. Zero dependencies, and three of the four never touch the
network - which is what lets the two that run in CI be immune to anything outside the
repository being unavailable.

```sh
npm run tasks           # the board: what is ready, what is blocked, what shipped
npm run tasks:links     # every docs/tasks reference in the repo still resolves
npm run tasks:gate      # this branch's spec says shipped
npm run tasks:validate  # how disk and the issues differ - needs an authenticated `gh`
```

**`tasks`** reads the frontmatter and marks an item READY when every `depends:` key has
shipped. A blocker says *why* it blocks, because a dependency that is `wont-do` or that no
spec claims can never clear on its own. It is grouped by state and sorted by key: priority
lives on the tracker and the repo does not encode one.

**`tasks:gate`** is the guard for the convention that has none otherwise - *the PR that ships
an item must set `status: shipped` in its spec*, or `main` lands with a closed issue and a
file claiming the work never started. It runs on **pull requests only**: a work-in-progress
push makes no claim to be mergeable, so failing it would only paint CI red all day. It reads
`GITHUB_HEAD_REF`, because a `pull_request` checkout is a detached merge commit with no branch
name in `.git/HEAD`.

Two answers, and the branch name is all it reads: a branch with an **anchored** key is held to
its spec, and every other branch passes as untracked. So `wip-23-stale-page-code` and
`fix/whatever` both slip past, which is a known gap rather than an oversight - telling a
misnamed branch from an ordinary one was built twice and removed twice, most sharply because a
legacy key collided with the bare issue sharing its number and the gate's own rename advice went
green over the wrong item's spec. It guards against forgetting, not against evasion. See
[docs/tasks/9-gate-passes-an-unkeyed-branch.md](../../../docs/tasks/9-gate-passes-an-unkeyed-branch.md).

**`tasks:links`** runs on every build, a dangling reference being just as broken on `main`.

**`tasks:validate`** is the only one that talks to the tracker, through `gh`, and it is a
**report**: disk and the tracker differing is normal, since a checkout describes what is
merged *here* while the tracker describes where the workflow is. Divergence exits 0; only a
spec naming an issue that does not exist fails.

**Know what it cannot check.** Jira carried four workflow states; an issue is open or closed.
So `backlog` and `in-progress` are indistinguishable from the tracker and are counted and
skipped rather than guessed between. What is still checked is the pair that actually goes
wrong: a spec saying `shipped` over an open issue, and a closed issue over a spec saying the
work never finished. Legacy `RAI-N` specs are exempt - they have no issue and are not expected
to.

It is not in CI. It *could* be, `gh` needing no credential of ours, and it is deliberately not:
it is a report, and a report that fails a build has become a gate.

## What to work on next

Read the **[project board](https://github.com/users/mattwwatson/projects/1)**, top down. It is the
priority order; the repo does not encode one and must not start.

**The board rather than the issue list, and this is a real distinction rather than a
preference.** The issues hold the items; the board holds their *order*. GitHub sorts an issue
list by newest, oldest, most-commented or recently-updated and gives you no way to rank one
item above another, so "read the issues top down" is an instruction that cannot be followed -
it was written that way when this moved off Jira, whose backlog did have a rank, and it was
wrong for as long as it stood. An item on no board has been captured and not yet ordered.

Then read the spec before committing to it:

- **A blocker stated on the issue wins over everything.** Those are set deliberately.
- **`depends:` in the spec file is the implementation view** - what must exist before this can
  be built, and therefore what can safely run in parallel. Advisory.
- **Ready is not the same as safe to run concurrently.** Two independent items can still want
  the same file. Read what each actually touches before running them in parallel.

Known interactions to watch, all independent in substance and conflicting in the file:

- **`src/dashboard.js`** is the busy one - **#2** (a card renames itself) and **#3** (two
  sessions claiming one pipeline) both change it, and sit closest together: both are about
  how a row is matched to a run, and #2 moves the identity match out of that code entirely,
  so whichever lands second should re-read the other's spec rather than assume its own still
  describes the file.
- **#4** (a pipeline agent that never registers) is the exception - it lives in
  `src/registry.js`, `src/server.js` and the hooks, so it can run alongside any of the above.

Add to this list as more are found.

## The rules that make this work

- **One tracked item, one branch, one issue, one file.** A tightly related batch may share a
  branch; prefer not to. A change that ships no tracked item has none of the four and needs
  none - see the top of this file.
- **Nothing edits a shared ordered list.** Status changes touch only the item's own file, so
  two branches never conflict over the roadmap itself.
- **GitHub issues the numbers**, so two sessions can create work items at the same time
  without colliding. Never hand-mint a number.
- **A user-facing change ships its test in the same PR**, and updates `README.md` if it alters
  a documented flow.
- **Both gates pass before anything is done**: `npm test` and `npm run typecheck`, plus
  `npm run lint`. See AGENTS.md.
