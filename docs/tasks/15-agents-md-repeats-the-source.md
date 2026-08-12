---
issue: 15
status: shipped
shipped: 2026-08-12
size: L
depends: -
branch: 15-agents-md-repeats-the-source
---
# 15 - AGENTS.md is mostly a second copy of the comments already in the code

**Self-contained brief.** No prior conversation needed. Written 12/08/2026.

`CLAUDE.md` is one line, `@AGENTS.md`, so the whole of `AGENTS.md` is inlined into every
session in this repo before any work starts. It is **1793 lines, 132KB, roughly 33k tokens**,
and it is paid on every session whether the work touches one module or none.

That cost would be worth paying for 1793 lines of knowledge that exists nowhere else. Most of
it is not. The measurement below found that the majority of the largest section is a second
statement of what the owning module's own header comment already says - so the reader who
needs it has it either way, and the reader who does not is paying for it anyway.

**This is a deletion, not a reorganisation.** Nothing here proposes moving the file's contents
somewhere else and calling that smaller.

## The problem, in the reader's terms

Two problems, and the second is the one that will still be here in November if only the first
is fixed.

**It is too large to be read.** An agent that loads 33k tokens of instructions before its first
tool call has less room for the work and a worse chance of holding any single rule in view. The
file's own *Maintaining this file* section asks for exactly the pruning that has not happened.

**Nothing bounds it.** It has grown across 82 commits, and the growth is structural rather
than careless: when an item ships, its reasoning has to go somewhere, and no rule says where.
`AGENTS.md` is the default, so everything lands here - the invariant, the rejected alternative,
the measurement and the narrative of how the wrong version failed, all in one place, for every
item. Compressing the file once without changing that leaves the same file again in a few
months.

## The evidence

Measured 12/08/2026 against the tree at `9fbf4fd`. **Re-measure before picking this up** - six
commits touched `AGENTS.md` between the first draft of this brief and the tree above, and every
figure below moved. A number here that is not attributed to a tree is a number to distrust.

| Finding | Evidence |
| --- | --- |
| One section is 68% of the file | `## Design decisions worth knowing` is lines 189-1409, so 1221 of 1793 |
| Most of that is already in the owning module's header | 9 of 11 modules sampled state their `AGENTS.md` rationale in their own top-of-file comment: `nm-state.js`, `run-owner.js`, `forge.js`, `untracked.js`, `firstmate.js`, `codex-transcript.js`, `registry.js`, `focus/tmux.js`, `hook-payload.js` |
| The source comments are not a thin echo | ~1000 of the repo's 21,100 source lines are top-of-file rationale. `PR_STATE_FRESH_MS`'s whole measurement - the 46 runs, the 64s median and 112s worst case, the 7h23m frozen `open` - is in `src/nm-state.js:255-283`, and `AGENTS.md:992` is a pointer *to* it |
| What is genuinely `AGENTS.md`-only | history, rejected alternatives, cross-module invariants, and the product and UI rules whose only code home is `public/index.html`, which has no header |
| Two exceptions, and they are the same shape | `src/dashboard.js` is 1573 lines behind a **14-line** header, with its real rules buried at 435 (`withForgeState`) and 861 (ownership vs rank); `src/server.js` is 632 behind **8** |
| The `docs/tasks/` specs cannot take the overflow | every spec opens *"Self-contained brief … Written DD/MM/YYYY"*, and they are stratified on purpose - `RAI-21` tells the reader a later section *"wins, and the paragraph it corrects says so"*. A document you must read in full to know which sentences are still true is the opposite of a reference |

The last row is the one that rules out the obvious alternative. The specs stay what they
already are: the home for measurements and one-time captures, which is how `AGENTS.md` uses
them at lines 1062, 1284 and 1638.

## The decision: one rule decides where every sentence goes

Applied to each paragraph of `## Design decisions worth knowing`. This is the whole method.

| The sentence is… | Goes to | Because |
| --- | --- | --- |
| a rule the owning module's header already states | **deleted** - `AGENTS.md` keeps one line in an index table | you cannot edit `nm-state.js` without reading `nm-state.js` |
| a rule the module owns that its header does not state | **into that module's header** | same reason, once the header is honest |
| a rejected alternative or superseded design tied to one module | **into that module's header**, as a compressed `Rejected:` or `Superseded:` note | the warning belongs where the tempting edit happens |
| an invariant spanning several modules | **stays in `AGENTS.md`** | no single header can own it |
| a product, UI or safe-change rule | **stays in `AGENTS.md`** | `public/index.html` has no header, and a safe-change rule must be known *before* you choose which file to open |
| a measurement or one-time capture | **cite the spec that holds it** | already written, and dated |

