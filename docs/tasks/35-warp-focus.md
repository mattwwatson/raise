---
issue: 35
status: backlog
size: M
depends: -
---
# 35 - Clicking a session running in Warp does nothing useful

**Self-contained brief.** No prior conversation needed. Written 17/11/2026.

---

## What and why

Focusing supports iTerm2 and Terminal.app only (`ALL_TERMINALS` in `src/focus/terminals.js`).
A session in Warp, or in tmux inside Warp, offers `Focus ↗`, and clicking it brings nothing to
the front and shows *"Could not find that tab in iTerm2 or Terminal.app. It may have been
closed."* That is wrong: the tab is open, and Raise has no adapter for the terminal it is in.

**Warp cannot be asked to focus a specific tab.** It has no AppleScript dictionary and no API
that lists or focuses existing tabs. Its `warp://action/new_tab` deeplinks open new tabs only,
and the request to focus an existing tab by name or path is open upstream
(warpdotdev/Warp issue 8929). Other focus tools record Warp as supporting window-level focus
only.

So the most Raise can do is bring the Warp app to the front. For tmux inside Warp that is
still most of the job, because `selectPane` has already put the right pane in the tmux
client's window. For a plain Warp tab it is partial: Warp comes to the front on whichever tab
was last active.

---

## What will visibly change

Clicking a Warp session brings Warp to the front, and a neutral toast says Raise could not pick
the tab - *"Brought Warp to the front; Warp does not let Raise choose the tab."* It is never
shown as a plain success, because it is not one.

---

## Design questions to settle before writing code

### 1. Activating an app is not a match, so it needs positive evidence first

Every other adapter returns true only after finding the exact tab. Activating Warp whenever a
tty matches nothing would be a guess: the session might be in a terminal Raise has never heard
of. So the adapter must first establish that the tty really belongs to Warp:

- **Plain tab:** `TERM_PROGRAM=WarpTerminal` from the hook is reliable.
- **tmux:** `TERM_PROGRAM` comes from whenever the tmux server started and can be stale. Walk
  the attached client's pid up the process tree to Warp's process instead. The hook already
  does this kind of walk in `src/process-tree.js`.

Without that evidence, return false as today.

### 2. A partial result does not fit the adapter interface, and that must be stated

`focus` returns a boolean, and `focusTerminal` in `src/focus/index.js` turns `true` into a
silent success. There is no way for an adapter to say "brought the app forward, not the tab".
`FocusResult.note` already exists for exactly this meaning (*raised something less than what you
clicked*) and the page already shows it as a neutral toast, but only `index.js` can set it.

So this item changes the adapter interface: for example, `focus` may return `'app'` as well as
`true`/`false`, and `focusTerminal` maps `'app'` to `{ ok: true, note }`. CONTRIBUTING's first
condition says a change outside `terminals.js` means the abstraction is being broken and must
be said rather than worked around. This is that case, and it is the reason this item is not a
one-entry change. Settle the shape here before writing code.

### 3. Re-check upstream before building

If Warp has shipped tab-level focus by the time this is picked up, build to that instead and
drop question 2.

---

## Deliberately not in scope

- **UI scripting through System Events** to click through Warp's tabs. It needs an
  Accessibility permission grant and would be matching on visible tab names, which is a guess.
- **Opening a new Warp tab** with a deeplink. That is creating something, not focusing what is
  waiting for you.

---

## Acceptance

- A Warp session, plain and under tmux, brings Warp to the front on click and shows the note,
  verified by hand on a real Warp session (CONTRIBUTING condition 3).
- A tty with no positive evidence of Warp does not activate Warp, asserted by a test.
- The partial-result shape is documented in the `Terminal` typedef and in CONTRIBUTING's
  "Adding a terminal" section.
- Tests use the injected `fakeExec` only.
- `npm test`, `npm run lint` and `npm run typecheck` pass.
