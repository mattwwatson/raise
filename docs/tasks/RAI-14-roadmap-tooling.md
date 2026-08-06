---
ticket: RAI-14
status: shipped
shipped: 2026-08-06
size: M
depends: -
branch: RAI-14-roadmap-tooling
---
# RAI-14 - Roadmap tooling: the board from disk, and a CI gate

**Self-contained brief.** No prior conversation needed. Written 06/08/2026.

---

## What and why

The roadmap workflow - one Jira ticket plus one spec file in `docs/tasks/` per work item - is
enforced entirely by reading. The `roadmap-workflow` skill says so, and names the convention
that has no guard at all:

> **the PR that ships an item must set `status: shipped` in its spec**, or `main` lands with a
> ticket marked Done and a file claiming the work never started.

That is the failure this item closes. Merging is what transitions a ticket to Done, so the
repository has to already agree - and nothing checks that it does.

This is a **port**, not a design exercise. `hexbattle` runs the same scheme and has the tooling:
`scripts/tasks.ts` (325 lines) and `scripts/check-task-links.ts` (78 lines), zero dependencies,
wired into that repo's pipeline. What does not survive the port is its structure - top-level
side effects, disk reads inside the logic, `console.log` woven through the decisions, and no
tests. Under this repo's rules that all has to be rebuilt, and rebuilding it is what surfaced
three latent bugs in the original, plus one claim in its own error text that is simply untrue
(below).

### The four commands

| Command | Answers | Network |
| --- | --- | --- |
| `npm run tasks` | what is ready, what is blocked, what shipped | none |
| `npm run tasks:links` | does every `docs/tasks/` reference in the tree still resolve | none |
| `npm run tasks:gate` | does this branch's spec say `shipped` | none |
| `npm run tasks:validate` | do disk and Jira agree | one read-only Jira query |

Three of the four are disk-only, and that is the point rather than an accident: the two that
run in CI cannot fail because a token expired or Jira was slow.

---

## Where it lives, and why not in `nmmon`

A new top-level `scripts/` directory, driven by npm scripts. **Not** a `nmmon` subcommand.

`nmmon` is a shipped product whose one sentence is *tell me which session is waiting for me, and
take me there*. This is the repository's own development workflow. A `nmmon roadmap` command
would enter `usage()`, README's Commands table, and the published `files` array - a dev-workflow
board shipped to every user of a session monitor. `package.json`'s `files` does not list
`scripts/`, so this placement keeps it out of the tarball for free, and **`scripts/` must never
be added to `files`**.

`scripts/` may import from `src/` - it does, for `GitBranch`. `src/` must never import from
`scripts/`, and nothing does.

---

## Design constraints

All from `AGENTS.md`, all non-negotiable.

**Zero runtime dependencies, and no new devDependencies.** Node builtins only. Frontmatter is a
fixed `key: value` shape written by us, so it is hand-parsed rather than pulling in a YAML
library.

**Pure logic and I/O stay in separate modules.** hexbattle's version reads disk inside its
loader and calls `fetch` inside `validate`, so none of it can be imported without running it.
Here every command is *pure core - result object - pure renderer*, and one entry script owns
disk, network, `process.argv` and `process.exitCode`.

**The exit code is a property of the result, not a side effect.** `Board`, `GateResult`,
`ValidationReport` and `LinkReport` each carry `exitCode`; only the entry assigns
`process.exitCode`. That makes *"a spec left backlog fails the gate with 1"* a pure assertion
with no subprocess in it.

**Inject everything external.** The filesystem is one injected `{readDir, readText}` accessor,
shared by the spec loader and the tree walk, matching `defaultGitAccess` in `src/git-branch.js`.
`fetch` is `fetchImpl = fetch` in the signature, matching `probeHealth` in `src/health.js`. The
environment is a parameter, so no test reads or sets `process.env`. Nothing in the suite reaches
the network or the real tree.

**No subprocess at all.** The original shells out to `git rev-parse --abbrev-ref HEAD` for the
branch. `src/git-branch.js` already reads `.git/HEAD` directly, handles a worktree's `.git`
file, caches on mtime and is tested. Reuse it; the port ends up importing no runner.

**Link resolution needs no filesystem call.** The walked set *is* the existence oracle, so the
whole check is a pure function of `{file, text}[]` - fewer syscalls than `existsSync` per
reference, and assertable from a fixture array.

**Never assume anything about the author's machine.** This is being prepared as an open source
tool, and one person's environment is not a specification. The original hardcodes both an email
address and an Atlassian cloud id; the line between them is **project identity versus somebody's
credential**, not "no literals in source":

| | |
| --- | --- |
| `JIRA_PROJECT`, `JIRA_CLOUD_ID` | **Defaulted inline.** They name *this project's* board and the site it lives on, the same class of fact as the repository's own URL. A fork overrides them, exactly as it would override the board link in `AGENTS.md` |
| `JIRA_EMAIL`, `JIRA_TOKEN` | **No default.** These identify a person. A hardcoded email works perfectly for one human and silently does nothing for every other |