The load-bearing observation is in the first row's *because*. A rule in a module header is
delivered by the act of opening the file it constrains, which is the moment it is needed. A
rule in `AGENTS.md` is delivered at session start, to every session, whether or not that file
is ever opened. The second is worth its cost only for rules you must know before you have
chosen a file - which is exactly the set the fourth and fifth rows keep.

### Two constraints on whoever builds this

Both are what separate this from summarising the file, which would lose rules.

- **Never delete a sentence on the assumption that a header covers it.** Open the module, find
  the covering sentence, and only then cut. Where the header does not say it, the header gains
  it. The 9-of-11 figure is a sample, not a licence.
- **Compression is rewriting, not summarising.** A rule that survives must keep its reason.
  *"Only `sqlite` is remembered"* without *"because the daemon creates the database on first
  use, long after a monitor was left running"* is a rule that gets reverted by the next person
  who thinks they are tidying.

## What gets built

**In `AGENTS.md`**, replacing lines 189-1409:

- A **decision index** - one row per decision, the invariant in a single line, and the file
  that owns it. Around 45 rows.
- **`### Invariants no single module owns`** - the cross-cutting rules, stated once each
  instead of the 4 to 13 times they currently recur. At minimum: quiet staleness is the failure
  mode; the three guards that fail three different ways on purpose (`isDisplayable` open,
  `attentionFor` soft, `isRunOwnerCommand` closed) and *"do not fix any of them to match the
  others"*; a reading we did not get is not evidence; indirect evidence may disprove and never
  assert, with the forge as the single documented exception; positive evidence, never absence;
  the branch comes from `.git/HEAD` and nowhere else, and gates the run match, the pull request
  match and ownership; the session is the unit, and an attribute we cannot place belongs to
  nobody.

**In the modules**, the residue that has no header today. Verify each against the current
header before writing - several may already be covered:

| Destination | What lands there |
| --- | --- |
| `src/dashboard.js` | a real header: lift the buried comments at 435 and 861, and add the veto-to-preference inversion as a `Superseded:` note, the *preference ends when the run does* qualifier, and identity following the session's own path |
| `src/server.js` | the keepalive must be an SSE `event` and never a comment, and why tidying it back breaks liveness; the `prune`-skipped-on-an-empty-reading rule now at the call site |
| `src/hooks.js` | the `PostToolUse` / `PostToolBatch` rejection - a one-line change to `HOOK_EVENTS` in this very file, so this is where the warning is needed |
| `src/nm-state.js` | the dev/ino check's failure narrative: the old inode answers every query happily, so `existsSync` is satisfied and the previous file's runs are served as current |
| `src/focus/tmux.js` | control mode matched on pane title rather than tty, iTerm2 reporting `tty` as `missing value`, the stripped braille glyph, and the title-collision refusal |
| `src/forge-config.js` | the mode is part of the cache key as well as the answer, so a later `chmod 0644` stops the file being used on the next poll |
| `src/forge.js` | a failed lookup drops the previous reading rather than letting it age out; the forge settles state, never identity, and never the link |
| `src/registry.js` | *"if the field is ever changed, change it to something that moves"* - the forward-looking half of the `blockAnnouncedAt` rule, which no spec generalises |
| `src/transcript.js` | the `lastActivityAt` whitelist and the `away_summary` regression, if not already at `summariseTranscript` |

**Elsewhere in `AGENTS.md`**, smaller and mostly deletion of prose another file owns:

- `## Roadmap and task tracking`, 63 lines to about 20. The `roadmap-workflow` skill is 318
  lines in-repo and already holds the two key namespaces, the four `tasks*` commands and what
  each can and cannot check. Keep the ownership sentence, the branch convention, the command
  names, and the instruction to load the skill.
- `## Project Overview` and `## Tech Stack` tighten; the Node 22.13 and zero-dependency
  reasoning stays whole, being load-bearing and duplicated in `CONTRIBUTING.md` on purpose.
- `## Architecture`, `## Coding Conventions`, `## UI Rules` and `## Safe-Change Rules` are
  **kept whole**.

