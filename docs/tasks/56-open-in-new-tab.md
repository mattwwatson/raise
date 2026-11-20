---
issue: 56
status: backlog
size: M
depends: -
---
# 56 - Focusing a tmux or Herdr session that nothing is showing opens it in a new tab

**Self-contained brief.** No prior conversation needed. Written 19/11/2026.

---

## What and why

Clicking a row whose session runs in tmux or Herdr raises the terminal tab that is showing it.
When nothing is showing it, the click fails and the toast gives a command to run yourself:

- **tmux, no client attached:** `focusSession` in `src/focus/index.js` gets `detached` from
  `resolveTmuxTarget` and returns *tmux session "x" is not attached to any window*, with a
  `tmux attach -t ...` hint.
- **Herdr, no typed `hc attach` tab and no desktop app pane:** `focusHerdr` either shows the
  terminal in the Herdr app's focused pane, which replaces what that pane showed (step 3), or
  refuses with *Not shown anywhere Raise can see* and an `hc attach <address>` hint (step 4).

In every one of those cases Raise already knows the exact command that would show the session.
The click asks to see the session, so with this setting on Raise runs that command itself in a
new tab of the terminal you named, and brings it to the front.

---

## What will visibly change

- **A new opt-in, `raise enable new-tab`.** It writes the terminal to open in, and refuses to
  guess when several are running.
- **With it on**, clicking a tmux session with no attached client, or a Herdr session that no
  tab and no app pane shows, opens a new tab in that terminal's front window running the attach
  command, and brings it forward. No toast: the tab arriving is the feedback, as for every
  successful focus.
- **With it on**, a Herdr session the app has no pane for opens in a new tab rather than
  replacing what the app's focused pane was showing.
- **The next click on the same session raises that tab** through the existing paths, because
  the tab Raise opened is an attached tmux client, or a typed `hc attach`.
- **With it off**, nothing changes.

### Not in scope

- **#42**, a tmux tab switched away from the window it was showing. This item only opens a tab
  when no tmux client is attached. A second client attached to the same session cannot fix #42:
  tmux keeps the current window per session rather than per client, so selecting the window in
  the new tab switches the old tab too. Avoiding that needs a grouped session
  (`tmux new-session -t`), which adds sessions to `tmux ls`; that was considered and rejected
  for this item. #42 keeps its own plan.
- **Linux** (#36). Opening a tab is AppleScript, like the rest of focusing.
- **Detecting the terminal.** See *Which terminal* below.

---

## Decisions

Settled before writing the spec; each one has its reason here so a later session does not
reopen it by accident.

### Which terminal: named in config, never detected

The session's recorded `TERM_PROGRAM` cannot say which terminal to open:

- for Herdr it is always Herdr's own `ghostty`, whichever app you use;
- for tmux it is whatever terminal started the tmux server, which may be stale.

Choosing from either is a guess presented as a fact, against *positive evidence, never
absence*. So the terminal is a value in config, named once by the user.

### The setting: a third feature, written by `raise enable`

```json
"newTab": { "enabled": true, "terminal": "iterm2" }
```

`terminal` is one of `iterm2`, `ghostty`, `terminal-app`: the `name` of an entry in
`ALL_TERMINALS`, so there is no second list to keep in step.

- `raise enable new-tab` sets `enabled: true` and, when `terminal` is not already set, writes
  the one supported terminal that is running. With several running it refuses and lists them;
  with none running it refuses and says to start one or name it. The user can then write
  `terminal` by hand, or the command can take the name as an argument; settle which while
  building, but **refuse an unknown terminal name** rather than writing a key nothing reads.
- `raise disable new-tab` writes `enabled: false` and keeps `terminal`, per the existing rule
  that `disable` writes `false` rather than deleting.
- `CONFIG_FEATURES` in `src/user-config.js` gains a third entry. Its header says *"a closed set
  of two, deliberately"*; that becomes *"a closed set"*, keeping the reasoning about typos
  succeeding, which is unchanged. This is the first feature that writes a value besides
  `enabled`, so `setFeature` needs the extra field, and the decision index row about the closed
  set is updated to match.
- `watched: true`. The setting is read at click time, so a running `raise serve` follows it
  without a restart.
- `raise doctor` reports it like the other two, naming the terminal when it is on.

### Where: a new tab in the front window

A tab in the named terminal's frontmost window, or a new window when it has none. If the
terminal is not running, AppleScript starts it: the user named it, so starting it is what was
asked for.

### When it applies, and what still wins

The new tab is a fallback, after every existing way of showing the session:

| Path | Today | With the setting on |
| --- | --- | --- |
| tmux, a client attached | raise its tab | unchanged |
| tmux, no client attached | refuse, `tmux attach` hint | **new tab** |
| Herdr, typed `hc attach` tab | raise it | unchanged |
| Herdr, app has a pane for it | raise the app on that pane | unchanged |
| Herdr, app running, no pane | show it in the app's focused pane, with a note | **new tab** |
| Herdr, nothing | refuse, `hc attach` hint | **new tab** |
| Herdr, two typed attaches (ambiguous) | refuse | unchanged - two tabs already show it, so a third is not the answer |

If opening the tab fails, the result is today's refusal with the same hint, so the user is
never worse off than with the setting off.

### Herdr: the menu attach

A session attached by picking it from `hc`'s menu is invisible to Raise today (the client's
command line says only `hc`). With the setting on, clicking it opens a typed `hc attach` in a
new tab, so it can now be shown, and later clicks raise that tab. The menu tab stays as it was.