`validate` names every variable that is missing, all at once rather than one per run, and prints
the exact invocation to use.

**Never print a token, and never let one reach a shell history.** The missing-credential message
tells you to use command substitution:

```sh
JIRA_EMAIL=you@example.com JIRA_TOKEN=$(secret-get JIRA_PERSONAL_API_TOKEN) npm run tasks:validate
```

Requests go through `api.atlassian.com` rather than a site URL, because a scoped token only
works there and a classic token works against both - one path serves either, and the scope
needed is `read:jira-work` and nothing more. **No CI job holds a Jira credential**, which is why
`validate` is never in the pipeline.

---

## Where the CI gate runs, and why not everywhere

**Pull requests only**, guarded by `if [ -n "$BITBUCKET_PR_ID" ]`.

This is the one place the port must not follow hexbattle, which guards with
`[ "$BITBUCKET_BRANCH" != "main" ]`. That works there because hexbattle has no `default:`
pipeline. This repo does, deliberately - it is the backstop for a branch with no open pull
request - and it fires on **every push, including work in progress**. A branch mid-flight
legitimately says `in-progress`, so hexbattle's guard would paint CI red on every WIP push, and
no-mistakes watches those checks.

A WIP push makes no claim to be mergeable. A pull request does. The gate asks the merge
question, so it belongs on the merge trigger.

`tasks:links` runs unconditionally: a dangling reference is broken on `main` too.

Both go in the existing `&lint-test-typecheck` step and not in `&test-floor` - neither is
version-dependent, which is the reasoning that file already gives for lint and typecheck.

---

## Three bugs in the original, fixed rather than ported

Each was found by rebuilding the logic against tests, and each would have been a confident wrong
answer.

**1. `maxResults=200` with no pagination check.** A truncated page turns every spec past the cut
into a phantom *"does not exist in Jira"* fault. A short read is not a short answer, so a page
Jira does not call the last one is a **fetch failure** (exit 2), not data.

**2. The JQL excludes epics, and this repo gives epics a spec.** `issuetype != Epic` plus
`docs/tasks/RAI-1-open-source-release.md` produces a permanent, uncorrectable fault: *"RAI-1 does
not exist in Jira"*, exit 1, forever. Epics are queried, and exempted from the *status*
comparison rather than from existence - an epic's status follows its children, so it is expected
to differ.

**3. No cycle detection in `depends`.** The original catches a self-dependency and an unknown
key; a ring of three is silently never READY with nothing saying why. A ring is a structural
fault naming the ring in order.

### The branch rule is a convention, and that is why it needs a check

Jira finds a ticket key **anywhere** in a branch name. `wip-RAI-14-tooling` links its commits and
transitions its ticket exactly as `RAI-14-tooling` does, so nothing upstream will ever object to
any of this.

The original says otherwise - its failure message claims a prefixed branch transitions nothing
because the automation is anchored on the key - and its own regex, which allows a path prefix,
already disagreed with the message. Neither the claim nor the anchoring is real.

**So this is our convention: the key starts the branch name or a path element of it.**
`RAI-14-roadmap-tooling` and `fix/RAI-14-roadmap-tooling` both pass; `wip-RAI-14-roadmap-tooling`
does not, the key there having stopped naming the branch and become a substring inside a word.
What we are protecting is a branch list that can be scanned by key. Precisely because Jira does
not care, `tasks:gate` is the only thing that can hold the convention, which is a better reason
to check it than if Jira had been doing it for us.

Two smaller departures. The board groups by `phase`, a field this repo's frontmatter does not
have, and sorts by `legacy-id`, which it also does not have - ported literally every row lands in
one `?` group in arbitrary order. Sections here are the row *state*, in a fixed order, sorted by
ticket number so RAI-2 precedes RAI-10. And a blocker records *why*: a dependency that is
`wont-do` or that no spec claims can never clear, and reporting it as a bare key makes a
permanently blocked item look merely late.

---

## What `validate` must tolerate without complaining

Reconciliation is a **report, not a gate**. Disk and Jira differing is normal and often correct:
a checkout describes what is merged *here*, while Jira describes where the workflow is. Both of
these are true of RAI today, verified 06/08/2026 against the live project - 17 issues, 10 specs:

- **RAI-4 through RAI-9 have tickets and no spec files.** That is the documented design - the
  RAI-1 epic spec carries their reasoning, and *"none of which need their own file until someone
  starts one"*. Orphans: reported dim, counted, exit 0.
- **RAI-1 is an Epic reading `To Do` in Jira and `in-progress` on disk.** Benign, and exempt.

A Jira workflow status we have never seen is reported as **unmapped**, not as divergence. That
fails soft on purpose, the same way `attentionFor` does: a word we have not seen is new, not
wrong.

Exit codes: `1` for a structural fault (a spec naming a ticket Jira does not have, a broken
reference, a failed gate), `2` only for *could not ask Jira*. Divergence and orphans exit `0`.

---