## The guard against regrowth

Without this the file is 1793 lines again by November, and the second problem above is the one
that matters.

- **Rewrite `## Maintaining this file`** to state the split as a rule: a shipped item adds the
  *invariant* to the index here, the *reasoning* to the module header, and the *measurement*
  stays in its spec. That is the sentence that was missing.
- **Add `test/docs-claims.test.js`**: every `src/…`, `bin/…`, `hooks/…` and `public/…` path
  referenced in `AGENTS.md` and `CONTRIBUTING.md` exists on disk. An index of pointers is only
  worth having if a pointer cannot rot. Note that `npm run tasks:links` does **not** cover
  this - it scans the whole repo but only resolves references into `docs/tasks/`.

## Deliberately not built

- **No `docs/design/` topic files.** Splitting the prose across new documents keeps every word,
  including the duplicated ones, and adds a second place for a rule to go stale. The
  duplication is the finding; deleting it is the fix.
- **No change to what `CONTRIBUTING.md` duplicates.** Issue #6 owns that, argues the
  duplication should stay, and proposes a drift test of its own. Taking the decision here would
  pre-empt it.
- **No rewrite of the retained prose for style.** The register of this file is an asset. What
  is cut is cut for being a second copy, never for being long.

## Acceptance

- `wc -l AGENTS.md` is **about 620**, down from 1793 - roughly a third. The arithmetic, so the
  number is checkable rather than aspirational: 572 lines currently sit outside the design
  section and are mostly kept; trimming Roadmap (63 to ~20), Project Overview and Tech Stack
  takes off ~70; the index table, the invariants section and its preamble add ~120. A materially
  smaller file than that means prose was cut for length, which this does not do.
- `npm test`, `npm run lint` and `npm run typecheck` pass.
- **The rule walk, which is the real acceptance test.** Extract the 107 bolded decision
  headlines from `AGENTS.md` as it stands on `main` (`grep -c '^\*\*' AGENTS.md`) and, for each,
  name the file that now holds it. A headline with no destination is a rule about to be lost.
  That table belongs in this file's `## Implementation notes`.
- Read the two rewritten headers cold - `src/dashboard.js` and `src/server.js` - and ask
  whether someone who had read only the header would make the right change to `buildRows` and
  to `KEEPALIVE_MS`. Those are the two pointers most likely to land somewhere that does not
  answer.

## Interaction to watch

`src/dashboard.js` is the busy file: **#2** and **#3** both change it, and the skill already
flags them as sitting close together. This item rewrites its *header* and moves nothing else,
so it conflicts textually without conflicting in substance. Whichever lands second should
re-read the others' specs rather than assume its own still describes the file.

## References to correct when this is built

`README.md:658,678` - one of the two is an anchor link to `#roadmap-and-task-tracking`, so
either keep that heading text or update both. Then `CONTRIBUTING.md:7,147,153`,
`.github/workflows/ci.yml:6,27`, `scripts/tasks.js:86`, `scripts/task-github.js:31`,
`src/hooks.js:15,46`, `src/nm-state.js:259` and `src/registry.js:349`, each of which describes
`AGENTS.md` in prose and should still read true afterwards.

## Implementation notes

Built 12/08/2026 on `15-agents-md-repeats-the-source`, against the tree at `633b32d`.

**The brief's figures were re-measured first and they hold at that tree**: 1793 lines, 132KB,
107 bolded headlines, `## Design decisions worth knowing` at lines 189-1409 (68% of the file).
The issue body's "1743 lines / ~103 headlines" is from an earlier draft and is the number to
distrust. Result: **1793 lines to 714**, a 60% cut, and roughly 33k tokens to ~13k.

**714 rather than the ~620 the brief estimated, and the difference is all index.** The estimate
assumed ~45 index rows; there are 83. Rows were split wherever one row would have covered two
headlines, because the acceptance test is that a reviewer can pick any headline and find where
it went - a coarser index passes the line count and fails the walk. Nothing was retained for
length: every section the brief said to keep whole is byte-identical, and the assembly was done
by slicing those ranges out of the old file rather than retyping them.

### The 9-of-11 measurement was checked and holds

