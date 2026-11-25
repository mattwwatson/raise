---
issue: 74
status: backlog
size: M
depends: -
---
# 74 - Focus a session running in the `herdr` terminal multiplexer

**Self-contained brief.** No prior conversation needed. Written 26/11/2026.

## Problem

"Herdr" names two products, and Raise supports only one of them.

- **Herdr Core** - the `hc` client, the `herdr-core` server and the Herdr desktop app. Raise
  focuses these sessions: see [40-herdr-focus.md](40-herdr-focus.md) and `src/focus/herdr.js`.
- **The `herdr` terminal multiplexer** - one `herdr` binary that runs a headless
  `herdr server` and draws its own workspaces, tabs and panes in whichever terminal you start
  it in, in the way tmux does. Installed from Homebrew; 0.9.5 on the machine this was written on.

Spec 40 set the second one aside on purpose: it noted that firstmate's Herdr lab drives
`herdr`, "a separate terminal multiplexer with its own CLI", and that the item was about the
other product. Nothing has picked it up since.

What a user on the `herdr` multiplexer sees today, read from the code and not yet reproduced:

- **Monitoring works.** Hooks and transcripts belong to the agent, not the terminal, so the row
  appears, ranks and turns red as usual.
- **Focusing does not.** Every way Raise recognises Herdr is specific to Herdr Core:
  - the hook records `HC_TERMINAL_ID` and `HC_TERMINAL_SOCKET` (`hooks/raise-hook.js`,
    `hooks/raise-pi-extension.js`). The `herdr` multiplexer sets its own `HERDR_*` variables
    instead - its binary names `HERDR_SOCKET_PATH`, `HERDR_CLIENT_SOCKET_PATH`,
    `HERDR_ACTIVE_PANE_ID` among others - so the session reports no Herdr identity;
  - `hostMultiplexer` in `src/process-tree.js` names `herdr` only for a `herdr-core hold`
    ancestor, which a `herdr server` process is not;
  - every focus command is `hc` or `herdr-app`.

  So the session falls through to the terminal adapters with the tty of a pseudo-terminal
  `herdr` owns, which no terminal tab holds. And if `herdr server` was first started inside a
  tmux pane, the inherited `TMUX` could make the session look like it is in that pane - the same
  environment-inheritance trap spec 40 measured for Herdr Core.

The README now says this support is missing (the `Herdr sessions` section). This item is to
add it.

## One machine runs several `herdr` sessions

**"Session" is `herdr`'s own word, and it clashes with Raise's.** In `herdr` a session is a
named, persistent server - its own process, socket and set of workspaces, tabs and panes.
`herdr session list` prints each one with its socket; `default` is the one a bare `herdr` starts
or attaches to, at `~/.config/herdr/herdr.sock` on the machine this was written on. In Raise a
session is one agent conversation. This spec writes **`herdr` session** for the first and
**agent session** for the second, and the code should keep the two apart in the same way.

Several `herdr` sessions run at once in ordinary use:

- **`default`** - the one you start by typing `herdr`.
- **Firstmate's own.** Firstmate can run its crew in a named `herdr` session of its own, and its
  remote setup uses one called `fm-remote`. Its backend (`bin/backends/herdr.sh` in the
  firstmate repository) passes `--session <name>` on every call and records *why*: on the
  `herdr` it measured, the `HERDR_SESSION` environment variable alone is not reliably honoured
  by CLI commands once another server is running, and the call quietly reaches whichever
  server answers. A command that leaves the session to the environment can therefore act on
  the wrong `herdr` session with no error.
- **Any other** started with `herdr --session <name>`.

So focusing an agent session is three resolutions, and every one must be positive evidence:

1. **Which `herdr` session holds the pane** - recorded by the hook from the pane's own
   environment or process tree, never assumed to be `default`.
2. **Which pane in that `herdr` session** - its pane id, plus the tab and workspace that
   contain it.
3. **Which client, if any, is showing that `herdr` session** - a `herdr` client in some terminal
   tab, attached to one named session.

Pane ids are only unique inside one `herdr` session, the same trap Herdr Core addresses have
(spec 40): every `herdr` call Raise makes carries `--session <name>`, and a pane whose `herdr`
session cannot be named is not focused.

## What will visibly change

An agent session running in a `herdr` pane gets a chip saying so, and `Focus ↗` does one of
two things:

- **A client is showing its `herdr` session** - Raise brings that terminal tab forward, then
  switches the client to the pane's workspace, tab and pane, all with `--session <name>`.
