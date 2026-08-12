---
ticket: RAI-5
status: in-progress
size: L
depends: RAI-3, RAI-6, RAI-8
branch: RAI-5-package-for-public-release
---
# RAI-5 - Package it for public release

The ticket was written as "make install one command instead of a clone". Two hand-over
comments have since made it the item where the project actually *becomes public*: the
Bitbucket-to-GitHub move, the CI that move destroys, and - decided while this was being picked
up - the retirement of Jira as the board.

That is a lot for one ticket and it is deliberate. Every part of it is the same act performed
on a different surface: **the place this project lives changes, exactly once.** Splitting it
would mean a period where the README names one home, CI runs at another and the issue tracker
is at a third, which is the inconsistency RAI-8 already had to accept temporarily and flagged
as closable only here.

## What is already true, and must not be re-done

The two hand-over comments were written against an older tree and two of their obligations are
already discharged. Checked on this branch before starting:

- **`LICENSE` exists** (MIT, `Copyright (c) 2026 Matthew Watson`) and **`package.json:29`
  already carries `"license": "MIT"`.** The comment's first bullet - that `CONTRIBUTING.md` and
  `SECURITY.md` reference a licence the repository does not carry - was true when written and
  is not true now. RAI-3 landed both.
- **The roadmap-workflow skill already points at GitHub** (`SKILL.md:38`), landed on the RAI-6
  branch this one is stacked on.
- **Private vulnerability reporting is enabled** on the destination repository, verified in the
  comment on 12/08/2026. It requires the repository to stay public.

What remains from those comments is genuinely outstanding and is below.

## The destination

`github.com/mattwwatson/raise` exists: **public, empty, issues enabled, description set, no
licence detected** (because it has no content yet). Verified over the API while picking this
up - `size: 0`, no branches.

**Bitbucket is not kept.** This is a move, not a mirror. A mirror would mean two homes to keep
honest, and the whole argument of this codebase is against two sources that can quietly
disagree.

---

## Phase A - packaging

### A.1 `npx` is not the install command, and that is a finding rather than a preference

The epic (`RAI-1-open-source-release.md:264`) proposes `npx raise-cli serve`. **That is
actively unsafe here**, and the reason is specific to this tool rather than general npm taste.

`bin/raise.js:58-60` resolves the hook scripts relative to the installed package:

```js
const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = resolve(HERE, '..', 'hooks', 'raise-hook.js');
```

That is correct, and it is what makes a global install work. But `raise install-hooks` writes
that absolute path into the user's `~/.claude/settings.json`, and under `npx` the path points
into npm's temporary cache - which is garbage-collected. The hooks then reference a script that
no longer exists, every session stops reporting, and the page keeps rendering.

**That is precisely the failure this tool exists to prevent**, and it is the one RAI-3 already
named as the worst outcome of the rename: *a dashboard that looks fine and reports nothing*. So
the README says `npm install -g raise-cli`, and says why `npx` is not offered rather than
leaving a reader to reach for the more familiar command.

### A.2 `package.json` metadata

Missing entirely: `repository`, `homepage`, `bugs`, `keywords`, `author`. Two consequences,
and the second is the one that is easy to miss - npm only rewrites relative links in a rendered
README when `repository` is set, so `README.md`'s links to `AGENTS.md` and `docs/tasks/` render
broken on npmjs.com without it.

`files` is already a tight allowlist and needs no change: `npm pack --dry-run` ships 38 files,
and `test/`, `docs/`, `scripts/`, `.claude/` and the CI config are all correctly outside it.

### A.3 `doctor` contradicts `engines`, and would pass on a Node that cannot run this

`bin/raise.js:730` still tests `major === 22 && minor >= 5` and `:733` says *"Raise needs 22.5
or newer"*. Everywhere else - `package.json:10`, `README.md:26`, `CONTRIBUTING.md:100` and the
Tech Stack section of `AGENTS.md` - says **22.13**, and AGENTS.md sets out at length why 22.5 is
wrong: `node:sqlite` existed from 22.5 but stayed behind `--experimental-sqlite` until 22.13.0,
and `npm test` passes no flags.

So on Node 22.5 through 22.12, `npm install -g` refuses the package on `engines` while `doctor`
- run from a checkout, where nothing enforces `engines` - reports Node **ok** in green, and the
tool then dies importing `node:sqlite`. A green check over a broken state is this project's
defining bug class, and publishing is what makes `engines` binding, so it is fixed here rather
than filed.

### A.4 A published CLI answers `--version`

There is no version flag at all (`src/cli-args.js` has none). Every other published CLI has
one, and the first thing anyone does with a bug report is ask which version. It reads the
version from `package.json`, which npm always includes in the tarball.

### A.5 `prepublishOnly`

Nothing currently gates a publish on the three checks AGENTS.md calls mandatory. A
`prepublishOnly` running `lint`, `test` and `typecheck` costs nothing and makes it impossible to
publish a build that does not pass them. It adds no dependency.

---

## Phase B - the move

### B.1 The author email on 23 commits

A full-history audit found **no secret ever committed** - no credential, in any blob, in any of
152 commits. The exposure is identity rather than security, and it has one sharp edge: **23
commits carry `mattw@moroku.com`.** All 23 are Bitbucket-generated merge commits, so the work
email came from the Bitbucket account rather than from local config; local and global
`user.email` are the personal address.

GitHub renders the author on every commit in every list, so left alone this publicly links a
personal project to an employer, permanently, in the most-read part of the UI.

**Decision: carry the history and rewrite those 23 emails.** The history is 152 readable
commits and the epic names it as a reason someone might trust the project, so squashing it away
costs something real. Rewriting costs nothing *here* specifically because Bitbucket is being
abandoned in the same change - the usual objection to rewriting, that it breaks everyone's
clones, has no one to apply to.