Every one of the eleven sampled modules was read before anything was cut. Nine carry their
`AGENTS.md` rationale in their own header (`nm-state.js`, `run-owner.js`, `forge.js`,
`untracked.js`, `firstmate.js`, `codex-transcript.js`, `registry.js`, `focus/tmux.js`,
`hook-payload.js`); `dashboard.js` (1573 lines behind a 14-line header) and `server.js` (632
behind 8) are the two that do not, exactly as described.

**Three of the brief's proposed relocations turned out to be unnecessary, which is the sample
being conservative rather than wrong.** `src/forge-config.js` already states the mode being part
of the cache key, at `watchForgeConfig`. `src/forge.js` already states that a failed lookup
drops the previous reading, at `#fail`, and that the forge settles state and never the link.
`src/transcript.js` already carries the `lastActivityAt` whitelist and the `away_summary`
regression in full, at `ACTIVITY_TYPES`. `src/server.js`'s keepalive and empty-reading rules
were already at their call sites - what was missing there was a *header* surfacing them, which
is what the acceptance criterion about reading it cold actually tests.

### What the modules gained

Ten edits, each a rule that was demonstrably in `AGENTS.md` and nowhere else. The last of them
was found in review rather than on the first pass, which is the walk doing its job:

| File | Gained |
| --- | --- |
| `src/dashboard.js` | a real header: ownership-over-rank and the veto-to-preference inversion, the preference ending when the run does, identity following the session's own path, the forge as the one asserting source, the three guards that fail three ways, and the two-lines-per-card rule |
| `src/dashboard.js` (`withForgeState`) | a disagreement with no-mistakes is not surfaced - one answer per fact |
| `src/server.js` | a real header: the keepalive as a named event and why tidying it back blinds the page, the no-sync-subprocess rule and its two test guards, and why `release`/`prune` are guarded on a non-empty reading |
| `src/nm-state.js` (`DbFile`) | the replaced-inode narrative - the old handle answers every query happily, so `existsSync` is satisfied and the previous file's runs are served as current |
| `src/hooks.js` (`HOOK_EVENTS`) | the `PostToolUse` / `PostToolBatch` rejection, stated where the one-line change would be made, including that hook registration is read at session start |
| `src/registry.js` (`dismissBlock`) | the forward-looking half: if the key is ever changed, change it to something that moves |
| `src/pi-transcript.js` | pi's `/name` normalises onto `custom-title`, and why the `ai-title` rewrite was wrong |
| `src/codex-transcript.js` | Codex writes no title of any kind, and `state_5.sqlite` is raw prompt text |
| `src/focus/tmux.js` | control mode matched on pane title, the `missing value` tty, the intermittency, and no `-t` target ever being a session name |
| `public/index.html` (`.name`) | why the name cannot go in `.meta` on layout as well as on meaning - that side is `flex: none` with no ellipsis - and that it never replaces `.summary`, because the two answer different questions and drift apart on a long session |

### The rule walk

All 107 headlines from `main`, in file order, with where each one now lives. Numbers are the
line in the old file. "kept" means the section survived byte-identical.

