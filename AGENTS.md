# AGENTS.md

Guidance for Claude Code and other agents working in this repo.

`README.md` is for people who want to *use* Raise - install it, run it, understand what they
are looking at. This file is for changing it: architecture, conventions, and the decisions
that are easy to undo by accident.

**It is deliberately short, and staying short is a rule rather than an aspiration.** Everything
here is loaded into every session before any work starts, so it earns its place only by being
something you must know *before* you have chosen a file to open. A rule about one module lives
in that module's header, where opening the file delivers it at the moment it is needed. See
[Maintaining this file](#maintaining-this-file) for where a new decision goes.

## Project Overview

Raise is a single-page monitor for the machine it runs on. It shows every agent session -
Claude Code in a terminal, Claude Desktop, pi or Codex - across every repo, ranks them by who needs
a human, and focuses the window when you click a row.

The product is one sentence: **tell me which session is waiting for me, and take me there.**
Everything else is supporting cast. Optimise for that signal arriving fast and never being
wrong.

**The session is the unit, and everything else is an attribute of one.** This is worth stating
plainly because it was not always true: Raise began as a monitor for `no-mistakes` and grew
into a monitor for sessions, and a run of decisions written under the old framing survived
into the new one. They all shared a shape - treating a pipeline run as a subject in its own
right - and every one of them eventually put a confident wrong answer on a card. So:

| Attribute | On a card when | From |
| --- | --- | --- |
| needs a human | always - it is the product | hooks, and the transcript that disproves a stale block |
| a no-mistakes run | it is tied to *this* session | the no-mistakes database and the process table |
| a pull request | it is on this checkout's branch | the database, or the session's own transcript - and, when it is switched on, the forge that hosts it |
| a Lavish review | this session is sitting in a poll | the process table |
| a firstmate ruling | firstmate says this crewmate has stopped on one | the fleet snapshot |

Two consequences that everything below keeps returning to. **A session and its pipeline run at
the same time** - you talk to a session while no-mistakes works for it - so the card shows
both, and neither may displace the other. And **an attribute we cannot place belongs to
nobody**: shown on every session that might own it, it is a false attribute on all but one,
and there is no way to tell which. Better a single card that admits it than three that quietly
disagree.

The failure mode that matters most is not a crash - it is **quiet staleness**. A monitor that
shows a confident green dot over state that stopped updating is worse than one that is
visibly down, because you stop checking. Any change that could let the page or the CLI assert
something it no longer knows is a bug, even if nothing throws.

**Raise watches one machine and serves the one person sitting at it.** No auth, no multi-user
support, no remote access. Those are scope boundaries rather than gaps waiting to be filled -
each of them turns a local page into a service, and none should be added speculatively.

**Focusing is macOS-only; monitoring itself is portable.** That is a fact about where it has been
run, not a position the design takes, and the seam for another platform is cheap by design - a
terminal is one entry, per the rule under [Architecture](#architecture). What is not worth
writing is an adapter for a terminal or a platform nobody is on: it cannot be exercised against
a real session, so it is guesswork in the shape of support.

**Read as a contribution policy that says the opposite of what it means, so read it carefully.**
The objection is to support nobody can exercise, never to the terminal - and somebody adding
Ghostty is by definition somebody who is on Ghostty. It is therefore a requirement on whoever
writes the adapter, not a reason to decline one, and the same holds for a Linux focus path that
Phase 0.4 declined to build *speculatively*. The terms are in
[CONTRIBUTING.md](CONTRIBUTING.md); the boundaries in the paragraph above are the ones that
genuinely stay closed.

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
with no maintenance, and `npm install -g raise-cli` fetches one package with nothing under it -
so the install is the tarball and there is no tree of somebody else's code to audit or to break.

**`npx` is not an install and the README says so.** `install-hooks` writes the absolute path of
`hooks/raise-hook.js` into the user's agent settings, and `src/cli.js` resolves that path
relative to the package - correct for a global install, and pointing into npm's temporary cache
under `npx`. When that cache is cleaned the hooks reference nothing, every session stops
reporting, and the page stays up looking healthy. Do not offer `npx` as a shortcut anywhere.

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

A fifth exists and is deliberately not in that table, because it answers a different kind of
question: **`src/untracked.js` walks the three agents' session directories for transcripts no
hook has ever accounted for.** It is not a source of *state* - it cannot be, which is the whole
of its design - it is what stops the first page a stranger sees being blank. See the header of
`src/untracked.js`.

| Path | What |
| --- | --- |
| `bin/raise.js` | the entry point: the Node version guard, and nothing that could fail before it |
| `src/cli.js` | the CLI itself, reached only through the guard |
| `src/node-support.js` | the Node floor and its one sentence; imports nothing, on purpose |
| `src/cli-args.js` | argument parsing (pure) |
| `src/config.js` | paths, ports, the shared token; all env-overridable |
| `src/nm-state.js` | reads the no-mistakes database, with schema probe and fallback |
| `src/registry.js` | live agent sessions, fed by hooks |
| `src/transcript.js` | what a session is doing, parsed from its transcript (pure) |
| `src/transcript-reader.js` | the tail read behind that, cached on mtime, branch and agent |
| `src/git-branch.js` | the branch a checkout is on, and the checkout a worktree belongs to, read from `.git` |
| `src/lavish.js` | resolving a Lavish artifact to the page waiting on you |
| `src/forge.js` | asking GitHub or Bitbucket whether a pull request is still open |
| `src/user-config.js` | the one file a user writes, the mode check that refuses it, and the one narrow write |
| `src/forge-config.js` | the `forge` block of that file, and what may be asked of a forge |
| `src/update-check.js` | asking npm whether a newer Raise exists, at most once a day |
| `src/poll-watch.js` | which sessions are in a `lavish-axi poll`, which have a pipeline running, and which are driving one |
| `src/firstmate.js` | which sessions firstmate started, from the markers it sets on itself |
| `src/firstmate-decisions.js` | which crewmates are stopped waiting for a ruling from you |
| `src/run-owner.js` | which session started which run, remembered across the gaps |
| `src/dashboard.js` | joins them all into ranked rows (pure) |
| `src/focus/` | tmux resolution, per-terminal adapters, and raising Claude Desktop |
| `src/process-tree.js` | which terminal or app, and which agent process, a hook is running under |
| `src/security.js` | token, Host and Origin checks (pure) |
| `src/build-stamp.js` | which build of the page is being served, so a pinned tab can tell it is running superseded code |
| `src/health.js` | probing a port to find out whether Raise is behind it |
| `src/exec.js` | the one place that runs external commands |
| `src/server.js` | HTTP, server-sent events, the poll loop |
| `src/hooks.js` | merging our hooks into the user's `~/.claude/settings.json` |
| `src/hook-payload.js` | which fields may leave an agent and reach us (pure) |
| `hooks/raise-hook.js` | the Claude Code and Codex hook - one reporter, `--agent` apart |
| `hooks/raise-pi-extension.js` | the pi extension, which is the same reporter in-process |
| `src/pi-transcript.js` | pi transcripts, normalised into the records `transcript.js` reads |
| `src/pi-extension.js` | merging our extension into pi's `settings.json` |
| `src/codex-transcript.js` | Codex rollouts, normalised into those same records |
| `src/untracked.js` | sessions found on disk that no hook has reported |
| `public/index.html` | the page, self-contained |
| `public/connection.js` | the liveness rule, and whether the page's own code is current (pure, no DOM, injected clock) |

`scripts/` is **not** part of the product. It holds this repository's own roadmap tooling -
the board, the link check, the shipped-spec CI gate and the issue reconciliation - and is
absent from `files` in `package.json` for that reason, so none of it ships. `scripts/` may
import from `src/`, as the gate does for `GitBranch`; `src/` must never import from
`scripts/`.

Rules:

- **Pure logic and I/O stay in separate modules.** `cli-args.js`, `dashboard.js`,
  `security.js` and `public/connection.js` are pure and are tested by calling them directly.
  Keep them that way - if a new rule needs the clock, the filesystem or a subprocess, inject
  it as a parameter rather than importing it.
- **Never import `src/exec.js` from a module that needs to shell out.** Take a runner as a
  parameter and default it at the edge (`src/cli.js`, `server.js`). This is what lets the
  suite assert on the AppleScript that *would* have run without stealing your focus mid-test.
- **Nothing reachable from the server may run a synchronous child process.** Use `execAsync`
  / `tryExecAsync`. The server polls on a 1s timer, pushes a stream and answers hook posts
  that time out in 2s; one blocking `spawnSync` stalls all three, and the dropped signal is
  the one you cared about. `server.test.js` injects an `exec` that fails the test if called -
  do not weaken that guard.
- **A new terminal is one entry in `src/focus/terminals.js`** - an availability check and a
  focus function, and nothing else in the codebase changes. If adding terminal support
  touches anything else, the abstraction is being broken; say so rather than working around it.
  This is the contribution the architecture was shaped for, and the bar an outside one has to
  clear is written out in [CONTRIBUTING.md](CONTRIBUTING.md).
- Config, paths and ports resolve through `src/config.js` and are env-overridable
  (`RAISE_HOME`, `NM_HOME`, `RAISE_PORT`) so tests never touch a real installation.

## Design decisions worth knowing

These were each arrived at the hard way. Changing them is allowed; changing them by accident
is the thing to avoid.

**This section holds two kinds of thing, and nothing else.** The invariants below span several
modules, so no single header can own one. The index after them is a pointer per decision: the
rule in a line, and the file whose own header carries the reasoning, the rejected alternative
and the failure that produced it. The index is not a summary of those headers - it is how you
find the one you need. **Open the file before changing anything it owns.** A rule compressed to
one line has lost the reason it exists, and a rule without its reason is one the next person
reverts while tidying.

### Invariants no single module owns

**Quiet staleness is the failure mode.** A confident indicator over state that stopped
updating is worse than a visible outage, because you stop checking. Every rule below is a
special case of this one. A signal silently *hidden* is the same failure wearing different
clothes, which is why a dismissed row still says `dismissed` and an unattributable run still
gets a card.

**Indirect evidence may disprove, and may never assert.** The transcript can clear a stale
block - a session writing records is self-evidently not sitting waiting for a human - and it
can never announce one. A live pipeline can disprove the idle nudge and never a permission
prompt. **The forge is the single documented exception**, and it earns it by being the
authority on its own pull requests where every other source is somebody's recollection of one;
it settles the state, never the identity and never the link. If you find yourself adding a
second exception, that is the argument to have first.

**Positive evidence, never absence.** Liveness is a `ping` that arrived, not an error that did
not. A firstmate crewmate is identified by the `fm-` window firstmate pins, never by the tty it
lacks. Claude Desktop is matched on paths only that app can occupy, never on having no
terminal - a no-mistakes agent under the daemon is indistinguishable by that measure. Where
there is nothing positive to read, the honest answer is no answer: a host we cannot place says
`no window`, and a label map with no entry renders no chip.

**A reading we did not get is not evidence.** An empty `ps`, an empty runs list, an empty
session list and a failed tmux query are all *absences of a reading*, not readings of an
absence. Nothing may be retired, pruned or released on one. This is why the poll's `release`
and `prune` calls are guarded on a non-empty list, and why a failed forge lookup drops its
previous reading rather than being treated as an answer.

**Guards fail in the direction that is safe for what they guard, and they do not match each
other.** `isDisplayable` fails **open** - an unrecognised run status keeps its card, because a
card going quiet is the worst outcome here. `attentionFor` fails **soft** - only `failed` is
coloured as a failure, because being on the page is knowledge and being red is a claim.
`isRunOwnerCommand` and `isIdleNudge` fail **closed** - an unrecognised driving verb claims no
run and an unrecognised notification type stays a hard block, because guessing puts a pipeline
on the wrong card and swallows a permission prompt. **Do not "fix" any of them to match the
others.**

**The branch comes from `.git/HEAD`, and from nowhere else.** It is the checkout's own property
or it is null - never borrowed from a run, never inferred. It gates three things at once: which
run a session matches, which pull request a row shows, and which run a sighting may claim. A
wrong branch is therefore a wrong pipeline *and* a confident link to the wrong review, and a
checkout that will not say gets nothing rather than a guess.

**An attribute we cannot place belongs to nobody.** Shown on every session that might own it,
it is false on all but one with no way to tell which - and a line you learn to distrust on one
card is one you distrust everywhere. An unattributable run gets a single card that says so.

**An optional integration's absence is not a degraded state, and the rule is: say nothing about
it, and run nothing looking for it.** no-mistakes, lavish-axi and firstmate are each somebody
else's tool, and the hooks and the transcript answer this product's question without them. So a
machine with none installed is a supported setup - no warning banner, no `fail` in `doctor`, no
subprocess. `server.test.js` asserts that none of `lavish-axi`, `no-mistakes`, `tmux` or the
`bash` behind firstmate's fleet snapshot is ever run on a machine without them; that is
negative evidence, so it has to be asserted or it is lost.

**One answer per fact.** The page never argues with itself. Where two sources disagree the
ranking decides and the loser is silent - a disagreement with no-mistakes is not surfaced,
because it means only that no-mistakes' reading is older, which `observedAt` already records. A
page that shows a second opinion teaches you to stop believing the first.

### Decision index

One row per decision, and the file that owns the reasoning. Where a row says a spec, the
measurement is there and dated - `docs/tasks/` is the home for one-time captures, and specs are
stratified on purpose, so read the whole file rather than one section.

| Decision | Owner |
| --- | --- |
| no-mistakes is optional; `absent` is a third mode, decided by the file not existing | `src/nm-state.js` |
| the mode is re-decided every read, and only `sqlite` is ever remembered | `src/nm-state.js` |
| the `stat` reads identity (`dev`/`ino`), not existence - a replaced database raises no error | `src/nm-state.js` |
| a database carrying no tables is `absent`, not a version mismatch | `src/nm-state.js` |
| a frozen `pr_state` is not a current one; `PR_STATE_FRESH_MS` and its measurement | `src/nm-state.js` |
| polling SQLite rather than the daemon's private socket | `src/server.js` |
| the keepalive is a named SSE `event`, never a comment | `src/server.js`, `public/connection.js` |
| `release` and `prune` are skipped on an empty reading | `src/server.js` |
| `server.json` is not the source of truth for "is it running" - `/health` is | `src/health.js` |
| a session's summary is read from its transcript, not reported by the hook | `src/transcript.js` |
| the tool in flight is the one with no result yet; match on ids, never position | `src/transcript.js` |
| `lastActivityAt` is a whitelist of `assistant` and `user` - the `away_summary` regression | `src/transcript.js` |
| the name survives the 128KB tail only because Claude Code re-appends it | `src/transcript.js` (`TAIL_BYTES`) |
| the tail read is cached on mtime, branch and agent | `src/transcript-reader.js` |
| both agents' session names normalise onto `custom-title` | `src/pi-transcript.js` |
| a recorded block is disbelieved once the transcript runs past it | `src/dashboard.js` (`blockDisproved`) |
| `PostToolUse` / `PostToolBatch` rejected - the one-line change and why not | `src/hooks.js` (`HOOK_EVENTS`) |
| `PermissionRequest` is the one per-tool-shaped hook worth installing | `src/hooks.js` |
| `Notification` means two things; `notification_type` says which, and the message is the fallback | `src/dashboard.js` (`isIdleNudge`) |
| one block announced twice needs two timestamps - `stateSince` vs `blockAnnouncedAt` | `src/registry.js` |
| a dismissal answers one announcement; the key must be something that moves | `src/registry.js` (`dismissBlock`) |
| only the idle nudge is dismissible; a permission prompt gets no control | `src/dashboard.js` (`isDismissibleBlock`) |
| `dismissed` is on the row only while the dismissal is what quietened it | `src/dashboard.js` (`Row`) |
| a `lavish-axi poll` is a human gate wearing work clothes, and is never on the poll path | `src/lavish.js` |
| a live poll process, not the transcript, settles whether a review is open | `src/poll-watch.js` |
| a pipeline is matched on the executable, never the word in argv; the daemon is excluded | `src/poll-watch.js` |
| which verbs count as driving: `isRunOwnerCommand` is an allowlist, scanned rather than positional | `src/poll-watch.js` |
| a run belongs to the session driving it, not to every session in the repo | `src/run-owner.js` |
| `RunOwners` is a memory because `axi run` returns at every gate | `src/run-owner.js` |
| ownership never changes hands between live sessions, and is released when the owner is gone | `src/run-owner.js` |
| a worktree's run is registered against the main checkout; only `.git` says so | `src/git-branch.js` |
| ownership of a *running* run decides which run a card shows; rank is the fallback | `src/dashboard.js` (`buildRows`) |
| the preference ends when the run does, and identity keeps the session's own path | `src/dashboard.js` (`buildRows`) |
| no-mistakes' own agents are folded into the repo's row; only the newest is kept | `src/dashboard.js` (`buildRows`) |
| `Agent` reaches no renderer; presence follows the run existing, never `activity` | `src/dashboard.js` (`Agent`) |
| `step.lastActivity` prefixes are an allowlist; `step failed:` is kept whole | `src/dashboard.js` (`stepActivity`) |
| an unattributable run gets one card, counts its candidates, and sorts below every session | `src/dashboard.js` (`Row`, `sortRows`) |
| a run that ended quietly leaves the page; `FINISHED_QUIETLY` names the two endings | `src/dashboard.js` (`isDisplayable`) |
| three local pull-request sources, ranked, all gated on the checkout's branch | `src/dashboard.js` (`buildRows`) |
| an observation time may never be substituted for a run's `updatedAt` | `src/dashboard.js` (`pullRequestForRun`) |
| a record listing several pull requests is not a sighting; the database is the negative authority | `src/dashboard.js` (`transcriptPullRequest`) |
| the forge asserts, ages through the same gate, `merged` is exempt, and it may never leave a row less current | `src/dashboard.js` (`withForgeState`) |
| a failed lookup drops the previous reading; cadence and the two caches | `src/forge.js` |
| timestamps come from the caller's clock at dispatch, never `Date.now()` on return | `src/forge.js` |
| the Bitbucket credential lives in a `0600` file and never in the environment | `src/forge-config.js` |
| GitHub goes through `gh` and holds no credential here - do not add a token path | `src/forge-config.js`, `src/forge.js` |
| an unsafe mode refuses the whole file, blocks with no secret in them included | `src/user-config.js` |
| the writer lives beside the reader, because `0600` is a property of the file | `src/user-config.js` (`writeUserConfig`) |
| `hooks.js`'s `writeSettings` is not reused; `mode` creates and only `chmod` repairs | `src/user-config.js` (`writeUserConfig`) |
| the backup is chmodded too, or repairing a mode leaks the credential it just secured | `src/user-config.js` (`writeUserConfig`) |
| `enable`/`disable` are a closed set of two, named for what `doctor` prints | `src/user-config.js` (`CONFIG_FEATURES`) |
| whether a running `raise serve` notices a write is a property of the feature, not the command | `src/user-config.js` (`CONFIG_FEATURES`) |
| `disable` writes `false` rather than deleting, and never removes a credential | `src/user-config.js` (`setFeature`) |
| no credential may reach argv - there is no `--token` flag, now or later | `src/cli.js` (`cmdSetFeature`), `docs/tasks/22-opt-in-commands.md` |
| a config file that will not parse is refused rather than overwritten | `src/user-config.js` (`readUserConfigForWrite`) |
| `problem` is for `doctor` only, and never for the ordinary case of no file | `src/user-config.js` |
| the config is re-read while the monitor runs; the mode is part of the cache key | `src/user-config.js` (`watchUserConfig`) |
| the watched read keeps its identity until the file changes, and `ForgeState` depends on it | `src/forge-config.js` (`watchForgeConfig`) |
| asking is capped at a day and telling happens every start - two cadences, not one | `src/update-check.js` |
| `doctor` reports the update check without making it; only `serve` ever asks | `src/update-check.js`, `docs/tasks/12-version-notice.md` |
| a failed check is stamped in the cache, so being offline is not a request per start | `src/update-check.js` |
| `isNewerVersion` fails closed on anything it cannot rank, pre-release pairs included | `src/update-check.js` |
| reporting currency asks whether the pair can be ranked; failing closed is not being up to date | `src/update-check.js` (`canCompareVersions`) |
| a cache stamped in the future is discarded by the read, so both callers get the rule | `src/update-check.js` (`readUpdateCache`) |
| a session nothing reported gets a row that refuses to say what it is doing | `src/untracked.js` |
| the four states worth telling apart write byte-identical files | `src/untracked.js`, `docs/tasks/RAI-4-first-run-shows-something.md` |
| the six bounds on the scan: window, tombstones, superseding, no id, no run, no pipeline agents | `src/untracked.js` |
| thirty-second interval, cwd read tail-first, only a positive answer cached | `src/untracked.js` |
| Claude Desktop is identified by paths only it can occupy | `src/process-tree.js` (`DESKTOP_APP`) |
| the resume link is an import and is not used; raising the app is the whole behaviour | `src/focus/claude-desktop.js` |
| a firstmate crewmate is the `fm-` window; the captain is the lock holding its pid | `src/firstmate.js` |
| the pane table is keyed by socket path, resolved once per pane, never awaited | `src/firstmate.js` |
| a firstmate decision is read from the fleet snapshot, never folded here and never matched in prose | `src/firstmate-decisions.js` |
| the snapshot's own reconciliation is the half that matters, so the schema is checked exactly | `src/firstmate-decisions.js` |
| an unreadable snapshot keeps the last answer; a snapshot with no tasks replaces it | `src/firstmate-decisions.js` (`parseSnapshot`) |
| gated on a status-file mtime, never more often than `REFRESH_MS`, and re-taken on a ceiling only while asserting | `src/firstmate-decisions.js` |
| a decision joins by the pinned window name or the worktree, and an ambiguous join places nothing | `src/dashboard.js` (`matchDecisionTask`) |
| ambiguity is guarded in both directions, and the second one is only visible once every session has been asked | `src/dashboard.js` (`buildRows`) |
| the joins are ranked, so ambiguity is only between claims of one kind - a lone window claim beats any number of worktree ones | `src/dashboard.js` (`matchDecisionTask`, `buildRows`) |
| a reading may not outlive the captain it came from, and an unreadable session list is not the captain leaving | `src/firstmate-decisions.js` (`refresh`), `src/server.js` |
| everything a lock contains is an answer; only a read that threw after a successful `stat` is not | `src/firstmate.js` (`LOCK_UNREADABLE`) |
| only the lock at the home a reading came from may hold it open - one session's lock cannot speak for the machine | `src/firstmate.js` (`lockUnreadableAt`), `src/server.js` |
| a reading is dropped after enough consecutive failed refreshes, because a re-dispatch that always fails is not evidence | `src/firstmate-decisions.js` (`MAX_CONSECUTIVE_FAILURES`) |
| one counter for every way of not getting a reading, the lock included; no branch asks which kind it was | `src/firstmate-decisions.js` (`CAPTAIN_UNREADABLE`, `refresh`), `src/server.js` |
| a failing state re-dispatches on the ceiling whether or not anything is asserted - a stopped crewmate writes no status line | `src/firstmate-decisions.js` (`refresh`) |
| rulings with no captain row to carry them get a card that says so, rather than being counted nowhere | `src/dashboard.js` (`buildRows`), `public/index.html` |
| `decision` sits between `review` and `parked`, and the captain carries the count rather than a colour | `src/dashboard.js` (`ATTENTION_ORDER`, `buildRows`) |
| a pi session can never be `blocked`, because pi has no approval gate | `src/registry.js` |
| a Codex row may go red and will never say why - no `Notification` at all | `src/registry.js` |
| pi's transcript is normalised, never summarised separately | `src/pi-transcript.js` |
| the pi reporter runs in-process, so "never fail" is stricter than for the hook | `hooks/raise-pi-extension.js` |
| the extension is registered by path, never copied | `src/pi-extension.js` |
| one reporter for Claude Code and Codex; the agent is declared by the installed command | `hooks/raise-hook.js`, `src/hook-payload.js` |
| Codex's hooks are trust-gated; Raise never writes `config.toml` | `src/cli.js` (`install-codex`), `src/hooks.js` |
| the entry point checks Node before importing the CLI, because a link-time throw beats any guard | `bin/raise.js`, `src/node-support.js` |
| reproducing a version bug on a version CI cannot run, and the control that keeps it honest | `test/fixtures/old-node.mjs`, `docs/tasks/5-doctor-node-guard.md` |
| Codex writes no title of any kind, and its `state_5.sqlite` is raw prompt text | `src/codex-transcript.js` |
| `codex-transcript.js` whitelists one outer type; `event_msg` would double-count | `src/codex-transcript.js` |
| a Codex tool call is written when issued; `status: completed` is a lie about progress | `src/codex-transcript.js` |
| every Codex tool goes through one `exec` tool, so the command is lifted from a snippet | `src/codex-transcript.js` |
| the host terminal for a tmux session is resolved at click time, never stored | `src/focus/tmux.js` |
| a pane can belong to several sessions; rank the clients and target by id | `src/focus/tmux.js` (`chooseTmuxClient`) |
| which session tmux names varies with time, so the symptom is intermittent | `src/focus/tmux.js` |
| control mode is matched on pane title, not tty; the glyph is stripped, a collision refuses | `src/focus/tmux.js`, `src/focus/index.js` (`titleNeedle`) |
| two picks from one ranking, and `controlMode` is a property of the ranked set | `src/focus/tmux.js` (`chooseTmuxClient`) |
| no `-t` target is ever a session name, and the `tmux attach` hint is shell-quoted | `src/focus/tmux.js` (`shellQuote`) |
| a new terminal is one entry, and nothing else in the codebase changes | `src/focus/terminals.js` |
| the hook may never fail and never block; every path exits 0 within the timeout | `hooks/raise-hook.js` |
| recording the wrong agent pid is worse than recording none | `src/process-tree.js` |
| the hook payload is an allowlist, and why it must be | `src/hook-payload.js` |
| what `tool_name` would have bought, and why the boundary did not move for it | `docs/tasks/RAI-11-question-vs-permission.md` |
| the build is the hash of the served bytes; version, restart time and a startup hash were each measured and rejected | `src/build-stamp.js`, `docs/tasks/1-stale-page-code.md` |
| the stamp is baked into the page it describes, so a tab knows what it loaded rather than what it was first told | `src/server.js` (`servePage`) |
| the stamp is taken before the bytes, so an edit landing between the two reads is self-healing | `src/server.js` (`servePage`) |
| one `PUBLIC_DIR`, handed to the server and the stamp together, because they must be the same directory | `src/build-stamp.js` (`PUBLIC_DIR`) |
| the build rides the state frame, because that frame is delivered at both moments the build can change | `src/server.js` (`snapshot`) |
| a frame stating no build says nothing and never clears a known mismatch | `public/connection.js` (`createBuildWatch`) |
| localhost is not a boundary: token, `Host` and `Origin` are all three load-bearing | `src/security.js` |
| the merge shows a diff, asks first, backs up, and is safe to run twice | `src/hooks.js`, `src/pi-extension.js` |
| `raise serve` asks the port rather than a file; `/health` needs no token | `src/health.js` |
| the no-mistakes signature check is a convention check, and not a required check | `.github/workflows/no-mistakes-required.yml`, `docs/tasks/7-require-no-mistakes.md` |
| two Node versions in CI, and why coverage is not a job | `.github/workflows/ci.yml` |
| the gate reads the branch name only, and the unkeyed-branch gap is deliberate | `scripts/task-gate.js`, `docs/tasks/9-gate-passes-an-unkeyed-branch.md` |

## Coding Conventions

- **The product is `Raise`; the command is `raise`. The capital is load-bearing, because the
  name is also a verb.** Written lowercase in running prose it reads as an instruction -
  *"raise says so rather than raising an arbitrary window"* - so the name takes a capital
  wherever it is the subject of a sentence, in comments, user-facing strings and documentation
  alike. Lowercase `raise` is reserved for the thing you actually type: `raise serve`,
  `raise doctor`, `bin/raise.js`, `~/.raise/`, `RAISE_HOME`, `.raise-backup`. This is why the
  codebase can still say *"the adapters compete to raise a window"* and mean the verb.

  The npm package is **`raise-cli`**, not `raise`, which is squatted; the `bin` key is what
  makes the command `raise`, and the two need not match.
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
- Attention colour is semantic and ordered: `blocked` > `review` > `decision` > `parked` >
  `failed` > `idle` > `working`, matching `ATTENTION_ORDER` in `dashboard.js`. Do not introduce
  a colour that competes with `blocked` red - `review` sits under it because it is the same
  thing wearing work clothes, and `decision` takes the same colour family for the same reason.
  The same family and **not** the same colour: they are two different facts, and a reader who
  cannot tell them apart at a glance has one word doing the work of two. There is no state
  for a run that finished quietly: it leaves the page
  rather than settling into one, `isDisplayable` being the exact complement of the condition
  that would have produced it. `untracked` is last in that list and is **not** one of these: it
  is the absence of an attention level, it is `--faint` rather than a colour, and it is not in
  `GROUPS` at all - a card that cannot say what it is doing must not sit among the ones that can.
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
- **Where a pull request's state came from is not on the card, and the page needed no change
  to gain the forge.** The chip has always been gated on one boolean, `PullRequest.current`,
  and a forge reading simply makes that true where nothing else could. A "from the forge"
  marker would be the second opinion the source ranking exists to avoid - one answer per fact -
  and it would be noise on a page whose whole job is to be scannable. The tooltip's
  *"last checked N ago"* already says everything a reader can act on.
- **An untracked row's explanation sits beside its state word too, and for the same reason the
  `dismissed` marker does.** `Not tracked` and *"Found on disk, never reported - restart the
  session and Raise will follow it"* are one sentence: the first says what we know, the second
  says why and what to do. Stacked on two lines they made the cards that say the least the
  tallest on the page, which inverts the whole ordering. The words live in one constant per
  renderer and must stay identical in both - the page and the CLI are one protocol, and a row
  explained on one and bare on the other is the two disagreeing about the same session.
- **The `dismissed` marker sits beside the state word, because the two are one sentence.** It
  is the only thing separating "nothing is waiting" from "I told it to stop saying so", and the
  page may never let those look alike - a signal hidden without a word is exactly the quiet
  staleness this page is built against. Outlined and `--muted`: it is an explanation, not an
  alarm. It explains a *quiet* row and appears on no other kind: a row red for its pipeline
  agent, or working because the transcript ran past the block, is not quiet and has nothing for
  it to explain.
- **No attention level may be used as a bare class selector, and `decision` is why the rule
  is written down.** Every level is a class on four different elements - `.card.decision`,
  `.bar.decision`, `.state.decision`, `.pill.decision` - so a rule written as plain
  `.decision` matches all of them at the same specificity and, sitting later in the sheet,
  quietly wins every property those rules do not restate. It did: the header pill lost its
  padding and the card lost half its height, and nothing in the markup looked wrong. The
  panel's own class is `.decision-item` for that reason.
- **A firstmate ruling is said in three places and they are one sentence.** The state word
  says a decision is open, the marker beside it says how many, and the expanded panel carries
  the summaries - which run to paragraphs, so they may not go on the card. A card carries the
  session's line and the pipeline's line and grows no third stacked block. The panel shows
  **every** open decision: four on one crewmate is the ordinary case, and a renderer that
  bounded the list without saying so would be this item's own failure reintroduced by its fix.
  One marker per row, never two - the captain's counts the whole crew and its own list is a
  subset of that, so both would be one number explaining another.
- **A ruling with no row to sit on gets a card of its own, and the card is why the section
  heading is not about pipelines.** The captain's row carries whatever could not be placed,
  and there is not always a captain's row - firstmate's own lock will not read for a bounded
  run of ticks, and the reading is deliberately held through them. Until that card existed the
  remainder went nowhere and was counted nowhere, which is the set silently bounded. It follows
  the unattributable run exactly: `attributable: false`, no `Focus`, and the same *Not
  traceable to a session* line in both renderers. It expands, though - the words of a ruling
  live only in the panel, so a card holding rulings must be openable whether or not a session
  is behind it.
- **The agent chip names pi and Codex and stays silent about Claude Code**, and `AGENT_LABELS`
  has no entry for it. Claude Code is most of the rows, and a chip on every card saying so is
  noise on a page whose whole job is to be scannable - the same reason `mode` hides `normal`.
  The other two are worth marking because what their states can mean differs: a pi row never
  turns red for a permission prompt, because pi has none, and a Codex row that does turn red
  carries no reason with it. It is outlined and `--faint`, quieter than the host chip beside
  it, since provenance must not compete with where your window actually is.
- **The spawner chip says who started the window, and `SPAWNER_LABELS` has no fallback
  either.** It sits beside the agent chip, wears the same outlined `--faint` style and comes
  first, because it answers the earlier question - who started this, then what is running in it.
  A tool we do not recognise gets no chip, and a session nobody in particular started - most of
  them - says nothing rather than saying so. That silence is the rule from `src/firstmate.js`
  reaching the page: positive evidence, never absence.
- **The expanded panel names the agent that wrote each line**, through `AGENT_NAMES`, which
  *does* carry Claude Code - a label on a line is required where a chip on a card is not. The
  record itself cannot say, because every agent writes the same parsed shape, so the row is
  what knows. An agent neither map recognises falls back to the neutral word `agent`, never
  to a name.
- Focusing succeeds silently: the window arriving in front of you is the feedback. A
  `FocusResult.note` is the exception - it means we raised something less than what you
  clicked, and it gets a neutral toast.
- The liveness dot is positive evidence (a `ping` within `STALE_AFTER_MS`), never the absence
  of an error. When stale, dim the page - it is a snapshot of the past.
- **The page never reloads itself, and that rule has no exception to earn.** It applies to the
  build notice that prompted it and to anything else that might later want the same power:
  offer, do not act. A reload discards whatever the user has expanded, at a moment they did not
  choose, on a page they are watching precisely because something needs them - so the notice is
  a button and pressing it is the whole of the behaviour. The rule above says the page must be
  honest about *data* it can no longer vouch for; this is the same obligation for *code*, and
  the two are deliberately answered the same way: say so plainly, change nothing on your own.
- Density over decoration. This is a page you leave pinned and glance at.

## Testing and Quality

```sh
npm test          # 941 tests, no network, no dependencies, ~9s
npm run lint      # oxlint over src, bin, hooks, public, test, scripts
npm run typecheck # tsc --noEmit over src, bin, hooks, public, scripts
```

All three must pass before anything is done, and `.github/workflows/ci.yml` runs them on every
pull request and on every push. Tests run again on Node 22 to hold the `engines` floor honest;
lint and typecheck do not, being version-independent. Why there is no coverage job, and what
the two Node versions are each for, is in that file's own comments; renaming any npm script it
invokes - these three, or either roadmap gate below - means changing it there too.

**A third workflow, `.github/workflows/no-mistakes-required.yml`, checks that a pull request
carries the signature the `no-mistakes` pipeline writes into its body.** It reads a
user-editable field, so it is a **convention check and not proof** - it gates against not
knowing the process, never against choosing to skip it, and the job is named for what it reads
rather than for what somebody might wish it proved.

**It is deliberately not a required status check.** It was added to the required set and taken
back out within the hour: requiring it makes a full pipeline run - fifty minutes, measured on
[#9](https://github.com/mattwwatson/raise/issues/9) - the price of correcting a single stale
sentence, which is exactly the friction that item existed to remove. The two are in direct
tension and the resolution is that the expectation is **stated, checked and visible, and not
enforced**. Do not quietly promote it without re-reading
[docs/tasks/7-require-no-mistakes.md](docs/tasks/7-require-no-mistakes.md); a rule too expensive
to follow is one that gets routed around, which costs more than the case it catches.

It deliberately does **not** use the machine-readable
`<!-- no-mistakes-pipeline-attestation:v1 … -->` line that sits beside the marker, even though
its `head_sha` would defeat copy-paste from another pull request. That was measured rather than
assumed: across six merged pull requests on the project this pattern was taken from, the
attested SHA matched the pull request head on three. It is written when the body is written and
a later push moves the head without rewriting it, so gating on it would fail legitimate
contributions - a false failure in the check whose whole job is teaching people the process.
Revisit only if `no-mistakes` starts rewriting it on every push. See
[docs/tasks/7-require-no-mistakes.md](docs/tasks/7-require-no-mistakes.md).

**A pull request and a push are two different builds and both run.** The push builds the
branch head; the pull request builds its merge with the base, which is what catches a branch
that passes alone and fails against `main`. The gate that is *not* on both is `tasks:gate`,
which asks a question about merging - see the comments in that file, and note that it needs
`GITHUB_HEAD_REF` because a `pull_request` checkout is a detached merge commit with no branch
in `.git/HEAD` to read.

- **Reproduce a bug as a test first**, then fix what the test exposes.
- Tests are `node:test` + `node:assert/strict`, one file per module, named after the
  behaviour in plain English (`'a blocked session outranks everything, including a parked
  pipeline'`). Use a factory helper with an overrides object for fixtures - see the `run()` /
  `session()` pattern at the top of `test/dashboard.test.js`.
- Comment the *why* in a test when the case is subtle, same as in source.
- **Inject everything external**: the exec runner, `fetch`, the clock, the process table, the
  pid liveness probe. The focus adapters take an injected command runner so the suite can assert
  on the AppleScript and tmux commands that *would* have run without stealing your focus
  mid-test. A test that touches the real machine does not belong here.
- **A test that starts a server must point the three agent homes at its scratch directory.**
  `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR` and `CODEX_HOME`, which the `scratch()` helpers in
  `server.test.js` and `cli-serve.test.js` set and restore. Without them the untracked scan walks
  whatever transcripts the developer happens to have open, and `/state` grows a row per one -
  which is both a test touching the real machine and one whose answer changes between two runs a
  minute apart. It is not a hypothetical: it is what those files did for the length of one commit.
- New behaviour in a pure module gets a direct unit test. New behaviour in `server.js` gets a
  test against a live server on an ephemeral port with a scratch `RAISE_HOME`.

Coverage uses Node's own instrumentation, so it needs no dependency either. It crashes on
Homebrew's default Node 26 (a `c8`/`yargs` ESM issue), so pin Node 24 for it:

```sh
PATH="$(brew --prefix node@24)/bin:$PATH" npm run coverage
```

## Safe-Change Rules

- **`src/hooks.js` writes to the user's `~/.claude/settings.json`.** It must keep showing a
  diff, asking first, backing up to `.raise-backup`, leaving foreign hooks untouched, and
  being safe to run twice. Never make it write without confirmation.
- **`hooks/raise-hook.js` runs inside someone's live Claude Code or Codex session.** It must never fail and
  never block: every path exits 0, quietly, within `TIMEOUT_MS`. A monitor that can break
  Claude Code is worse than no monitor.
- **`hooks/raise-pi-extension.js` runs in-process inside someone's live pi session**, which
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
  file contents. Do not widen it. Which agent sent an event is added *after* the allowlist
  rather than through it, because it is what the installation says it is and not something a
  payload may claim about itself - see `declaredAgent`.

  It has to be an allowlist because Claude Code's payloads carry all three of those already,
  and Codex's carry them too - which is the allowlist doing its job for an agent it was not
  written for, and the reason a third agent needed no privacy review of its own:
  `UserPromptSubmit` carries `prompt`, `Stop` carries `last_assistant_message`, and
  `PermissionRequest` carries `tool_input`, which for `Write` and `Edit` is the contents of the
  file. Until 04/08/2026 the hook forwarded the payload verbatim, so the first two crossed the
  process boundary on every turn - unread and unstored, but sent. The two failure modes are
  not comparable: a field we forgot to allow is a feature that quietly does not work, and a
  field we forgot to deny is somebody's source code on a socket.

  **The test a proposed field has to meet, decided on RAI-11: the boundary does not move for
  something that merely reads better, only for something the page cannot do its job without.**
  That ticket wanted `tool_name` to tell a question from a permission prompt, which Claude
  Code makes byte-identical on the wire; it was refused and the row says less instead. The
  accepted cost is recorded in `docs/tasks/RAI-11-question-vs-permission.md`, along with the
  capture, so neither the measurement nor the argument needs redoing.
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
- **There are exactly two outbound requests in the product, both opt-in, and the count is part
  of the rule.** The forge lookup sends nothing but a pull request URL to the forge already
  named in it; the update check sends one GET to `registry.npmjs.org` for this package's own
  name. Each is off unless `~/.raise/config.json` says so, each is separately opted into, and
  each is silent in every failure. `server.test.js` carries `fetch: () => assert.fail(...)`
  beside its `exec` guard on every other test, which is what proves a server whose `forge` block
  is off makes no request at all - **do not weaken that guard either**, and do not read it as
  more than it says. The one request the server itself can make is the forge lookup, fired from
  the poll through that very injection; the guard passes because every `scratch()` points
  `RAISE_HOME` at an empty directory. The update check is outside the server entirely, in
  `raise serve`'s own command.

  **A third one is a change to the README's Security section first and code second.** That
  section's strongest sentence - that in the default configuration Raise makes no outbound
  request of any kind - survives only because every one of these is off by default, and it is
  written to say so rather than to be true by technicality. It had to be rewritten to admit a
  second; issue 12 is the worked example of what that costs and what honesty it demands. Adding
  one quietly is the failure this project is built against, turned on its own documentation.
- **`.github/workflows/no-mistakes-required.yml` reads a pull request body, which is untrusted
  input.** It takes it through the environment and never interpolates `${{ }}` into the `run:`
  block, because that substitution happens before the shell sees it - a body containing shell
  syntax would execute. Same rule `src/exec.js` follows for argv. It is also not redundant with
  `ci.yml` and must not be folded into it: `ci.yml` asks whether the code is good, this asks how
  the change got here, and only this one needs the `edited` trigger.
- **`bin/raise.js` reaches `src/cli.js` through `await import()`, and that is not a style
  choice.** An unresolvable `node:` specifier - `node:sqlite` on Node 22.5 to 22.12 - throws
  while the module graph is *linked*, before any module body runs, so no static arrangement can
  put the version guard in front of it. Making that import static, or giving
  `src/node-support.js` an import of its own, restores the stack trace in full on exactly the
  versions nobody testing the change is running. It looks like a tidy-up and reads as one.
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

**[GitHub issues][board] own ordering and state; this repo owns the specification.** Each work
item is one issue plus one spec file named for it, `docs/tasks/<issue>-<short-name>.md`. The
issue says what and why; the file says how. There is no ordered list of work in the repo -
what to do next is the **[project board](https://github.com/users/mattwwatson/projects/1)**, top
down, because GitHub's issue list sorts but does not rank.

Branch as `<ISSUE>-<short-name>`, with the number starting the branch name or a path element of
it - `23-stale-page-code` or `fix/23-stale-page-code`. The PR that ships an item sets
`status: shipped` and `shipped:` in its spec and adds `## Implementation notes`. A branch
shipping no tracked item needs neither an issue nor a spec.

```sh
npm run tasks                  # the board from docs/tasks/
npm run tasks:links            # every docs/tasks reference resolves - runs on every build
npm run tasks:gate             # this branch's spec says shipped - pull requests only
npm run tasks:validate         # how disk and the issues differ - needs an authenticated `gh`
```

Everything else - the two key namespaces and why not to tidy them, capturing an item, picking
one up, epics, what each command can and cannot check, and why `validate` never runs in CI - is
the [roadmap-workflow skill](.claude/skills/roadmap-workflow/SKILL.md).
**Load it before creating an issue or touching anything under `docs/tasks/`.**

[board]: https://github.com/mattwwatson/raise/issues

## Commands

```sh
npm test                       # 941 tests, ~9s
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
npm run tasks:validate         # how disk and the issues differ - needs an authenticated `gh`
```

The `raise` commands themselves, and their flags, are documented in
[README.md](README.md#commands) and only there - a second copy is what drifts.

When exercising them by hand, set `RAISE_HOME` and `NM_HOME` so you do not disturb the
running installation.

## Maintaining this file

This file was 1793 lines and roughly 33k tokens, paid on every session whether the work touched
one module or none. Most of that was a second statement of what the owning module's own header
already said. It grew that way structurally rather than carelessly: when an item ships its
reasoning has to go somewhere, and nothing said where, so everything landed here.

**So the placement rule is the maintenance rule, and it decides every sentence:**

| The sentence is… | Goes to | Because |
| --- | --- | --- |
| a rule one module owns | **that module's header**, plus a row in the [decision index](#decision-index) | opening the file delivers it at the moment it is needed |
| a rejected alternative or superseded design tied to one module | **that module's header**, beside the tempting edit | the warning is worth nothing anywhere else |
| an invariant spanning several modules | **[Invariants no single module owns](#invariants-no-single-module-owns)** | no single header can own it |
| a layout or rendering rule with one site in `public/index.html` | **a comment at that site** | the page carries per-rule comments and reads like the modules do - the `.name` identity rule sits on `.name` |
| a page-wide UI rule with no single site, or a product rule | **[UI Rules](#ui-rules)**, here | nothing owns it, so a comment on one selector would be a claim about the rest of the page |
| a safe-change rule | **stays here** | it must be known *before* you choose which file to open, so a comment inside the file is already too late |
| a measurement or one-time capture | **its spec in `docs/tasks/`**, cited from wherever it is relied on | already written, and dated |

Two things that keep the rule honest, both learned from the state this file was in:

- **Never delete a sentence on the assumption a header covers it.** Open the module, find the
  covering sentence, and only then cut. Where the header does not say it, the header gains it -
  nothing is dropped, things are relocated to where they are read.
- **Compression is rewriting, not summarising. A rule that survives must keep its reason.**
  *"Only `sqlite` is remembered"* without *"because the daemon creates the database on first
  use, long after a monitor was left running"* is a rule the next tidy-up reverts.

`test/docs-claims.test.js` checks that every source path named here, in `CONTRIBUTING.md` and
in `README.md` exists, because an index of pointers is only worth having if a pointer cannot
rot. It is not covered by `npm run tasks:links`, which resolves references into `docs/tasks/`
only.

The same file pins the **one inventory `CONTRIBUTING.md` duplicates that can honestly be
pinned** - the three devDependencies, against `package.json`. That duplication is deliberate and
stays, because a contribution policy has to state a self-contained bar; the check makes it
*detectable* when it drifts rather than impossible. The other three duplicated bars are prose,
and are deliberately not matched on - the reasoning, and what would have to change for
`REPORTABLE_FIELDS` to join them, is in that file's header and in
[docs/tasks/6-contributing-drift.md](docs/tasks/6-contributing-drift.md).

Prefer rewriting or pruning an existing entry over appending a new one, and keep entries
concise. Adding a section here is a decision, not a default.
