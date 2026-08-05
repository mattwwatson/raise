# AGENTS.md

Guidance for Claude Code and other agents working in this repo.

`README.md` is for people who want to *use* nmmon - install it, run it, understand what they
are looking at. This file is for changing it: architecture, conventions, and the decisions
that are easy to undo by accident.

## Project Overview

`nmmon` is a single-page monitor for one developer's machine. It shows every `no-mistakes`
pipeline run and every agent session - Claude Code or pi - across every repo, ranks them by
who needs a human, and focuses the terminal window when you click a row.

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

Four sources of truth, joined into one list:

| Source | Module | Answers |
| --- | --- | --- |
| no-mistakes SQLite DB (polled, 1s) | `src/nm-state.js` | is a pipeline run parked, working, failed? |
| agent hooks (pushed) | `src/registry.js` | is the agent blocked waiting for a human? |
| the session's own transcript (tail, on change) | `src/transcript.js` | what is it working on, what is it doing right now, and did it open a pull request? |
| the process table (one `ps`, every 3s) | `src/poll-watch.js` | is a review still open, is a pipeline still running, and whose is it? |

| Path | What |
| --- | --- |
| `bin/nmmon.js` | CLI |
| `src/cli-args.js` | argument parsing (pure) |
| `src/config.js` | paths, ports, the shared token; all env-overridable |
| `src/nm-state.js` | reads the no-mistakes database, with schema probe and fallback |
| `src/registry.js` | live agent sessions, fed by hooks |
| `src/transcript.js` | what a session is doing, parsed from its transcript (pure) |
| `src/transcript-reader.js` | the tail read behind that, cached on mtime, branch and agent |
| `src/git-branch.js` | the branch a checkout is on, and the checkout a worktree belongs to, read from `.git` |
| `src/lavish.js` | resolving a Lavish artifact to the page waiting on you |
| `src/poll-watch.js` | which sessions are in a `lavish-axi poll`, which have a pipeline running, and which are driving one |
| `src/run-owner.js` | which session started which run, remembered across the gaps |
| `src/dashboard.js` | joins them all into ranked rows (pure) |
| `src/focus/` | tmux resolution, per-terminal adapters, and raising Claude Desktop |
| `src/process-tree.js` | which terminal or app, and which agent process, a hook is running under |
| `src/security.js` | token, Host and Origin checks (pure) |
| `src/health.js` | probing a port to find out whether nmmon is behind it |
| `src/exec.js` | the one place that runs external commands |
| `src/server.js` | HTTP, server-sent events, the poll loop |
| `src/hooks.js` | merging our hooks into the user's `~/.claude/settings.json` |
| `src/hook-payload.js` | which fields may leave an agent and reach us (pure) |
| `hooks/nmmon-hook.js` | the Claude Code hook |
| `hooks/nmmon-pi-extension.js` | the pi extension, which is the same reporter in-process |
| `src/pi-transcript.js` | pi transcripts, normalised into the records `transcript.js` reads |
| `src/pi-extension.js` | merging our extension into pi's `settings.json` |
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

**no-mistakes and lavish-axi are optional, and their absence is not a degraded state.** Two of
the four sources are somebody else's tool, and the other two - the hooks and the transcript -
answer the question this product exists for on their own. So a machine with neither installed
is a supported setup, not a broken one, and the rule that follows is: **say nothing about an
integration that is not there, and run nothing looking for it.** No warning banner, no `fail`
in `doctor`, no subprocess.

`nm-state.js` enforces it with a third mode, `absent`, decided by the database file simply not
existing. Conflating that with `cli` - which is what a missing file used to fall into - cost
both halves of the rule at once. It put *"Could not open the no-mistakes database
(ERR_SQLITE_ERROR). Falling back to reading each repo individually"* on the page of somebody
who had never installed no-mistakes, which is a fault report for a choice, and the error code
could not even name the real reason: `node:sqlite` reports a missing file as a generic
`ERR_SQLITE_ERROR`. And it armed the degraded path, which spawns `no-mistakes axi status` once
per session directory every fifteen seconds, forever, for a binary that is not on the machine.