---

## Design

### The terminal interface

Add an optional method to `Terminal` in `src/focus/terminals.js`, as `focusByTitle` already is:

```js
/** @property {(exec: Function, target: {argv: string[]}) => Promise<boolean>} [openTab] */
```

It takes an **argv array**, never a command string. Each adapter quotes it for its own path,
once, in `src/focus/applescript.js`:

- **iTerm2:** `create tab with default profile command "..."` on the current window, or
  `create window with default profile command "..."` when it has none.
- **Terminal.app:** `do script "..."` in a new tab, or a new window when there is none.
- **Ghostty 1.4:** `new tab` (or `new window`) with a `surface configuration` whose `command`
  is the attach command. Checked on 19/11/2026 against the `Ghostty.sdef` shipped in 1.4.0,
  which has `new tab`, `new window`, `new surface configuration` and a `command` property. Check
  whether `command` is run through a shell or split; quote for whichever it is.

Then `activate`, as the focus scripts already do.

All three terminals implement it, so this extends the interface rather than adding a terminal.
The *"a new terminal is one entry"* rule is unaffected: a fourth terminal implements
`openTab` in its own entry or does without it, and a missing `openTab` means this fallback is
not available in that terminal.

### Escaping

The command crosses two quoting layers, a shell and an AppleScript string literal, and it is
built from values a hook reported. Every value is `shellQuote`d (`src/focus/tmux.js`) and the
result escaped for AppleScript (backslash and double quote). Tests assert the exact script for
awkward values: a socket path with a space or a single quote, and a tmux session id. Herdr
addresses are already checked by `isHerdrAddress` (`src/focus/herdr.js`).

### tmux

1. On `detached`, run `select-window` / `select-pane` for the pane first (`selectPane`), so the
   new client opens on the right window.
2. Open `tmux [-S <socket>] attach-session -t <session id>`. The socket comes from the
   session's `$TMUX` (`socketArgs` in `src/focus/tmux.js`, the existing `-S` handling); the target is the `$N` id,
   never the name, per the rule in `src/focus/tmux.js`.
3. Check `window-size` behaviour: with tmux's default `latest` a new client resizes the
   session to itself, which is what a user looking at it wants. Note the outcome in
   Implementation notes.

### Herdr

`attachHint` in `src/focus/herdr.js` already builds the command, including `HC_SOCKET` for a
non-default server. Build the argv from the same inputs rather than parsing the hint. For a
non-default server the environment variable needs to reach the new tab: either `env
HC_SOCKET=<socket> hc attach <address>` as argv, or the adapter's own environment option
(Ghostty's `environment variables`); pick one and use it for every terminal.

In `focusHerdr`, when the setting is on, the new tab replaces step 3 (app running, no pane) and
step 4 (nothing). Steps 1 and 2 and the ambiguous refusal are unchanged.

### Wiring

`focusSession` takes the setting as a parameter, defaulted at the edge (`server.js` reads it
through `user-config.js` at click time), so `focus/index.js` stays free of file access and the
tests pass it directly.

---

## Documentation

Update `README.md` in the same pull request:

- **Requirements list near the top.** The Herdr bullet says Raise cannot raise a session
  attached by picking it from `hc`'s menu. Add that with the new-tab setting on, Raise opens a
  new tab to show a tmux or Herdr session that nothing is showing, including one attached from
  the menu. Same for the tmux bullet: a detached session is no longer only a hint.
- **How focusing works** (*"If the session is detached there is no window to focus, and Raise
  tells you the `tmux attach` command"*) and **Herdr sessions** (steps 3 and 4, and the
  *"Attach with the address"* paragraph): say what happens with the setting on.
- **A new section for the setting**, beside the other two opt-ins: what it does, how to turn it
  on, how the terminal is chosen, and that it makes no outbound request.
- **Commands table:** add `new-tab` to `raise enable` / `disable`.

---

## Acceptance

- [ ] `raise enable new-tab` writes `newTab.enabled: true` and the only running supported
      terminal; refuses with several or none running; refuses an unknown terminal name.
- [ ] `raise disable new-tab` writes `enabled: false` and keeps `terminal`.
- [ ] `raise doctor` reports the setting and the terminal.
- [ ] Each adapter's `openTab` script is asserted exactly in tests, including a socket path
      with a space and a single quote.
- [ ] tmux, no client attached, setting on: a new tab opens on the session's pane; the next
      click raises that tab. Setting off: unchanged refusal and hint.
- [ ] Herdr, app running with no pane, setting on: a new tab rather than the app's focused
      pane. Nothing showing it: a new tab. Next click raises the tab through the typed-attach
      path. Ambiguous typed attaches: unchanged refusal.
- [ ] A session on a non-default tmux socket and a non-default Herdr server opens correctly.
- [ ] Opening the tab fails: today's refusal and hint.
- [ ] Checked by hand in iTerm2, Terminal.app and Ghostty 1.4, for tmux and Herdr.
- [ ] README updated as listed above; `CONFIG_FEATURES` header and the decision index updated.
- [ ] `npm test`, `npm run lint`, `npm run typecheck` pass.
