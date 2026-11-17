---
issue: 33
status: backlog
size: M
depends: -
---
# 33 - Clicking a session running in kitty does not bring it to the front

**Self-contained brief.** No prior conversation needed. Written 17/11/2026.

---

## What and why

Focusing supports iTerm2 and Terminal.app only (`ALL_TERMINALS` in `src/focus/terminals.js`).
A session in a kitty window, or in tmux inside kitty, is shown on the page and offers
`Focus ↗`, but clicking it does not bring kitty to the front:

- **Plain kitty tab:** no adapter recognises the tty, and the toast reads *"Could not find that
  tab in iTerm2 or Terminal.app. It may have been closed."* That is misleading, because the tab
  is open and Raise just has no adapter for the terminal it is in.
- **tmux inside kitty:** `selectPane` switches the right window and pane inside tmux, then
  the same adapter lookup fails. The pane is correct, but the window stays behind
  whatever is in front of it, and the same misleading toast appears.

Of the three terminals assessed on 17/11/2026 (kitty, Ghostty, Warp), kitty is the one that can
be matched as exactly as iTerm2, and the match fits the existing adapter interface with no
change anywhere else.

---

## What will visibly change

With kitty remote control switched on, clicking a session in kitty brings that kitty window and
tab to the front, for a plain tab and for tmux inside kitty alike. Without remote control
switched on, Raise says that is what is missing, rather than claiming the tab was closed.

---

## How kitty can be matched

kitty has a remote-control protocol driven by `kitten @`:

- `kitten @ --to <socket> ls` returns JSON for every OS window, tab and window, including each
  window's `id`, its child `pid` and its `foreground_processes` (each with a `pid`).
- `kitten @ --to <socket> focus-window --match id:<N>` focuses that window.

Raise is not a child of kitty, so it must talk to kitty over a socket. That only works if the
user has set both of these in `kitty.conf`:

```
allow_remote_control socket-only   # or yes
listen_on unix:/tmp/kitty
```

kitty appends `-<kitty pid>` to a `listen_on` path, so the real socket is `/tmp/kitty-12345`.

**The adapter receives a tty and nothing else, and that is enough.** The tty is the session's
own for a plain tab, and the attached tmux client's for a tmux pane. So:

1. List the processes on that tty (one `ps -t <tty> -o pid=`).
2. `kitten @ ls` and find the window whose `pid` or any `foreground_processes[].pid` is in that
   set.
3. `focus-window --match id:<N>`, then bring kitty to the front if `focus-window` does not
   already do that on macOS (to be tested - see question 3).

Both halves are positive evidence: a pid that kitty itself reports as running in a window,
matched against processes on the exact tty we were given. No title or cwd guessing.

---

## Design questions to settle before writing code

### 1. Finding the socket

Options, in order of preference to evaluate:

- **Capture `KITTY_LISTEN_ON` in the hook**, as `ITERM_SESSION_ID` is captured. Exact, but it is
  a new `host` field, so it is a change outside `terminals.js` and the adapter interface would
  have to pass it through. CONTRIBUTING says a change outside that file means the abstraction
  is being broken and must be said rather than worked around. That would apply here.
- **Find it from the running kitty process:** glob the configured `listen_on` path prefix, or
  match `kitty-<pid>` against the pid of the running kitty. Stays inside the adapter. The risk
  is a `listen_on` path we cannot predict.

Recommendation to test first: the second, since it keeps the change to one entry, and fall back
to the first only if it proves unreliable.

### 2. Remote control switched off

`isAvailable` should be true only when kitty is running **and** a socket answers. When kitty
is running but no socket answers, that is worth saying in the toast (*"kitty is running but
remote control is off - see README"*). Decide whether that message belongs in the adapter or
in the generic "could not find that tab" message in `src/focus/index.js`. Prefer not to touch
`index.js` for one terminal.

### 3. Does `focus-window` raise the app?

Unknown on macOS. If it only changes kitty's internal focus, follow it with an AppleScript
`activate` of kitty. Test on a real machine with kitty behind another app and on another
Space.

### 4. `termProgram`

Only used to decide the order adapters are tried in. kitty sets `TERM=xterm-kitty` and
`KITTY_WINDOW_ID`; confirm whether it sets `TERM_PROGRAM` at all before choosing a value.

---

## Deliberately not in scope

- **Writing `kitty.conf` for the user.** Remote control is a security decision for the user to
  make, not something `raise install-hooks` should switch on. The README states the two lines.
- **kitty on Linux.** Focusing is macOS-only today; the kitty protocol is the same on Linux,
  so this would be a reasonable later item, but only if somebody is running it there.

---

## Acceptance

- A plain kitty tab and a tmux pane inside kitty both come to the front on click, verified by
  hand on a real kitty session (CONTRIBUTING condition 3).
- `test/focus.test.js` covers both paths with the injected `fakeExec`: the `ps`, `kitten @ ls`
  and `focus-window` calls that would have run, a tty that matches no window (returns false),
  and kitty running with no socket answering.
- No file outside `src/focus/terminals.js` (and its tests and the README) changes, or the spec
  records why one had to.
- `npm test`, `npm run lint` and `npm run typecheck` pass.