**Which of the three it is gets re-decided on every read**, by one `stat`, and the rule is
that **only `sqlite` is ever remembered, and only while the handle still points at the file it
was decided about.** The database appearing is the daemon creating it on first use, long after
a monitor was left running - deciding `absent` once and for good would leave the page quietly
blind to every pipeline until somebody thought to restart it. The database *going away*
matters more: the read-only handle keeps working on the unlinked inode, so an uninstall would
otherwise leave the monitor serving a deleted file's frozen runs as current.

**That `stat` reads identity, not existence, and the difference is a third case.** The daemon
replaces the file on update, migration or a restore, which the module already assumes when it
reopens once on a query error - but a replacement raises no error at all. The old inode
answers every query happily, so `existsSync` sees a database that is there, the mode stays
`sqlite`, and the previous file's runs are served as current for as long as the monitor runs:
the deletion case's quiet staleness, reached by the path the deletion case does not cover.
`dev` and `ino` captured when the handle is opened, compared on each read, close both for the
same one `stat`.

**`cli` may not latch either, and a database with no tables in it is not a version mismatch.**
`PRAGMA table_info` returns no rows for a table that does not exist rather than throwing, so a
file the daemon has created and not yet applied its schema to reads as one whose every column
has been renamed. Reporting that as `cli` put the warning banner and the fifteen-second
per-repo spawns - the two symptoms `absent` exists to remove - onto the ordinary act of
installing no-mistakes under a running monitor, and left them there, because the re-probe used
to fire only while the mode was `absent`. So a database carrying no tables at all is `absent`,
and every mode except `sqlite` is re-probed on each read. A genuine version mismatch - tables
present, columns we do not recognise - still degrades to the per-repo fallback with its
warning, and now leaves it again when the schema becomes one we know. Re-probing costs an open
and three PRAGMAs against a path that mode is already spawning a process per repo for.

