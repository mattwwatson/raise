# Raise (`raise`)

One page that shows every agent session on your machine - Claude Code, Claude Desktop and pi -
tells you which one is waiting for you, and jumps to that window when you click it. If you use
`no-mistakes`, each session also shows what its pipeline is doing.

If you run several agent sessions across several repos, the problem is not knowing that work
is happening. It is noticing the one that stopped and wants an answer, and then finding which
of your fifteen terminal tabs it was in. That is what this fixes.

```
WAITING FOR YOU
  hexbattle      HXB-56-residue-never-drains   Waiting for you - permission to use Bash   2m   tmux
PIPELINE PARKED
  firstmate      fm/poll-dispatch              Pipeline parked at a gate                  12s  tab
                 NO-MISTAKES  review
WORKING
  moroku-skills  feature/dev-setup-skill       Working                                         tab
                 NO-MISTAKES  test · Running npm test
```

## What it watches

Three different things, because they answer three different questions.

| Signal | Where it comes from | What it means |
| --- | --- | --- |
| **Waiting for you** | Claude Code hooks | Claude hit a permission prompt or is idle waiting for input. This is the one worth interrupting yourself for. **Claude Code only** - see [pi sessions](#pi-sessions). |
| **Waiting on your review** | the running `lavish-axi poll` | The agent is sitting in a `lavish-axi poll`, waiting for you to open a review page and respond. It looks busy from the outside; it is not. |
| **Pipeline parked** | the no-mistakes database | A run stopped at a gate. Usually the agent answers it itself within seconds, so it is informational. |

**There is nothing to configure per project.** Sessions report themselves through the agent's
hooks, so a repo shows up the first time you work in it and is never registered anywhere. The
pipeline half needs no setting up either: `no-mistakes` keeps one daemon and one SQLite database
for the whole machine, so every repo's runs are read from that one place.

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
would separate them, so they are told apart by their branch, their state, and the name you
gave the session, if you gave it one.

## Every row says what it is about

"Working" across four repos tells you nothing about which one to look at. Every row shows
Claude's own name for the session and the tool it is running this second - and when
no-mistakes is driving, what the pipeline is doing gets a line of its own beneath, because the
two are happening at once:

```
WAITING FOR YOU
  hexbattle      Waiting for you - Claude needs your permission   Editing terrain.js   2m
                 Design landing page with hex game visuals
WORKING
  money-webapp   Working                                          Running npm
                 Build PR feedback automation
```

That comes from the transcript Claude Code already writes, so it is quoted rather than
guessed at. The transcript never leaves your machine: the server reads a local file and
renders it on your own dashboard, in your own browser. Nothing else leaves it either, unless
you deliberately turn on the one feature that asks a forge about a pull request - see
[Security](#security).

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
you to it. The state is only shown as a badge while somebody is actually watching the PR -
which, unless you turn on the forge lookup below, means a no-mistakes run still going *and* a
reading from the last few minutes. Once the run ends no-mistakes stops checking, so a stored
"open" can be days out of date; and a run can keep running long after anything stopped
looking, so being alive is not on its own enough. After that the link stays and the state
moves into the tooltip as *"was open, last checked 3d ago"*. The link outlives the run on
purpose: the run is over in minutes, and the review is what you are waiting on for the rest
of the day.

Pull requests opened outside a no-mistakes run are picked up from the session's own
transcript, so a plain `gh pr create` still gets a link.

**You can have the badge always be right, by letting Raise ask.** Turning on
[pull request state](#pull-request-state-from-the-forge) makes Raise ask GitHub or Bitbucket
directly, which is the one source that cannot be out of date - so a merged pull request stops
saying `OPEN` within the minute, and a review nobody is watching gets a real state rather than
a tooltip. It is off until you configure it, and it is the only thing in Raise that makes an
outbound request.

**The branch is always shown**, next to the repo name, read straight from `.git/HEAD` - so it
is right for worktrees and for sessions that have never run the pipeline. It is also what ties
a pipeline and a pull request to a session, so a checkout on a detached HEAD shows neither
rather than borrowing whichever was nearest.

**If you have named a session, the name is shown too**, between the repo and the branch. Two
sessions on one repo and one branch is an ordinary day, and nothing else on the row tells them
apart - so `/rename Open Source Planning` in Claude Code, or `/name` in pi, is the fastest way
to make the right card obvious:

```
no-mistakes-monitor  Open Source Planning     feat/session-names   3m  tmux  Focus ↗
Waiting for you - Claude needs your permission
Add Pi support and promote session monitoring tool
```

The AI-generated title stays on its own line underneath. The name is what you meant the session
for; the title is what it turned out to be doing, and over a long session the two drift apart.

**One row per repo, even while no-mistakes is running.** no-mistakes does its pipeline work in
its own Claude sessions, in worktrees of their own. Those show up to the hooks like any other
session, so they used to arrive as extra cards titled with a run id - an unrelated-looking
repo you could not click. They are now folded onto the row of the repo they are working on:

```
PIPELINE PARKED
  hexbattle  HXB-63-review                                    2m  tmux  Focus ↗
  Pipeline parked at a gate
  Work out why the ridge tiles overlap
  NO-MISTAKES  review - 2 finding(s) · Reviewing terrain.ts
```

If one of those agents ever stops for a permission prompt, the repo's row goes red and says so
- the pipeline has stalled and only you can free it.

**What you are doing and what the pipeline is doing are separate lines**, because they happen
at the same time. Your session keeps its own state and title while no-mistakes works underneath
it; the `NO-MISTAKES` line says which step is running and what it is up to. That works even when
there is no pipeline agent to see - a CI monitor rebasing your pull request runs inside the
no-mistakes daemon, and the line still reports it.

**The pipeline lands on the session that started it.** Several sessions open on one checkout
is an ordinary day, and only one of them can answer a gate - so the other cards show nothing
about the pipeline at all: no step, no parked gate, no `NO-MISTAKES` line. They still name the
same repo and branch, and they still link its pull request.

**A run that cannot be placed gets one card of its own, at the bottom**, saying it could not be
traced to a session and how many of your sessions share that repo. That happens when the session
that started it has gone, when it was run by hand, or when nothing was running to trace it to.
It is never shown on a session that might not own it: on a page you trust to tell you who needs
you, a pipeline attached to the wrong card is worse than one attached to none.

**A run that has passed leaves the page**, because it is finished business. A run that
**failed** stays, until you switch that checkout to another branch.

A session in a git worktree counts here as being in the checkout the worktree was created
from, because that is the repo no-mistakes registers its runs against - so a pipeline started
from a Treehouse tree lands on that tree's row rather than on an idle card for the main
checkout. Sibling worktrees are told apart by their branch, so a worktree left on a detached
HEAD shows no pipeline rather than the one next door's.

**A session waiting on a Lavish review says so, and gives you the link back.** An agent
sitting in a `lavish-axi poll` has stopped and is waiting for you to open a page you opened a
while ago and have since buried under thirty tabs. The hooks see a busy session, so this used
to be invisible. Now it gets its own group, ranked just under "waiting for you", with a
`Review ↗` straight back to the page.

The favicon carries the most urgent state on the page, so a pinned tab tells you whether
anything wants you without being opened. It goes hollow when the page goes stale, for the same
reason the header dot does.

## Requirements

- Node 22.13 or newer (`node:sqlite` is used, and it is built in - **there are no runtime dependencies**). 22.13 is where `node:sqlite` stopped needing a command-line flag; earlier 22.x will not run it
- Claude Code, for the "waiting for you" half. pi is supported too, with the caveat below
- macOS for window focusing. Monitoring itself works anywhere.

Optional, and independently so - Raise runs with neither, and says nothing about the ones you
do not have:

| Optional | Without it |
| --- | --- |
| `no-mistakes` | No pipeline rows: nothing is parked, failed or running a step, and no pull request comes from the database. Sessions, blocks, reviews and focusing are unaffected. |
| `lavish-axi` | No "waiting on your review" rows. That state is detected by watching for a live `lavish-axi poll` and by nothing else, so without Lavish there is nothing to detect. |
| `gh` | No pull request state from GitHub, if you turned that on at all - see [pull request state](#pull-request-state-from-the-forge). It is off by default, so on an unconfigured machine `gh` is never looked for. |

Absence is not degradation and is never reported as a fault: no warning banner, no `fail` in
`raise doctor`, and nothing shelled out looking for a command that is not there. `raise doctor`
lists each as `--  not installed` so you can tell an integration you skipped from one that
broke. Install no-mistakes later and a running monitor picks it up within a second - the
daemon creates its database on first use, and Raise looks each time it reads.

## Install

```sh
git clone git@bitbucket.org:mattw_watson/no-mistakes-monitor.git
cd no-mistakes-monitor
npm link          # optional, puts `raise` on your PATH
raise install-hooks
raise serve
```

`install-hooks` merges six hook entries into `~/.claude/settings.json`. It shows you exactly
what it will change and asks before writing, keeps a `.raise-backup` copy, leaves any hooks
you already have alone, and is safe to run twice. Undo it with `raise uninstall-hooks`.

When a later version of Raise adds an event to that set, `serve` and `doctor` name the ones
you are missing rather than calling the hooks uninstalled - what you already have keeps
working, and the new event only makes the signal arrive sooner. Re-run `install-hooks` when it
suits you, and restart your sessions then.

**Restart your existing Claude sessions afterwards.** Hooks are read when a session starts, so
sessions already open will not report themselves until you restart them.

Then open the URL `raise serve` prints and leave the tab pinned. Click "Enable alerts" once if
you want desktop notifications when something starts waiting on you.

### Upgrading from `nmmon`

Raise used to be called `nmmon`. If that is what you have installed, two things need doing by
hand, and the first of them wants doing **before you pull this change**.

**Uninstall the old hooks with the old binary.** From your existing checkout, still on the old
commit:

```sh
nmmon uninstall-hooks
nmmon uninstall-pi
```

Raise recognises its own entries in `~/.claude/settings.json` and `~/.pi/agent/settings.json`
by the *filename* of the hook and the extension, and both filenames changed with the rename, so
the new binary does not know the old entries are its. Each one goes on running `node` against
`hooks/nmmon-hook.js` - a path this change deletes - on every one of the six events it was
registered for. What you are likely to see for that is a module-not-found on stderr naming the
old path, which says nothing about a rename, so it is worth knowing to look for it; how loudly
a failing non-blocking hook is surfaced is Claude Code's business rather than ours, and not
something to count on.

What is certain is that Raise cannot tidy this up for you. `uninstall-hooks` does not recognise
the old marker, so it cannot remove the stale entries, and `install-hooks` appends a *second*
group per event rather than replacing the old one - leaving both registered and both firing. If
you have already pulled, editing those two settings files by hand and deleting the entries
naming `nmmon` is the only remedy left.

**Move the forge config across**, if you turned on
[pull request state from the forge](#pull-request-state-from-the-forge):

```sh
mkdir -p ~/.raise && mv ~/.nmmon/config.json ~/.raise/config.json   # keep it 0600
```

`~/.raise/` is created by `raise serve`, which at this point you have not run yet - hence the
`mkdir`. Everything else in `~/.nmmon/` regenerates - the token, `server.json`, the session
records - but this file does not. Left where it is, the lookup silently reverts to off, and it
is silent in both directions: `raise doctor` reports it as simply not enabled, because from the
new path's point of view there is no config to have an opinion about. The mode matters as much
as the move, since an unsafe mode makes Raise refuse the whole file, opt-in included.

### pi sessions

[pi](https://pi.dev) sessions are watched too, and they are marked with a `pi` chip so you can
tell them from Claude Code rows at a glance:

```sh
raise install-pi
```

That adds one path to `~/.pi/agent/settings.json`, with the same manners as `install-hooks` -
it shows the change, asks first, keeps a `.raise-backup`, leaves your other extensions alone
and in order, and is safe to run twice. Restart any pi sessions afterwards; extensions load at
startup. Undo it with `raise uninstall-pi`.

Everything on a pi row works the way it does on a Claude Code row - the repo, the branch, the
pull request, the pipeline step, what it is doing right now, the review gate, and clicking to
focus the window.

**One thing is genuinely different: a pi row never says "waiting for you".** pi has no
permission prompt - it runs its tools without asking - so there is no such state to report,
and Raise does not invent one. A pi session that has finished its turn shows as idle, not as
something demanding your attention. It can still reach the top of the page through its
pipeline: parked, failed, or waiting on a review.

The other small difference: Claude Code writes a short AI-generated title for every session and
pi generates none, so a pi row shows no summary line. Naming the session with `/name Refactor
auth` still works and still shows - it appears next to the repo, the same place Claude Code's
`/rename` does.

## Commands

| Command | Does |
| --- | --- |
| `raise serve` | Start the monitor and print the dashboard URL |
| `raise open` | Print and open that URL again |
| `raise status` | One-shot text summary; no server needed |
| `raise doctor` | Check the setup and explain anything missing |
| `raise focus <session>` | Bring a session's window to the front from the terminal |
| `raise install-hooks` / `uninstall-hooks` | Manage the Claude Code hooks |
| `raise install-pi` / `uninstall-pi` | Manage the pi extension |

Useful flags: `--port`, `--settings <path>`, `--dry-run`, `--yes`. `RAISE_PORT` sets the
default port when `--port` is absent; if it holds something that is not a port, `serve`
refuses to start and says so, while `raise --help` still prints (that being where you go to
find out what the variable should contain).

### When the port is already taken

`serve` asks the port itself - `/health`, the one unauthenticated route - rather than
trusting `~/.raise/server.json`, and answers with one of three things:

| Message | Means | Do |
| --- | --- | --- |
| `Raise is already running on port N (pid P)` | your own monitor is up | `raise open` |
| `Port N is held by another Raise (pid P) that this installation has no record of` | a leftover started under a different `RAISE_HOME` - usually a test run or a stray agent shell | `kill P`, or `raise serve --port <n>` |
| `Port N is in use, and whatever is listening is not Raise` | something unrelated | `lsof -nP -iTCP:N -sTCP:LISTEN` |

The middle case is the awkward one: a monitor started under another `RAISE_HOME` writes its
record somewhere you will never look, so `~/.raise/server.json` says "not running" while the
port very much disagrees. That is why `serve` asks the port rather than the file. `doctor`
reports the same states, and `open` refuses to print a URL when the recorded server has
stopped answering.

## The dashboard is honest about not knowing

Any row that can be focused is a button, says `Focus ↗` on the right, and raises that window
when you click it. Rows without a live agent session behind them - a pipeline running with
no session attached - are plain and do nothing.

The chip beside a row says where the session lives - `tmux`, `tab`, `desktop` - and a session
whose window Raise could not place says `no window` rather than guessing at one. Focusing is
otherwise silent, since the window arriving in front of you is the answer; a short message
means you were raised onto something less than the row you clicked.

A quieter chip says who *started* the window, and today the only tool that declares itself is
[firstmate](https://github.com/kunchenguid/firstmate) - so a crewmate running on your behalf
is distinguishable from a session you opened yourself. It marks the crew and the first mate
alike, and only on firstmate's own evidence: an `fm-` tmux window, or firstmate's lock file
naming the session. Having firstmate's source open is not enough to earn it, a window some
other tool spawned gets nothing, and on a machine without firstmate nothing is looked for at
all. `raise status` prints the same word.

The dot in the header is **positive evidence, not the absence of an error**. The server sends
a `ping` event every 20 seconds; if nothing arrives for 50 the dot goes red, the header reads
`no response for 2m`, and the whole page dims, because everything on it is now a snapshot of
the past. The page then reopens the stream to find out which it is.

This matters more than it sounds. A connection can stop carrying data long before it visibly
breaks - a suspended laptop, a frozen server, a dropped NAT entry - and for a tool whose only
job is telling you something needs you, quietly showing stale data is the worst thing it can
do. So the page never infers that it is live; it waits to be told.

## Telling a nudge it was not needed

Claude Code turns a finished turn into a loud **Waiting for you** after sixty idle seconds, and
that escalation is wanted - it is how a session asks for its next instruction. But nothing
clears it. Raise retires a stale block when the transcript runs past it, and an idle session
writes nothing, so a row where nothing is actually gated can sit red for as long as you leave
it. One was caught at over twelve minutes.

So a row like that carries a **`Not for me`** button. Click it and the row drops to `Idle` and
says `dismissed`, on the page and in `raise status` alike - never silently, because a signal
quietly hidden is exactly as bad as one that is quietly wrong.

**A dismissal answers one announcement, not the session.** The next time anything on that
session asks for you - a permission prompt above all - the row is red again immediately, with
nothing for you to undo. It cannot hide something that matters.

**A permission-prompt row has no button at all.** That session genuinely cannot proceed without
you, so there is nothing there to dismiss, and a control that must not be used is not offered.

**The word `dismissed` explains a quiet row, so it appears on nothing else.** If the same session
turns red again for its pipeline, or starts working because its transcript ran on, the row says
that and only that - the marker is there to tell a quiet row apart from one with nothing to say,
and a row that is neither has no use for it.

## How focusing works

Every terminal style collapses to the same final step - bring the tab with a given tty to the
front - which is why a machine mixing plain tabs and tmux needs no configuration.

- **Plain terminal tab.** The session's own identifiers are captured at session start.
  iTerm2 tabs are matched by their session UUID, which survives the tab being dragged to
  another window. Terminal.app is matched by tty.
- **tmux pane.** A window can belong to more than one tmux session at once, so Raise asks for
  every session this pane lives in, and raises the terminal that is already showing it. Only
  when nothing is showing it does anything move inside tmux, and then only in that one
  session - never in whichever tmux happened to name first.
- **tmux control mode (`tmux -CC`)**, which is how iTerm2 hosts tmux, is a case of its own and
  is matched on the pane title instead. It works the same way from your side.

The host terminal for a tmux session is deliberately **not** stored, because a tmux session
can be detached and reattached in a different terminal entirely. If the session is detached
there is no window to focus, and Raise tells you the `tmux attach` command instead of failing
silently.

Supported terminals today: **iTerm2** and **Terminal.app**, plus **tmux** inside either.

### Claude Desktop sessions

Opening a session in the Claude Desktop app puts it on the dashboard too - the app runs the
same Claude Code underneath, so it fires the same hooks. Those rows are marked `desktop`
rather than `tab`, and everything else about them is ordinary: the repo, the branch, what it
is working on, its pull request, and any no-mistakes run it started all appear exactly as they
do for a terminal session.

Focusing one brings the app to the front, and says so in a toast: Raise cannot reach inside
Claude Desktop to select a session, so it raises the app and leaves the sidebar to you. The
app's `claude://resume` link looks like the answer and is not - it *imports* a session rather
than switching to one, and because the app files its sessions under an id of its own, resuming
one it is already running leaves you with two entries over the same conversation. The one case
where the app would recognise the id instead of copying is a session an earlier such click
already imported, so the link would land on that duplicate rather than the session you clicked
- which is why Raise never uses it.

## Security

The server binds to `127.0.0.1`, but that alone is not a boundary: any page open in your
browser can make requests to localhost, and DNS rebinding can point a hostile domain there.
Since this server ends up running `osascript` and `tmux`, it also requires

- a shared token, generated per install and kept `0600` in `~/.raise/token`
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

**One optional feature sends anything at all, and it is off until you configure it.** Raise
can ask GitHub or Bitbucket whether a pull request already on your dashboard is still open -
once a no-mistakes run ends nothing is watching it, so a stored "open" can be days old. What
goes out is that pull request's own URL, the one the row already links to, to the forge that
hosts it. Nothing else: no transcript, no prompt text, no file contents, no branch names, no
list of your repositories, and no request to any host but that forge's own API -
`api.github.com`, reached through `gh`, or `api.bitbucket.org`, and nowhere else. With it
off - which is the default - Raise makes no outbound network request of any kind. GitHub
goes through your own `gh` login, so Raise never sees a GitHub credential at all; Bitbucket
needs an API token with the single scope `read:pullrequest:bitbucket`, which grants no access
to your source code, kept `0600` in `~/.raise/config.json`, never logged, never echoed, and
never sent anywhere but Bitbucket.

### Pull request state from the forge

Off by default. Turn it on by writing `~/.raise/config.json`:

```sh
umask 077 && cat > ~/.raise/config.json <<'JSON'
{
  "forge": {
    "enabled": true
  }
}
JSON
chmod 600 ~/.raise/config.json
```

That is the whole of it for GitHub: it goes through `gh`, which authenticates itself, so
there is no credential to configure and none for Raise to hold. `gh` needs to be installed
and logged in (`gh auth login`) - it requires authentication even for a public pull request.

Bitbucket has no equivalent CLI, so it needs a token. Create an
[API token with scopes](https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/)
under **Account settings → Security → API tokens**, select **Bitbucket** as the app, and give
it **`read:pullrequest:bitbucket` and nothing else**. That scope allows viewing pull requests
and explicitly does *not* imply `read:repository:bitbucket`, so a token minted for Raise
cannot read your source code. Add it with the Atlassian account email it belongs to, because
Bitbucket authenticates with both:

```json
{
  "forge": {
    "enabled": true,
    "bitbucket": { "email": "you@example.com", "token": "..." }
  }
}
```

**The file must be `0600`.** It holds a credential, so if anyone else on the machine can read
it Raise refuses the whole file - opt-in included - and `raise doctor` says so rather than
quietly doing nothing.

**There is nothing to restart.** A running `raise serve` picks the file up as you write it, so
turning the lookup on, correcting a token or fixing the mode all take effect within a second -
and `raise doctor` never reports something the monitor is not actually doing.

Everything about this fails silently and completely. No `gh`, no login, no credential, no
network, a repository the token cannot see, a rate limit: each of them leaves the row exactly
as it would have been, showing whatever no-mistakes last knew. Failures are remembered too, so
a repository Raise cannot read is asked once and then left alone for fifteen minutes rather
than retried every minute forever - though editing the config file clears that immediately, so
a corrected credential is never a wait. An open pull request is re-checked about once a minute;
a merged one is never asked about again, because it cannot un-merge.

A forge answer ages like any other reading: if the lookups stop answering, the badge goes back
to the tooltip's *"was open, last checked"* within five minutes rather than sitting on an
answer nobody can confirm. A `MERGED` badge is the one exception, and it is the same rule -
that answer cannot change, so there is nothing for it to go stale against. Turning this on can
only ever make a badge more current than it would have been without it, never less.

## Troubleshooting

**Nothing appears.** Run `raise doctor`. The usual cause is hooks installed but sessions not
restarted.

**A session shows but is not clickable.** It started before the hooks were installed, so it
never reported a window identity. Restart it. A Claude Desktop session that predates this
feature is the one exception - it needs no restart, and becomes clickable the next time you
send it anything.

**"tmux session X is not attached to any window."** Exactly what it says - attach it with the
command shown and it becomes focusable.

**A warning banner about the no-mistakes database.** Raise probes the schema each time it
reads, and if a no-mistakes version moves the columns it depends on, it falls back to reading
each repo through `no-mistakes axi status` instead of guessing. Pipeline state still works; it
is just limited to repos that have a live agent session. Worth reporting so the fast path can
be updated - and the banner clears itself, with no restart, once the schema is one Raise
knows again.

This banner means a no-mistakes that is installed and cannot be read. Not having no-mistakes
at all is silent by design - see [Requirements](#requirements).

**No pipeline rows, ever.** Check `raise doctor`. If it says `--  no-mistakes  not installed`
then Raise is looking in `~/.no-mistakes/state.sqlite` and finding nothing, which is the
supported no-no-mistakes setup rather than a fault. `NM_HOME` moves where it looks.

## Development

```sh
npm test          # no network, no build step, ~2s
npm run lint
npm run typecheck
```

Every pull request runs all three, plus the two roadmap checks below, and the tests again on
Node 22 to keep the version requirement above honest.

Architecture, conventions, the file layout and the design decisions behind them are in
[AGENTS.md](AGENTS.md).

## Roadmap

Planned work lives in
[Jira RAI](https://mattwwatson.atlassian.net/jira/software/c/projects/RAI/boards/6) - the
backlog, top down, is the priority order. Each item's written spec is in
[docs/tasks/](docs/tasks/): the ticket says what and why, the file says how.

`npm run tasks` prints the same board from those files. `npm run tasks:links` and
`npm run tasks:gate` are the two checks CI runs over them, the second asserting that the spec
for a pull request's item already says `shipped`. What each command reports, and why only
those two run in CI, is in
[AGENTS.md](AGENTS.md#roadmap-and-task-tracking).
