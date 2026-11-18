---
issue: 42
status: backlog
size: S
depends: -
---
# 42 - Focusing a tmux session switches your tab away from what it showed, without saying so

**Self-contained brief.** No prior conversation needed. Written 18/11/2026.

---

## What and why

To focus a session in tmux, Raise picks an attached tmux client, runs `select-window` and
`select-pane` in that client's session (`selectPane` in `src/focus/tmux.js`), then brings the
client's terminal tab forward. For an ordinary (non-control-mode) client that tab shows one tmux
window at a time, so selecting the session's window **replaces whatever that tab was showing**.

Often that costs nothing - a tab you attached only to watch workers. But when the tab was
showing something you were using, it disappears from view, and the click reports a silent
success. The concrete case: firstmate runs its crewmates as windows of one tmux session. If the
captain Claude itself runs in window 0 of that same session and is the only attached client,
clicking a crewmate switches the captain's tab to the crewmate, and the captain is out of view
until you select window 0 again. Nothing says that happened or how to get back.

This is the same trade the Herdr spec (#40) makes with `terminal.show`, and there it is
announced with a note. Here it is silent, which is the inconsistency to fix.

### A second case with the same cause

`selectPane` runs **before** the terminal adapters look for the client's tab. If the client is
in a terminal Raise cannot raise (one with no adapter), the click fails - but the tmux view has
already been switched. The failed click changed what a tab shows and brought nothing forward.

### What it does not affect

- **Control mode (iTerm2 `tmux -CC`).** Each tmux window is its own native tab, so nothing is
  hidden; and the control-mode path already skips `selectPane`.
- **A client already showing the target window.** `select-window` is a no-op there.
- **A session with no attached client.** Raise refuses with the `tmux attach` hint and moves
  nothing.

---

## What will visibly change

- A click that switches a tab away from a different window still succeeds, and the neutral
  note toast says what moved, e.g. *"Your tmux tab was showing window 0 (zsh). It now shows
  window 1 (fm-sls-257)."*
- A click that switches nothing (the tab already showed that window) stays silent, as today.
- A click that fails after switching puts the tab back on the window it was showing, so a
  failed click changes nothing.

---

## Design

1. **Read the client's current window before selecting.** One more tmux call, aimed at the
   chosen client's session by id as every other call already is:
   `display-message -p -t <sessionId> '#{window_id}\t#{window_index}\t#{window_name}'`.
   If it fails, proceed as today with no note - a reading we did not get is not evidence.
2. **If the current window is not the target window**, `selectPane` reports the window it
   replaced, and `focusSession` in `src/focus/index.js` turns a successful raise into
   `{ ok: true, note }`. `FocusResult.note` already exists for exactly this meaning (*raised,
   but not only the thing you asked for*) and the page already shows it neutrally, so the page
   needs no change. Window names are user data; the page renders the toast with `textContent`,
   so no escaping is needed beyond what that gives.
3. **If the raise fails after a switch**, run `select-window` back to the window read in step 1
   before returning the failure.

All three are inside the tmux path; no terminal adapter changes.

### Open questions to settle before writing code

- **Note, or refuse when the hidden window holds another live session Raise is tracking?**
  Recommendation: note only. A click is an explicit request to see that session, and refusing
  would make the captain-in-tmux arrangement unable to reach its crewmates at all. Naming the
  hidden session in the note (*"... was showing the captain"*) is worth considering if it is
  cheap to look up.
- **The note does not name a key.** The prefix key is user configuration, so the note names the
  window, not `Ctrl+B 0`.
- **The toast lasts 3.2 seconds**, which is short for a two-sentence note. Check by hand whether
  it is readable; lengthening it for notes only is a page change and would need stating.

---

## Deliberately not in scope

- **Choosing a different client to avoid the switch**, e.g. preferring a client whose window
  holds no other session. `chooseTmuxClient` ranks clients for reasons recorded in its header,
  and this item only reports what the chosen one did.
- **Switching a client to another session** (`switch-client`). Raise never moves a client
  between sessions, and this does not change that.

---

## Acceptance

- A test asserts the note when the client's current window differs from the target, and no note
  when it is the same.
- A test asserts the window is selected back when the raise fails after a switch.
- A failed `display-message` gives today's behaviour with no note, asserted by a test.
- Checked by hand: a captain in window 0 of a session, clicking a crewmate in window 1, shows
  the note and the toast is readable.
- Tests use the injected `fakeExec` only.
- `npm test`, `npm run lint` and `npm run typecheck` pass.