## Not being built

- **No priority anywhere.** The board is the roadmap and the repo must not start encoding an
  order. Sorting is by state then ticket number, which is arbitrary rather than ranked.
- **No writes to Jira.** Read-only, one query, `read:jira-work`.
- **No new frontmatter fields.** `phase`, `milestone` and `legacy-id` are hexbattle's and do not
  come across.
- **No `validate` in CI**, so no pipeline holds a credential.

---

## Definition of done

```sh
npm test          # no network, no disk, no subprocess in the new tests
npm run lint      # now covering scripts/
npm run typecheck # now covering scripts/
```

And by hand:

```sh
npm run tasks         # 11 items; RAI-3 blocked by RAI-2, RAI-13 blocked by RAI-10
npm run tasks:links   # every reference resolves
npm run tasks:gate    # fails while this spec says in-progress, passes once it says shipped
JIRA_EMAIL=... JIRA_TOKEN=$(secret-get JIRA_PERSONAL_API_TOKEN) npm run tasks:validate
```

Negative cases proven rather than assumed: renaming a referenced spec makes `tasks:links` fail
and name the referrer; a spec left `backlog` makes `tasks:gate` fail with the exact frontmatter
to add; the suite passes with no network; and the pipeline change is confirmed against a real PR
build to run there and **not** on a plain branch push.

---

## Implementation notes

Shipped as 8 modules in `scripts/` and 6 test files, ~1,000 source lines against the ticket's
estimate of 400. The multiplier is module comments, JSDoc typedefs, the render/logic split and
the guards below; the executable logic is barely larger than the original. **134 tests added,
462 to 596.**

**The structure is the part that differs most from the port.** Every command is *pure core -
result object - pure renderer*, and `scripts/tasks.js` is the only file that reads a directory,
makes a request, writes a line or assigns `process.exitCode`. `exitCode` is a field on `Board`,
`GateResult`, `ValidationReport` and `LinkReport` rather than a side effect, which is what makes
*"a spec left backlog fails the gate with 1"* a pure assertion with no subprocess in it. The
original runs its whole program at import and cannot be loaded by a test without executing.

The branch comes from `src/git-branch.js` rather than `git rev-parse`, so the port ends up with
no subprocess at all and inherits worktree handling that is already tested.

### Three things only the live API could settle

- **`/rest/api/3/search/jql` returns no `total`** - only `isLast` and `nextPageToken`. So the
  original's un-paginated `maxResults=200` cannot even detect that it was truncated, and every
  spec past the cut reads as a ticket that does not exist. Paging runs to the end and exceeding
  `MAX_PAGES` is a failure rather than a short answer.
- **An epic is `issuetype.hierarchyLevel > 0`**, not a type named `Epic`, which an admin can
  rename. The name survives as a fallback.
- **A `+` for a space in the query string is accepted** by Jira, so `URLSearchParams` output goes
  through unmodified. Verified against the real endpoint rather than assumed.

### Two guards found by running the thing

- **The link checker failed its own first run with 27 broken references, every one its own test
  fixtures.** A test that asserts a broken reference is caught must contain a broken reference.
  `test`, `tests`, `__tests__` and `fixtures` are skipped, and two placeholder paths in the
  module's own JSDoc were reworded to `<name>.md`. The cost is a stale reference inside a test
  going unnoticed; the benefit is a check anybody believes.
- **It then found the one real instance**: this spec's neighbour, `RAI-13-pr-state-from-forge.md`,
  named its prerequisite as `PR-STATE-FRESHNESS.md`, renamed long ago. Corrected, and rewritten
  with its directory so the check can see it at all.

### `JiraFetchResult` is one object, not a union

`{ok: true, ...}|{ok: false, ...}` reads better and does not survive this repository's deliberate
`strict: false`: with `strictNullChecks` off, TypeScript stops narrowing on a boolean discriminant,
so `if (!result.ok)` leaves the failure branch typed as the success member and the checker objects
to the code that is correct. Optional-by-convention fields, documented as such, are what `Board`
and `ValidationReport` already do.

### Frontmatter strips a trailing comment

The canonical block in the `roadmap-workflow` skill documents every field with an inline comment
naming its legal values. Copying that block is what the skill is *for*, and without stripping it
yields a `status` of `backlog          # backlog | ...` and an `unknown-status` fault on a
correctly written file.

### What changed outside `scripts/`

`package.json` gained four scripts and `scripts` on the lint path; `tsconfig.json` includes
`scripts/**/*.js`, so a non-shipping directory holding two CI gates is typechecked like the rest.
Both were pulled forward from this chunk into the first, because otherwise every chunk would have
reported a green definition of done that had never read the code it added.

`AGENTS.md` and the `roadmap-workflow` skill both claimed the ticket key had to start the branch
name *because the Jira automation is anchored there*. It is not - Jira finds a key anywhere in a
branch name. The convention stands on its own terms instead, and `tasks:gate` is the only thing
that can hold it, which is a better reason to check it than if Jira had been doing it for us.