Lavish needs no equivalent, and the reason is worth knowing before adding one: the only thing
that asks `lavish-axi` anything is a session whose transcript or process table shows a live
`lavish-axi poll`, which cannot happen if Lavish is not installed. It is already inert. The
guard that keeps it that way is `server.test.js`'s assertion that neither command is ever run
on a machine without them - negative evidence, so it has to be asserted or it is lost.

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
`SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `Notification`, `Stop`, `SessionEnd` -
so after a block is announced, nothing fires again until the turn ends. **Claude Code has no
event for a permission prompt being answered**, and that is a fact about Claude Code rather
than a choice we made: all 31 hook events were read out of the 2.1.221 binary looking for one.
Granting a permission prompt therefore leaves the session reading "Waiting for you" for the
whole rest of the turn.
Observed live at 185 seconds stale while the transcript was 3 seconds old. A false "waiting
for you" is worse than a missing one: it is what teaches you to stop believing the page.

The transcript settles it, because a session writing records is self-evidently not sitting
waiting for a human. Two properties make this safe, and both were measured rather than
assumed:

- the post-turn metadata records (`ai-title`, `mode`, `last-prompt`) carry **no timestamp**,
  so they cannot move `lastActivityAt` - a genuinely idle session goes quiet immediately

  > **This was true when measured and is no longer the whole story.** Claude Code has since
  > added timestamped records that are not the conversation, and one of them -
  > `system`/`away_summary` - is written *because* the human is away. Counting it moved
  > `lastActivityAt` forward on an idle session, disproved a real block, and rendered the row
  > as "Working": this tool's one signal exactly inverted. Seen at 199s and 191s into a quiet
  > stretch. `lastActivityAt` now counts `assistant` and `user` records only - a whitelist,
  > because the conversation is the stable shape of a transcript while the ancillary types
  > keep arriving (`attachment`, `file-history-delta`, `permission-mode` are all newer than
  > this paragraph). **Do not widen it back to "any record with a timestamp".**
- across real idle periods the last timestamped write lands within **0.3s** of the block,
  against a 3s margin

The transcript may only ever *clear* a block, never assert one. A transcript that cannot be
read leaves the hooks' answer standing.

> **Option not taken: a `PostToolUse` hook.** The direct fix would be to have Claude Code
> report the *end* of the block rather than leave it to be inferred. It is a one-line change -
> add `PostToolUse` to `HOOK_EVENTS` in `src/hooks.js`; `EVENT_STATES` in `registry.js`
> already maps it (and `PreToolUse`) to `working`, so nothing else moves.
>
> Not chosen because it costs a hook process and a localhost POST **per tool call**, inside
> the user's editing loop, and because hooks are read at session start: it fixes nothing
> until `nmmon install-hooks` is re-run *and* every open session is restarted, which is
> exactly when a stale block is most annoying. The transcript approach fixes sessions that
> are already running, for free.
>
> `PostToolBatch` was looked at when `PermissionRequest` was adopted and rejected on the same
> ground. It is cheaper - one hook per batch of parallel calls rather than one per call - but
> it still fires on every step of every turn, and it buys nothing the transcript does not
> already give within 3 seconds.
>
> Adopting `PermissionRequest` did not change this. It reports the *start* of a block sooner;
> the end of one is still inferred, because there is nothing to report it. Revisit only if
> the transcript stops being readable or the 3s margin proves wrong in practice.

**A `lavish-axi poll` is a human gate wearing work clothes.** It blocks until someone opens
the artifact and responds, so the hooks see a busy session while the actual blocker is a
person who has lost the browser tab. That is why `review` outranks `parked`, and why the row
drops its activity text - "Running lavish-axi" beside "Waiting on your review" reads as
progress. `lavish-axi` takes about 1.7 seconds, so it is never on the poll path: the lookup is
fired at most once every `REFRESH_MS` and the page uses the last answer.

**Claude Code's `Notification` hook means two different things, and the payload says which.**
It fires both when Claude wants permission for a tool and when a turn has ended and Claude has
been idle for sixty seconds - and `registry.js` maps both to `blocked`, because at that layer
they are the same event.

The escalation is deliberate for the second case and worth keeping: a quiet `Stop` becoming a
loud "waiting for you" a minute later is how a finished session asks for its next instruction.
What is wrong is applying it to a session whose pipeline is still running. Claude Code
backgrounds a command past its own ten-minute timeout, the turn ends, the nudge fires, and the
page summons you to a session doing plenty of work - observed live for two minutes with
`no-mistakes axi respond` running the whole time.

So a live pipeline disproves the nudge, and **only the nudge**. `isIdleNudge` fails closed:
anything unrecognised stays a hard block, because a permission prompt stops everything until a
human answers whether or not something churns in the background.

**Which one it is comes from `notification_type`, not from the message.** The payload carries
`idle_prompt` for the nudge and `permission_prompt` for a real prompt, so the answer is read
rather than matched. This replaced a regex on the message text, and it is strictly better than
one: a reworded string no longer costs anything, and there is no case where the words and the
type disagree. A type we do not recognise is *new*, not missing, so it stays a block and the
message is not consulted underneath it - falling back there would be guessing with the answer
already in hand. The message remains the fallback only when there is no type at all, which is
a Claude Code too old to send one, or a record written before nmmon read it.

Two other things about this notification are worth knowing, both measured in the 2.1.221
binary. It is **fired on a six-second tick and only once you have been idle six seconds**, so
a permission prompt reaches us six to twelve seconds late, and later still while you are
typing. And it is the *only* thing Claude Code says about a permission prompt: nothing fires
when one is answered. See the `PermissionRequest` note below for the first, and the "recorded
block is disbelieved" note above for the second.

**`PermissionRequest` is the one per-tool-shaped hook worth installing, because it is not
per-tool.** It fires only when a tool actually needs a human: the permission evaluation runs
first, and a rule that approves the tool, `bypassPermissions`, `acceptEdits` for an edit, and
the auto-mode classifier all settle the question before the event is reached. So it is as rare
as a `Notification` and carries none of the cost that made `PostToolUse` unacceptable.

What it buys is **six to twelve seconds**. The `Notification` for a permission prompt is fired
on a repeating six-second tick and only once you have been idle six seconds, so it arrives
late, and later still while you are typing. `PermissionRequest` fires the instant Claude
decides it needs to ask. It also catches prompts answered inside six seconds, which previously
never reached us at all - the cost being that a prompt you answer immediately can render the
row red for one poll. That is a true statement briefly displayed, and `blockDisproved` clears
it as soon as the transcript moves.

It carries no message, so the row says a human is needed and picks up the reason when the
`Notification` catches up. `stateSince` is what matters and it is set by the earlier event, so
the waiting timer counts from when Claude asked rather than from when it got round to saying
so.

**One block, announced twice, needs two timestamps.** `stateSince` deliberately does not move
while the state is unchanged, so once the `Notification` restates a block `PermissionRequest`
already reported, it still points six to twelve seconds back. That is right for the waiting
timer and wrong for the disproof: measuring `blockDisproved`'s three-second margin from there
hands every permission block that much extra tolerance, and a transcript write four seconds
after Claude asked - a sibling tool in the same batch returning, say - would clear a prompt
still sitting open. So `Session.blockAnnouncedAt` moves on *every* event that says blocked and
the disproof anchors on it, while the timer keeps counting from `stateSince`. It is held on
the same terms as `message` and `notificationType`, and a record without it falls back to
`stateSince`, so an older reporter behaves exactly as it always did.

Two things this does **not** do. It does not shorten a stale block by one millisecond - there
is no resolution event, so clearing is still the transcript's job. And it does nothing at all
for a session that is already open: hook *registration* is read at session start, so this
needs `nmmon install-hooks` re-run and every session restarted. Reading `notification_type`,
by contrast, took effect everywhere the moment the server restarted, because the hook script's
*contents* are read fresh on every event. That asymmetry is worth remembering when choosing
between the two kinds of fix.

One residual risk, noted rather than guarded: the hook fires *before* the dialog is rendered,
and a `PermissionRequest` hook that returns `allow` or `deny` suppresses the dialog entirely.
Ours returns nothing so it cannot do that, but a foreign hook could leave us asserting a block
no human ever saw. The transcript clears it within seconds, which is why this is a note and
not a mechanism.

**A live poll process is what settles whether a review is still open**, not the transcript.
Claude Code backgrounds any tool past its own ten-minute timeout and writes a `tool_result`,
so the transcript reads as though the poll returned while the process runs on and the gate is
still open - and a review taking a person more than ten minutes is the normal case, not an
edge one. `src/poll-watch.js` scans the process table and attributes each poll to a session by
walking up to the `host.pid` the registry already records for focusing, so nothing new has to
be captured. The path there comes from argv, already expanded. One `ps` answers both questions
it is asked - which sessions are polling, and which have a pipeline still running.

**A pipeline is matched on the executable, never on the word appearing in argv.** The session
most likely to be wrongly marked is the one working *on* no-mistakes, which greps for the
string, runs tests in a directory named after it, and passes it inside `--instructions` text.
Verified against a real run: the shell wrapper (`zsh -c eval 'no-mistakes axi status'`) is not
matched and does not need to be, because the actual `no-mistakes axi status` child is, and both
walk up to the same session. The permanently running `daemon` is excluded explicitly as well -
the ancestor walk already drops it, but a rule that depends on the walk alone is one refactor
away from claiming every session on the machine.

**A run belongs to the session that started it, and only the process table knows which.**
`matchRunForCwd` places a run by repo path alone. That is deliberate and right for *identity* -
the row keeps showing the repo's recent pipeline - but several sessions open on one checkout is
an ordinary day, and every one of them matched the same run. Three cards then carried the same
step, the same parked gate and the same folded agent, each with a `Focus ↗` to a window that
could not answer it. Seen with three sessions on this repo: one driving `axi run`, two with
nothing under them at all.

Nothing in no-mistakes' database says whose run it is - `runs.intent_session_id` is empty on
every row, the same field that already fails to place the pipeline's own agents. The answer
comes from where the poll gate's does: walk the live process up to the `host.pid` the registry
records for focusing. Same `ps`, third question.

Two rules keep it from becoming a confident wrong answer of its own:

- **Driving a run is ownership; reading one is not.** `isRunOwnerCommand` allows `run`,
  `rerun`, `respond` and `abort` and refuses `status`, `logs` and the rest, so a session that
  merely glanced at the pipeline cannot take the row off the one running it. It is an
  allowlist, and it fails the safe way: a driving verb a later no-mistakes adds goes
  unrecognised, the run goes unattributed, and the page behaves as it did before attribution
  existed. The verb is found by scanning rather than by position, because global flags precede
  it and `--intent` follows it with paragraphs of English - the five most recent real intents
  on this machine run to 5.6KB and use the words "run", "abort" and "status" throughout.
- **Ownership narrows and never widens.** A run nobody was observed to own stays on every
  session in its repo, exactly as before. This is the same shape as the transcript being
  allowed to clear a block but never assert one.

**`RunOwners` is a memory because the evidence is intermittent, not because it is expensive.**
`axi run` *returns* at every approval gate and does not run again until the agent answers with
`axi respond`, so there is no process to walk up from for exactly as long as a run is parked -
which is when the dashboard matters most. Without the memory the row would scatter back across
every session in the repo at the gate, and again for the half hour a finished run stays
visible. Verified live - with the run parked, `ps` showed only the daemon, and `nmmon status`,
which is one-shot and has no memory, still reported all three rows. The server polls, so it
catches `axi run` within a second of it starting and holds the answer.

**Ownership does not change hands between live sessions, and is released when the owner is
gone.** The first half is the guard against a session that ran a driving command near the end
of a pipeline taking the row off the session that started it - a sighting from another *live*
session is not a handover.

The second half exists because the memory above outlives the sessions it names. A session ends
while its run is parked, which is the ordinary way a pipeline outlives the window that started
it, and whoever answers the gate next with `axi respond` is the session a human actually needs.
Held by a dead owner, that run stayed unattributable: the new driver's card showed no pipeline
at all, and the run fell through to a row with no Focus button - this feature's own failure
mode inverted, and a confident wrong answer rather than the vague one it replaced. So `release`
drops any ownership whose session is no longer registered, and it runs *before* the tick's
sightings, or the new driver would still be refused on the very tick the old owner disappeared.

**A reading we did not get is not evidence.** `prune` forgets runs that have left no-mistakes'
recency window, so an empty runs list would forget every ownership at once - and the degraded
`axi status` path returns exactly that from its cache until the first non-blocking call warms
it. A parked run has no live process to be re-observed from, so one such tick would scatter it
back across its repo permanently. The prune is therefore skipped on an empty reading, the same
rule `PollWatch` applies to a `ps` it could not read. A few stale entries until a real reading
arrives is the cheap side of the trade.

**A run started in a worktree is registered against the main checkout, and only `.git` says
so.** no-mistakes places a run by the path a repository resolves to, which for any linked
worktree is the checkout it was created from. The session reporting itself to us is in the
worktree, so `matchRunForCwd`'s prefix could never match - and this is not an edge case,
because Treehouse puts *every* session in a worktree.

Both halves of the attribution above failed on it, in a way that looked like neither. The
sighting was there - `ps` saw `no-mistakes axi run` under the worktree session - and
`observeFrom` threw it away, because it resolves the run being claimed through the same match.
Unowned, the run then fell through to whichever other session happened to be open on the main
checkout. Seen live: the worktree session sat at a parked review gate showing no pipeline at
all, while an idle `main` card claimed the run, on a branch it was not on, with a `Focus ↗` to
the one window that could not answer the gate. Ownership's own failure mode, reached by the
route it does not cover.

`GitBranch.linkedCheckoutFor` reads the link off the same `.git` the branch already comes
from, so it costs nothing extra, and `matchRunForCheckout` tries the session's own directory
first. Three things it deliberately does not do:

- **the link is a fallback, never an override.** no-mistakes will register a worktree as a
  repository in its own right, and that run is the more specific answer - the same rule
  `matchRunForCwd` already applies to nesting.
- **only a common dir named `.git` yields a checkout.** A linked worktree's admin directory is
  always `<common dir>/worktrees/<name>`, and that dir is called `.git` only when the
  repository has a working tree at all. no-mistakes' own gate repos are bare
  (`~/.no-mistakes/repos/<hash>.git`), so its pipeline agents would otherwise be translated to
  a directory no session is ever in; they are placed by run id instead, below. A submodule
  points into `modules/` and is refused the same way.
- **identity keeps the session's own path.** `titlePath` borrows the repo's path only when the
  session is genuinely inside it. Borrowing it here would anchor the worktree and the checkout
  on one path, and `disambiguateTitles` would have nothing left to grow - the `1/` and `2/`
  that name a Treehouse tree would vanish and both cards would read `repo`.
- **a run reached through the link may not lend its branch.** `branch` falls back to the
  matched run's when a checkout's own cannot be read, and that fallback is fine for a session
  sitting *in* the run's repo. Through the link it is a known-wrong answer, because a worktree
  exists to be on another branch. Caught the moment the link started matching: a tree on a
  detached HEAD, legitimately branchless, took the name of the *sibling* tree's branch - and
  since the pull request is gated on `run.branch === branch`, would have been handed that
  branch's review as well.

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

One row per repo, never two - and once a run has an owner, that is the owner's row, because the
folded agent is pipeline state like the step and the parked gate. But folding must not swallow
the one signal this tool exists to give, so **a blocked agent still makes the row blocked and
carries its message** - an agent sitting on a permission prompt has stalled the pipeline, and
only a human can free it.

An agent's block is subject to every disproof a human session's is, and for a sharper reason:
the hooks fall silent between the permission prompt and the end of the turn either way, but
here a stale block pins the whole repo's row red rather than only its own. So the `Agent`
record is built through `effectiveSessionState` - its own transcript clears it, and a live
pipeline answers the idle nudge - and the message goes when the block does. **Only the newest
agent of a run is kept**: a step's agent is still registered while the next one starts, and
letting the later write win would let an older calm agent mask a newly blocked one, which is
exactly the signal folding is not allowed to swallow.

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

**All three are gated on the checkout's branch, the run's own included.** `matchRunForCwd`
places a run by repo path alone - deliberately, so the row keeps showing the repo's recent
pipeline - which means a finished run still matches a session for the whole thirty minutes it
counts as recent, long after the checkout has moved on. Taking its pull request
unconditionally therefore put another branch's review beside `main`: exactly the confident
wrong link the rest of this section is built to prevent. A checkout whose branch cannot be
read is unaffected, because `branch` already falls back to the run's own and the two agree by
construction.

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

A third guard closes the gap between those two, and it lives in `transcriptPullRequest` rather
than in the parser: **the database is the negative authority on ownership.** A run table whose
other rows have not opened a pull request yet carries exactly one URL, so it reads as a
sighting and the exactly-one rule waves it through - which is how PR #1 landed on
`feat/session-summaries-and-typecheck` while this very branch was being built. no-mistakes
knows which branch it opened each pull request from, so a sighting it recognises on a
*different* branch is rejected outright. A sighting it has never heard of is untouched, and
must stay that way: that is the entire case this source exists for. `src/transcript.js`
reports what it saw and deliberately does not decide whose it is.

**The branch comes from `.git/HEAD`, not from a matched run.** Borrowing it from no-mistakes
meant a session had a branch only while its pipeline run was recent, which is backwards - the
branch belongs to the checkout. It is also load-bearing for the above, since a pull request is
matched on it. `src/git-branch.js` reads the file directly (handling a worktree's `.git` file)
and caches on mtime; it never shells out, because nothing reachable from the poll loop may.

**A Claude Desktop session is identified by evidence, never by what it is missing.** The
desktop app hosts a session by spawning its own bundled Claude Code with no controlling
terminal, so it registers through the same hooks as any other session and everything that
keys off `cwd`, `transcriptPath` or `host.pid` - the run match, the branch, the pull request,
the Lavish gate, the pipeline scan - already works on it unchanged. The one thing it has
none of is a window: no tty, no `TERM_PROGRAM`, no terminal UUID. So `planFocus` had nothing
to plan with and the row rendered as a dead card, which is the worst kind on this page - it
tells you a session wants you and offers no way to get there.

`hostApp` in `process-tree.js` settles it from the ancestor walk the hook already does, on
paths only the app can occupy: the Electron binary above the session, or the Claude Code it
bundles under `Application Support/Claude/claude-code/`. **Never inferred from the absence of
a terminal**, even though that absence is what makes the session distinctive - a no-mistakes
agent under the daemon looks identical by that measure, and acting on the guess is not a
harmless miss. Matching a path rather than the word "Claude" is the whole guard.

Focusing is a branch of its own in `focus/index.js` and a sibling module, not an entry in
`terminals.js`, because the `Terminal` interface is `{sessionUuid, tty}` and this host has
neither. Checked before every other branch, since all of them would fall through.

**Claude Desktop cannot be asked to select a session it is already hosting, and the link that
looks like it does something else.** `claude://resume?session=<uuid>` is an *import*, and its
only guard against doing it twice is `if (sessions.get('local_' + idFromTheUrl))`. The app
names its own sessions after a uuid it mints itself and spawns the CLI with a *different* one
- of 197 records in a real store, 189 had a `sessionId` and a `cliSessionId` that disagreed -
so the id we hold is never the id that lookup wants. Resuming a natively hosted session
therefore imported a second entry over the same transcript: two rows in the app's sidebar, one
of them untitled, mirroring each other keystroke for keystroke, and two Claude Code processes
resuming the same session id. Observed three times over two days before anyone connected it to
the click.