| # | Headline | Now in |
| --- | --- | --- |
| 1 (19) | The session is the unit | `AGENTS.md` § Project Overview (kept) + § Invariants |
| 2 (44) | Raise watches one machine | `AGENTS.md` § Project Overview (kept) |
| 3 (48) | Focusing is macOS-only | `AGENTS.md` § Project Overview (kept) |
| 4 (54) | Read as a contribution policy | `AGENTS.md` § Project Overview (kept) |
| 5 (99) | `npx` is not an install | `AGENTS.md` § Tech Stack (kept) |
| 6 (194) | no-mistakes and lavish-axi are optional | `src/nm-state.js` header + § Invariants |
| 7 (210) | re-decided on every read | `src/nm-state.js` header |
| 8 (218) | the `stat` reads identity | `src/nm-state.js` `DbFile` **(added)** |
| 9 (227) | `cli` may not latch either | `src/nm-state.js` header |
| 10 (245) | Polling SQLite, not the daemon socket | `src/server.js` header |
| 11 (250) | the keepalive is an SSE `event` | `src/server.js` header **(added)**, call site, `public/connection.js` |
| 12 (257) | `server.json` is not the source of truth | `src/health.js` header |
| 13 (262) | summary read from the transcript | `src/transcript.js` header |
| 14 (268) | the name is identity, so line 1 | `public/index.html` (`.name`) + `src/dashboard.js` (`sessionName` in `buildRows`) |
| 15 (281) | both names normalise onto `custom-title` | `src/pi-transcript.js` **(added)** |
| 16 (286) | the name survives the 128KB tail | `src/transcript.js` `TAIL_BYTES` |
| 17 (299) | the tool with no result yet | `src/transcript.js` header |
| 18 (304) | a recorded block is disbelieved | `src/dashboard.js` `blockDisproved`; `src/hooks.js` **(added)**; § Invariants |
| 19 (356) | a human looking is evidence too | `src/registry.js` `dismissBlock` |
| 20 (367) | a dismissal answers one announcement | `src/registry.js` `dismissBlock` **(added forward half)** |
| 21 (376) | only the idle nudge may be dismissed | `src/dashboard.js` `isDismissibleBlock` + § UI Rules (kept) |
| 22 (385) | server-side, and it says so on the row | `src/dashboard.js` `Row.dismissed` + § UI Rules (kept) |
| 23 (393) | only while the dismissal quietened it | `src/dashboard.js` `Row.dismissed`, `blockDismissalInEffect` |
| 24 (408) | a `lavish-axi poll` is a human gate | `src/lavish.js` header + `src/dashboard.js` `ATTENTION_ORDER` |
| 25 (415) | `Notification` means two things | `src/dashboard.js` `isIdleNudge` + `src/registry.js` `EVENT_STATES` |
| 26 (431) | it comes from `notification_type` | `src/dashboard.js` `isIdleNudge` |
| 27 (447) | `PermissionRequest` is worth installing | `src/hooks.js` `HOOK_EVENTS` |
| 28 (466) | one block, announced twice | `src/registry.js` `blockAnnouncedAt` |
| 29 (491) | a live poll process settles it | `src/poll-watch.js` header |
| 30 (500) | matched on the executable | `src/poll-watch.js` `isPipelineCommand` |
| 31 (509) | a run belongs to the session that started it | `src/run-owner.js` header |
| 32 (578) | `RunOwners` is a memory | `src/run-owner.js` header |
| 33 (588) | ownership does not change hands | `src/run-owner.js` header |
| 34 (602) | a reading we did not get is not evidence | `AGENTS.md` § Invariants + `src/server.js` call sites |
| 35 (610) | a worktree run registers against the checkout | `src/git-branch.js` header |
| 36 (701) | ownership of a running run decides | `src/dashboard.js` header **(added)** + `buildRows` |
| 37 (729) | the preference ends when the run does | `src/dashboard.js` header **(added)** + `buildRows` |
| 38 (740) | a session and its pipeline get a line each | `AGENTS.md` § UI Rules (kept) + `src/dashboard.js` header **(added)** |
| 39 (764) | presence follows the run existing | `src/dashboard.js` `Agent` |
| 40 (770) | `step.lastActivity` arrives prefixed | `src/dashboard.js` `STEP_ACTIVITY_PREFIXES` |
| 41 (781) | an unattributable run gets one card | `src/dashboard.js` `Row.attributable` |
| 42 (791) | it sorts below every session | `src/dashboard.js` `sortRows` + § UI Rules (kept) |
| 43 (798) | the pipeline's own agents are folded | `src/dashboard.js` `buildRows` |
| 44 (825) | the marker never follows `Agent.activity` | `src/dashboard.js` `Agent` |
| 45 (832) | the rule survives; where it hangs has moved | `src/dashboard.js` `Agent` |
| 46 (841) | `Agent` reaches no renderer | `src/dashboard.js` `Agent` |
| 47 (849) | three sources, ranked | `src/dashboard.js` `buildRows` (the `pr` chain) |
| 48 (854) | a fourth outranks all three | `src/dashboard.js` `withForgeState` + § Invariants |
| 49 (865) | not "the forge's last answer wins forever" | `src/dashboard.js` `withForgeState` |
| 50 (872) | one exception and one guard | `src/dashboard.js` `withForgeState` |
| 51 (889) | a disagreement is not surfaced | `src/dashboard.js` `withForgeState` **(added)** + § Invariants |
| 52 (895) | a failed lookup drops the reading | `src/forge.js` `#fail` |
| 53 (901) | the Bitbucket credential lives in a file | `src/forge-config.js` header |
| 54 (911) | GitHub is the asymmetry | `src/forge-config.js` + `src/forge.js` headers |
| 55 (918) | an unsafe mode refuses the whole file | `src/forge-config.js` header |
| 56 (926) | the config is re-read while running | `src/forge-config.js` `watchForgeConfig` |
| 57 (932) | only the positive case is remembered | `src/forge-config.js` `watchForgeConfig` |
| 58 (940) | cadence and the two caches | `src/forge.js` `OPEN_REFRESH_MS`, `FAILURE_BACKOFF_MS`, `#start` |
| 59 (948) | timestamps from the caller's clock | `src/forge.js` `#start` |
| 60 (960) | all three gated on the branch | `src/dashboard.js` `buildRows`, `matchPullRequest` |
| 61 (983) | still going is not still current | `src/nm-state.js` `prStateIsCurrent` |
| 62 (992) | the threshold is measured | `src/nm-state.js` `PR_STATE_FRESH_MS` |
| 63 (1000) | an observation time may not be substituted | `src/dashboard.js` `pullRequestForRun` |
| 64 (1009) | several pull requests is not a sighting | `src/dashboard.js` `transcriptPullRequest` + `src/transcript.js` |
| 65 (1026) | the branch comes from `.git/HEAD` | `src/git-branch.js` header + § Invariants |
| 66 (1034) | a session nothing reported still gets a row | `src/untracked.js` header |
| 67 (1044) | a hook record vs a recent transcript | `src/untracked.js` header |
| 68 (1048) | four states, byte-identical files | `src/untracked.js` header, `test/untracked.test.js`, `docs/tasks/RAI-4-first-run-shows-something.md` |
| 69 (1105) | thirty seconds, and tail-first | `src/untracked.js` `SCAN_INTERVAL_MS`, `#cwdFor` |
| 70 (1121) | Claude Desktop identified by evidence | `src/process-tree.js` `DESKTOP_APP` + § Invariants |
| 71 (1141) | firstmate declares itself | `src/firstmate.js` header |
| 72 (1163) | the working directory would chip an editor | `src/firstmate.js` header |
| 73 (1172) | the cost is once per pane | `src/firstmate.js` header + `#servers` |
| 74 (1191) | the app cannot select a hosted session | `src/focus/claude-desktop.js` header |
| 75 (1207) | the link is not used even where dedupe fires | `src/focus/claude-desktop.js` header |
| 76 (1223) | a pi session can never be `blocked` | `src/registry.js` header |
| 77 (1239) | pi's transcript is normalised | `src/pi-transcript.js` header |
| 78 (1260) | the pi reporter is an extension | `hooks/raise-pi-extension.js` header |
| 79 (1272) | registered by path, never copied | `src/pi-extension.js` header |
| 80 (1277) | Codex is a third agent | `hooks/raise-hook.js` + `src/hooks.js` headers |
| 81 (1286) | the agent comes from the installed command | `hooks/raise-hook.js` header + `src/hook-payload.js` `declaredAgent` |
| 82 (1293) | a Codex row may go red and not say why | `src/registry.js` header |
| 83 (1304) | a stale Codex block is cleared by the transcript | `src/codex-transcript.js` header |
| 84 (1313) | Codex hooks are trust-gated | `bin/raise.js` (`install-codex`) |
| 85 (1322) | `SessionEnd` asks for three seconds | `src/hooks.js` (Codex timeout) |
| 86 (1328) | Codex writes no title of any kind | `src/codex-transcript.js` **(added)** |
| 87 (1335) | a normaliser, whitelisting one outer type | `src/codex-transcript.js` header |
| 88 (1341) | every Codex tool goes through one `exec` | `src/codex-transcript.js` header |
| 89 (1347) | the host terminal is not stored | `src/focus/tmux.js` header |
| 90 (1351) | control mode matched on pane title | `src/focus/tmux.js` header **(added)**, `paneTitle`, `src/focus/index.js` `titleNeedle` |
| 91 (1363) | a pane can belong to several sessions | `src/focus/tmux.js` header |
| 92 (1374) | which session tmux names varies with time | `src/focus/tmux.js` header **(added)** |
| 93 (1392) | two picks from one ranking | `src/focus/tmux.js` `chooseTmuxClient` |
| 94 (1397) | `controlMode` belongs to the ranked set | `src/focus/tmux.js` `chooseTmuxClient` |
| 95 (1405) | no `-t` target is ever a session name | `src/focus/tmux.js` header **(added)** + `shellQuote` |
| 96 (1543) | the signature workflow is a convention check | `AGENTS.md` § Testing and Quality (kept) + `.github/workflows/no-mistakes-required.yml` |
| 97 (1549) | deliberately not a required check | `AGENTS.md` § Testing and Quality (kept) + `docs/tasks/7-require-no-mistakes.md` |
| 98 (1568) | a pull request and a push are two builds | `AGENTS.md` § Testing and Quality (kept) + `.github/workflows/ci.yml` |
| 99 (1683) | issues own ordering, the repo owns the spec | `AGENTS.md` § Roadmap (kept) |
| 100 (1688) | the board is where the order lives | `AGENTS.md` § Roadmap (compressed to one clause) + the skill |
| 101 (1693) | both halves are public now | **dropped as a dated change note** - see below |
| 102 (1699) | two key namespaces | roadmap-workflow skill, *Two key namespaces* |
| 103 (1713) | the gate gives two answers | `scripts/task-gate.js` `gateBranch` |
| 104 (1715) | every other branch passes | `scripts/task-gate.js` `gateBranch` |
| 105 (1718) | the gap was tried twice and abandoned | `scripts/task-gate.js` `gateBranch` + `docs/tasks/9-gate-passes-an-unkeyed-branch.md` |
| 106 (1751) | what `validate` can no longer check | roadmap-workflow skill |
| 107 (1759) | load the skill before touching `docs/tasks/` | `AGENTS.md` § Roadmap (kept) |