`git filter-repo` is not installed and `git filter-branch --env-filter` is built in and
sufficient for 152 commits. A backup ref is taken first.

**A `.mailmap` is not the fix** and was considered: it changes what tools *display* and leaves
the commit objects untouched, so the address is still in the data and still served by the API.

### B.2 Test fixtures, and the line this stops at

Still at HEAD, in `test/` only: `hexbattle` with real `HXB-*` ticket keys and branch names,
real `bitbucket.org/mattw_watson/hexbattle` pull request URLs, `moroku`, and
`/Users/mattw/work/hexbattle`.

These are **scrubbed**, and the reason is that `test/` is already anonymised almost everywhere
else - `/Users/x`, `acme/widgets` - so the residue is inconsistency rather than intent, and
nothing in a fixture depends on the string being real.

**`docs/tasks/` is deliberately left alone.** Those are recorded measurements of real runs on a
real machine, and the whole evidential weight of these specs is that they say what was actually
observed. Replacing a real path with a fake one would make a true statement false, which is the
rule RAI-3 already settled when it refused to rename `no-mistakes-monitor` out of sample output.
The cost is that `hexbattle` and `/Users/mattw` remain visible in the specs; that is accepted,
because neither is a secret and the alternative damages the thing worth publishing.

### B.3 The push, and what stops being used

The rewritten history is pushed to `github.com/mattwwatson/raise` as `main`. RAI-6, RAI-7,
RAI-8 and this item land as part of that initial push rather than through a pull request,
because the destination is empty and there is nothing to open one against.

Then: the Bitbucket repository stops being the remote, and **the no-mistakes push target is
repointed**. That target is not in this repository - it is the gate repo under
`~/.no-mistakes/repos/<hash>.git` - so it is a change to live local tooling and is done
deliberately, not as a side effect.

---

## Phase C - CI, which the move destroys

`bitbucket-pipelines.yml` runs five checks and nothing at the destination runs any of them. A
public repository with no CI is worse than a private one with none, because the first
contributor's pull request has nothing to go green.

It is replaced by `.github/workflows/ci.yml` carrying the same five checks, on the same two
Node versions, for the same recorded reasons - the comments in that file are the specification
and move with it. The one thing that cannot be renamed is the pull-request guard:

```sh
if [ -n "$BITBUCKET_PR_ID" ]; then npm run tasks:gate; fi
```

`BITBUCKET_PR_ID` has no GitHub equivalent as a variable. The real equivalent is the **event**:
`tasks:gate` runs in a job conditioned on `github.event_name == 'pull_request'`. That preserves
the actual rule - the gate asks a question about *merging*, and a work-in-progress push makes no
claim to be mergeable, so running it on every push would paint CI red all day on branches whose
spec correctly still says `in-progress`.

`bitbucket-pipelines.yml` is deleted in the same change. Leaving it would be a second CI
definition for a forge nothing pushes to.

---

## Phase D - Jira retires, GitHub issues become the board

**Decided 12/08/2026 while picking this up.** This is the largest single change here and the
one least implied by the ticket title, so the reasoning is worth stating: the argument for Jira
was that it holds ordering and workflow state for a private project. Once the project is public
that argument inverts - the board is where a stranger looks to see whether anything is
happening, and a private Jira is invisible to them. The audit in the second hand-over comment
found the convention had never once produced a link a reader could open: 14 tickets carried a
spec link, 13 named the pre-rename slug, and all 14 pointed into a private repository.

Consequences, in the order they have to be resolved:

- **The 19 spec web links are not written.** That job existed to make Jira tickets point at
  GitHub specs; with Jira retiring it is work on something being switched off. This is a
  deliberate reversal of an instruction in the hand-over comment, on grounds that arrived after
  it was written.
- **The four open bugs move**: RAI-12, RAI-15, RAI-16, RAI-17 become GitHub issues, carrying
  their descriptions and a link to their spec file.
- **`.github/ISSUE_TEMPLATE/`** gets `config.yml` with a `contact_links` entry pointing at the
  private advisory form, **plus at least one real template**. The real template is not
  decoration: GitHub documents `contact_links` as rendering "in the template chooser" and does
  not say whether the chooser appears at all when a repository has a config and no templates.
  Shipping a template makes the chooser certain rather than hoped for.
- **The roadmap-workflow skill, `scripts/task-jira.js` and `tasks:validate`** all speak Jira.
  The skill is rewritten around issues; `tasks:validate` is the only command that talks to Jira
  and the only one that needs a credential, which is why no pipeline has ever run it.
- **The `ticket:` frontmatter keeps its `RAI-N` keys.** Renumbering 21 shipped specs onto issue
  numbers would rewrite the historical record to match a tracker that did not exist when the
  work was done, and every cross-reference between specs would have to move with it. `RAI-N` is
  what those items were called. New items take their issue number.

---

## Acceptance

- `npm run lint`, `npm test` and `npm run typecheck` green.
- `npm pack --dry-run` ships the same 38 files and nothing from `test/`, `docs/`, `scripts/` or
  `.claude/`.
- `README.md` install is `npm install -g raise-cli`, and no document names Bitbucket as the
  home of the project.
- `git log --format='%ae' | sort -u` on the rewritten history returns one address.
- `grep -rn 'hexbattle\|HXB-\|moroku' test/` returns nothing.
- `doctor` and `engines` agree on 22.13.
- The GitHub workflow runs all five checks, on both Node versions, with the gate on pull
  requests only.
- `raise-cli` is installable from npm, and `raise --version` answers.

## Implementation notes

To be written as this lands.
