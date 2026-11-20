---
issue: 14
status: shipped
size: M
depends: 30, 56
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

**Record after #56 has shipped in a release, and record from the installed package.** The click
in the loop opens a session in a new tab (#56), and the demo should show what someone who
installs Raise gets, not a checkout.

## What is in shot

Four real sessions, each running a different way. The page does not name the terminal app: a
row's chip says only `herdr`, `tmux` or `tab`, and iTerm2 and Ghostty are both `tab`. So the
range shown is those three chips, plus the terminal the click brings forward:

| Session | Repo | Runs in | Chip |
| --- | --- | --- | --- |
| A Firstmate session, waiting on the captain about a crewmate's decision | Firstmate (the upstream home) | Herdr | `herdr` |
| A Firstmate crewmate whose no-mistakes pipeline is waiting on a decision, so its `NO-MISTAKES` line and the decision row show | raise | Firstmate's tmux | `tmux`, `firstmate` |
| A session doing ordinary work | another of the maintainer's projects | an iTerm2 tab | `tab` |
| **The one that stops and waits for an answer** | a third project | a detached tmux session, so **nothing is showing it** | `tmux` |

The session clicked last is one nothing is showing, so the click opens it in a new tab (#56).
Turn that on with `raise enable new-tab` before recording.

**Not in shot, ever:** any work or client repository, any project whose content is not safe
to publish, and anything outside these four repositories. Which private projects appear is
decided outside this repository.

## The loop, beat by beat

1. The dashboard. Hold long enough to read it (2-3 s).
2. A click on the Firstmate row brings its Herdr terminal forward, showing the decision it is
   waiting on; then back to the dashboard.
3. One session changes to *Waiting for you* and moves to the top.
4. The cursor moves to it and clicks.
5. A new tab opens and comes to the front, attached to that session and showing the agent's
   question. No window was showing it before the click.
6. Back to the dashboard. This does not match frame 1, because the session that stopped is now
   at the top, so the loop jumps when it repeats. Accepted: a loop that ends where it started
   would have to undo the one change it exists to show.

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
  - The private projects in shot: give their sessions tasks on code, not data. Nothing about a
    real person (names, phone numbers, emails) may appear anywhere on screen.
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
