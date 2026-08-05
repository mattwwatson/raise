# no-mistakes-monitor (`nmmon`)

One page that shows every `no-mistakes` pipeline run and every agent session on your machine -
Claude Code and pi - tells you which one is waiting for you, and jumps to that window when you
click it.

If you run several agent sessions across several repos, the problem is not knowing that work
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

Three different things, because they answer three different questions.

| Signal | Where it comes from | What it means |
| --- | --- | --- |
| **Waiting for you** | Claude Code hooks | Claude hit a permission prompt or is idle waiting for input. This is the one worth interrupting yourself for. **Claude Code only** - see [pi sessions](#pi-sessions). |
| **Waiting on your review** | the running `lavish-axi poll` | The agent is sitting in a `lavish-axi poll`, waiting for you to open a review page and respond. It looks busy from the outside; it is not. |
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

## Every row says what it is about

"Working" across four repos tells you nothing about which one to look at. When no-mistakes is
driving, the row shows the pipeline step. When it is just Claude - which is most of the time -
the row shows Claude's own name for the session, and the tool it is running this second:

```
WAITING FOR YOU
  hexbattle      Waiting for you - Claude needs your permission   Editing terrain.js   2m
                 Design landing page with hex game visuals
WORKING
  money-webapp   Working                                          Running npm
                 Build PR feedback automation
```

That comes from the transcript Claude Code already writes, so it is quoted rather than
guessed at. Nothing leaves your machine: the server reads a local file and renders it on your
own dashboard, in your own browser.

**Expand a row to see the last few things it did.** The chevron on the right of any session
row opens a panel with what you asked, what Claude said back, and every tool it ran with how
each turned out - enough to decide whether to go and look without switching to the terminal.

```
alpha  feat/live-pr                                    PR #41 OPEN   51m  tab  Focus ↗  ⌃
  14:39:21  YOU     can you wire up the settlement ledger and make it idempotent
  14:39:31  CLAUDE  Looking at the existing job first - it retries on failure, so…
  14:39:41  Read    Reading reconcile.js                                        ✓
  14:40:11  Bash    Run the reconciliation tests                                ✗
  14:42:41  Bash    Re-run the reconciliation tests                             …
```

It is fetched only when you open it, one session at a time, and it refreshes while it is
open. Subagent side-conversations and the boilerplate Claude Code injects into the user role
are filtered out, so what you see is what actually passed between you and Claude.

**A row links its pull request.** If a branch has one open, the row shows `PR #41` and takes
you to it. The state is only shown as a badge while a no-mistakes run is actually watching
the PR - once the run ends, no-mistakes stops checking, so a stored "open" can be days out of
date. After that the link stays and the state moves into the tooltip as *"was open, last
checked 3d ago"*. The link outlives the run on purpose: the run is over in minutes, and the
review is what you are waiting on for the rest of the day.

Pull requests opened outside a no-mistakes run are picked up from the session's own
transcript, so a plain `gh pr create` still gets a link.

**The branch is always shown**, next to the repo name, read straight from `.git/HEAD` - so it
is right for worktrees and for sessions that have never run the pipeline.

**One row per repo, even while no-mistakes is running.** no-mistakes does its pipeline work in
its own Claude sessions, in worktrees of their own. Those show up to the hooks like any other
session, so they used to arrive as extra cards titled with a run id - an unrelated-looking
repo you could not click. They are now folded onto the row of the repo they are working on:

```
PIPELINE PARKED
  hexbattle  HXB-63-review                                    2m  tmux  Focus ↗
  Pipeline parked at a gate - step review
  NO-MISTAKES  Reviewing terrain.ts
```

If one of those agents ever stops for a permission prompt, the repo's row goes red and says so
- the pipeline has stalled and only you can free it.

**The pipeline lands on the session that started it.** Several sessions open on one checkout
is an ordinary day, and only one of them can answer a gate - so the other cards show nothing
about the pipeline at all: no step, no parked gate, no `NO-MISTAKES` line. They still name the
same repo and branch, and they still link its pull request. When nmmon cannot tell which
session started a run, the run shows on every session in that repo, as it always did.

**A session waiting on a Lavish review says so, and gives you the link back.** An agent
sitting in a `lavish-axi poll` has stopped and is waiting for you to open a page you opened a
while ago and have since buried under thirty tabs. The hooks see a busy session, so this used
to be invisible. Now it gets its own group, ranked just under "waiting for you", with a
`Review ↗` straight back to the page.

The favicon carries the most urgent state on the page, so a pinned tab tells you whether
anything wants you without being opened. It goes hollow when the page goes stale, for the same
reason the header dot does.

## Requirements

- Node 22.5 or newer (`node:sqlite` is used, and it is built in - **there are no runtime dependencies**)
- Claude Code, for the "waiting for you" half. pi is supported too, with the caveat below
- macOS for window focusing. Monitoring itself works anywhere.

Optional, and independently so - nmmon runs with neither, and says nothing about the ones you
do not have:

| Optional | Without it |
| --- | --- |
| `no-mistakes` | No pipeline rows: nothing is parked, failed or running a step, and no pull request comes from the database. Sessions, blocks, reviews and focusing are unaffected. |
| `lavish-axi` | No "waiting on your review" rows. That state is detected by watching for a live `lavish-axi poll` and by nothing else, so without Lavish there is nothing to detect. |

Absence is not degradation and is never reported as a fault: no warning banner, no `fail` in
`nmmon doctor`, and nothing shelled out looking for a command that is not there. `nmmon doctor`
lists each as `--  not installed` so you can tell an integration you skipped from one that
broke. Install no-mistakes later and a running monitor picks it up within a second - the
daemon creates its database on first use, and nmmon looks each time it reads.

## Install

```sh
git clone git@bitbucket.org:mattw_watson/no-mistakes-monitor.git
cd no-mistakes-monitor
npm link          # optional, puts `nmmon` on your PATH
nmmon install-hooks
nmmon serve
```

`install-hooks` merges six hook entries into `~/.claude/settings.json`. It shows you exactly
what it will change and asks before writing, keeps a `.nmmon-backup` copy, leaves any hooks
you already have alone, and is safe to run twice. Undo it with `nmmon uninstall-hooks`.

When a later version of nmmon adds an event to that set, `serve` and `doctor` name the ones
you are missing rather than calling the hooks uninstalled - what you already have keeps
working, and the new event only makes the signal arrive sooner. Re-run `install-hooks` when it
suits you, and restart your sessions then.

**Restart your existing Claude sessions afterwards.** Hooks are read when a session starts, so
sessions already open will not report themselves until you restart them.

Then open the URL `nmmon serve` prints and leave the tab pinned. Click "Enable alerts" once if
you want desktop notifications when something starts waiting on you.

### pi sessions

[pi](https://pi.dev) sessions are watched too, and they are marked with a `pi` chip so you can
tell them from Claude Code rows at a glance:

```sh
nmmon install-pi
```

That adds one path to `~/.pi/agent/settings.json`, with the same manners as `install-hooks` -
it shows the change, asks first, keeps a `.nmmon-backup`, leaves your other extensions alone
and in order, and is safe to run twice. Restart any pi sessions afterwards; extensions load at
startup. Undo it with `nmmon uninstall-pi`.

Everything on a pi row works the way it does on a Claude Code row - the repo, the branch, the
pull request, the pipeline step, what it is doing right now, the review gate, and clicking to
focus the window.

**One thing is genuinely different: a pi row never says "waiting for you".** pi has no
permission prompt - it runs its tools without asking - so there is no such state to report,
and nmmon does not invent one. A pi session that has finished its turn shows as idle, not as
something demanding your attention. It can still reach the top of the page through its
pipeline: parked, failed, or waiting on a review.

The other small difference: Claude Code writes a short AI-generated title for every session
and pi generates none, so a pi row shows no summary line unless you have named the session
yourself. `/name Refactor auth` gives it one, and the page picks it up on the next poll.

## Commands

| Command | Does |
| --- | --- |
| `nmmon serve` | Start the monitor and print the dashboard URL |
| `nmmon open` | Print and open that URL again |
| `nmmon status` | One-shot text summary; no server needed |
| `nmmon doctor` | Check the setup and explain anything missing |
| `nmmon focus <session>` | Bring a session's window to the front from the terminal |
| `nmmon install-hooks` / `uninstall-hooks` | Manage the Claude Code hooks |
| `nmmon install-pi` / `uninstall-pi` | Manage the pi extension |

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

The middle case is the awkward one: a monitor started under another `NMMON_HOME` writes its
record somewhere you will never look, so `~/.nmmon/server.json` says "not running" while the
port very much disagrees. That is why `serve` asks the port rather than the file. `doctor`
reports the same states, and `open` refuses to print a URL when the recorded server has
stopped answering.

## The dashboard is honest about not knowing

Any row that can be focused is a button, says `Focus ↗` on the right, and raises that window
when you click it. Rows without a live agent session behind them - a pipeline running with
no session attached - are plain and do nothing.

The chip beside a row says where the session lives - `tmux`, `tab`, `desktop` - and a session
whose window nmmon could not place says `no window` rather than guessing at one. Focusing is
otherwise silent, since the window arriving in front of you is the answer; a short message
means you were raised onto something less than the row you clicked.

The dot in the header is **positive evidence, not the absence of an error**. The server sends
a `ping` event every 20 seconds; if nothing arrives for 50 the dot goes red, the header reads
`no response for 2m`, and the whole page dims, because everything on it is now a snapshot of
the past. The page then reopens the stream to find out which it is.

This matters more than it sounds. A connection can stop carrying data long before it visibly
breaks - a suspended laptop, a frozen server, a dropped NAT entry - and for a tool whose only
job is telling you something needs you, quietly showing stale data is the worst thing it can
do. So the page never infers that it is live; it waits to be told.

## How focusing works

Every terminal style collapses to the same final step - bring the tab with a given tty to the
front - which is why a machine mixing plain tabs and tmux needs no configuration.

- **Plain terminal tab.** The session's own identifiers are captured at session start.
  iTerm2 tabs are matched by their session UUID, which survives the tab being dragged to
  another window. Terminal.app is matched by tty.
- **tmux pane.** The pane is raised inside tmux first, then the host window is found by asking
  tmux which client is currently attached.
- **tmux control mode (`tmux -CC`)**, which is how iTerm2 hosts tmux, is a case of its own and
  is matched on the pane title instead. It works the same way from your side.

The host terminal for a tmux session is deliberately **not** stored, because a tmux session
can be detached and reattached in a different terminal entirely. If the session is detached
there is no window to focus, and nmmon tells you the `tmux attach` command instead of failing
silently.

Supported terminals today: **iTerm2** and **Terminal.app**, plus **tmux** inside either.

### Claude Desktop sessions

Opening a session in the Claude Desktop app puts it on the dashboard too - the app runs the
same Claude Code underneath, so it fires the same hooks. Those rows are marked `desktop`
rather than `tab`, and everything else about them is ordinary: the repo, the branch, what it
is working on, its pull request, and any no-mistakes run in that checkout all appear exactly
as they do for a terminal session.

Focusing one brings the app to the front, and says so in a toast: nmmon cannot reach inside
Claude Desktop to select a session, so it raises the app and leaves the sidebar to you. The
app's `claude://resume` link looks like the answer and is not - it *imports* a session rather
than switching to one, and because the app files its sessions under an id of its own, resuming
one it is already running leaves you with two entries over the same conversation. The one case
where the app would recognise the id instead of copying is a session an earlier such click
already imported, so the link would land on that duplicate rather than the session you clicked
- which is why nmmon never uses it.

## Security

The server binds to `127.0.0.1`, but that alone is not a boundary: any page open in your
browser can make requests to localhost, and DNS rebinding can point a hostile domain there.
Since this server ends up running `osascript` and `tmux`, it also requires

- a shared token, generated per install and kept `0600` in `~/.nmmon/token`
- a `Host` header allowlist, which is what actually defeats DNS rebinding
- an `Origin` allowlist

`/health` is the only unauthenticated route, and it returns nothing but liveness.

The hook - and pi's extension, which posts the same payload - never sends prompts,
transcripts or file contents. It sends the session id, the working directory, the event name,
a notification message where Claude supplies one, and the window identity needed to focus
the tab. That is an allowlist rather than a promise: the hook copies out the fields it is
allowed to send, so anything Claude Code adds to a payload in a future version stays inside
your session unless someone deliberately adds it to the list.

Expanding a row shows conversation text, and that is the only place it appears. It is read
from a local file by a local server and rendered in your own browser - it is not in the
event stream, not in the hook payload, and not sent anywhere. The token guards that route
like every other one, which is exactly why localhost alone is not treated as a boundary.

## Troubleshooting

**Nothing appears.** Run `nmmon doctor`. The usual cause is hooks installed but sessions not
restarted.

**A session shows but is not clickable.** It started before the hooks were installed, so it
never reported a window identity. Restart it. A Claude Desktop session that predates this
feature is the one exception - it needs no restart, and becomes clickable the next time you
send it anything.

**"tmux session X is not attached to any window."** Exactly what it says - attach it with the
command shown and it becomes focusable.

**A warning banner about the no-mistakes database.** nmmon probes the schema at startup, and
if a no-mistakes version moves the columns it depends on, it falls back to reading each repo
through `no-mistakes axi status` instead of guessing. Pipeline state still works; it is just
limited to repos that have a live agent session. Worth reporting so the fast path can be
updated.

This banner means a no-mistakes that is installed and cannot be read. Not having no-mistakes
at all is silent by design - see [Requirements](#requirements).

**No pipeline rows, ever.** Check `nmmon doctor`. If it says `--  no-mistakes  not installed`
then nmmon is looking in `~/.no-mistakes/state.sqlite` and finding nothing, which is the
supported no-no-mistakes setup rather than a fault. `NM_HOME` moves where it looks.

## Development

```sh
npm test          # 417 tests, no network, no build step, ~2s
npm run typecheck
```

Architecture, conventions, the file layout and the design decisions behind them are in
[AGENTS.md](AGENTS.md).
