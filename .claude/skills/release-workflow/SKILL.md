---
name: release-workflow
description: How to publish a new version of raise-cli to npm - preparing the release pull request, editing its notes, merging, approving the staged package with 2FA, and checking it went out. Load this BEFORE running `npm run release` or touching `scripts/release*.js`, `.github/workflows/release.yml` or `release-check.yml`. Triggers - "cut a release", "publish a new version", "release 0.x", "push a new version to npm", "what's in the next release", "approve the staged package", a release pull request or release workflow run that failed, or npmjs.com showing a staged package as Validating.
---

# Release workflow

**A laptop never publishes.** Releases are prepared as a pull request, published from GitHub
Actions through npm Trusted Publishing (no npm token exists anywhere), and made public by a
person approving the staged package with 2FA. The changelog is the GitHub Release for each tag,
written from the notes reviewed in the release pull request. There is no `CHANGELOG.md`.

The design, and every decision behind it, is in
[docs/tasks/39-release-process.md](../../../docs/tasks/39-release-process.md). Its **Recovery**
section covers a release workflow that failed partway. This file is the procedure.

| Piece | What it does |
| --- | --- |
| `npm run release -- <patch\|minor\|major>` | bumps the version on `release/<version>` and opens the release pull request, whose description is the notes |
| `release-check.yml` (required check "Release notes are current") | fails a release pull request whose notes miss a shipping pull request; re-runs on every push, branch update and description edit |
| `release.yml` | on every push to `main`: does nothing unless an untagged version came from a merged release pull request; then checks, stages on npm, tags, and creates the GitHub Release |

## 1. Prepare

From an up-to-date, clean `main`, with `gh` authenticated:

```sh
npm run release -- minor --dry-run   # the next version and the notes; changes nothing
npm run release -- minor             # opens the release pull request
```

Pick the bump yourself; nothing infers it. Before 1.0, a release with features is `minor` and a
release with only fixes or docs is `patch`.

The script switches back to `main` once the pull request is open, so the checkout is never left
on a release branch whose remote is deleted when it merges.

**Merge anything else you want in this release first.** A pull request that changes shipped code
and merges while the release pull request is open makes "Release notes are current" fail, because
the notes no longer cover everything. Close the release pull request and delete its branch, with
`gh pr close <number> --delete-branch`, then prepare it again. Closing alone leaves
`release/<version>` on GitHub, and `npm run release` refuses to start while it is there.

## 2. Review and edit the notes

Edit the release pull request's description. **Only the text between the two
`raise-release-notes` markers ships**, as the GitHub Release. Leave the markers alone, and leave
the `raise-release-prs` line below them - it records which pull requests the notes cover, and the
check fails without it.

What the notes include, and what to change:

- **Only pull requests that changed shipped code** (`bin/`, `src/`, `public/`, `hooks/`) are
  listed. Docs, CI and roadmap work are left out, and so is a `README.md`-only change.
- **A README-only release generates "No change to the installed package since the last
  release."** Replace that line with what changed, for example a `### Documentation` heading and
  a one-line entry linking the pull request. 0.2.1 is the worked example.
- **Entries under Other** have no `feat` or `fix` prefix. They are listed so nothing is dropped
  silently; delete one if it means nothing to a user (comment-only changes, for instance).
- **Never write "closes", "fixes" or "resolves" next to an issue number**, even inside a link.
  GitHub links the release pull request to that issue, and the board moves it from Done back to
  In Review. The generated notes say "issue [#N]" for this reason.

## 3. Merge

Merge when the checks are green. "PR body carries the no-mistakes signature" shows as skipped on
a release pull request, which is correct - the script opens it, not the pipeline.

The merge starts `release.yml` on `main`. Watch it in the Actions tab, or:

```sh
gh run list --workflow release.yml --limit 1
gh run view <run id> --log | grep -E "Releasing|staged with id"
```

It runs lint, tests and typecheck, stages the package, pushes the `v<version>` tag, and creates
the GitHub Release. The log line `staged with id <uuid>` is the stage id.

## 4. Approve the staged package

On npmjs.com, open `raise-cli`, then the **Staged Packages** tab:

1. The new version first shows **Validating**, and Approve is disabled. npm is running its own
   automated checks. Wait a few minutes and refresh.
2. When it shows **Staged**, select it, click **Approve** and give your 2FA code.

Or from a terminal (npm 11.15 or later), once it is Staged:

```sh
npm stage approve <stage id>
```

Until approval, the GitHub Release exists and npm's `latest` is still the previous version. That
gap was accepted in the spec.

## 5. Check it went out

```sh
npm view raise-cli dist-tags                                    # latest: the new version
npm view raise-cli@<version> dist.attestations.provenance       # an slsa.dev provenance predicate
```

**The npmjs.com package page lags the registry by a few minutes.** It can keep the tick on the
previous version and show its README after `latest` has moved. The registry is the answer; a hard
refresh later catches the page up.

## One-time setup, already done

These exist and should only need redoing if something is renamed or recreated:

- **The trusted publisher on npmjs.com**, in `raise-cli`'s settings: GitHub Actions, user
  `mattwwatson`, repository `raise`, workflow `release.yml`, no environment. Every field is exact
  and case-sensitive, and npm does not check it until a publish. **Renaming `release.yml` breaks
  publishing** until this is changed to match, and a new configuration expires if nothing
  publishes within two days.
- **"Release notes are current" is a required status check on `main`.** If it is ever re-added,
  do it only once `release-check.yml` is on `main` - a required check whose workflow a pull
  request cannot see is never reported, and blocks every merge.
- **The `v0.1.0` tag and GitHub Release**, at the commit 0.1.0 was published from, are where the
  first generated notes counted from.

## When something fails

- **"Release notes are current" fails** on a release pull request: something shipping merged
  after the notes were written, or the markers or the `raise-release-prs` line were removed.
  Restore what was removed, or close the pull request and delete its branch with
  `gh pr close <number> --delete-branch`, then run `npm run release` again.
- **`release.yml` refuses** on `main`, or fails partway: see **Recovery** in the spec.
- **`release.yml` fails on every push** after a version bump: `package.json` carries a version
  that did not come from a release pull request. See Recovery; the next `npm run release` moves
  past it.