There is no other route: `claude://code/...` matches `/^(cse|session)_/`, which is cloud
session ids, and is behind a feature flag. So **raising the app and saying so is the whole
behaviour** - `open -b com.anthropic.claudefordesktop`, plus a `note` on the `FocusResult`
that the page toasts.

**The link is not used even where that dedupe would fire**, and this is the half that took a
second pass to see. A record filed under the id we hold is, by those same numbers, one an
earlier click imported - so resuming it lands on the *copy* rather than the session, and both
such records in the real store were archived, which takes the "unarchive and reuse" branch and
can put a second Claude Code process on the one transcript. The original symptom, reached by
the path meant to avoid it. Consulting the app's own store to tell the two apart was tried and
removed: nothing in a record distinguishes a prior import from the rare case where the app's
uuid and the CLI's coincide, so there is no test that could make the link safe. **Do not
reintroduce a precise path without one.**

Two honest limits remain, and both belong on the page rather than in a comment. `open` returns
once Launch Services accepts, so the app's own failures (expired sign-in, deleted transcript)
surface as a toast inside it and never reach us. And the app opens wherever it left off, which
is usually the session you clicked and sometimes is not - hence the note. `ok` here means
*raised*, never *showing what you asked for*.

**A pi session can never be `blocked`, and that is the design rather than a gap.** pi is a
second agent this monitors, and everything that keys off `cwd`, `transcriptPath` or `host.pid`
- the run match, the branch, the pull request, the Lavish gate, the pipeline scan, every focus
adapter - works on it unchanged. What does not carry over is the signal the tool exists for.

