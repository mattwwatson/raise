# AGENTS.md

Guidance for Claude Code and other agents working in this repo.

`README.md` is for people who want to *use* nmmon - install it, run it, understand what they
are looking at. This file is for changing it: architecture, conventions, and the decisions
that are easy to undo by accident.

## Project Overview

`nmmon` is a single-page monitor for one developer's machine. It shows every `no-mistakes`
pipeline run and every Claude Code session across every repo, ranks them by who needs a human,
and focuses the terminal window when you click a row.

The product is one sentence: **tell me which session is waiting for me, and take me there.**
Everything else is supporting cast. Optimise for that signal arriving fast and never being
wrong.

The failure mode that matters most is not a crash - it is **quiet staleness**. A monitor that
shows a confident green dot over state that stopped updating is worse than one that is
visibly down, because you stop checking. Any change that could let the page or the CLI assert
something it no longer knows is a bug, even if nothing throws.

Personal tool, macOS-only for focusing (monitoring itself is portable). Do not add
cross-platform focus adapters, auth, multi-user support or remote access speculatively.

## Tech Stack

- Node **22.5+**, ESM only (`"type": "module"`). `node:sqlite` and `node:test` need it.
- **Zero runtime dependencies.** Node builtins only: `node:test`, `node:assert/strict`,
  `node:sqlite`, `node:http`, `node:child_process`. This is absolute - `dependencies` in
  `package.json` stays empty.
- **devDependencies are `typescript` and `@types/node`, and that is the whole list.** They
  exist only for `npm run typecheck`; nothing ships or runs against them. Adding a third -
  a linter, a formatter, a test framework, a bundler - needs raising first, not just doing.
- Frontend is plain HTML/CSS/JS in `public/`, served as files. No framework, no bundler, no
  build step.
- Coverage via `node --test --experimental-test-coverage`.

The constraint is deliberate: this has to keep working across Node and no-mistakes upgrades
with no maintenance, and it installs by `git clone` + `npm link` with nothing to fetch at
runtime.

## Architecture

Two sources of truth, joined into one list:

| Source | Module | Answers |
| --- | --- | --- |
| no-mistakes SQLite DB (polled, 1s) | `src/nm-state.js` | is a pipeline run parked, working, failed? |
| Claude Code hooks (pushed) | `src/registry.js` | is Claude blocked waiting for a human? |
| the session's own transcript (tail, on change) | `src/transcript.js` | what is it working on, what is it doing right now, and did it open a pull request? |

| Path | What |
| --- | --- |
| `bin/nmmon.js` | CLI |
| `src/cli-args.js` | argument parsing (pure) |
| `src/config.js` | paths, ports, the shared token; all env-overridable |
| `src/nm-state.js` | reads the no-mistakes database, with schema probe and fallback |
| `src/registry.js` | live Claude sessions, fed by hooks |
| `src/transcript.js` | what a session is doing, parsed from its transcript (pure) |
| `src/transcript-reader.js` | the tail read behind that, cached on mtime and branch |
| `src/git-branch.js` | the branch a checkout is on, read from `.git/HEAD` |
| `src/lavish.js` | resolving a Lavish artifact to the page waiting on you |
| `src/dashboard.js` | joins the two into ranked rows (pure) |
| `src/focus/` | tmux resolution and per-terminal adapters |
| `src/process-tree.js` | which terminal and which agent process a hook is running under |
| `src/security.js` | token, Host and Origin checks (pure) |
| `src/health.js` | probing a port to find out whether nmmon is behind it |
| `src/exec.js` | the one place that runs external commands |
| `src/server.js` | HTTP, server-sent events, the poll loop |
| `hooks/nmmon-hook.js` | the Claude Code hook |
| `public/index.html` | the page, self-contained |
| `public/connection.js` | the liveness rule (pure, no DOM, injected clock) |

Rules:

- **Pure logic and I/O stay in separate modules.** `cli-args.js`, `dashboard.js`,
  `security.js` and `public/connection.js` are pure and are tested by calling them directly.
  Keep them that way - if a new rule needs the clock, the filesystem or a subprocess, inject
  it as a parameter rather than importing it.
- **Never import `src/exec.js` from a module that needs to shell out.** Take a runner as a
  parameter and default it at the edge (`bin/nmmon.js`, `server.js`). This is what lets the
  suite assert on the AppleScript that *would* have run without stealing your focus mid-test.
