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

**Rows name themselves apart.** A row is normally labelled with just the repo directory name,
but a repo, its worktrees and a second clone of it all share that name - three cards reading
`hexbattle` tell you nothing about which is which. When two rows would collide, each grows
one parent directory at a time until they differ, and no further:

```
work/hexbattle          /Users/you/work/hexbattle
2/hexbattle             /Users/you/.treehouse/hexbattle-04b649/2/hexbattle
no-mistakes-monitor     unique already, so left alone
```

Rows for the *same* place keep one name - two sessions in one repo, say. No amount of path
would separate them, so they are told apart by their branch and state instead.

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

Useful flags: `--port`, `--settings <path>`, `--dry-run`, `--yes`. `NMMON_PORT` sets the
default port when `--port` is absent; if it holds something that is not a port, `serve`
refuses to start and says so, while `nmmon --help` still prints (that being where you go to
find out what the variable should contain).

### When the port is already taken

`serve` asks the port itself - `/health`, the one unauthenticated route - rather than
trusting `~/.nmmon/server.json`, and answers with one of three things:

| Message | Means | Do |
| --- | --- | --- |
| `nmmon is already running on port N (pid P)` | your own monitor is up | `nmmon open` |
| `Port N is held by another nmmon (pid P) that this installation has no record of` | a leftover started under a different `NMMON_HOME` - usually a test run or a stray agent shell | `kill P`, or `nmmon serve --port <n>` |
| `Port N is in use, and whatever is listening is not nmmon` | something unrelated | `lsof -nP -iTCP:N -sTCP:LISTEN` |

The middle case is the awkward one, and it is why `server.json` is not the source of truth
here: a monitor started under another `NMMON_HOME` writes its record somewhere you will never
look, so the file says "not running" while the port very much disagrees. `doctor` reports the
same four states, and `open` refuses to print a URL when the recorded server has stopped
answering - a record outlives a server that was killed rather than shut down.

## The dashboard is honest about not knowing

Any row that can be focused is a button, says `Focus ↗` on the right, and raises that window
when you click it. Rows without a live Claude session behind them - a pipeline running with
no session attached - are plain and do nothing.

The dot in the header is **positive evidence, not the absence of an error**. The server sends
a `ping` event every 20 seconds; if nothing arrives for 50 the dot goes red, the header reads
`no response for 2m`, and the whole page dims, because everything on it is now a snapshot of
the past. The page then reopens the stream to find out which it is.

This matters more than it sounds. `EventSource` only reports an error once the connection
actually breaks, and a connection can stop carrying data long before that - a suspended
laptop, a frozen server, a dropped NAT entry. The keepalive used to be an SSE *comment*, which
the browser discards without telling the page, so in all of those the dashboard sat on a green
"live" dot over state that had stopped updating. For a tool whose only job is telling you
something needs you, quietly showing stale data is the worst thing it can do.

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

126 tests, no dependencies, no network, no build step. The focus adapters take an injected
command runner, so the suite asserts on the AppleScript and tmux commands that *would* run
without stealing your focus mid-test. The same goes for the process table and the pid
liveness probe, which are injected rather than read from the machine running the tests.

That injected runner is **asynchronous everywhere it is reachable from the server**. The
server polls on a one second timer, pushes an event stream and answers hook posts that give
up after two seconds; one synchronous child process stalls all three at once, and the signal
you actually care about is the one that gets dropped. The server tests inject an `exec` that
fails the test if it is ever called, and `/focus` is exercised against it so that guard means
something.

Coverage comes from Node's own `--experimental-test-coverage`, so it needs no dependency
either:

```sh
npm run coverage
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