Claude Code asks permission before it runs a tool, so it can say *a human is needed right now*.
pi ships no sandbox and no approval gate; its tools simply run. Nothing inside it corresponds
to a permission prompt, so `PI_EVENT_STATES` in `registry.js` contains no `blocked` at all.

The tempting inference is "the turn ended and nobody has typed since, so escalate to blocked
after a minute" - Claude Code's idle nudge, reimplemented. It was considered and rejected: it
would put pi rows in competition with real permission prompts on the strength of a guess, and
red that sometimes means *nothing is wrong* is how a page stops being believed. A pi session
still reaches the top the honest way, through its pipeline: parked, failed, or waiting on a
review. Revisit only if pi grows a real approval gate, in which case map that and nothing else.

**pi's transcript is normalised, never summarised separately.** `parseTranscriptTail` is the
only Claude-shaped thing in `transcript.js`; everything past it takes plain records. So
`pi-transcript.js` rewrites pi's entries into those records and `summariseTranscript` runs on
both unchanged. A parallel summariser would fork the id-matching in-flight rule, the
`lastActivityAt` whitelist and all three pull-request guards - and the copy that missed the
next fix would be the one putting a confident wrong answer on the page.

Three things the rename has to get right, each learned from the other agent:

- **Every pi entry carries a top-level timestamp**, `model_change` and `thinking_level_change`
  included, and those are written at startup. This is the `away_summary` trap in another
  dialect, so anything that is not the conversation is dropped rather than passed through
  with a timestamp attached. `compactionSummary`, `branchSummary` and extension `custom`
  records go the same way.
