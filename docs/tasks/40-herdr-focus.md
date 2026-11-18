---
issue: 40
status: shipped
size: M
depends: -
branch: fm/raise-40-herdr-focus
shipped: 2026-11-18
---
# 40 - Clicking a session running in Herdr does nothing useful

**Self-contained brief.** No prior conversation needed. Written 18/11/2026, from a hand
reproduction on macOS with Herdr.app 0.1.15 and `hc` 0.1.20.

---

## What and why

Herdr is a terminal session manager in the same family as tmux: programs
run in terminals owned by a Herdr server, which stay alive while you attach to them, detach
from them, or reach them from another machine. A Herdr terminal is shown in one of two ways:

- **in the Herdr desktop app**, which lays terminals out in spaces, tabs and panes, or
- **in an ordinary terminal app**, by running `hc attach <address>` (or the `hc` / `hc attach`
  picker) in a Ghostty, iTerm2 or Terminal.app tab.

A Claude Code session started in a Herdr terminal offers `Focus ↗`, and clicking it brings
nothing to the front and shows *"Could not find that tab in Ghostty or iTerm2. It may have
been closed."* That is wrong twice over: the session is open, and it may not be in Ghostty at
all.

### What was measured

Four sessions on one Mac, each with the app showing it first switched to something else:

| Session | Shown by | Click on `main` today |
|---|---|---|
| `t5` | Herdr desktop app, which was showing a space on another machine | fails, message above |
| `t6` | `hc attach t6` typed in a Ghostty tab, Ghostty on another tab | fails |
| `t7` | `hc attach t7` typed in an iTerm2 tab, iTerm2 on another tab | fails |
| `t7` again | `hc` picker, `t7` chosen, in a new iTerm2 tab (the typed attach closed first) | fails |
| `t8` | `hc` picker, "new here", `claude` run in it, in iTerm2 | fails |

Three facts explain every one of those:

1. **Herdr sets `TERM_PROGRAM=ghostty` in every terminal it creates**, whatever app the
   terminal was created from or is shown in. `t7` and `t8` were created from iTerm2 and still
   say `ghostty`, with no `ITERM_SESSION_ID`. `hc get` reports `"identity": "ghostty"` for all
   of them: the value comes from the Herdr server, not from the app on screen. So the hook
   records every Herdr session as a Ghostty session.
2. **The recorded tty is Herdr's own pseudo-terminal**, not the tab of any app. No terminal
   adapter can ever match it. The Ghostty adapter correctly finds nothing, and the failure
   message then names an app the session is not in.