- **Nothing reachable from the server may run a synchronous child process.** Use `execAsync`
  / `tryExecAsync`. The server polls on a 1s timer, pushes a stream and answers hook posts
  that time out in 2s; one blocking `spawnSync` stalls all three, and the dropped signal is
  the one you cared about. `server.test.js` injects an `exec` that fails the test if called -
  do not weaken that guard.
- **A new terminal is one entry in `src/focus/terminals.js`** - an availability check and a
  focus function, and nothing else in the codebase changes. If adding terminal support
  touches anything else, the abstraction is being broken; say so rather than working around it.
- Config, paths and ports resolve through `src/config.js` and are env-overridable
  (`NMMON_HOME`, `NM_HOME`, `NMMON_PORT`) so tests never touch a real installation.

## Design decisions worth knowing

These were each arrived at the hard way. Changing them is allowed; changing them by accident
is the thing to avoid.

**Polling SQLite, not the daemon socket.** The no-mistakes daemon does expose a live event
stream over its unix socket, but the protocol is private and undocumented. Polling a local
SQLite file once a second is effectively free and survives no-mistakes upgrades that a
reverse-engineered wire format would not.

**The keepalive is an SSE `event`, not a comment.** `EventSource` only reports an error once
the connection actually breaks, and a connection can stop carrying data long before that - a
suspended laptop, a frozen server, a dropped NAT entry. The keepalive used to be an SSE
*comment*, which the browser discards without telling the page, so in all of those the
dashboard sat on a green "live" dot over state that had stopped updating. Liveness is
positive evidence, never the absence of an error. Do not "tidy" the event back into a comment.

**`server.json` is not the source of truth for "is it running".** `serve` asks the port
itself via `/health`. A monitor started under a different `NMMON_HOME` writes its record
somewhere you will never look, so the file says "not running" while the port disagrees -
and a record outlives a server that was killed rather than shut down.

**A session's summary is read from its transcript, not reported by the hook.** Claude Code
already writes an `ai-title`, a `mode` and every `tool_use` into the transcript, so the
summary is quoted rather than inferred. Doing it in the hook instead would mean a
`PreToolUse`/`PostToolUse` pair firing a localhost POST inside the user's editing loop on
every single tool call, to learn something already on disk.

**The tool that is running is the one with no result yet.** A `tool_use` id that no
`tool_result` refers back to is in flight; that is the whole basis of "what is it doing right
now", and it is what separates *is sitting in a Bash command* from *used Bash at some point*.
Results arrive out of order when tools run in parallel, so match on ids, never on position.

**A recorded block is disbelieved once the transcript runs past it.** The installed hooks are
`SessionStart`, `UserPromptSubmit`, `Notification`, `Stop`, `SessionEnd` - so after
`Notification` fires, nothing fires again until the turn ends. Granting a permission prompt
therefore leaves the session reading "Waiting for you" for the whole rest of the turn.
Observed live at 185 seconds stale while the transcript was 3 seconds old. A false "waiting
for you" is worse than a missing one: it is what teaches you to stop believing the page.

The transcript settles it, because a session writing records is self-evidently not sitting
waiting for a human. Two properties make this safe, and both were measured rather than
assumed:

- the post-turn metadata records (`ai-title`, `mode`, `last-prompt`) carry **no timestamp**,
  so they cannot move `lastActivityAt` - a genuinely idle session goes quiet immediately
- across real idle periods the last timestamped write lands within **0.3s** of the block,
  against a 3s margin

The transcript may only ever *clear* a block, never assert one. A transcript that cannot be
read leaves the hooks' answer standing.

> **Option not taken: a `PostToolUse` hook.** The direct fix is to have Claude Code report
> the state change itself rather than infer it. It is a one-line change - add `PostToolUse`
> to `HOOK_EVENTS` in `src/hooks.js`; `EVENT_STATES` in `registry.js` already maps it (and
> `PreToolUse`) to `working`, so nothing else moves.
>
> Not chosen because it costs a hook process and a localhost POST **per tool call**, inside
> the user's editing loop, and because hooks are read at session start: it fixes nothing
> until `nmmon install-hooks` is re-run *and* every open session is restarted, which is
> exactly when a stale block is most annoying. The transcript approach fixes sessions that
> are already running, for free.
>
> Worth revisiting if the transcript ever stops being readable or the 3s margin proves wrong
> in practice - in which case prefer it outright rather than stacking both, since a reported
> state beats an inferred one whenever you can have it.

