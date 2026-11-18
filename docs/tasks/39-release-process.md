---
issue: 39
status: shipped
size: M
depends: -
branch: 39-release-process
shipped: 2026-11-18
---
# 39 - Releasing a new version is undocumented and by hand, and nothing says what changed

**Self-contained brief.** No prior conversation needed. Written 18/11/2026.

---

## What and why

0.1.0 is the only version of `raise-cli` on npm. It was published by hand from a laptop on
12/08/2026, and nothing about how was written down: no tag, no workflow, no notes. Since then
eighteen pull requests have merged to `main`, including Ghostty focus (#37), the version notice
(#21) and `raise enable/disable` (#23), and **none of it has reached anyone who installed with
npm**. `package.json` still says 0.1.0.

Two gaps, and this item closes both:

- **There is no release process.** Releasing means remembering to bump the version, getting it
  through a protected `main`, logging in to npm with a one-time password, and publishing whatever
  happens to be in the local checkout. Nothing guarantees the published tarball is the reviewed
  commit.
- **Nothing says what a release contains.** `npm publish` writes no changelog. The version notice
  (#12) tells a user a newer version exists and gives them no reason to want it.

---

## What will visibly change

- A maintainer runs **one command** to prepare a release. It opens a pull request containing the
  version bump, whose description is the generated release notes, ready to edit.
- **Merging that pull request publishes the release** from GitHub Actions. There is no npm token
  anywhere, and the package carries a provenance attestation linking it to the commit it was built
  from.
- Every release has a **GitHub Release** carrying its notes, linked from the README. That is the
  changelog.

---

## Decisions, agreed 18/11/2026

### 1. The changelog is the GitHub Release, and only that

No `CHANGELOG.md`. The notes are generated, reviewed in the release pull request, and published
as the GitHub Release for the tag. One place, nothing in the repository that can drift, and
nothing that anybody hand-edits after the fact. The README links to the Releases page.

### 2. A pull request belongs in the notes if, and only if, it changed a file the package ships

The package is `files` in `package.json`: `bin/`, `src/`, `public/`, `hooks/` and `README.md`.
**Use `files` itself, read at release time, not a copy of the list.** Of the eighteen pull requests
since 0.1.0, seven pass that test. The other eleven are docs, CI and roadmap process, which mean
nothing to somebody running `npm install`. The test is exact and mechanical, so it needs no label
convention that a contributor could forget.

`README.md` counts because it ships, and a user reading the notes would want to know the
documentation changed. That is a judgement call: it would include a docs-only README fix. Settle
it when the first notes are generated, by looking at what it lets in.

### 3. Titles from the pull request, not the spec

Spec titles are written as problems (*"Nothing tells anyone a new version exists"*). Pull request
titles say what you get (*"feat(cli): tell you when a newer Raise has been published"*). Group them
into **Features** and **Fixes** by the conventional prefix, strip the prefix, and link each entry to
its pull request and to the issue it closes. A shipping pull request whose prefix is neither goes
under **Other**, so it is never dropped. Hiding a change from the notes is the quiet-staleness
failure this project is built against.

### 4. Publishing runs in GitHub Actions with npm Trusted Publishing

The alternative was publishing locally from the script, which needs `npm login` and a one-time
password every time and publishes whatever is in the checkout. Rejected. Trusted Publishing
(npm docs: https://docs.npmjs.com/trusted-publishers) exchanges the workflow's OIDC token for a
publish credential, so:

- **no npm token exists**, to leak or to rotate;
- the published tarball is built from the merged commit and nothing else;
- npm **generates provenance automatically** for a public package from a public repository.

Requirements, from npm's docs as of 18/11/2026: npm CLI 11.5.1 or later, Node 22.14 or later,
`permissions: id-token: write`, GitHub-hosted runners only, and `repository.url` in `package.json`
matching the repository exactly. That is already true:
`git+https://github.com/mattwwatson/raise.git`.

**One-time setup on npmjs.com, by the maintainer.** In the package settings, add a trusted
publisher with the user `mattwwatson`, the repository `raise`, and the workflow filename,
case-sensitive and exact. npm does not validate it when saved, so a typo shows up only at publish
time. A new configuration must complete its first publish within two days or it expires, so add it
on the day of the first release.

### 5. Staged publishing: decide before building

Trusted publisher configurations created after 03/09/2026 default to **`npm stage publish`**. The
workflow stages the package, and a maintainer approves it with 2FA, on npmjs.com or with
`npm stage approve`, before it is public. Approval cannot use OIDC, so it is always a person.
Direct `npm publish` can be allowed as well.

**Recommendation: keep staging.** It is the one step where a compromised workflow still cannot
publish on its own, and it costs a single approval per release. The release pull request already
had a human review the contents, and this has a human confirm the artefact. Under staging, the
GitHub Release is created when the package is staged, so for the minutes before approval the
release page leads npm. Accept that, or create the Release as a draft and publish it from the
approval. Settle it with the build.

### 6. The tag is created by the workflow, never by hand

The workflow runs on a push to `main` and acts only when `package.json` carries a version with no
`v<version>` tag yet. It then tags that commit, publishes (or stages) it, and creates the Release
from the notes in the merged release pull request's description, so the edited notes are the ones
that ship. Every other push to `main` is a no-op. There is no local step after the merge except
the staged approval.

It must refuse, not publish, when:

- the version is not greater than the latest tag;
- the merge commit has no associated release pull request, so there are no reviewed notes to use;
- a pull request that changed the package merged after the notes were written (see Implementation
  notes);
- `npm test`, `lint` or `typecheck` fails. `prepublishOnly` already runs them, and that is kept as
  the last guard.

### 7. The preparing script

`scripts/release.js`, run as `npm run release -- <patch|minor|major>`. `scripts/` does not ship.
It uses Node builtins only, like the rest of the repository, and `gh` for GitHub. It:

1. checks that it is on `main`, the tree is clean, `main` is up to date with `origin`, and `gh` is
   authenticated;
2. finds the latest `v*` tag and lists the pull requests merged since it;
3. keeps the ones whose files touch `files` (decision 2), and renders the notes (decision 3);
4. creates `release/<version>`, runs `npm version <bump> --no-git-tag-version`, and commits;
5. pushes and opens the pull request with the notes as its description. It never merges it.

`--dry-run` prints the version and the notes, and changes nothing. That is also how the notes
logic gets tested by hand.

The rendering is a pure function from a list of pull requests (number, title, files, closing
issues) and the `files` list to Markdown, tested directly with fixtures, per AGENTS.md's
pure-versus-I/O rule. The `gh` calls are injected.

### 8. A one-off: tag 0.1.0

The first run needs a tag to count from. The published 0.1.0 tarball was compared on 18/11/2026
against `git archive` of `3a16735` (*"RAI-5: the epic's outstanding list is not outstanding any
more"*, the last commit before the publish at 20:02 AEST on 12/08/2026). It is identical apart
from `LICENSE`, which npm always adds. Tag `3a16735` as `v0.1.0`.

---

## Deliberately not in scope

- **Automatic version choice** from commit prefixes. The maintainer picks patch, minor or major.
  A pre-1.0 package's bump is a judgement, not a rule.
- **Telling users through the product.** Pointing the version notice at the Release URL would help.
  It is a change to what `raise serve` prints, so it is its own item, and it costs no outbound
  request.
- **Pre-releases and dist-tags.** Only `latest` is published.

---

## Acceptance

- `v0.1.0` is tagged at `3a16735`.
- `npm run release -- minor --dry-run` prints 0.2.0 and notes listing exactly the seven shipping
  pull requests since 0.1.0, grouped and linked.
- The notes renderer has direct unit tests: grouping, the `files` filter (with a docs-only pull
  request excluded), an unprefixed pull request kept under Other, and links to the issues closed.
- The publish workflow does nothing on an ordinary push to `main`, refuses in each case listed in
  decision 6, and publishes 0.2.0 with provenance on the real release. Check the provenance on
  npmjs.com afterwards.
- The README says where the release notes are.
- `npm test`, `npm run lint` and `npm run typecheck` pass.

---

## Implementation notes

- **`scripts/release-notes.js`** holds every rule and is pure: the `files` filter, grouping,
  links, the notes markers, `nextVersion`, `latestTag` and `planRelease`, the workflow's
  decision. It reuses `isNewerVersion` from `src/update-check.js` rather than a second version
  comparison. Tested directly in `test/release-notes.test.js`.
- **`scripts/release.js`** is the I/O: `npm run release -- <bump> [--dry-run]` and `ci`, the
  workflow's half, which writes `publish`, `release`, `tag` and `notes-file` to
  `$GITHUB_OUTPUT`. Pull requests since the last tag are matched by **merge commit within
  `tag..HEAD`**, not by date.
- **`README.md` does not count (decision 2, settled 18/11/2026).** On the first real notes the
  only README-only pull requests since 0.1.0, #8 and #17, were contribution process, so
  `NOT_NEWS` excludes it. #17 still appears under Other: it also changed comments in nine `src/`
  files, which is a change to shipped code. That is the rule working, and removing the line in
  review is what the review step is for.
- **The notes record which pull requests they were written from.** Branch protection on `main`
  requires the release branch to be up to date before it merges, and updating it can bring in a
  shipping pull request the notes never saw. That pull request is then an ancestor of the new tag,
  so no later release would list it either. So the release body carries a hidden
  `<!-- raise-release-prs: 18,21,23 -->` comment inside the markers, which `extractNotes` leaves
  out, and `ci` recomputes the shipping pull requests merged since the previous tag with the same
  rule the notes use. `planRelease` refuses when any of them is not on the recorded list, naming
  them, and when the list is missing. The check is against the recorded list and not the rendered
  lines, so deleting a line in review still releases.
- **The same check runs before the merge.** `node scripts/release.js check` is a step in CI's
  `Lint, tests and typecheck (Node 24)` job, on pull requests only, and does nothing on a branch
  that is not `release/<version>`. On a release pull request it reads the current description
  with `gh` and fails through the same `notesProblem` that `planRelease` uses, while the remedy -
  close it and run `npm run release -- <bump>` again from an up-to-date `main` - is still open.
  That job checks out with `fetch-depth: 0` so it can see the tags. After the merge the only
  remedy left is the next version, so that is what the workflow's refusal says.
- **The workflow skips only when the tag and its GitHub Release both exist.** A tag with no
  Release is a run that stopped after tagging, so the plan is `release-only`: the job creates the
  Release from the notes and does not stage or tag again. A `v0.1.0` GitHub Release was created
  for that reason, so the first run on `main` after this merges skips.
- **A release branch reads as untracked to `tasks:gate`** (`release/0.2.0` has no `-` after its
  digits). A test pins that, since a change to the gate's pattern would otherwise block every
  release pull request.
- **`.github/workflows/release.yml`**: Node 24, npm pinned to exactly 12.2.3 (`npm stage` is an
  npm 12 command; npm 12.2.3 needs Node ^24.15.0). Checks run in their own steps before
  anything is staged. It stages first and tags after, so a failed stage leaves no tag and a
  re-run tries again. A `concurrency` group stops two merges racing to one tag. The GitHub
  Release is created at staging (decision 5, accepted).
- **`v0.1.0` tagged at `3a16735`**, an annotated tag, pushed before this merged. Without it the
  workflow's first run on `main` would have found 0.1.0 untagged and refused.
- **Not verified until the first release:** Trusted Publishing itself, the staged approval and
  provenance. They can only be exercised by publishing. The 0.2.0 release is that check. Add the
  trusted publisher on npmjs.com (user `mattwwatson`, repository `raise`, workflow
  `release.yml`, no environment) on the day, since an unused configuration expires after two
  days.

---

## Recovery

- **The tag push failed after a successful stage.** A re-run would stage again, which npm
  refuses, and checking for an existing stage needs interactive auth, so this is left to fail
  loudly. Push the tag by hand at the release merge commit
  (`git tag v<version> <sha> && git push origin v<version>`) and re-run the job. It then finds the
  tag with no GitHub Release and creates only the Release.
- **The tag was pushed but `gh release create` failed.** Re-run the job; it creates only the
  Release.
- **A release run was cancelled by the `concurrency` group.** Re-run it from the Actions tab.
- **The workflow refused a merged release pull request whose notes miss a shipping pull request,
  or record no list.** CI's pre-merge check should have stopped it, so this means it was bypassed.
  That version will not be published. Prepare the next release with `npm run release -- <bump>`
  from `main`; its notes cover everything since the last tag, the missed pull request included.
