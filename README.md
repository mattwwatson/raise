# no-mistakes-monitor (`nmmon`)

One page that shows every `no-mistakes` pipeline run and every Claude Code session on your
machine, tells you which one is waiting for you, and jumps to that window when you click it.

If you run several Claude sessions across several repos, the problem is not knowing that work
is happening. It is noticing the one that stopped and wants an answer, and then finding which
of your fifteen terminal tabs it was in. That is what this fixes.

```
WAITING FOR YOU
  hexbattle      HXB-56-residue-never-drains   Waiting for you - permission to use Bash   2m   tmux
PIPELINE PARKED
  firstmate      fm/poll-dispatch              Pipeline parked at a gate - step review    12s  tab
WORKING
  moroku-skills  feature/dev-setup-skill       Working - step test                             tab
```

## What it watches

Two different things, because they answer two different questions.

| Signal | Where it comes from | What it means |
| --- | --- | --- |
| **Waiting for you** | Claude Code hooks | Claude hit a permission prompt or is idle waiting for input. This is the one worth interrupting yourself for. |
| **Pipeline parked** | the no-mistakes database | A run stopped at a gate. Usually the agent answers it itself within seconds, so it is informational. |

`no-mistakes` keeps a single daemon and a single SQLite database for the whole machine, so
nmmon reads every repo's state from one place. You do not register repos with it and there is
nothing to configure per project.

## Requirements

- Node 22.5 or newer (`node:sqlite` is used, and it is built in - **there are no npm dependencies**)
- `no-mistakes` installed
- Claude Code, for the "waiting for you" half
- macOS for window focusing. Monitoring itself works anywhere.

## Install

```sh
git clone git@bitbucket.org:mattw_watson/no-mistakes-monitor.git
cd no-mistakes-monitor
npm link          # optional, puts `nmmon` on your PATH
nmmon install-hooks
nmmon serve
```

`install-hooks` merges five hook entries into `~/.claude/settings.json`. It shows you exactly
what it will change and asks before writing, keeps a `.nmmon-backup` copy, leaves any hooks
you already have alone, and is safe to run twice. Undo it with `nmmon uninstall-hooks`.

**Restart your existing Claude sessions afterwards.** Hooks are read when a session starts, so
sessions already open will not report themselves until you restart them.

Then open the URL `nmmon serve` prints and leave the tab pinned. Click "Enable alerts" once if
you want desktop notifications when something starts waiting on you.

## Commands

| Command | Does |
| --- | --- |
| `nmmon serve` | Start the monitor and print the dashboard URL |
| `nmmon open` | Print and open that URL again |
| `nmmon status` | One-shot text summary; no server needed |
| `nmmon doctor` | Check the setup and explain anything missing |
| `nmmon focus <session>` | Bring a session's window to the front from the terminal |
| `nmmon install-hooks` / `uninstall-hooks` | Manage the Claude Code hooks |

Useful flags: `--port`, `--settings <path>`, `--dry-run`, `--yes`.

## How focusing works

Both hosting styles collapse to the same final step - bring the terminal tab with a given tty
to the front - which is why a machine mixing plain tabs and tmux needs no configuration.

- **Plain terminal tab.** The session's own identifiers are captured at session start.
  iTerm2 tabs are matched by their session UUID, which survives the tab being dragged to
  another window. Terminal.app is matched by tty.
- **tmux pane.** The pane is raised inside tmux first, then the host window is found by asking
  tmux which client is currently attached and matching that client's tty.

The host terminal for a tmux session is deliberately **not** stored. A tmux session can be
detached and reattached in a different terminal entirely, so it is resolved fresh every time
you click. If the session is detached there is no window to focus, and nmmon tells you the
`tmux attach` command instead of failing silently.

Supported terminals today: **iTerm2** and **Terminal.app**, plus **tmux** inside either.
Adding another is a single entry in `src/focus/terminals.js` - it needs an availability check
and a focus function, and nothing else in the codebase changes.

## Security

The server binds to `127.0.0.1`, but that alone is not a boundary: any page open in your
browser can make requests to localhost, and DNS rebinding can point a hostile domain there.
Since this server ends up running `osascript` and `tmux`, it also requires

- a shared token, generated per install and kept `0600` in `~/.nmmon/token`
- a `Host` header allowlist, which is what actually defeats DNS rebinding
- an `Origin` allowlist

`/health` is the only unauthenticated route, and it returns nothing but liveness.

The hook never sends prompts, transcripts or file contents. It sends the session id, the
working directory, the event name, a notification message where Claude supplies one, and the
window identity needed to focus the tab.

## Troubleshooting

**Nothing appears.** Run `nmmon doctor`. The usual cause is hooks installed but sessions not
restarted.

**A session shows but is not clickable.** It started before the hooks were installed, so it
never reported a window identity. Restart it.

**"tmux session X is not attached to any window."** Exactly what it says - attach it with the
command shown and it becomes focusable.

**A warning banner about the no-mistakes database.** nmmon probes the schema at startup, and
if a no-mistakes version moves the columns it depends on, it falls back to reading each repo
through `no-mistakes axi status` instead of guessing. Pipeline state still works; it is just
limited to repos that have a live Claude session. Worth reporting so the fast path can be
updated.

## Development

```sh
npm test
```

108 tests, no dependencies, no network, no build step. The focus adapters take an injected
command runner, so the suite asserts on the AppleScript and tmux commands that *would* run
without stealing your focus mid-test. The same goes for the process table and the pid
liveness probe, which are injected rather than read from the machine running the tests.

Coverage under Node 26 needs Node 24 (`c8` breaks on 26):

```sh
PATH="$(brew --prefix node@24)/bin:$PATH" npm run coverage
```

### Layout

| Path | What |
| --- | --- |
| `bin/nmmon.js` | CLI |
| `src/cli-args.js` | argument parsing (pure) |
| `src/nm-state.js` | reads the no-mistakes database, with schema probe and fallback |
| `src/registry.js` | live Claude sessions, fed by hooks |
| `src/dashboard.js` | joins the two into ranked rows (pure) |
| `src/focus/` | tmux resolution and per-terminal adapters |
| `src/process-tree.js` | which terminal and which agent process a hook is running under |
| `src/security.js` | token, Host and Origin checks (pure) |
| `src/server.js` | HTTP, server-sent events, the poll loop |
| `hooks/nmmon-hook.js` | the Claude Code hook |
| `public/index.html` | the page, self-contained |

The server polls the SQLite file once a second and pushes to the browser over server-sent
events. The daemon does expose a live event stream over its unix socket, but the protocol is
private and undocumented, so polling a local database was the more stable choice - it survives
no-mistakes upgrades that a reverse-engineered wire format would not.
