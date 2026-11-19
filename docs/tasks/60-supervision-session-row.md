---
issue: 60
status: shipped
size: S
depends: -
branch: fm/60-supervision-session-row
shipped: 2026-11-19
---
# 60 - Firstmate's supervision session shows as a "Not tracked" row that never goes away

**Self-contained brief.** No prior conversation needed. Written 19/11/2026.

---

## What and why

While Firstmate is running, Raise shows an extra row for the Firstmate home:

```
Not tracked   firstmate  main
  Found on disk, never reported - restart the session and Raise will follow it
```

It is not the captain's session, which has its own tracked row. It is Firstmate's **supervision
session**: a headless Claude Code run that Firstmate starts in its home to watch its workers
between the captain's turns.

- Firstmate starts it as `claude -p --safe-mode`. Safe mode loads no hooks, so it never runs
  Raise's hook and never reports.
- It writes an ordinary transcript under `~/.claude/projects/<home>/`, so the untracked scan
  (`src/untracked.js`) finds a recent transcript no hook record accounts for, and shows it.
- Its records carry `"entrypoint": "sdk-cli"`, and its first prompt starts
  `MAIN DIALOG MIRROR (read-only context: ...`.

The row's advice is wrong for it - restarting changes nothing - and it comes back whenever
Firstmate is supervising. It is an agent of Firstmate's, not a session a person has open, which
is exactly why the scan already leaves out no-mistakes' pipeline agents.

## What will visibly change

The supervision session no longer has a row, on the page or in `raise status`. The captain's
own Firstmate session, in the same directory, keeps its row, and so does any other headless run.

## Decisions

**The decision comes from the transcript, not the path.** `isPipelineWorktree` excludes
no-mistakes' agents by where they run. That cannot work here: the supervision session runs in
the same directory as the captain's own session, so any path test hides both or neither.

**The first prompt, and only its start.** The scan reads the head of each Claude Code transcript
and finds the first prompt - the first `user` record that is not `isMeta` and carries text,
skipping records that are only tool results. The session is left out when that prompt starts
with either of two fixed texts from Firstmate. A session that merely quotes one, or says it in a
later prompt, keeps its row.

**Two prefixes, both from one Firstmate function.** Every supervision wake prompt is built by
`branchWakePrompt` in Firstmate's `.pi/extensions/lib/fm-branch-dispatch.ts`. When the wake
carries a dialog mirror - an attended wake on which something new was said - it opens with
`MAIN_DIALOG_MIRROR_HEADER`, `MAIN DIALOG MIRROR (read-only context: ...`. Otherwise - an away
wake, or nothing new said - it opens `FIRSTMATE SUPERVISION WAKE: `. A session's first wake can
be either, so matching only the mirror header, as the issue first proposed, would leave the row
on the page for every supervision session that started without a mirror. Firstmate ruled to
recognise both.

**`entrypoint: sdk-cli` decides nothing.** Every headless or SDK run writes it, and some of those
are sessions a person wants to see.

**The prefixes are pinned by a test.** They are Firstmate's text, so a rewording there brings the
row back. `test/untracked.test.js` pins both, and the full mirror header the first was taken from,
so that change is noticed in this repository rather than on a page.

**Claude Code transcripts only.** The supervision session is a `claude -p` run; pi and Codex
keep their prompts in records of their own shape, so reading their heads would be a read for
nothing.

**One head read per transcript, remembered once it cannot change.** A first prompt never changes,
so the answer is cached per path as soon as the head held a prompt, or as soon as the file is
longer than `HEAD_BYTES` - its head is then fixed and a prompt beyond it will never be read. A
short file with no prompt yet is still being written and is asked again on the next scan. A
transcript that cannot be read is answered "not supervision", so its row stays: unplaceable is
shown, never hidden.

`HEAD_BYTES` (64KB) holds the prompt. Measured on a live supervision transcript, the prompt was
the fourth record, about 9KB in behind an 8.7KB queue record repeating it, and Firstmate bounds
the mirror it carries at 16,000 characters.

**The page and `raise status` agree because they share the scan.** Both build their untracked
rows from `UntrackedScan`, so the filter is applied in one place; a test runs both against the
same transcripts and compares.

## Deliberately not in scope

- Hiding any other headless or SDK session.
- Any change to how tracked rows are built.

## Acceptance

- Both prefixes are pinned by a test.
- A transcript whose first prompt starts `MAIN DIALOG MIRROR` or `FIRSTMATE SUPERVISION WAKE:`
  is left out of the untracked rows.
- An `sdk-cli` transcript with any other first prompt still appears.
- The captain's own session in the same directory is unaffected.
- The page and `raise status` agree.

## Implementation notes

- `src/untracked.js` gains `FIRSTMATE_SUPERVISION_PROMPTS`, the pure `firstPrompt` and
  `isFirstmateSupervisionPrompt`, and a private `#isFirstmateSupervision` on `UntrackedScan`,
  called from `#scan` after the pipeline-worktree test for Claude Code roots only. Its cache is
  pruned with the cwd cache.
- `test/untracked.test.js` covers the pin, the exclusion under either prefix, the other headless run, a quoted or
  later prefix, the captain's session beside it, meta and tool-result records, pi and Codex never
  being read, and both caching rules. The fake filesystem now records which paths had their head
  read, because Claude Code transcripts are now read at the head for their prompt and an existing
  test counted head reads to show only a long Codex rollout needed one for its cwd.
- `test/cli-serve.test.js` runs `raise status` and the server's `/state` over one Firstmate home
  holding a supervision session under each prefix, the captain's session and another headless run, and checks
  both list the same two.
