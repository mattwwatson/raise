---
issue: 2
status: backlog
size: S
depends: -
---
# 2 - A card renames itself when a pipeline run ages out

**Self-contained brief.** No prior conversation needed. Written 06/08/2026.

Found during the review of **PR #13** (`fix/own-path-run-branch-match`, "make a session the
unit and no-mistakes an attribute of one"). It is **pre-existing** - the commit before that
branch behaves identically - so nothing regressed. It was reported there, deliberately left
out of scope, and captured here instead.

---

## The symptom

A session whose `cwd` is a **subdirectory** of a repository changes its own name on the page
depending on whether that repository happens to have a recent no-mistakes run.

A session in `/Users/mattw/work/repo/packages/api`:

| While the repo has a run in the reading | Once the last one ages out |
| --- | --- |
| titled **`repo`** | titled **`api`** |
| `titlePath` = `/Users/mattw/work/repo` | `titlePath` = `/Users/mattw/work/repo/packages/api` |
| transcript-sourced pull request link shown | link silently disappears |

Nothing about the session changed. A card renaming itself under the reader is corrosive on a
page whose whole job is *find the one that needs you* - it is the thing you scan by, and it
moves when `disambiguateTitles` re-anchors on the new `titlePath`.

The lost pull request link is the sharper half, because it fails silently and looks like the
link was never there.

---

## Why it happens

`src/dashboard.js:717`:

```js
const identityRepo = matchRunForCwd(session.cwd, runs);
```

Card identity is derived from a **match against the current runs reading**:

- `title` - `identityRepo?.repoName || basename(session.cwd)` (line 752)
- `titlePath` - `identityRepo.repoPath` when the cwd is inside it, else `session.cwd` (760)
- the repo path handed to `transcriptPullRequest` - `identityRepo?.repoPath || session.cwd` (845)

And `runs` is a **30-minute window**. `src/nm-state.js:233` sets `RECENT_WINDOW_MS = 30 * 60 *
1000`; `RUNS_QUERY` returns runs that are active *or* updated inside it. So when the last run
for a repository falls out of that window, `identityRepo` becomes `null` and all three values
change at once.

The pull request loss follows from the third. `transcriptPullRequest` guards on the repository
slug (`src/dashboard.js:356`):

```js
const repo = basename(repoPath);
if (!seen.slug || !repo || seen.slug.toLowerCase() !== repo.toLowerCase()) return null;
```

With `repoPath` fallen back to the session's own cwd, `basename` is `api`, the slug in the URL
is `repo`, and a genuine link is rejected. That guard is correct and must stay - it is what
stops a session that merely *mentions* somebody else's pull request linking to it. The input
is what is wrong.

---

## The fix

**Identity should not depend on the runs reading at all.** The question "which checkout is this
session in?" has a run-independent answer, and `src/git-branch.js` already computes it and
throws it away.

`GitBranch.#findGit(dir)` walks up until something answers to `.git` and returns
`{ headPath, mainCheckout }`. The directory it stopped at - the local `current` in that loop -
**is the checkout root**, and it is exactly the right answer in both shapes:

| Checkout | `.git` is | Root found |
| --- | --- | --- |
| ordinary repo | a directory | the repo root |
| linked worktree (Treehouse, no-mistakes) | a file | the worktree's own directory |

Suggested shape, following the pattern the same file already uses:

1. Return the root from `#findGit`, carry it on the cached `Resolved` entry, and expose it from
   `checkoutFor(dir)` alongside `branch` and `mainCheckout`. **One `.git` resolution, three
   answers** - `checkoutFor` exists precisely because asking separately meant stat-ing the same
   HEAD twice per session per poll. Do not add a fourth accessor.
2. Thread it into `buildRows` as a `Map<sessionId, string|null>`, exactly as `branches` and
   `mainCheckouts` are threaded today, from `src/server.js` and `bin/raise.js`. `dashboard.js`
   is pure and may not touch the filesystem.
3. Use it for `title`, `titlePath` and the `transcriptPullRequest` repo path. Fall back to
   `session.cwd` when there is no root, which is a directory that is not in a repository.

