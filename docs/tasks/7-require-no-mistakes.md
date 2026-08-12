---
issue: 7
status: shipped
shipped: 2026-08-12
size: S
depends: -
branch: 7-require-no-mistakes
---
# 7 - Require contributions to go through the no-mistakes pipeline

The first item keyed by its GitHub issue number rather than a Jira key, which is the convention
RAI-5 established and this is the first use of.

## Why this is defensible here, when it was argued against a day earlier

The initial answer to *"can we require no-mistakes?"* was no, on three grounds. Two of them were
wrong or have weakened, and recording which is the point of this section - a reversal nobody can
retrace is one somebody re-argues from scratch.

- **"A contributor cannot obtain it."** *Wrong.* `no-mistakes` is public at
  `github.com/kunchenguid/no-mistakes` and installs from a curl script. The supporting fact -
  that the npm package named `no-mistakes` is an unrelated static-analysis tool by a different
  author - is true and remains a live trap for anyone told to "install no-mistakes", which is
  why `CONTRIBUTING.md` names the install method rather than the tool.
- **"It cannot be verified."** *Still true, and unchanged.* See below.
- **"It contradicts the stated contribution posture."** *Weakened.* RAI-8 set a deliberately low
  bar for a terminal adapter, and this raises it. Accepted knowingly: the pipeline is what keeps
  a contribution from arriving as a diff a human has to reason about unaided, and this project's
  whole claim is that the reasoning is written down.

## What the check actually checks

`no-mistakes` writes a `## Pipeline` section into the pull request body containing:

```
Updates from [git push no-mistakes](https://github.com/kunchenguid/no-mistakes)
```

The workflow greps for that. **It is a convention check and not proof**, and the naming has to
say so: a job called *"this PR went through no-mistakes"* asserts something a `grep` of a
user-editable field cannot know. It gates against not knowing the process. It does not gate
against deciding to skip it, and it is not pretending to.

That honesty is not decoration here. This repository refuses a confident claim it cannot stand
behind on every card it renders; a CI check that overstated its own evidence would be the same
failure wearing a different hat.

### The attestation is the better signal and is deliberately not used

`no-mistakes` also writes a machine-readable line:

```
<!-- no-mistakes-pipeline-attestation:v1 {"head_sha":"a546d0a…","steps":[{"step":"review","status":"completed"},…]} -->
```

A `head_sha` bound to the pull request would defeat copy-paste from another PR, which is
strictly stronger than a prose grep. **Measured before building on it, across six merged
firstmate pull requests: the SHA matched the PR head on three of six.** The attestation is
written when the body is written, and any later push moves the head without rewriting it. A
check gated on it would fail legitimate pull requests - a false failure in the gate that is
supposed to be teaching people the process, which is worse than not gating at all.

Revisit only if `no-mistakes` starts rewriting the attestation on every push. The steps array
has the same problem in a milder form: at the moment the PR is opened, `pr` is `running` and
`ci` is `pending`, so "every step completed" is never true when the check first runs.

## The sequencing, which is the part that can brick the repository

`main` requires a pull request, both CI jobs, and carries `enforce_admins`. So a required check
that can never pass locks the repository for **everybody, the maintainer included** - there is
no bypass to fall back on, and that includes the pull request that would remove the check.

Every `no-mistakes` run this repository has ever done pushed to Bitbucket. Whether it can open a
**GitHub** pull request is unverified: its `--help` names no forge or provider, and this repo has
no `.no-mistakes.yaml`, while firstmate's repository has one.

So, in order:

1. **This change lands the workflow unrequired.** It runs, it reports, it cannot block a merge.
2. **A throwaway change is pushed through `no-mistakes`** to prove it opens a GitHub pull
   request and writes the marker. That also settles the open question left by RAI-5.
3. **Only then** is `PR must be raised via no-mistakes` added to the required status checks.

Doing 1 and 3 together is the failure mode. It is cheap to avoid and expensive to undo.

## Documentation, and which document was actually wrong

- **`CONTRIBUTING.md`** - the load-bearing change. It said `npm test`, `npm run lint`,
  `npm run typecheck`, then *"All three pass, or it is not ready."* Once the pipeline is
  expected that sentence is not incomplete, it is **false** - it tells a contributor they are
  ready when their pull request will fail a check. It also mentioned `no-mistakes` zero times.
- **`AGENTS.md`** - what CI runs is enumerated there, and a third workflow that can block a
  merge belongs in that enumeration, with a safe-change rule so it is not later deleted as
  duplicating `ci.yml`.
- **`README.md`** - one clause. Its Development section already delegates the contribution bar
  to `CONTRIBUTING.md`, and that delegation stays true, so nothing structural moves.

## What is deliberately not built

- No verification that the pipeline ran. See above; it is not possible from a pull request.
- No `head_sha` or step-status gating, for the measured reason above.
- No second CI system, and no change to what `ci.yml` checks.
- **No exemption for the maintainer.** firstmate's equivalent check is bypassed in practice -
  their PR #2191 carries neither marker nor attestation and merged - because their
  `enforce_admins` is off. Ours is on, and stays on. A rule the author does not follow is one
  contributors correctly ignore.

## Acceptance

- A pull request without the marker fails the check, with a message naming the install command
  and `git push no-mistakes`.
- Bot-authored pull requests are exempt.
- `npm run lint`, `npm test`, `npm run typecheck` and `npm run tasks:links` stay green.
- `CONTRIBUTING.md` no longer tells a contributor three green commands mean they are ready.
- The check is **not** in the required set when this merges.

## Implementation notes

Shipped 12/08/2026.

**The check was verified against a real pipeline body, not just against itself.** Pulled the
body of a merged firstmate pull request and ran the exact `grep -qF` the workflow runs: it
matches. An ordinary body does not, and the bare words *"Updates from git push no-mistakes"*
without the link do not either - `-F` makes the whole marker literal, so the URL is part of what
must be present rather than decoration.

**A hostile body was tried, and this is why the body goes through the environment.** A pull
request body is written by anyone who can open one, and `${{ }}` inside a `run:` block is
substituted by the runner *before the shell sees it* - so a body containing `$(…)` in an
interpolated script would execute on the runner. Passing it as `env:` and reading `$PR_BODY`
inside the script means the shell only ever sees data. Confirmed with a body of
`x$(touch /tmp/PWNED)\`id\`; rm -rf /`: no match, and nothing ran.

**This pull request fails its own check, and that is correct.** It was not raised through the
pipeline, because the pipeline's ability to open a GitHub pull request is the very thing step 2
exists to establish. The check is not in the required set, so the red mark is a report rather
than a block - which is the whole reason the sequencing puts step 3 last.

**`edited` is in the trigger list for a reason worth keeping.** The pipeline writes its section
into the body, and on some orderings that is an edit to a pull request that already exists.
Without `edited`, a pull request that legitimately gained the marker would keep a failed check
with no way to clear it short of a fresh commit.