- **A tool result is a `user` record**, exactly as in Claude Code. A returning tool is the
  session working; typing it as anything else would make a busy session look idle.
- **Tool names are mapped, not passed through.** `describeToolUse` picks a verb by name and
  `summariseTranscript` keys on `Bash` to notice a `lavish-axi poll`. pi's `bash` left
  lowercase would render as a bare word and, worse, hide a review gate. pi's `path` becomes
  `file_path` for the same reason: without it the card reads "Reading Read".

**The pi reporter is an extension, so "never fail" is stricter than for the hook.**
`nmmon-hook.js` is a separate process - if it throws, a subprocess dies quietly. The pi
extension runs *inside the agent*, and pi awaits event handlers, so an exception surfaces in
somebody's editing loop and a slow `fetch` stalls their turn. Every handler catches
everything; the post is bounded and never awaited.

Two things are easier in return, both from being in-process: the agent pid is simply
`process.pid` rather than something to walk the process table for, and the session file comes
from `ctx.sessionManager.getSessionFile()`. That last one **must be resolved to an absolute
path** - pi returns it exactly as given, so a relative `--session-dir` yields a relative path
that the server would then resolve against its own working directory.

**The extension is registered by path, never copied into `~/.pi/agent/extensions/`.**
Auto-discovery would work and is shorter, but a copied file is a fork: it goes stale the first
time the repo is pulled, and the stale half is the one running inside the agent.
`nmmon-hook.js` is registered the same way for the same reason.

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
- Attention colour is semantic and ordered: `blocked` > `review` > `parked` > `failed` >
  `idle` > `working` > `done`, matching `ATTENTION_ORDER` in `dashboard.js`. Do not introduce
  a colour that competes with `blocked` red - `review` sits under it because it is the same
  thing wearing work clothes.
