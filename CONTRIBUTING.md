# Contributing

Yes, contributions are welcome, and the answer was decided before publishing rather than under
pressure afterwards. What follows is the bar, stated specifically enough that you can tell
before you start whether a change will land.

Read [AGENTS.md](AGENTS.md) first. It is the architecture, the conventions, and - in *Design
decisions worth knowing* - the reasoning behind the decisions that are easy to undo by
accident. Most review comments here would be quotations from it.

## The one thing to understand before changing anything

The failure this project cares about most is not a crash. It is **quiet staleness**: a page
that shows a confident indicator over state that stopped updating. That is worse than a monitor
which is visibly down, because you stop checking it.

So a change that lets the page or the CLI assert something it no longer knows is a bug here
**even if nothing throws and every test passes**. Several rules below only make sense in that
light - why one guard fails open, another fails closed, and why a signal may be allowed to
disprove something but never to assert it.

## Adding a terminal

This is the contribution the architecture was shaped for, and the one most likely to be wanted:
Ghostty, WezTerm, Kitty, an editor's built-in terminal. Supported today are iTerm2 and
Terminal.app, plus tmux inside either.

A terminal is **one entry in `src/focus/terminals.js`**, and that is the whole interface:

```js
export const ghostty = {
  name: 'ghostty',                 // machine-readable, reported back as the adapter used
  label: 'Ghostty',                // how to name it to a human
  termProgram: 'ghostty',          // the TERM_PROGRAM that means "this one" - ordering only
  async isAvailable(exec) { ... }, // is this terminal even running?
  async focus(exec, { sessionUuid, tty }) { ... },  // true if a tab was found and raised
  async focusByTitle(exec, { title }) { ... },      // optional - 'ok' | 'notfound' | 'ambiguous'
};
```

`focusByTitle` is required only if your terminal can host tmux in control mode (`tmux -CC`) -
iTerm2 is the only implementer today. A control-mode pane is tried by title first and
`focusByPaneTitle` skips any adapter without it, leaving only the ordinary tty path - which is
there for such a pane only when a plain client happens to be attached as well. A terminal that
never hosts control mode does not need it.

Then add it to `ALL_TERMINALS`. Three conditions:

1. **Nothing else in the codebase moves.** If your terminal needs a change somewhere else, the
   abstraction is being broken - please say so in the issue rather than working around it. That
   is a bug in the seam, not in your patch, and it is worth fixing properly.
2. **A test, using the injected command runner.** Never the real one. `test/focus.test.js` has
   a `fakeExec` that answers from a table and records what it was asked, which is what lets the
   suite assert on the AppleScript that *would* have run without stealing your focus mid-test.
   A test that drives a real terminal does not belong here.
3. **You are running the terminal you are adding.** An adapter nobody can exercise against a
   real session is guesswork in the shape of support, and it will be believed by the next
   person to read the list. Being on it is what makes the difference.

`focus` returns `false` rather than guessing when it was handed nothing it can use - see how
Terminal.app, which exposes no session identifier, is tty-only. Affordance must match
capability everywhere in this project, and that starts here.

### Other platforms

Focusing is macOS-only today. That is a fact about where it has been run rather than a position
the design takes: monitoring itself is portable, and the seam above is the same seam a Linux
path would use. It has not been built because X11 needs `wmctrl` or `xdotool` and Wayland has
no portable answer - not because a patch would be unwelcome.

The same three conditions apply, the third one especially.

## What will not be accepted, and why

These are scope boundaries rather than gaps waiting to be filled. Each of them turns a local
page into a service, and the project is deliberately not one:

- **auth**, **multi-user support**, **remote access**. Raise watches one machine and serves the
  one person sitting at it.
- **A runtime dependency.** `dependencies` in `package.json` is empty and stays empty - Node
  builtins only. This is non-negotiable rather than a preference: it is what lets the tool keep
  working across upgrades with no maintenance, and it is half of the answer to *why should I
  let this read my transcripts*.
- **A fourth devDependency.** They are `typescript`, `@types/node` and `oxlint`, for
  `npm run typecheck` and `npm run lint`. A formatter, a test framework or a bundler needs
  raising in an issue first.
- **Widening the hook payload.** `REPORTABLE_FIELDS` in `src/hook-payload.js` is an allowlist,
  and it is a privacy boundary: a field we forget to allow is a feature that quietly does not
  work, and a field we forget to deny is somebody's source code on a socket. The bar for moving
  it is not that a row would read better - it is that the page cannot do its job without it.
- **A synchronous child process anywhere reachable from the server.** Use `execAsync` /
  `tryExecAsync`. The server polls on a 1s timer, pushes a stream and answers hook posts that
  time out in 2s; one blocking call stalls all three, and the dropped signal is the one you
  cared about.

## Before you open a pull request

```sh
npm test          # no network, no build step
npm run lint
npm run typecheck
```

All three pass, or it is not ready. CI runs them on every pull request, and runs the tests
again on Node 22 to keep the `engines` floor honest rather than asserted.

- **Node 22.13 or newer.** 22.13 is where `node:sqlite` stopped needing a flag.
- **Reproduce a bug as a test first**, then fix what the test exposes. Tests are `node:test`
  and `node:assert/strict`, one file per module, named after the behaviour in plain English.
- **Inject everything external** - the exec runner, `fetch`, the clock, the process table. A
  test that touches the real machine does not belong here.
- **Comment the reason at the point of a surprising decision**, not the obvious. Match the
  density of the file you are in; it is the most valuable thing in this codebase.
- Match the surrounding style: 2-space indent, single quotes, semicolons, trailing commas,
  ~100 columns, named exports. There is no formatter configured on purpose.

## Issues and pull requests

Both at **https://github.com/mattwwatson/raise**.

**Open an issue before a large change.** A small, self-contained patch - a terminal adapter, a
bug with a failing test - is welcome straight as a pull request. Anything that touches how a
row is ranked, what a source is allowed to assert, or the shape of the state frame is worth a
conversation first, because those decisions usually have reasoning behind them that is written
down in `AGENTS.md` and easy to undo by accident.

**Planning happens in [the issues](https://github.com/mattwwatson/raise/issues), ordered on
[the board](https://github.com/users/mattwwatson/projects/1)**, and the
specifications live beside the code: every item that has been picked up has one in
[docs/tasks/](docs/tasks/), saying what was built and why. If you want to know how something got
the way it is, that and `AGENTS.md` are the two places to look. You are not expected to write a
spec for a contribution - that is the maintainer's job.

Security issues do **not** go in an issue - see [SECURITY.md](SECURITY.md).

By contributing you agree that your work is published under the project's MIT licence.
