# AGENTS.md

Guidance for Claude Code and other agents working in this repo.

`README.md` is for people who want to *use* nmmon - install it, run it, understand what they
are looking at. This file is for changing it: architecture, conventions, and the decisions
that are easy to undo by accident.

## Project Overview

`nmmon` is a single-page monitor for the machine it runs on. It shows every agent session -
Claude Code in a terminal, Claude Desktop, or pi - across every repo, ranks them by who needs
a human, and focuses the window when you click a row.

The product is one sentence: **tell me which session is waiting for me, and take me there.**
Everything else is supporting cast. Optimise for that signal arriving fast and never being
wrong.

**The session is the unit, and everything else is an attribute of one.** This is worth stating
plainly because it was not always true: nmmon began as a monitor for `no-mistakes` and grew
into a monitor for sessions, and a run of decisions written under the old framing survived
into the new one. They all shared a shape - treating a pipeline run as a subject in its own
right - and every one of them eventually put a confident wrong answer on a card. So:

| Attribute | On a card when | From |
| --- | --- | --- |
| needs a human | always - it is the product | hooks, and the transcript that disproves a stale block |
| a no-mistakes run | it is tied to *this* session | the no-mistakes database and the process table |
| a pull request | it is on this checkout's branch | the database, or the session's own transcript |
| a Lavish review | this session is sitting in a poll | the process table |

Two consequences that are not obvious, and that the sections below keep returning to. **A
session and its pipeline run at the same time** - you talk to a session while no-mistakes
works for it - so the card shows both, and neither may displace the other. And **an attribute
we cannot place belongs to nobody**: shown on every session that might own it, it is a false
attribute on all but one, and there is no way to tell which. Better a single card that admits
it than three that quietly disagree.

The failure mode that matters most is not a crash - it is **quiet staleness**. A monitor that
shows a confident green dot over state that stopped updating is worse than one that is
visibly down, because you stop checking. Any change that could let the page or the CLI assert
something it no longer knows is a bug, even if nothing throws.

**nmmon watches one machine and serves the one person sitting at it.** No auth, no multi-user
support, no remote access. Those are scope boundaries rather than gaps waiting to be filled -
each of them turns a local page into a service, and none should be added speculatively.

