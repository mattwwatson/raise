---
issue: 58
status: shipped
size: S
depends: -
branch: fm/58-firstmate-worker-summary
shipped: 2026-11-19
---
# 58 - Every Firstmate worker's row says "Firstmate operational inbox message"

**Self-contained brief.** No prior conversation needed. Written 19/11/2026.

---

## What and why

A row's summary line is Claude Code's own title for the session, read from the last `ai-title`
record in its transcript. Claude Code writes that title from the session's first prompt and does
not change it afterwards.

Current Firstmate no longer sends a worker its brief as the first prompt. It types a pointer to a
file that holds the brief:

```
: Firstmate operational input waiting: read '<home>/state/operational-inbox/<id>.msg' and handle its contents as Firstmate operational input.
```

So Claude Code names every worker after the pointer - "Firstmate operational inbox message" - and
with several workers running, every row carries the same line and it tells you nothing about any
of them.

## Decided in the issue

1. **Show the task id from the fleet snapshot** (`raise-30-draft-pr-state`). Raise already reads
   the snapshot to place firstmate rulings, so this needs no new read of anything Firstmate owns.
   Reading the brief instead would make Raise depend on a Firstmate file whose format it does not
   control.
2. **Replace the summary only when it is the doorbell's wording, recognised from the session's
   first prompt rather than from the generated title.** The title is written by a model and its
   wording varies; the pointer is fixed text in Firstmate's `bin/fm-operational-input.sh`. A test
   pins the prefix so a change to it in Firstmate is noticed. A worker whose title was prompted by
   anything else keeps it.
3. **`raise status` and the page show the same text**, as for every other row.

## Design

- **The prefix is `: Firstmate operational input waiting:`, leading `: ` included.** The issue
  wrote it without the colon; Firstmate's own `FM_OPERATIONAL_DOORBELL_PREFIX` has it, and five
  worker transcripts on this machine all carry it. Matching the exact text Firstmate writes keeps
  the test honest about what it pins.
- **The first prompt comes from the head of the transcript.** The summary is read from a 128KB
  tail, and the first prompt of a long session is far outside it - measured at about 22.8KB from
  the start, behind Claude Code's bookkeeping records. So `TranscriptReader` reads the first 64KB
  once per transcript and keeps the answer: a transcript is only appended to, so the first prompt
  never changes. A tail that already holds the whole file answers it without the head read. The
  first prompt is found with the same "a person speaking" rule the expanded panel uses, and only
  its first 200 characters are kept.
- **A first prompt we cannot see is unknown, never guessed.** If it is cut by the end of the head
  window, the answer is null for good rather than the prompt after it; if the head cannot be read
  at all, nothing is settled and it is tried again.
- **The task is placed by the join that already places rulings** - the pinned window name, then
  the worktree - under the same ambiguity rules. A worker with no task placed on it keeps its
  title: a name we cannot place belongs to nobody.
- **The replacement lives in `dashboard.js` (`sessionSummary`)** and both renderers print
  `Row.summary`, so they cannot disagree.

## Deliberately not in scope

- Reading Firstmate's brief or inbox files.
- Any change to rows that are not Firstmate workers, including the untracked-session rows (#60
  is about Firstmate's supervision session appearing as one).

## Acceptance

- A test pins the doorbell prefix against a real worker's first prompt record.
- A worker row whose first prompt is the doorbell shows its task id.
- A session whose first prompt is anything else keeps its generated title.
- A worker row with no matching fleet task keeps its existing summary.
- The page and `raise status` show the same text for the same row.

## Implementation notes

- `src/transcript.js`: `firstPrompt(records)`, `OPENING_BYTES` (64KB) and `FIRST_PROMPT_CHARS`
  (200); `TranscriptSummary.firstPrompt`, always null from `summariseTranscript`.
- `src/transcript-reader.js`: `readHead` on the injected file access, and `#firstPrompt`, which
  fills the field and keeps a settled answer per path in its own map, pruned with the cache.
- `src/dashboard.js`: `FIRSTMATE_DOORBELL`, `sessionSummary(summary, taskId)`, and a
  `sessionTasks` map filled where `buildRows` places a task on its single claimant.
- Tests: `test/transcript.test.js`, `test/transcript-reader.test.js`, `test/dashboard.test.js`
  (the prefix pin and the replacement rules), and `test/cli-status.test.js` (the page and
  `raise status` agree, end to end, with a stand-in fleet snapshot).