**A `lavish-axi poll` is a human gate wearing work clothes.** It blocks until someone opens
the artifact and responds, so the hooks see a busy session while the actual blocker is a
person who has lost the browser tab. That is why `review` outranks `parked`, and why the row
drops its activity text - "Running lavish-axi" beside "Waiting on your review" reads as
progress. `lavish-axi` takes about 1.7 seconds, so it is never on the poll path: the lookup is
fired at most once every `REFRESH_MS` and the page uses the last answer.

**A live poll process is what settles whether a review is still open**, not the transcript.
Claude Code backgrounds any tool past its own ten-minute timeout and writes a `tool_result`,
so the transcript reads as though the poll returned while the process runs on and the gate is
still open - and a review taking a person more than ten minutes is the normal case, not an
edge one. `src/poll-watch.js` scans the process table and attributes each poll to a session by
walking up to the `host.pid` the registry already records for focusing, so nothing new has to
be captured. The path there comes from argv, already expanded.

**no-mistakes' own agent sessions are folded into the repo's row, never given one.**
no-mistakes runs its pipeline steps as Claude sessions in a worktree at
`~/.no-mistakes/worktrees/<repo-hash>/<run-id>`. They carry the same hooks, so they register
themselves - and the worktree is nowhere near the repo, so `matchRunForCwd` cannot place them.
They arrived as a card titled with the bare run id, looking like an unrelated repo, and one
you could never focus, because a daemon-spawned agent has no terminal.

The tie is `matchRunForAgentCwd`: **the run id is a path segment of the agent's cwd.**
(`runs.intent_session_id` looks like the obvious link and is empty on every row.) Matched as a
whole segment against ids we already hold, never as a pattern - guessing at the shape of a
ULID would eventually claim somebody's real directory.

One row per repo, never two. But folding must not swallow the one signal this tool exists to
give, so **a blocked agent still makes the row blocked and carries its message** - an agent
sitting on a permission prompt has stalled the pipeline, and only a human can free it.

**The marker's presence follows the agent existing, never `Agent.activity`.** `activity` is
the tool with no result yet, so it is null between every pair of tool calls - most seconds, on
a busy agent - and rendering on it blinked the marker in and out several times a minute, which
on a pinned page reads as the pipeline starting and stopping. There is no second string to
fall back on either: **a no-mistakes agent transcript carries no `ai-title`** (Claude Code
writes those for interactive sessions only), so `Agent.summary` is always null for one of
these. Hence `Agent.what`, which is never null. Do not re-derive the marker from `activity`.

**A pull request has three possible sources, and they are ranked by how much they know.**
A live no-mistakes run is being watched right now, so its `pr_state` is real. The database's
history is branch-verified but frozen. The transcript is neither, and is the only one that
sees a pull request no-mistakes never opened.

*The frozen part is the trap.* no-mistakes stops observing a pull request the moment its run
reaches a terminal state - `pr_state_observed_at` never advances past `updated_at` - so every
cancelled run in a real database still says `open`, days later. **The link survives the run;
the state word does not.** `PullRequest.live` is what enforces that, and the page shows the
state as a chip only when it is true, otherwise as "was open, last checked 3d ago" in the
tooltip. The runs query deliberately does *not* bound pull requests by the thirty-minute
window it uses for runs: a run is interesting for half an hour, and the review it opened is
what you are waiting on for the rest of the day.

*The transcript part is the sharp edge.* A session mentions plenty of pull requests that are
not its own, and the failure is not a missing link but a confident link to the wrong review.
Two guards, both learned the hard way: the repository in the URL must match the checkout, and
**a record listing several pull requests is not a sighting of any of them**. The no-mistakes
skill injects a table of the last ten runs, every row a different branch and a different PR;
taking the first URL out of it put an unrelated review on the card. A URL on a line naming
our branch is ours; failing that, a record mentioning exactly one is reporting it; a record
mentioning several and none of them ours is worth nothing. This is why `summariseTranscript`
takes a branch, and why `TranscriptReader` caches on it as well as on mtime.