- **Affordance must match capability.** A focusable row is a `<button>` and says `Focus ↗`; a
  row with no live session behind it is plain and does nothing. Never render a control that
  might not work.
- **The host chip states what we know, and `HOST_LABELS` has no fallback.** A kind with no
  entry renders no chip at all. It used to default to `tab`, which turned every host we failed
  to recognise - a Claude Desktop session included - into a confident claim about a terminal
  window that was not there. An unplaceable session says `no window`.
- **The agent chip names pi and stays silent about Claude Code**, and `AGENT_LABELS` has no
  entry for it. Claude Code is most of the rows, and a chip on every card saying so is noise
  on a page whose whole job is to be scannable - the same reason `mode` hides `normal`. pi is
  worth marking because what its states can mean differs: a pi row never turns red for a
  permission prompt, because pi has none. It is outlined and `--faint`, quieter than the host
  chip beside it, since provenance must not compete with where your window actually is.
- **The expanded panel names the agent that wrote each line**, through `AGENT_NAMES`, which
  *does* carry Claude Code - a label on a line is required where a chip on a card is not. The
  record itself cannot say, because both agents write the same parsed shape, so the row is
  what knows. An agent neither map recognises falls back to the neutral word `agent`, never
  to a name.
- Focusing succeeds silently: the window arriving in front of you is the feedback. A
  `FocusResult.note` is the exception - it means we raised something less than what you
  clicked, and it gets a neutral toast.