**Row 101 is the only headline deliberately dropped rather than relocated, and it is worth
being explicit about.** *"Both halves are public now, and that is the change"* is a dated note
about a transition that has already happened - it told a reader in August 2026 that the board
used to be private. It states no rule a future change could break. The fact survives in
`README.md`'s Roadmap section, which says the same thing to the audience it is actually for.
Nothing else on this list was cut; everything else moved.

### The regrowth guard

The compression alone would leave the file 1793 lines again by November, so:

- **`## Maintaining this file` is rewritten as the placement rule** - a table saying where a
  shipped item's invariant, reasoning and measurement each go, plus the two constraints that
  keep it honest (never cut on the assumption a header covers it; compression is rewriting,
  not summarising).
- **`test/docs-claims.test.js`** asserts that every `src/…`, `bin/…`, `hooks/…`, `public/…`,
  `test/…`, `scripts/…`, `docs/…`, `.github/…` and `.claude/…` path named in `AGENTS.md`,
  `CONTRIBUTING.md` or `README.md` exists, and that every row of the decision index names a
  file. An index of pointers is only worth having if a pointer cannot rot, and
  `npm run tasks:links` does not cover this - it scans the whole repo but resolves references
  into `docs/tasks/` only. It was verified to fail on a deliberately broken pointer, not just
  to pass. `README.md` is in the set because the split left it naming the roadmap-workflow
  skill, which nothing else names, and it is the document a stranger reads first; `.claude/`
  is in the prefix list for that same skill.