3. **Herdr says which terminal a Claude is in.** Every process in a Herdr terminal has
   `HC_TERMINAL_ID` (`t5`) and `HC_TERMINAL_SOCKET` (the server's socket path) in its
   environment. The hook does not record either today.

### What brought the right window forward, by hand

| Shown by | Positive evidence of where it is shown | What worked |
|---|---|---|
| Herdr desktop app | `herdr-app ls` lists every pane with the terminal it shows | `herdr-app do pane.focus --terminal t5` switched the app from the other machine's space to the right one; it does **not** bring the app forward, so it is followed by `tell application id "dev.herdr.app" to activate`. Herdr came forward on the right space. |
| typed `hc attach t6` in Ghostty | the client process's argv is `hc attach t6`, and its tty (`/dev/ttys022`) is the Ghostty tab's | the existing Ghostty adapter, given that tty: Ghostty came forward on that tab |
| typed `hc attach t7` in iTerm2 | the same, tty `/dev/ttys020` | the existing iTerm2 adapter, given that tty: iTerm2 came forward on that tab |
| `hc` or `hc attach` picker | **none** | not attempted |

Each was confirmed by eye, not only by the script's return value.

**The picker leaves no trace.** Whether it attaches an existing terminal or creates a new one,
the client's argv stays `hc` or `hc attach`, it holds only a unix socket to the server, and
`hc get` lists no clients. At the time of measuring two bare `hc` clients in iTerm2 were
showing `t8` and `t7`, and nothing on the machine told them apart. Choosing between them would
be a guess.

---

## What Herdr can and cannot do here

**An `hc` client shows one terminal for its whole life.** `hc attach` opens a single stream to
one terminal. It has no key to switch to another, and ctrl+\ detaches and exits - it does not
return to the picker. Herdr's API has no way to list clients or to tell one to show a different
terminal. So unlike a tmux client, which Raise can switch to the session's window, an `hc`
client can only be raised if it is already showing the session.

**The desktop app is the viewer Raise can redirect**, measured:

- `herdr-app do pane.focus --terminal <id>` works when a pane in the app holds the terminal. It
  selects the right space *and* tab (measured from tab 1 to tab 2 of a space). It returns
  `no such pane` for a terminal with no pane of its own.
- `herdr-app do terminal.show --terminal <id>` works for any terminal on this machine, pane or
  not. It shows the terminal in the currently focused pane, in place of that pane's own, until
  the user switches back. It is temporary: `herdr-app ls` still lists the pane's own terminal.
- Neither brings the app forward; `tell application id "dev.herdr.app" to activate` does.

---

## What will visibly change

- **A session attached with a typed `hc attach <address>`** comes forward in the terminal app
  holding that attach, on that tab, through the adapter that app already has. This is the case
  the README recommends.
- **A session the desktop app already has a pane for** comes forward in the app, on its space
  and tab.
- **Any other session, while the desktop app is running,** comes forward in the app, shown in
  the focused pane, with a neutral note: *"Shown in the Herdr app. To bring up your own
  terminal instead, attach it with hc attach t8."*
- **Otherwise** the click says so and names the way out: *"Not shown anywhere Raise can see.
  Run `hc attach t8`."* It no longer names Ghostty.
- **README:** the Herdr section tells people to attach with `hc attach <address>` rather than
  bare `hc` or `hc attach` and the picker, and says why: Raise cannot tell which terminal a
  picker client is showing.

Most people using Herdr are expected to use their own terminal app and `hc`, not the desktop
app, so the typed attach is the main case and the README guidance is part of the change, not
an afterthought.

---

## Design

### 1. The hook records the Herdr terminal

Add `HC_TERMINAL_ID` and `HC_TERMINAL_SOCKET` to the host fields captured in
`hooks/raise-hook.js`, beside `tmux_pane`. Both are window identity of the kind the host block
already carries - an address and a socket path, no content - so the payload privacy boundary
does not move. `HC_TERMINAL_SOCKET` matters because two Herdr servers on one machine can both
have a `t5`; every command below must go to the server the session reported.

### 2. Herdr is a multiplexer path, not a terminal adapter

This item does **not** fit the one-entry rule for `src/focus/terminals.js`, and says so as
that rule requires: Herdr is not a terminal app, it sits between the session and one. It is the
same shape as tmux, which already has its own path in `planFocus` and resolves to a client tty
that the terminal adapters then raise. Herdr gets the same: a `herdr` kind in `planFocus`,
checked **before** `term_program`, because for a Herdr session `term_program` is always
`ghostty` and always unreliable.

### 3. Resolution order at click time

Resolved when clicked, never stored, as for tmux - which app shows a terminal changes all day.
First match wins:

1. **A typed attach shows it.** The process table has an `hc attach <id>` client for this
   terminal on this server: hand that client's tty to the terminal adapters, exactly as the
   tmux path hands over a tmux client's tty. It wins because typing the address is a
   deliberate choice of where to look.
2. **The desktop app has a pane for it.** `dev.herdr.app` is running (the bundle-id check needs
   no System Events permission) and `herdr-app ls` lists a pane holding this terminal:
   `pane.focus`, then activate the app.
3. **The desktop app is running.** `terminal.show`, then activate the app, and return the note
   above. This replaces what the focused pane shows until the user switches back - the same
   trade tmux makes when Raise moves a client to another window, and the note says where the
   session went.
4. **Nothing Raise can use.** Refuse, with the `hc attach <id>` hint.

Every command is run through the injected `exec` and asynchronously. Herdr is at 0.1.x, so any
failed command, unparseable output or unknown field counts as "not available there" and moves to
the next step, never as an error.

### Open questions, and how each was settled

- **More than one typed attach of the same terminal.** Settled by the default this spec gave:
  refuse as ambiguous and fall through to the desktop app. Herdr has no way to say which client
  was used last - it cannot list clients at all - so there was nothing better to build to. With
  the app not running the click refuses with *"More than one terminal is attached to Herdr
  terminal t6, so Raise cannot tell which is this session."* and moves nothing.
- **How the client is matched to a server.** Settled by measurement on `hc` 0.1.21, and the
  answer is that **a client's argv cannot say**. `hc attach` takes no server option at all -
  `hc help attach` lists `--json`, `--observe` and `--history` and nothing else - so the server
  comes only from `HC_SESSION` or `HC_SOCKET` in the client's environment, and `ps -E` /
  `ps eww` on this macOS print no environment for another process, even one of the same user.
  A client against a non-default server therefore reads `hc attach t6`, identical to one
  against the default. What the process table *does* show is each running server's holder,
  `herdr-core hold --socket <state>/<name>/<name>.holder.<hex>.sock`, and the server's own
  socket is `<state>/<name>/<name>.sock` (`core.lock` names
  `~/.local/state/herdr-core/default/default.sock`). So the address is used alone **only while
  no holder for another server's state directory is running**: a second holder disproves it,
  because `t6` could then be either server's. Seeing no holder at all asserts nothing - the
  typed address is still the evidence - so that check only ever removes a sighting.

  The same finding reaches the desktop app: `herdr-app` takes no socket either, and its
  local core is the default server's. So steps 2 and 3 run only for a session whose recorded
  socket has the `default/default.sock` shape, and a session on any other server gets the
  attach hint with its socket named, `HC_SOCKET=<socket> hc attach t6`.

  **This was measured from the installed binaries rather than against a second running
  server.** The isolated Herdr lab helper (`fm-herdr-lab.sh`) requires a `herdr` 0.7.3 CLI,
  and this machine has `hc` / `herdr-core` 0.1.21 and Herdr.app 0.1.16 instead, so `prepare`
  stops at `herdr is required`. Starting a second server by hand would have bypassed the helper,
  so it was not done. The command-line surface and the process-table shapes above are enough
  to build to; confirming against a live second server is in the manual testing.
- **The note on step 3.** `FocusResult.note`, unchanged - #35 (Warp) has not landed, so there
  was no other shape to use.

---

## Would make the picker work: a request to Herdr

The picker (`hc`, or `hc attach` with no address) leaves no trace of which terminal a client is
showing, so step 1 cannot see it. That is why the README steers people to the typed address.
Herdr reporting, per attached client, the terminal it is showing and the client's tty - an
`hc clients` list, or the address in the client's argv - would let step 1 cover the picker too.
Ask upstream (`herdr-app feedback`) when this is picked up, and build to it if it has shipped.

It had not shipped in `hc` 0.1.21. Sending the request is outward-facing, so it was drafted and
not sent; the text, ready for `herdr-app feedback`:

> A tool that raises the window showing a given Herdr terminal (Raise, a session monitor) can
> find a typed `hc attach t6` client from its argv, but cannot place a client started from the
> `hc` picker: its argv stays `hc` or `hc attach` whatever it shows, and there is no API to list
> clients. Two things would each fix it. (1) An `hc clients --json` listing, per attached
> client, the terminal address it is showing, the client's pid and its tty. Or (2) the picker
> re-executing itself as `hc attach <address>` once a terminal is chosen, so argv names it.
> Separately, `hc attach` cannot name its server in argv (only `HC_SESSION`/`HC_SOCKET` in its
> environment), so with two servers running a client's `t6` is ambiguous; an
> `hc attach --session <name>` flag, or (1) including the server's socket, would resolve that
> too.

---

## Deliberately not in scope

- **Guessing between picker clients.** Even "the only bare `hc` client" is a guess: there is no
  evidence it shows this terminal rather than another.
- **Sessions on another machine.** A Claude in a terminal on a remote Herdr machine runs its
  hook there and reports to that machine's Raise, if any. This Mac's Raise never sees it.
- **firstmate crewmates under Herdr.** firstmate's `fm-` marker is a tmux window name; how
  firstmate marks a crewmate it runs in Herdr is a separate question.

---

## Side bug, fix in the same change

The failure message names the adapters tried, in an order led by the recorded `term_program`.
For a Herdr session it says *"Ghostty or iTerm2"* about a session in neither. Once the Herdr
path exists that message is no longer reached for Herdr sessions, which fixes it for this
case; check no other route still produces it.

---

## Acceptance

- Each step of the resolution order verified by hand on real Herdr sessions, with the showing
  app first switched away (CONTRIBUTING condition 3): typed attach in Ghostty, typed attach in
  iTerm2, a desktop-app pane, `terminal.show` with its note, and the refusal with the app not
  running.
- A typed attach wins over the desktop app when both show the session, asserted by a test.
- A picker-only session with the desktop app not running refuses with the `hc attach <id>` hint
  and moves no window, asserted by a test.
- The README's Herdr section recommends `hc attach <address>` and says the picker is not
  supported.
- A Herdr session is never handed to the terminal adapters by its recorded tty, asserted by a
  test.
- Commands go to the server named by the recorded socket, asserted by a test.
- Tests use the injected `fakeExec` only.
- `npm test`, `npm run lint` and `npm run typecheck` pass.

---

## Implementation notes

- **Where it lives.** `src/focus/herdr.js` holds the Herdr-specific reading - the typed attach
  parse, the holder check, the server name, and the `herdr-app` calls. `focusHerdr` in
  `src/focus/index.js` runs the four steps in order and owns the step 3 note, as the spec put
  it. `planFocus` returns `kind: 'herdr'` after tmux and before anything that reads
  `term_program` or the tty: a tmux pane inside a Herdr terminal keeps the tmux path it always
  had, which is the one thing it is still right about.
- **The hook records `hc_terminal_id` and `hc_terminal_socket`**, in `hooks/raise-hook.js` and
  in the pi extension, which runs in Herdr terminals just as readily. They are added to the
  `host` block the reporter builds, not to `REPORTABLE_FIELDS`, so the payload allowlist did
  not move.
- **An address that is not `t<number>` is unfocusable**, rather than passed to `herdr-app` as
  an argument or pasted into a hint. herdr-core's own error text says addresses are
  `t<number>`.
- **What a typed attach is.** The executable is `hc` or `herdr-core`, bare or by path - a path
  holding a space is accepted only inside an `.app` bundle, so `vim notes/hc attach t6` is not
  a client. Its flags are the three `hc help attach` lists, and any other flag makes the line
  untrusted, because a flag taking a value would make that value look like the address.
  `hc attach machine/t6` is another machine's terminal and does not match, and neither does an
  attach by name (`hc attach fix`), which only the server can resolve. A client with no tty
  has no tab to raise and is not counted.
- **A typed attach no adapter can raise falls through**, rather than ending the click: it may
  be in a terminal Raise has no adapter for, or a tab that has since closed. If nothing after
  it works either, the adapters' own message is returned - it is about a real tab now - with
  the attach hint.
- **The refusal is a reason and a hint**, `Not shown anywhere Raise can see.` and
  `hc attach t8`, rather than one sentence holding both: the page shows them as
  `reason  ->  hint` and `raise focus` as the reason then `Try: <hint>`, the same split the tmux
  `attach` hint uses.
- **`herdr-app do` success** is an exec that resolved with no output or a JSON object with no
  `error`. Anything else, including output that is not JSON, is "not available there".
- **The desktop app is never launched.** It is checked with `is running` by bundle id first,
  and `activate` - which would launch it - is only sent after a command succeeded. If
  `activate` then fails, the app has already switched its pane, so the click does not fall
  through to the refusal: it fails with a reason saying the app is showing the terminal (in
  its focused pane for now, after `terminal.show`) but could not be brought to the front,
  and the `hc attach <id>` hint.
- **The step 3 note does not wrap the command in backticks**, because the page toast renders
  plain text and would show them as stray characters.
- **The host chip says `herdr`.** `hostKindFor` would otherwise have called a Herdr session
  `unknown`, and before this change it said `tab`. `herdr` is the one thing known for certain
  until the click works out which app shows it.
- **Side bug.** A Herdr session no longer reaches `focusTerminal` with its own tty, so it can
  no longer produce *"Could not find that tab in Ghostty or iTerm2"*. The one route that still
  produces that message for a Herdr session is a typed attach whose real tab no adapter found,
  where it is true. Every other route to it - plain tabs and tmux - is about a tab the session
  itself is in, and was not changed.
- **Not verified by hand here.** The Herdr lab could not be provisioned (see the second open
  question), and the safety contract keeps every hands-on Herdr check off the captain's own
  server and app. So each step was verified against a stubbed `exec` only, and the hand checks
  in Acceptance are in the pull request's manual testing.
