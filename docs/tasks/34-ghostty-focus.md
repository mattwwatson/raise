---
issue: 34
status: shipped
size: S
depends: -
branch: 34-ghostty-focus
shipped: 2026-11-17
---
# 34 - Clicking a session running in Ghostty does not bring it to the front

**Self-contained brief.** No prior conversation needed. Written 17/11/2026.

---

## What and why

Focusing supported iTerm2 and Terminal.app only (`ALL_TERMINALS` in `src/focus/terminals.js`).
A session in Ghostty, or in tmux inside Ghostty, offered `Focus ↗`, and clicking it left Ghostty
behind whatever was in front of it, with a toast claiming the tab *"may have been closed"*.

Reproduced on 17/11/2026 against the running installation, with Ghostty 1.4.0 holding a plain
Claude Code tab and a tmux tab running Claude Code. `POST /focus` for each, exactly as a click
sends it:

```
plain tab   -> {"ok":false,"reason":"Could not find that tab in iTerm2. It may have been closed."}
tmux pane   -> {"ok":false,"reason":"Could not find that tab in iTerm2. It may have been closed.",
                "tmuxSession":"ghostty-test 🔔"}
```

(Only iTerm2 is named because Terminal.app was not running.) In both cases Raise already held
the exact tty Ghostty would need - the session's own for the plain tab, the attached tmux
client's for the pane. What was missing was an adapter to ask Ghostty for it.

---

## What changes

Clicking a session in Ghostty brings its window and tab to the front, for a plain tab and for
tmux inside Ghostty alike.

---

## How Ghostty is matched: by tty, like Terminal.app

**This spec was first written from a desk survey that said Ghostty could not be matched by
tty.** That was true of 1.3.0, whose AppleScript dictionary gives a terminal only an id, a
title and a working directory, and it led to a plan built on title and cwd matching, sized L.
Installing Ghostty showed it is out of date: **1.4.0's dictionary
(`Ghostty.app/Contents/Resources/Ghostty.sdef`) gives every `terminal` a `tty` and a `pid`.**
Checked live on 17/11/2026:

- Ghostty's tabs reported `/dev/ttys015`, `/dev/ttys017`, `/dev/ttys019` and `/dev/ttys020`,
  and `ps` agreed on each.
- `terminals whose tty is "/dev/ttys017"` returned exactly one terminal id; an unused tty
  returned none.
- The plain Claude Code session's hook record carried `tty: /dev/ttys017` and
  `term_program: ghostty`. The tmux session's attached client was on `/dev/ttys020`, Ghostty's
  fourth tab.

So the adapter is the Terminal.app shape: tty only, one entry in `terminals.js`, no hook change
and no change to the adapter interface. The dictionary's `focus` command focuses a terminal
and brings its window to the front.

### Older Ghostty

Before 1.3 there is no dictionary at all, and 1.3 has no `tty`. In both cases the lookup errors
or finds nothing, and the adapter returns false: the same answer as a tty Ghostty does not
hold. It does not try to work out a version, and it never falls back to title or cwd, which is
the guessing this spec originally planned and no longer needs.

### Two things seen in the tmux session's record

- `term_program` was `tmux`, not `ghostty`. It only orders the adapters, so Ghostty is still
  reached, just not first.
- It carried an **iTerm2 session UUID** although it was running in Ghostty - inherited from the
  tmux server, which was first started from iTerm2. The tmux path never reads it, so it is
  harmless today; anything that one day trusts that field for a tmux session would raise the
  wrong iTerm2 tab.

---

## Deliberately not in scope

- **Title or cwd matching**, for any Ghostty version.
- **tmux control mode in Ghostty.** Only iTerm2 hosts tmux that way, so the adapter has no
  `focusByTitle`.

---

## Acceptance

- Both of the reproduced sessions come to the front on click, checked by hand on the real
  Ghostty sessions (CONTRIBUTING condition 3).
- `test/focus.test.js` covers the script (matches on tty, escapes it, brings the window
  forward), and the adapter answering true, false on no match, and false on an error.
- The "no supported terminal is running" message names the terminals from the adapter list
  rather than a hard-coded pair, so the next terminal does not need to change it.
- README and CONTRIBUTING list Ghostty as supported.
- `npm test`, `npm run lint` and `npm run typecheck` pass.

---

## Implementation notes

- **`ghostty` in `src/focus/terminals.js`**, tty-only, placed after iTerm2 and Terminal.app in
  `ALL_TERMINALS`. Order only decides who is asked first; `orderedTerminals` still moves it to
  the front for a plain tab whose `TERM_PROGRAM` is `ghostty`.
- **Availability is asked by bundle id** (`application id "com.mitchellh.ghostty" is running`),
  not through System Events like the other two. Ghostty's process is `ghostty` and its app
  `Ghostty`, so a name match depends on which one System Events reports. The bundle-id form
  never launches the app and needs no System Events permission; an app that is not installed
  makes it error, which reads as not available.
- **`ghosttyFocusScript`** in `src/focus/applescript.js` looks up `terminals whose tty is ...`
  inside a `try`, so a Ghostty with no `tty` property answers `notfound`; then `focus` and
  `activate`.
- **One change outside the adapter list, in `src/focus/index.js`.** The "no supported terminal
  is running" message hard-coded "iTerm2 and Terminal.app", so every new terminal would have
  had to edit it. It now names the adapters it was given. This is the abstraction being
  repaired rather than worked around, as CONTRIBUTING asks.
- **CONTRIBUTING's example adapter** was a hypothetical `ghostty` entry, which would now read
  as describing the real one. It is a hypothetical `wezterm` entry instead, and the text points
  at `ghostty` as the smallest real example.
- **Verified by hand on 17/11/2026** against the two reproduced sessions, through the branch
  build on a spare port with a scratch `RAISE_HOME`: the plain tab came forward from tab 4 to
  tab 2, and the tmux pane brought Ghostty in front of iTerm2 on its own tab, each answering
  `{"ok":true,"adapter":"ghostty"}`.