### References corrected

`CONTRIBUTING.md:7` said the reasoning was *in* *Design decisions worth knowing*; it now says
that section is an index and the reasoning is in the headers. **`CONTRIBUTING.md:147` and
`:153` in the old numbering are the same pointer gone false twice more**, and were missed on
the first pass: one told a contributor the reasoning behind a ranking or state-frame decision
is "written down in `AGENTS.md`", the other that `docs/tasks/` and `AGENTS.md` are "the two
places to look". Both now name the owning module's header as where the reasoning is, with
`AGENTS.md` as the index that says which module. What `CONTRIBUTING.md` *duplicates* from
`AGENTS.md` is untouched - issue #6 owns that. `scripts/task-github.js:31`
pointed at "the note in AGENTS.md" about there being no GitHub token path, which now lives in
`src/forge-config.js`. `README.md:678` claimed `AGENTS.md` says what each `tasks*` command
reports, which is the skill's job now. `src/registry.js` no longer cites `AGENTS.md` for a rule
it states itself. The rest of the brief's list - `README.md:658`,
`.github/workflows/ci.yml:6,27`, `scripts/tasks.js:86`, `src/hooks.js:15`, `src/nm-state.js:259`
- were each re-read and still read true, because every section they point at was kept whole.

### Verification

`npm test` (798, up from 793 - the five new ones), `npm run lint`, `npm run typecheck`,
`npm run tasks:links` and `npm run tasks:gate` all pass.
