---
issue: 14
status: backlog
size: M
depends: 30
---
# 14 - Record the demo

**Self-contained brief.** No prior conversation needed. Written 19/11/2026, from issue #14 and
[RAI-1 Phase 4](RAI-1-open-source-release.md#phase-4---the-demo).

---

## What and why

A loop of about 20 seconds that shows what Raise does without any words: several agent sessions
working, one stops and wants an answer, it rises to the top of the page, a click on it brings
its window to the front. RAI-1 is blunt about its weight: **it is the pitch, and it outweighs
everything written about the project.** The README opens with a text mock-up of the dashboard
because there was nothing better to open with.

One recording serves every place Raise is shown: the top of the README, the Firstmate Discord
showcase, and a LinkedIn post and profile.

A second, cheaper asset: **a still of the expanded row panel**, the feature people do not expect
and the one that reads as "someone thought about this".

## When

**Record after #30 has been worked in a Firstmate home running upstream Firstmate** (hence
`depends: 30`). The loop shows a Firstmate task label, and Raise's Firstmate integration was
built against a fork of Firstmate. Recording against upstream means the label in the demo is
what an upstream user will see. Writing this spec does not wait.

## What is in shot

Four real sessions, each in a different repo and a different way of running, so the loop shows
the range of terminals Raise supports without saying so:

| Session | Repo | Runs in |
| --- | --- | --- |
| A Firstmate session, so its task label shows | Firstmate (the upstream home) | Herdr |
| A worker with a no-mistakes pipeline running, so its `NO-MISTAKES` line shows | raise | Ghostty |
| A session doing ordinary work | hexbattle | iTerm2, inside tmux |
| **The one that stops and waits for an answer** | sls-scheduling | Herdr or Ghostty - pick whichever focus looks clearest on screen |

Which session does what can be swapped while rehearsing; the requirement is that the four
terminals and both optional signals (Firstmate, no-mistakes) appear.

**Not in shot, ever:** basicaccounting, cto-plan, any Moroku or client repo, and anything
outside these four repos.

## The loop, beat by beat

1. The dashboard, four sessions, all working. Hold long enough to read it (2-3 s).
2. One session changes to *Waiting for you* and moves to the top.
3. The cursor moves to it and clicks.
4. Its window comes to the front, showing the agent's question.
5. Back to the dashboard, matching frame 1 closely enough that the loop has no visible jump.

## How it has to be made

- **Real sessions, not mocks.** The whole argument of this project is that it does not assert
  what it cannot stand behind; a faked demo of a tool built on that claim would be a poor joke.
  Staging is fine (choosing the prompts, timing when the session stops); faking the page is not.
- **No narration, no music, no captions, no landing page.** One loop that explains itself.
- **Pixel-check the page before recording.** Fixed window size, no half-drawn rows, nothing
  clipped or wrapping awkwardly, nothing showing that would look odd to a stranger (a stale
  row, a debug label, an error). If the page looks off in the recording it looks off to everyone
  who ever sees the project. Record in light or dark mode, not both.
- **Everything visible is publishable.** Row titles show branch names, and the expanded panel
  shows conversation text. Every prompt, branch name, file name and terminal line in shot must
  be safe to publish:
  - sls-scheduling: give its session a task on code. Nothing about the club's members (names,
    phone numbers, emails) may appear anywhere on screen.
  - No tokens, no account names, no client names, no notifications from other apps. Turn on Do
    Not Disturb and hide the menu-bar items that show personal details.

## Formats

Record once with macOS screen recording, then export:

- **GIF** for the README and Discord, sized for the README column, small enough to load quickly
  (check GitHub's current limit for images in a README).
- **MP4** for LinkedIn, which plays video natively. Check its current size, length and aspect
  ratio rules before exporting.
- **PNG** of the expanded row panel, at the same window size as the recording.

The limits above are deliberately not written down here: they change, and should be checked on
the day.

## Done means

- The GIF, the MP4 and the still all exist and have been pixel-checked by Matt.
- The GIF replaces the text mock-up at the top of the README, with the still further down where
  the README explains expanding a row.
- The assets live in the repository, or wherever the README can link to them for good, so the
  README never shows a broken image.
- This spec is marked `shipped`.

## Not in scope

- A longer walkthrough video, a landing page, or a demo of every feature.
- Recording on Linux. Focusing is macOS-only (#36).