**The branch comes from `.git/HEAD`, not from a matched run.** Borrowing it from no-mistakes
meant a session had a branch only while its pipeline run was recent, which is backwards - the
branch belongs to the checkout. It is also load-bearing for the above, since a pull request is
matched on it. `src/git-branch.js` reads the file directly (handling a worktree's `.git` file)
and caches on mtime; it never shells out, because nothing reachable from the poll loop may.

**The host terminal for a tmux session is deliberately not stored.** A tmux session can be
detached and reattached in a different terminal entirely, so it is resolved fresh on every
click.

**tmux control mode (`tmux -CC`) is matched on pane title, not tty.** Control mode is how
iTerm2 hosts tmux, and it breaks every other assumption: each tmux window becomes a native
iTerm2 tab the tmux client knows nothing about, iTerm2 reports `tty` as `missing value` for
all of them, and the client's own tty belongs to the idle tab where you typed `tmux -CC`.
Focusing that tty - correct for ordinary tmux - raises that one tab no matter which session
you clicked. Title is the one handle both sides share, since iTerm2 names each tab after the
tmux pane title. The leading status glyph is stripped first, because Claude Code animates a
braille spinner through it and the two sides are read a moment apart. On a title collision
nmmon says so rather than raising an arbitrary window, and nothing is selected inside tmux -
iTerm2 does not follow tmux's selection in control mode, so doing it anyway would just move
the user's active window for no visible reason.

## Coding Conventions

- **Every module opens with a comment explaining why it exists**, not what it does - the
  constraint, the failure it prevents, the thing that is non-obvious. Match that density; it
  is the most valuable thing in the codebase. See `src/exec.js`, `public/connection.js`,
  `src/security.js` for the register.
- Comment the *reason* at the point of a surprising decision - see the `titlePath` note in
  `buildRows`, or why the hook cannot read `tty`. Do not comment the obvious.
- JSDoc on exported functions where the shape is not self-evident. No TypeScript syntax - the
  typechecker reads the JSDoc.
- **JSDoc is checked, so it has to be true.** `@param {object[]} rows` is not a description,
  it is a claim that the elements have no properties, and `npm run typecheck` will say so.
- **A `@typedef` lives in the module that owns the concept**, and everything else imports it
  with `@typedef {import('./registry.js').Session} Session`. There is no shared types file -
  `Session` and `Host` belong to `registry.js`, `Run` to `nm-state.js`, `Row` to
  `dashboard.js`, `Terminal` to `focus/terminals.js`. A shape crossing a module boundary gets
  a typedef; a one-off inline object does not.
- **Data arriving from outside gets its own typedef, kept separate from ours.** `RunRow` is
  no-mistakes' snake-cased schema in unix seconds; `Run` is what we speak, camel-cased in
  milliseconds. `HookPayload` is Claude Code's; `Session` is ours. Keeping the pairs distinct
  is what makes the normalising boundary visible.
- Named exports only. `SCREAMING_CASE` module constants for tunables (`POLL_INTERVAL_MS`,
  `STALE_AFTER_MS`) - never a bare number inline.
- 2-space indent, single quotes, semicolons, trailing commas, ~100 columns. There is no
  formatter configured; match the surrounding file.
- `for...of` over `forEach`; early return over nesting; `?.` and `??` freely.
- No dead code, no commented-out blocks, no compatibility shims for versions we do not
  support.

## UI Rules

`public/index.html` is self-contained (inline CSS, one module import of `connection.js`).
Keep it that way - it has no build step and must open as a file.

- Colour comes from the CSS custom properties in `:root`, with a
  `@media (prefers-color-scheme: dark)` block. **Add a variable to both blocks or neither.**
- Attention colour is semantic and ordered: `blocked` > `parked` > `failed` > `idle` >
  `working` > `done`, matching `ATTENTION_ORDER` in `dashboard.js`. Do not introduce a colour
  that competes with `blocked` red.
- **Affordance must match capability.** A focusable row is a `<button>` and says `Focus ↗`; a
  row with no live session behind it is plain and does nothing. Never render a control that
  might not work.
- The liveness dot is positive evidence (a `ping` within `STALE_AFTER_MS`), never the absence
  of an error. When stale, dim the page - it is a snapshot of the past.
- Density over decoration. This is a page you leave pinned and glance at.

## Testing and Quality

```sh
npm test          # 286 tests, no network, no dependencies, ~1s
npm run typecheck # tsc --noEmit over src, bin, hooks, public
```

Both must pass before anything is done.

- **Reproduce a bug as a test first**, then fix what the test exposes.
- Tests are `node:test` + `node:assert/strict`, one file per module, named after the
  behaviour in plain English (`'a blocked session outranks everything, including a parked
  pipeline'`). Use a factory helper with an overrides object for fixtures - see the `run()` /
  `session()` pattern at the top of `test/dashboard.test.js`.
- Comment the *why* in a test when the case is subtle, same as in source.
- **Inject everything external**: the exec runner, the clock, the process table, the pid
  liveness probe. The focus adapters take an injected command runner so the suite can assert
  on the AppleScript and tmux commands that *would* have run without stealing your focus
  mid-test. A test that touches the real machine does not belong here.
- New behaviour in a pure module gets a direct unit test. New behaviour in `server.js` gets a
  test against a live server on an ephemeral port with a scratch `NMMON_HOME`.

Coverage uses Node's own instrumentation, so it needs no dependency either. It crashes on
Homebrew's default Node 26 (a `c8`/`yargs` ESM issue), so pin Node 24 for it:

```sh
PATH="$(brew --prefix node@24)/bin:$PATH" npm run coverage
```

## Safe-Change Rules

- **`src/hooks.js` writes to the user's `~/.claude/settings.json`.** It must keep showing a
  diff, asking first, backing up to `.nmmon-backup`, leaving foreign hooks untouched, and
  being safe to run twice. Never make it write without confirmation.
- **`hooks/nmmon-hook.js` runs inside someone's live Claude session.** It must never fail and
  never block: every path exits 0, quietly, within `TIMEOUT_MS`. A monitor that can break
  Claude Code is worse than no monitor.
- **The hook payload is a privacy boundary.** Session id, cwd, transcript *path*, event name,
  Claude's own notification message, and window identity. Never prompt text, transcript
  content or file contents. Do not widen it.
- **Reading a transcript is not the same as sending one, and the difference is the rule.**
  The server reads the tail of a local file and renders it on the user's own dashboard, in
  the browser, on that same machine. Nothing leaves the machine, and the conversation never
  crosses a process boundary it did not already cross.

  The card itself stays at a glanceable altitude - a title, a mode, a tool name - because
  that is what a list you leave pinned is for. **The expanded panel is the one place
  conversation text appears**, and it is deliberate: pulled per session from `/recent` only
  when a human clicks the chevron, never pushed, never in the state frame, and never in the
  hook payload. Widening the *card* is a design change; widening the *hook payload* is
  forbidden outright, and the boundary that matters is the process one, not the altitude.

  > This rule used to read "do not start putting prompt or message text on the page" full
  > stop. It was relaxed on purpose, for the expando, once it was clear the two halves it
  > collapsed are separable: what the page may show and what may leave the machine. The
  > second half has not moved an inch.
- **Do not weaken `src/security.js`.** Token, `Host` allowlist and `Origin` allowlist are all
  three load-bearing - this server ends up running `osascript` and `tmux`, and localhost is
  not a boundary. `/health` is the only unauthenticated route and returns liveness only.
- **`nm-state.js` reads someone else's database.** Keep the schema probe and the
  `no-mistakes axi status` fallback. Never assume a column exists.
- Do not change the SSE frame shape, event names or `/api` responses without updating
  `public/` in the same change - they are one protocol.
- Flag any change to the poll interval, `KEEPALIVE_MS` or `STALE_AFTER_MS` - they are tuned
  against each other.

## Commands

```sh
npm test                       # 286 tests, ~1s
npm run typecheck              # tsc --noEmit
npm run coverage               # needs Node 24, see above
nmmon serve                    # start the monitor, print the URL
nmmon status                   # one-shot text summary, no server needed
nmmon doctor                   # check the setup, explain what is missing
nmmon focus <session>          # raise a session's window from the terminal
nmmon install-hooks            # merge hooks into ~/.claude/settings.json
nmmon uninstall-hooks
```

Flags: `--port`, `--settings <path>`, `--dry-run`, `--yes`. `NMMON_PORT` sets the default
port. `NMMON_HOME` and `NM_HOME` relocate state - use them when testing by hand so you do not
disturb the running installation.