**Focusing is macOS-only; monitoring itself is portable.** That is a fact about where it has been
run, not a position the design takes, and the seam for another platform is cheap by design - a
terminal is one entry, per the rule under [Architecture](#architecture). What is not worth
writing is an adapter for a terminal or a platform nobody is on: it cannot be exercised against
a real session, so it is guesswork in the shape of support.

## Tech Stack

- Node **22.13+**, ESM only (`"type": "module"`). CI runs the suite on 22 as well as 24, so
  the floor is tested rather than asserted.

  **22.13 is exact, not cautious.** It used to read 22.5, which is when `node:sqlite` landed
  - but it landed *behind* `--experimental-sqlite`, and `npm test` passes no flags, so every
  version from 22.5 to 22.12 would have failed on the import in `src/nm-state.js` the moment
  anyone tried. The flag came off in **22.13.0** (and 23.4.0), which the v22.12 and v22.13
  docs confirm either side of the change. It also clears `oxlint`'s own `>=22.12.0`, so a
  contributor on the floor no longer gets `EBADENGINE` from `npm ci` and a lint step that
  fails on a skipped binary rather than on a lint error.
- **Zero runtime dependencies.** Node builtins only: `node:test`, `node:assert/strict`,
  `node:sqlite`, `node:http`, `node:child_process`. This is absolute - `dependencies` in
  `package.json` stays empty.
- **devDependencies are `typescript`, `@types/node` and `oxlint`, and that is the whole
  list.** They exist only for `npm run typecheck` and `npm run lint`; nothing ships or runs
  against them. Adding a fourth - a formatter, a test framework, a bundler - needs raising
  first, not just doing.

  The linter was raised and agreed rather than assumed, and `oxlint` was chosen over ESLint
  and Biome on the terms this section sets: it is a single binary with **no dependencies of
  its own**, where ESLint means several direct devDependencies and a plugin tree. Biome was
  the other zero-dependency candidate and lost because it bundles a formatter, and turning
  that on would reformat the codebase against the deliberate choice recorded below - so it
  would have meant adding a tool and immediately disabling half of it.

  It runs with no config file, on purpose. The version is pinned by `package-lock.json`, so
  `npm ci` cannot surprise CI with rules a later release added.
- Frontend is plain HTML/CSS/JS in `public/`, served as files. No framework, no bundler, no
  build step.
- Coverage via `node --test --experimental-test-coverage`.

The constraint is deliberate: this has to keep working across Node and no-mistakes upgrades
with no maintenance, and it installs by `git clone` + `npm link` with nothing to fetch at
runtime.

## Architecture

Four sources of truth, joined into one list. **They are listed in the order they matter**, which
is an editorial claim and meant as one: the hooks and the transcript need nothing but the agent
itself, so they lead - the hooks first because they answer the one question the product exists
for, is a human needed, and the transcript because it is what qualifies that answer. The process
table and the database both speak about somebody else's tool, and the database is the optional
one, so it comes last. Do not reorder them back.

| Source | Module | Answers |
| --- | --- | --- |
| agent hooks (pushed) | `src/registry.js` | is the agent blocked waiting for a human? |
| the session's own transcript (tail, on change) | `src/transcript.js` | what is it working on, what is it doing right now, and did it open a pull request? |
| the process table (one `ps`, every 3s) | `src/poll-watch.js` | is a review still open, is a pipeline still running, and whose is it? |
| no-mistakes SQLite DB (polled, 1s) | `src/nm-state.js` | is a pipeline run parked, working, failed? |

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
| `src/firstmate.js` | which sessions firstmate started, from the markers it sets on itself |
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

`scripts/` is **not** part of the product. It holds this repository's own roadmap tooling -
the board, the link check, the shipped-spec CI gate and the Jira reconciliation - and is
absent from `files` in `package.json` for that reason, so none of it ships. `scripts/` may
import from `src/`, as the gate does for `GitBranch`; `src/` must never import from
`scripts/`.

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

**The name you gave a session is identity, so it goes on line 1 and not in `.meta`.** Both
agents let a human name a session - `/rename` in Claude Code, `/name` in pi - and that name is
the only thing that distinguishes two sessions on the same repo *and* the same branch, which is
an ordinary day here. It sits between the repo and the branch because it belongs with them;
`.meta` is where controls and status live, and it is `flex: none` with no ellipsis, so a
34-character name there would push the strip and squeeze line 1 instead of giving. It does not
feed `disambiguateTitles`, which grows a path until two *places* differ - a name that happens to
be unique must not stop that.

The `ai-title` stays on its own line beneath. The two answer different questions - what you
meant the session for, and what it turned out to be doing - and on a long session they drift
apart, which is itself worth seeing.

**Both agents' names normalise onto Claude Code's `custom-title` record**, for the reason pi's
transcript is normalised at all: one concept, one field, one place on the card. pi's `/name`
used to be rewritten as an `ai-title` for want of anywhere better, since pi generates no title
of its own - and `title` for a pi session is null again now, correctly.

**The name survives the 128KB tail window only because Claude Code re-appends it.** `/rename`
writes its `custom-title` record once, which on a long session is far outside anything we read.
What saves it is that Claude Code rewrites the record with every `ai-title` flush, within a few
hundred bytes of one - measured on a 1.3MB transcript as flushes every ~40KB, worst gap 59KB. So
the name inherits the summary's guarantee rather than having one of its own, and needs no head
read, no second cache key and no extra I/O. That is a fact about Claude Code, not about us: if a
name ever stops appearing on a card whose `ai-title` still updates, that re-appending is what
changed, and a head read is the fix.

A `custom-title` is not proof that `/rename` was typed - a fork writes `"<name> (fork)"`, and a
resumed session carries its name forward - and no attempt is made to prove it. All three are the
name Claude Code itself displays for the session, which is the thing worth showing.

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

**A human looking at the row is evidence too, and it is the only evidence an idle session can
produce.** Everything above clears a stale block from something the session *did* - records in
the transcript, a pipeline still running. An idle nudge is fired precisely because the session
is doing nothing, so the one mechanism that retires a block has nothing to work with in the
case where the block means least. Seen live at 749s red on a session with nothing gated.

The escalation itself is right and is not touched - a quiet `Stop` becoming a loud "waiting for
you" a minute later is how a finished session asks for its next instruction. What is added is
that you may answer it. The page claims a human is needed; you are that human, and if you have
looked and nothing is needed, that reading beats the sixty-second timer's.

**A dismissal answers one announcement, never a session, and the key is what makes that true.**
`Session.dismissedBlockAt` stores the `blockAnnouncedAt` that was dismissed, and the row is
quiet only while the two are *equal*. `blockAnnouncedAt` moves on every event that says blocked,
so the next announcement - a permission prompt above all - makes them disagree and the row is
red again on the next poll, unaided. `stateSince` is the obvious key and the wrong one: it does
not move while the state is unchanged, so keying on it would make one dismissal permanent and
let it swallow every future prompt on that session. That is the failure this design exists to
prevent, so if the field is ever changed, change it to something that moves.

**Only the idle nudge may be dismissed, and a permission prompt gets no control at all.** A
session stopped at a prompt genuinely cannot proceed without you, so a control there would be
one whose *working* is the wrong outcome - the affordance rule from the other end. `isIdleNudge`
already separates them and fails closed, so an unrecognised type is a hard block and offers
nothing. The eligibility test is `isDismissibleBlock`, and the server re-runs it on the request
rather than trusting the page: a tab is seconds behind, and the row it drew as a nudge may be a
prompt by the time it is clicked. The state rule holds the block to `isIdleNudge` a second time,
so even a dismissal that somehow reached the record could not suppress a prompt.

**It is server-side, and it says so on the row.** The page and `nmmon status` are one protocol,
so a dismissal only the browser knew would have them disagreeing about the same session; it
lives with the session record, and both renderers show `Row.dismissed`. That visibility is the
load-bearing half. The failure this product cares about most is quiet staleness - a confident
indicator over state that stopped updating, because you stop checking - and a signal silently
hidden is that same failure wearing different clothes. A dismissed row reads `Idle` *and*
`dismissed`, so "nothing is waiting" and "I told it to stop saying so" can never be confused.

Deliberately not built: dismissing a permission prompt, and any timeout that clears a nudge by
itself. The second would be inventing evidence - the whole premise is that a human looked, and
nothing else knows that.

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
`matchRunForCwd` places a run by repo path alone, and that was once the whole rule - deliberate,
on the ground that the row keeps showing the repo's recent pipeline. But several sessions open
on one checkout is an ordinary day, and every one of them matched the same run. Three cards then
carried the same step, the same parked gate and the same folded agent, each with a `Focus ↗` to
a window that could not answer it. Seen with three sessions on this repo: one driving `axi run`,
two with nothing under them at all.

> **The path is no longer sufficient on its own, and the "recent pipeline" rule is gone.**
> `matchRunForCheckout` requires the run's branch to match the checkout's, on the session's own
> path as well as through a worktree's link. The old rule put a *live* pipeline from another
> branch on an idle `main` card - the same wrong answer from the other direction - and a
> checkout that has switched branch has said it is done with what ran there. A checkout whose
> branch cannot be read matches nothing at all, failing closed like every other rule here.
>
> This also retired the thirty-minute recency window. A run that **passed** leaves the page
> when it passes; a run that ended **badly** stays, because failure is unfinished business and
> the moment a card must not go quiet. The failed one needs no timer either - it stops showing
> when the checkout leaves its branch, which is the same signal. `cancelled` counts as
> finished: you cancelled it, so nothing is waiting on you. See `isDisplayable`.
>
> **`FINISHED_QUIETLY` names the two endings that leave, and everything else stays** - so a
> status a later no-mistakes invents (`errored`, `timed_out`) cannot be dropped from the page
> in silence. The status word decides it and whether the run carries an error deliberately does
> not: every `cancelled` run in the real database has one, so reading that instead would put
> back exactly what this drops.
>
> **Staying is not the same as being red, and the two rules fail in different directions.**
> `isDisplayable` fails **open** - an unrecognised status keeps its card, because a card going
> quiet is the worst thing this page can do. `attentionFor` fails **soft** - only `failed` is
> coloured as a failure, and an unrecognised status reads as `working`. Being on the page is
> knowledge; being red is a claim, and we genuinely do not know what a word we have never seen
> means. `ACTIVE_STATUSES` in `nm-state.js` is an allowlist, so an unknown status is not
> `active` either, and a new *running* state (`queued`, `waiting`) would arrive here looking
> exactly like a new ending - red that sometimes means nothing is wrong is how this page stops
> being believed. `ACTIVE_STATUSES` is the one place a new word would need adding.
>
> That makes three guards that fail three different ways, and the shape is the point: each
> fails in the direction that is safe for the thing it guards. `isRunOwnerCommand` fails
> **closed** - an unrecognised *driving verb* must refuse to claim a run, because guessing puts
> a pipeline on the wrong card. Do not "fix" any of them to match the others.

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
- **Ownership narrows for every session but the one that owns the run.** This is the same
  shape as the transcript being allowed to clear a block but never assert one. On the owner's
  own card it is also the positive answer, which is a later change and the resolution of a
  whole class of failures - see *Ownership of a running run decides which run a session's card
  shows* below.

  > A run nobody was observed to own used to stay on **every** session in its repo, on the
  > reasoning that an unattributed pipeline is better shown three times than not at all. Under
  > a session-centric model that is a false attribute on all but one of them, with no way to
  > tell which - and a pipeline line you learn to distrust on one card is one you distrust
  > everywhere. It now goes to a card of its own; see *An unattributable run gets one card*.

**`RunOwners` is a memory because the evidence is intermittent, not because it is expensive.**
`axi run` *returns* at every approval gate and does not run again until the agent answers with
`axi respond`, so there is no process to walk up from for exactly as long as a run is parked -
which is when the dashboard matters most. Without the memory the run would fall off the card of
the session holding its gate, at the gate, onto an unattributable row nobody can act on - and
again for as long as a failed run stays visible, since nothing of it is running by then either.
Verified live - with the run parked, `ps` showed only the daemon, so `nmmon status`, which is
one-shot and has no memory, had nothing to attribute the run with at all. The server polls, so
it catches `axi run` within a second of it starting and holds the answer.

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

`GitBranch.checkoutFor` reads the link off the same `.git` the branch already comes from, and
returns both from one resolution - not two accessors over one cache, because a cache *hit*
still stats HEAD, so asking separately costs a second stat per session per second for one
answer's worth of information. `matchRunForCheckout` tries the session's own directory first.
Five things it deliberately does not do:

- **the link is a fallback, never an override.** no-mistakes will register a worktree as a
  repository in its own right, and that run is the more specific answer - the same rule
  `matchRunForCwd` already applies to nesting.
- **it does not resolve the link by rank, because the link is one-to-many.** Every worktree of
  a checkout resolves to the same path and no-mistakes registers all of their runs against it,
  so `matchRunForCwd`'s ranking - parked, then active, then most recent - hands one run to
  every sibling tree and hands each of them somebody else's. Two runs on one repo inside the
  thirty-minute window is an ordinary half-hour here. A worktree exists in order to be on its
  own branch and every run carries one, so **through the link the branch is required**, and a
  worktree with no branch to match on - a detached HEAD, which Treehouse produces routinely -
  gets no run at all rather than a guess.

  **The branch requirement applies everywhere, for display as well as for ownership.** It
  used to stop at the link, on the rule that display asks what pipeline this checkout has
  recently seen - so a session physically inside the checkout matched by repo path alone,
  whatever branch it had since moved to. That rule is gone: it put a *live* pipeline from
  somebody else's branch on an idle `main` card, with a `Focus ↗` to a window that could not
  answer its gate, and a checkout that has switched branch has said it is done with what ran
  there. Ownership asks the narrower question - which run this session is *driving* - and
  `axi run` and `axi respond` both act on the branch they are issued from, so a session
  cannot be driving a run for a branch it is not on. Narrowing a sighting by branch is the
  definition of that question, not a heuristic answer to it.

  **What the branch may not narrow is identity.** The run a card shows and the repo a card is
  *named* after are two answers, and `buildRows` resolves them separately: `identityRepo` from
  the unfiltered `matchRunForCwd` on the session's own path, `checkoutRun` from the
  branch-gated match. Resolving both from the second coupled a card's name to which runs
  happened to be in the reading - a session in a subdirectory retitled itself from `repo` to
  `packages/api` and back as runs came and went, and lost the pull request its transcript
  reported, the slug guard comparing the URL's repository against that subdirectory's name.

  `RunOwners.observeFrom` therefore resolves a sighting through the same function - for the
  same reason it was given the link in the first place: if the two disagree about which run
  was seen, a genuine `axi run` from the second tree claims the first tree's run, is discarded
  as already owned, and the run it was really of falls through to a bystander - but it hands
  that function only the runs on the session's own branch, and a session with no branch to
  read owns nothing at all. An unowned run gets a card of its own, which is the documented
  degradation rather than a new failure.

  **That was the third instance of one class, and the class is worth naming: rank standing in
  for the branch.** The link picked a run by rank; the link then fanned one run out across
  sibling trees; and a sighting on a session's *own* path was resolved by rank while a parked
  run sat on the same `repoPath` - `rankRun` puts parked above active and `run.parked` implies
  `run.active`, so `observeFrom`'s "only an active run can be owned" guard let it through. The
  common cause is this branch's own premise: every worktree's run registers against the one
  main checkout, so **several runs per `repoPath` is now the ordinary reading, not an unusual
  one**, and anything that resolves a run by rank alone is picking between somebody else's.
  There was a fourth, and it is what closed the class - see below.
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
- **a run may not lend its branch at all, and the fallback that let it is gone.** `branch` used
  to fall back to the matched run's when a checkout's own could not be read, which was fine for
  a session sitting *in* the run's repo and a known-wrong answer through the link, because a
  worktree exists to be on another branch. Caught the moment the link started matching: a tree
  on a detached HEAD, legitimately branchless, took the name of the *sibling* tree's branch -
  and since the pull request is gated on `run.branch === branch`, would have been handed that
  branch's review as well. Requiring the branch on *every* path then removed the fallback
  entirely rather than narrowing it: a run is matched on the branch, so in the one case the
  fallback existed for there is no matched run to borrow from, and the line could never have
  run again. What remains is the rule it was protecting: the branch is the checkout's own, or
  it is null.

**Ownership of a *running* run decides which run a session's card shows; rank is the fallback
for a session that owns nothing live.** This is the resolution of the class above rather than a
fifth rule beside it, and the shape of the mistake is the part worth carrying forward.

`buildRows` used to resolve exactly one run by rank and only then consult `runOwners`, and it
consulted it as a **veto**: the run was dropped when somebody else owned it. So ownership could
take a wrong run off a card and never put the right one on it - which is precisely why the same
failure kept arriving by a new route each time. Through the link, through the sibling fan-out,
through the sighting, and finally here on the display path, every instance was rank picking
between runs that ownership already knew the answer for. A session driving `axi run` was handed
the parked run next to it, `rankRun` putting parked above active, and the run it was actually
driving fell through to an unfocusable row of its own: this feature's failure mode, reached on
the one path that had not yet been closed. Inverting the consultation closes all four, because
there is no longer a place where rank decides something ownership knows.

Two things it deliberately does not change. **Identity still follows the session's own path** -
`title` and `titlePath` come from `identityRepo`, the unfiltered match on the session's own cwd,
so a session that owns a run is not retitled after it and two cards on one checkout keep looking
alike whatever branch either is on. And the **branch requirement is unmoved**: it narrows which
run a card shows and which run a sighting claims, and it never touches the name of the card.
`branch` is the checkout's own, from `.git/HEAD` and nothing else.

The consequence is accepted on purpose: a session owning a run on a branch its checkout has
since left shows *that* run, for as long as it is still going, rather than the repo's newest.
That is the right answer - it is the run this session is answering for, and the only one whose
gate it can actually reach - and the run it no longer shows is not lost, because an unclaimed
run still gets a row of its own.

**The preference ends when the run does, and that qualifier is load-bearing rather than
tidying.** The whole justification for preferring an owned run is the gate it is holding open,
and a finished run has none - so there is nothing left to prefer. An ownership outlives its run
by design (`prune` keeps it for the half hour the run stays in the reading, `release` for as
long as the session lives), so an unconditional preference would let a *completed* run sit on
the card while a live or parked one in the same checkout lost the only session that could focus
it: this branch's own failure, reached from the other side. `run.parked` implies `run.active`,
so a parked run is still preferred, which is the case with a gate actually waiting. A session
whose owned run has finished falls back to the rank-resolved match, nulled when somebody else
owns it, exactly as a session that never owned anything.

**A session and its pipeline get a line each, because they are happening at once.** The card
used to have one line for both, and the step won it: `summary` was set to `step <name>` whenever
a run was attached, and the page then suppressed the summary line outright when a step existed.
The justification was that the step says what is being done to the repo where the transcript
title only says what the conversation is about - true, and beside the point. They are not
alternatives. no-mistakes runs *while* you are talking to the session, so the moment a pipeline
started, what you had been doing vanished off its own card.

So `Row.summary` is always the session's own title, and `Row.pipeline` is what no-mistakes is
doing, rendered as a marked line beneath it. Three shapes, because no-mistakes works in three
different ways and only one of them has an agent to fold in:

| Shape | Where the words come from |
| --- | --- |
| a step running a Claude agent (review, test) | the folded agent's `activity` |
| the CI monitor rebasing a pull request | `step.lastActivity` - it runs **inside the daemon**, with no agent session at all |
| parked at a gate | neither; the step name and the state word above it are the whole story |

The middle row is the one worth remembering. A pipeline can be doing substantial work - a
rebase, a conflict resolution, a re-push - with no Claude session anywhere, so nothing registers
through the hooks and there is nothing to fold. Reported as "no no-mistakes attributed to that
session", and the answer was that `step.lastActivity` had been reaching the page all along and
being thrown away.

**Presence follows the run existing, never the activity** - the same rule as the folded agent
marker, and for the same reason. `activity` is null between every pair of tool calls, so a line
rendered on it blinks several times a minute and reads as the pipeline stopping and starting.
`Pipeline.what` may be null and the line still renders: a step that has not said anything yet
is not a pipeline that has gone away.

**`step.lastActivity` arrives prefixed, and `stepActivity` reads the prefix as an allowlist.**
The vocabulary is no-mistakes' to grow - the live database carries `status:`, `step failed:` and
`log:` - so an unrecognised prefix is dropped rather than shown raw, which is what keeps its
transport noise off a card. `log:` is a line the step printed and the prefix goes. `status:` is
dropped outright, because it restates the step status the line above is already carrying.
`step failed:` is **kept, prefix and all**: it is why a run failed, and a failed run is the one
finished run the page deliberately keeps - dropping it left exactly the card that must not go
quiet showing a step name and nothing else, with the reason already on the row and thrown away.
The word stays because "push to upstream: exit status 1" without it reads as something the step
is doing rather than how it ended.

**An unattributable run gets one card, and it says so.** A run we cannot tie to any session -
started by hand, its session gone, or simply never observed because `axi run` returns at every
gate and `nmmon status` has no ownership memory at all - is the one thing on this page that is
not a session. It earns that by admitting what it does not know: `attributable: false`, a
count of the live sessions sharing its repository, and no `Focus ↗`, because there is nothing
to focus.

The count is of the **logical** repo, not the path. With Treehouse, `work/repo`, `1/repo` and
`2/repo` are one repository, which is exactly what `GitBranch.checkoutFor` already resolves.

**It sorts below every session, whatever state either is in** - including parked, which
normally outranks working. The page ranks by who you can go and help, and this card cannot
take you anywhere. `sortRows` is not enough on its own: the page builds its groups by
filtering the whole list per attention, so a parked run landed in "Pipeline parked at a gate"
above every working session until the page was given a trailing section of its own. If you
change one, check the other.

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

**The marker's presence never follows `Agent.activity`.** `activity` is the tool with no
result yet, so it is null between every pair of tool calls - most seconds, on a busy agent -
and rendering on it blinked the marker in and out several times a minute, which on a pinned
page reads as the pipeline starting and stopping. There is no second string to fall back on
either: **a no-mistakes agent transcript carries no `ai-title`** (Claude Code writes those for
interactive sessions only), so `Agent.summary` is always null for one of these.

**The rule survives; where it hangs has moved.** It used to hang on a never-null `Agent.what`,
and the marker was the agent's own line. The card carries one pipeline line now, for the
session's run and the folded agent alike, so presence follows **the run existing** and
`Pipeline.what` is allowed to be null while the line still renders. `Agent.what` is gone
rather than left unread - once both renderers moved to `Pipeline`, its `title || 'working'`
fallback reached nothing. The accepted consequence: between two tool calls the line shows the
step name alone, where the old one said "working". A step that has not spoken yet is not a
pipeline that has gone away, which is the same statement the never-null rule was making.

**`Agent` does not reach a renderer at all, and is not on `Row`.** It is how a stalled
pipeline turns its repo's row red and lends it the message, and it is where `Pipeline.what`
gets the tool in flight - the row carries those answers rather than the agent behind them. It
was on `Row` until the page and then the CLI both moved to `Pipeline`, at which point it was
unread payload crossing the event stream while looking load-bearing. What it feeds is not
optional and has its own tests: assert the folding through the row's `attention`, `message`
and `pipeline`, never by reaching for the agent.

**A pull request has three possible sources, and they are ranked by how much they know.**
A live no-mistakes run is being watched right now, so its `pr_state` is real *for as long as
something is actually looking*. The database's history is branch-verified but frozen. The
transcript is neither, and is the only one that sees a pull request no-mistakes never opened.

The first of those is `pullRequestForRun`, and it is worth knowing that it is the source a
session card usually shows rather than a fallback - the runs query carries `pr_url` and
`pr_state` too, so any card with a matched run takes its pull request from there. It was
documented as mattering only on the degraded `axi status` path, and that sentence is what hid
the freshness bug below for as long as it did.

**All three are gated on the checkout's branch, the run's own included.** This was written when
`matchRunForCwd` placed a run by repo path alone, so a finished run went on matching a session
for the whole thirty minutes it counted as recent, long after the checkout had moved on -
taking its pull request unconditionally put another branch's review beside `main`. The run
match is branch-gated now and the recency window is gone, so the run can no longer *be* on
another branch. **Keep the check anyway.** It costs nothing, it is the last line of defence on
the source with the most to lose from being wrong, and it stops a future change to the match
silently re-opening a confident wrong link.

A checkout whose branch cannot be read gets no pull request at all, which is a change: the
branch used to fall back to the matched run's, and there is no matched run to borrow from any
more - a run is matched *on* the branch. Nothing is the right answer when the checkout will
not say, because a borrowed branch was a borrowed review link.

*The frozen part is the trap.* no-mistakes stops observing a pull request the moment its run
reaches a terminal state - `pr_state_observed_at` never advances past `updated_at` - so every
cancelled run in a real database still says `open`, days later. **The link survives the run;
the state word does not.** `PullRequest.current` is what enforces that, and the page shows the
state as a chip only when it is true, otherwise as "was open, last checked 3d ago" in the
tooltip. The runs query deliberately does *not* bound pull requests by the thirty-minute
window it uses for runs: a run is interesting for half an hour, and the review it opened is
what you are waiting on for the rest of the day.

**"The run is still going" is not "this reading is current", and the field is called `current`
because reading it as `live` is exactly the mistake.** The rule above guards a frozen reading
from a *finished* run and, until RAI-10, guarded nothing at all against a stale one from a
*running* one - so a merged pull request kept a confident `OPEN` chip. Observation stops
without the run stopping: two runs in the real database were last observed at the same second,
a daemon restart, and then sat in the `ci` step marked `running` for a further **7h23m**
carrying `open`. So `current` requires the run to be active **and** the reading to be no older
than `PR_STATE_FRESH_MS`.

**That threshold is measured, and the measurement is recorded beside it in `nm-state.js`.**
no-mistakes rewrites `pr_state_observed_at` on every poll of its `ci` step rather than only on
change, at a cadence whose worst case over 43 unbiased samples was 112s; five minutes is 2.7x
that, so a healthy run never loses its chip. What no threshold can close is the cadence itself
- up to about two minutes of honestly-fresh, honestly-wrong `open` between a merge and
no-mistakes noticing. That residual is the whole remaining case for **RAI-13**, and it needs
the forge and therefore credentials.

**An observation time may never be substituted.** `pullRequestForRun` used to report
`run.updatedAt` as `observedAt`, which is when the *run* was last touched - it advances every
time the run does anything, so the source most likely to be on a card was also the one a
freshness rule could not see. A source with no observation to offer says null and is not
current: the degraded `axi status` path, and a no-mistakes too old to carry the column.

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

**The branch comes from `.git/HEAD`, and from nowhere else.** Borrowing it from no-mistakes
meant a session had a branch only while its pipeline run was recent, which is backwards - the
branch belongs to the checkout. It is also load-bearing twice over now: a pull request is
matched on it, and so is the run itself, so a wrong branch is a wrong pipeline *and* a wrong
review link. A checkout that will not say gets null and matches neither.
`src/git-branch.js` reads the file directly (handling a worktree's `.git` file) and caches on
mtime; it never shells out, because nothing reachable from the poll loop may.

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

**A firstmate session is identified by what firstmate declares, and it is the same rule again.**
firstmate runs a crew of agents on your behalf, each an ordinary Claude Code session in a tmux
window and a treehouse worktree - so everything we compute already works on one unchanged, and
that is the problem: on a page about which session needs you, there was no way to tell a session
you started from one something else started for you.

Nothing a crewmate *lacks* identifies it. No tty, a treehouse worktree and
`--dangerously-skip-permissions` in argv are each equally true of a handoff worker and of a
no-mistakes pipeline agent. Two positive markers hold, both of them firstmate declaring itself,
and `src/firstmate.js` uses those and nothing else:

| | Evidence |
| --- | --- |
| crew | the pane's tmux **window** name starts `fm-` |
| the captain | `<session cwd>/state/.lock` exists and holds this session's `host.pid` |
| anything else | no chip |

Two near-misses are refused on purpose, and either would be the failure this exists to prevent.
The tmux **session** name is shared by the captain and its crew, so keying on it would chip the
captain as crew - and the captain's own *window* name is no good either, because firstmate pins
`allow-rename off` on a crew window and leaves it *on* for its own, so Claude Code can retitle
it and a chip that silently stops appearing is worse than one that was never there. And the
**working directory** would chip anyone who merely has firstmate's source open: someone fixing
firstmate is not the first mate, and the lock is exactly what separates running it from working
on it, since an editing session's pid is not in it.

One answer for both, because a secondmate goes through the same spawn path and gets an `fm-<id>`
window; telling them apart would mean reading firstmate's private `state/<id>.meta`. The field
is `Row.spawnedBy` - *which tool spawned this window* rather than a firstmate boolean - because
handoff uses the same mechanism with a `handoff-` prefix and is the obvious next entry.

**The cost is on the poll loop, so it is paid once per pane.** RAI-18 introduced the same
`list-panes -a` query, but on the focus *click* path; this one builds cards. The name is pinned
for the life of the window, so a pane is resolved when it is first seen and cached, and the read
is fired and never awaited the way `lavish.js` does - the chip appears a tick later rather than
the loop waiting on tmux. An empty or failed reading keeps the last answer, because a reading we
did not get is not evidence. The pane tables are keyed by the **socket path**, through the same
`socketPath` that `-S` is built from, because a pane id is unique only within a server: keyed on
the raw `$TMUX` instead - whose last field is the *session* index - one server would hold a table,
a rate limit and a `list-panes -a` per session on it, and the once-per-pane claim above would not
be true. The lock is one small file, cached on its own mtime like
`git-branch.js` caches HEAD; the *stat* is not cached, because the lock is written after the
captain's session exists and caching its absence would mean the captain never got a chip at all.

Nothing runs for a session with no tmux pane, and nothing anywhere looks for firstmate itself. A
machine without it has no lock and no `fm-` window, which means no chip, no warning and no
subprocess - the same terms no-mistakes and Lavish are held to. Backends firstmate also supports
(herdr, cmux, zellij, orca) have no `fm-<id>` window and get nothing; guessing from a treehouse
worktree path would chip handoff workers as crew.

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

**A tmux window can belong to more than one session, so "the session owning this pane" is not
a question with one answer.** `link-window` puts one window in several sessions and a grouped
session does the same; `display-message -p -t %356 '#{session_name}'` then returns an arbitrary
one of them, and `select-window -t %356` acts on an arbitrary one of them. The `handoff` skill
builds exactly that shape - a worker runs in a window of a parent session and is then linked
into a per-worker viewer session whose tab is the one you are looking at - so focusing a worker
raised the *parent's* tab and switched that client's current window to the worker's,
permanently. Two clients then displayed one window at different sizes, and tmux sizes a window
to its smallest client, so the real tab drew half width filled with dots until the mouse made
it "latest" again. Seen on all four of four workers.

**Which session tmux names varies with time, which is why the symptom is intermittent.** An
hour after the four readings above, the same panes on the same server resolved to the *viewer*
instead - nothing had changed but which session was most recently active. So the failure comes
and goes with nothing the user did to explain it, and a bug report saying "sometimes" is the
expected shape of this one rather than a sign of something else.

So the pane is resolved to *every* session it lives in (`list-panes -a`), every client is
weighed against those (`list-clients`, deliberately without `-t`, which prefix-matches on
names), and one client is chosen: **the one whose session already displays the window**, because
raising it moves nothing - tmux keeps no per-client current window, so that rule tells candidate
sessions apart and never two clients on one session, which is exactly what it is needed for;
failing that, the one on the session holding **fewest windows**, because a
session holding only this window is a viewer dedicated to it while a session holding five is
somebody's working view that happens to be parked here. Everything after that is aimed at that
client's session by id - `select-window -t '$204:@349'`, never `-t %356`. There is no
"already there, skip it" flag: tmux's `session_set_current` is a no-op when the window is
already current, so the guard would be state to keep true for nothing.

**Two picks come out of that one ranking, not one.** The best client overall is what the ranking
is for; the best **plain** client answers *which tty do I raise, and in which session do I
select*. They are the same client in every ordinary case, and collapsing them loses the
plain-tty fallback that a control mode session with a second, ordinary `tmux attach` depends on.

**`controlMode` is a property of the ranked set, not of either pick**, because the question -
*is this pane living in a native terminal tab tmux cannot see* - is about any client that could
be showing it. Reading it off the top-ranked client was nondeterministic for the reason above:
two clients on one session tie on both keys, so the winner is attach order, and a plain
`tmux attach` that got there first would suppress the pane-title path entirely. The set is
already narrowed to the pane's candidate sessions, which is what keeps this from being the old
`clients.some(...)` over one arbitrarily-chosen session's clients.

**No `-t` target is ever a session name**, and the one name that still reaches a human - the
`tmux attach` hint - is shell-quoted. Names are user data: a bell plugin renames sessions to
`hv-sls-86-fb9d 🔔` here, `-t hv-sls-7` really does match it, and the unquoted hint was two
shell arguments. tmux forbids `:` and `.` in a session name, so `$204:@349` cannot mis-split.

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
  `idle` > `working`, matching `ATTENTION_ORDER` in `dashboard.js`. Do not introduce a colour
  that competes with `blocked` red - `review` sits under it because it is the same thing
  wearing work clothes. There is no state for a run that finished quietly: it leaves the page
  rather than settling into one, `isDisplayable` being the exact complement of the condition
  that would have produced it.
- **Affordance must match capability.** A focusable row is a `<button>` and says `Focus ↗`; a
  row with no live session behind it is plain and does nothing. Never render a control that
  might not work.
- **The host chip states what we know, and `HOST_LABELS` has no fallback.** A kind with no
  entry renders no chip at all. It used to default to `tab`, which turned every host we failed
  to recognise - a Claude Desktop session included - into a confident claim about a terminal
  window that was not there. An unplaceable session says `no window`.
- **A card carries the session's line and the pipeline's line, never one in place of the
  other.** They describe two things happening at once. The step used to take the summary line
  outright, so starting a pipeline erased what you were working on. If a card ever has room for
  only one of them, the answer is not to choose - it is that the card is doing too much.
- **The `unattributed` chip goes where `Focus ↗` would be**, because it answers the same
  question - *where is this?* - with the honest answer that we do not know. That is the
  affordance rule again: a row you cannot act on must not offer a control, and must say why.
- **`Not for me` is the one control here that quiets a signal, so it is drawn to be found and
  not to be pressed.** It shares the focus hint's shape because it sits beside it and answers
  the same row, and it stays at rest colour on hover: focusing takes you somewhere, this takes
  something away, and it must never be the more inviting of the two. It appears only on
  `Row.dismissible` - Claude Code's idle nudge - and a permission-prompt row gets *no* control
  rather than a disabled one.
- **The `dismissed` marker sits beside the state word, because the two are one sentence.** It
  is the only thing separating "nothing is waiting" from "I told it to stop saying so", and the
  page may never let those look alike - a signal hidden without a word is exactly the quiet
  staleness this page is built against. Outlined and `--muted`: it is an explanation, not an
  alarm.
- **The agent chip names pi and stays silent about Claude Code**, and `AGENT_LABELS` has no
  entry for it. Claude Code is most of the rows, and a chip on every card saying so is noise
  on a page whose whole job is to be scannable - the same reason `mode` hides `normal`. pi is
  worth marking because what its states can mean differs: a pi row never turns red for a
  permission prompt, because pi has none. It is outlined and `--faint`, quieter than the host
  chip beside it, since provenance must not compete with where your window actually is.
- **The spawner chip says who started the window, and `SPAWNER_LABELS` has no fallback
  either.** It sits beside the agent chip, wears the same outlined `--faint` style and comes
  first, because it answers the earlier question - who started this, then what is running in it.
  A tool we do not recognise gets no chip, and a session nobody in particular started - most of
  them - says nothing rather than saying so. That silence is the rule from `src/firstmate.js`
  reaching the page: positive evidence, never absence.
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
npm test          # 648 tests, no network, no dependencies, ~2s
npm run lint      # oxlint over src, bin, hooks, public, test, scripts
npm run typecheck # tsc --noEmit over src, bin, hooks, public, scripts
```

All three must pass before anything is done, and `bitbucket-pipelines.yml` runs them on every
pull request, on `main`, and on any other branch push. Tests run again on Node 22 to hold the
`engines` floor honest; lint and typecheck do not, being version-independent. Why there is no
coverage job, and what the two Node versions are each for, is in that file's own comments;
renaming any npm script it invokes - these three, or either roadmap gate below - means
changing it there too.

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
  against each other. `PR_STATE_FRESH_MS` is tuned against something outside this repo
  entirely - no-mistakes' own observation cadence - so changing it means re-measuring, not
  re-reasoning. The measurement is in the comment beside it.

## Roadmap and task tracking

**Jira project [RAI][board] owns ordering and workflow state; this repo owns the
specification.** Each work item is one ticket plus one spec file named for it,
`docs/tasks/RAI-12-stale-page-code.md`. The ticket says what and why; the file says how.
There is no ordered list of work in the repo - what to do next is the backlog, top down.

Branch as `<KEY>-<short-name>`, with the key starting the branch name or a path element of
it - `RAI-12-stale-page-code` or `fix/RAI-12-stale-page-code`. Jira finds the key **anywhere**
in a branch name, so this is our convention rather than its constraint, and
`npm run tasks:gate` is what enforces it. Move the ticket to In Progress by hand when you
pick it up, because nothing transitions until a branch exists. The PR that ships an item
sets `status: shipped` and `shipped:` in its spec file and adds `## Implementation notes`.

An Epic gets a spec too, and it carries the shared background for everything under it -
`docs/tasks/RAI-1-open-source-release.md` holds the reasoning behind the whole open-source
push, so its children need their own file only when one is picked up. **No branch without a
spec file.**

`scripts/` holds four commands over all this - `npm run tasks`, `tasks:links`, `tasks:gate`
and `tasks:validate`. Two of them run in CI, and which two is the design:

- **`tasks:links` on every build.** A spec filename is rewritten when its item is captured,
  so a reference to the old name goes stale in silence - and is as broken on `main` as on a
  branch.
- **`tasks:gate` on pull requests only**, guarded by `BITBUCKET_PR_ID`. It asks a question
  about *merging*, and the `default` pipeline fires on every push including work in progress,
  where the spec correctly still says `in-progress`.
- **`tasks:validate` never**, because it is the only one that talks to Jira and no pipeline
  should hold a credential. That is also why the other two are disk-only: neither can go red
  because a token expired.

Full workflow - capturing, picking up, shipping, the Jira-vs-disk rules and what each command
reports - is the [roadmap-workflow skill](.claude/skills/roadmap-workflow/SKILL.md). **Load it
before creating a ticket or touching anything under `docs/tasks/`.**

[board]: https://mattwwatson.atlassian.net/jira/software/c/projects/RAI/boards/6

## Commands

```sh
npm test                       # 648 tests, ~2s
npm run lint                   # oxlint, no config file
npm run typecheck              # tsc --noEmit
npm run coverage               # needs Node 24, see above
```

The roadmap tooling, which is this repository's own workflow rather than part of the product
- see [Roadmap and task tracking](#roadmap-and-task-tracking):

```sh
npm run tasks                  # the board from docs/tasks/
npm run tasks:links            # every docs/tasks reference resolves
npm run tasks:gate             # this branch's spec says shipped
npm run tasks:validate         # how disk and Jira differ - needs JIRA_EMAIL and JIRA_TOKEN
```

The `nmmon` commands themselves, and their flags, are documented in
[README.md](README.md#commands) and only there - a second copy is what drifts.

When exercising them by hand, set `NMMON_HOME` and `NM_HOME` so you do not disturb the
running installation.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