- **No client is showing it** - with [`new-tab`](../../README.md#opening-a-session-nothing-is-showing)
  on, Raise opens a new tab in the chosen terminal running `herdr --session <name>` (or
  `herdr session attach <name>`, whichever the measurement shows is right), waits for the
  client, then focuses the pane. That tab is what the first case finds on the next click.
  With `new-tab` off, the row says nothing is showing it and gives that attach command, as the
  tmux and Herdr Core paths already do.

Switching a client to another pane changes what that tab shows. If the client was showing a
different pane of the same `herdr` session, that is the same trade the tmux path makes and the
same note applies (see issue #42).

## Non-goals

- **Remote `herdr` machines** (`herdr --machine`, `herdr --remote`). A pane on another machine
  is outside Raise's one-machine scope.
- **Guessing between clients.** If two `herdr` clients are attached to one `herdr` session and
  nothing says which is showing the pane, refuse rather than pick - the rule
  `src/focus/herdr.js` and `src/focus/tmux.js` already follow. With `new-tab` on, refusing does
  not mean opening a third.
- **Starting a `herdr` session.** A `herdr` session that is not running has no pane to focus.
  Raise attaches to running ones only, and never runs `herdr server` or anything else that
  could start or stop one.

## Open questions - to settle by measurement, not by reading the help text

Each of these needs a real agent session in a real `herdr` pane, measured in a scratch named
`herdr` session and never against `default` or firstmate's. Record the version measured
against.

1. **What does a pane's environment name?** Capture it in `default` and in a named `herdr`
   session. Is there a pane id, and is the `herdr` session named directly (`HERDR_SESSION`?) or
   only through a socket path (`HERDR_SOCKET_PATH`?) that has to be matched against
   `herdr session list`? Each variable recorded widens the hook payload, so it has to meet the
   bar in `src/hook-payload.js`: the page cannot do its job without it.
2. **What does the process tree look like?** Is a pane's shell a child of `herdr server`, so
   `hostMultiplexer` can tell `herdr` from tmux and from Herdr Core by nearest ancestor? Does a
   named `herdr` session's server carry its name in argv, so the process table alone can say
   which `herdr` session a pane belongs to?
3. **How is a pane focused?** `herdr pane focus` is documented as "Focus a neighboring pane",
   which may not take a pane id; `herdr tab focus` and `herdr workspace focus` exist, and
   firstmate's backend uses `tab focus`. Find the sequence that puts a given pane in front of a
   client, and whether it moves every client attached to that `herdr` session or one.
4. **Which client is showing which `herdr` session?** A client runs in an ordinary terminal
   tab. Is its `herdr` session in its argv (`herdr --session fm-x`, `herdr session attach fm-x`),
   with bare `herdr` meaning `default`? Or can it come from the client's environment, which
   macOS `ps` will not show for another process - the same gap that made Herdr Core's picker
   unsupported? Can Raise find the tab by the client's tty, as tmux clients are found? Does
   `herdr api` list attached clients?
5. **Does attaching start a `herdr` session?** If `herdr --session <name>` starts a server when
   none is running, the new-tab path must check `herdr session list` first, or a click on a
   stale row starts an empty `herdr` session.
6. **How does a new tab know the client is ready?** The new-tab path has to focus the pane
   after the client attaches. Find a positive signal that it has, rather than a sleep.
7. **What does an agent session in `herdr` look like in Raise today?** Reproduce the row and the
   click result before changing anything, in `default` and in a named `herdr` session, and keep
   both as the first tests.

## Decisions to keep

- **A multiplexer path, not a terminal entry.** Like tmux and Herdr Core, `herdr` sits between
  the session and a terminal, so it does not belong in `src/focus/terminals.js`.
- **Positive evidence only.** A session is a `herdr` session because of a variable or an
  ancestor process that only `herdr` produces, never because it lacks something else.
- **Every command through the injected `exec`, asynchronously**, and a failed or unparseable
  answer means "not available there", as in `src/focus/herdr.js`.
- **Every `herdr` command names its `herdr` session with `--session`.** Never rely on
  `HERDR_SESSION` or on `default` being the one that answers - firstmate measured that a call
  left to the environment can reach the wrong server.
- **Read-only, apart from focusing and the new tab.** Raise never stops, starts, renames or
  closes anything in a `herdr` session - firstmate's sessions especially.
- **Absent means silent.** A machine without `herdr` runs no `herdr` command, and
  `server.test.js` asserts it.