`identityRepo` then has no remaining consumer and should go with it.

### Why `repoName` is not lost

`Run.repoName` is `basename(repoPath)` - `src/nm-state.js:632` and `:750`, and the typedef says
so. no-mistakes registers a repository at its git root, so `basename(checkoutRoot)` yields the
same string by construction. Nothing about the title's *content* changes; only where it comes
from, and therefore whether it is stable.

---

## What this deliberately changes

**A session in a subdirectory of a repository that has never run no-mistakes is currently
titled after the subdirectory, and will start being titled after the repository.** That is a
visible change and it is the intended one - `AGENTS.md` already states the rule this restores:

> Identity follows the repo the session is in, never the run it owns. A bystander session
> titled after its own subdirectory would stop looking like the same checkout as the one
> running the pipeline.

Today that holds only while a run happens to be in the window. The fix makes it unconditional,
and makes it true for repositories that use no-mistakes not at all.

## What this must not change

- **Worktrees keep their own path.** A Treehouse tree's `.git` is a file *in that tree*, so its
  root is itself - `titlePath` stays the worktree path and `disambiguateTitles` keeps growing
  `1/repo` and `2/repo`. Verify this rather than assume it: collapsing the two onto one anchor
  was a real bug on an earlier branch and both cards read `repo`.
- **Pipeline state stays branch-gated.** `matchRunForCheckout` and the `checkoutRun` /
  `ownedRuns` logic are not in scope. PR #13 separated identity from pipeline state precisely
  because one value was doing both jobs; this change replaces the identity half's *source* and
  must leave the other half alone.
- **The slug guard stays.** It is what stops a confident link to somebody else's review.

---

## Reproduce as a test first

Per `AGENTS.md` and Matt's standing preference. `dashboard.js` is pure and directly testable;
see the `run()` / `session()` factory pattern at the top of `test/dashboard.test.js`, and the
`build()` helper beneath it which supplies a branch for every session.

The reproducing case is one assertion: a session at a subdirectory path keeps the same `title`,
`titlePath` and `pr` whether `runs` is populated or empty. It fails today on all three.

Worth adding alongside:

- a worktree session keeps its own `titlePath` (guards the regression named above)
- a session in no repository at all still falls back to its cwd basename
- `git-branch.test.js` gains a root case for both `.git`-as-directory and `.git`-as-file, using
  the existing `fakeFiles` harness

---

## Constraints (from AGENTS.md, non-negotiable)

- **Pure modules stay pure.** `dashboard.js` takes maps; it does not read `.git`.
- **Nothing reachable from the server may run a synchronous child process.** This is a file
  read, which is fine - but do not reach for `git rev-parse`, which is the obvious wrong turn
  here. `git-branch.js` exists because the poll loop may not shell out.
- **One stat on the happy path.** The cache is keyed on HEAD's mtime; adding a separate walk
  would double it per session per second.
- Zero runtime dependencies.
- `npm test`, `npm run typecheck` and `npm run lint` all pass.

---

## Related, and deliberately not in this item

Two other residuals were recorded during the same review. Neither is this bug and neither
should be folded in:

1. **Two sessions in one checkout on one branch both show that branch's unowned run.** The
   branch requirement added in PR #13 removes the cross-branch case, which is what was actually
   reported; it cannot separate two sessions genuinely on the same branch in the same
   repository. Making that case unattributable too was considered and rejected, because it
   would strip the pipeline from the ordinary single-session card whenever ownership is unknown
   - after a monitor restart, for instance.
2. **A no-mistakes `review` step ran with a live `agent_pid` and registered no session**, so
   nothing was folded onto the card. The `ci` step's equivalent turned out to be by design (the
   CI monitor runs inside the daemon with no agent at all), but this one is unexplained and is
   upstream of raise.

---

## Definition of done

```sh
npm test
npm run typecheck
npm run lint
```

Report whether the worktree `titlePath` case was verified, since that is the regression this
change is most likely to reintroduce.