- The liveness dot is positive evidence (a `ping` within `STALE_AFTER_MS`), never the absence
  of an error. When stale, dim the page - it is a snapshot of the past.
- Density over decoration. This is a page you leave pinned and glance at.

## Testing and Quality

```sh
npm test          # 434 tests, no network, no dependencies, ~2s
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
- **`hooks/nmmon-pi-extension.js` runs in-process inside someone's live pi session**, which
  is a stricter version of the rule above: pi awaits event handlers, so a throw reaches the
  user's turn and a slow request stalls it. Every handler catches everything, and the post is
  bounded and never awaited. Do not make it `await` anything on pi's path.
- **`src/pi-extension.js` writes to the user's `~/.pi/agent/settings.json`.** Same obligations
  as `hooks.js`: show a diff, ask first, back up, leave every foreign entry in place and in
  order - load order is meaningful in pi - and be safe to run twice.
- **The hook payload is a privacy boundary, and it is an allowlist.** Session id, cwd,
  transcript *path*, event name, Claude's own notification message and type, and window
  identity - the list is `REPORTABLE_FIELDS` in `src/hook-payload.js`, and the reporter sends
  those fields rather than the payload it was handed. Never prompt text, transcript content or
  file contents. Do not widen it.

  It has to be an allowlist because Claude Code's payloads carry all three of those already:
  `UserPromptSubmit` carries `prompt`, `Stop` carries `last_assistant_message`, and
  `PermissionRequest` carries `tool_input`, which for `Write` and `Edit` is the contents of the
  file. Until 04/08/2026 the hook forwarded the payload verbatim, so the first two crossed the
  process boundary on every turn - unread and unstored, but sent. The two failure modes are
  not comparable: a field we forgot to allow is a feature that quietly does not work, and a
  field we forgot to deny is somebody's source code on a socket.
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
npm test                       # 434 tests, ~2s
npm run typecheck              # tsc --noEmit
npm run coverage               # needs Node 24, see above
```

The `nmmon` commands themselves, and their flags, are documented in
[README.md](README.md#commands) and only there - a second copy is what drifts.

When exercising them by hand, set `NMMON_HOME` and `NM_HOME` so you do not disturb the
running installation.
