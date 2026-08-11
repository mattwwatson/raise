---
ticket: RAI-4
status: shipped
branch: RAI-4-first-run-shows-something
shipped: 2026-08-11
size: M
depends: -
---
# RAI-4 - Make the first run show something

The shared background is [`RAI-1-open-source-release.md`](RAI-1-open-source-release.md)
**section 1.4**, and its gate is 1.5. This file is the *how*, and the record of the decisions
taken while building it - including the one 1.4 left open and asked to be settled with a test.

---

## The problem

A stranger installs Raise, runs `raise install-hooks`, opens the dashboard, and sees an empty
page. Every session they have open predates the hooks, so none of them has ever fired
`SessionStart` and none of them will say anything until its next `UserPromptSubmit`. The
obvious conclusion is that the tool does not work, and it is drawn at the exact moment they
have the most sessions running and the least patience.

Today the remedy is a README footnote telling them to restart their sessions. That is fine for
the person who wrote it. RAI-1 marks this **launch-blocking** and it is right to.

A **new** session already appears immediately with no activity required, which is better than
the neighbours. This ticket is only about sessions that were already running when the hooks
went in.

---

## What gets built

A **scan for recently-modified transcripts that have no hook record**, rendered as plain,
non-focusable rows that say what they are and how to fix them. The page is populated on first
run and gets better as sessions restart.

That is 1.4's proposal and the evidence did not contradict it, so it is what was built. What
follows is the detail 1.4 did not settle.

---

## The open question, settled: no state word, and no colour

1.4 asked whether such a row can honestly show a state at all, and leaned towards no. **The
evidence agrees, and it is stronger than "we cannot be sure".** It is not that a quiet
transcript is *weak* evidence of state - it is that the four states worth telling apart write
byte-identical files.

Two measurements, one taken live for this ticket and one already in the repo:

- **A block and an idle turn are the same file.** Read live from the registry on 11/08/2026: a
  session recorded `blocked` / `Notification` / `idle_prompt` had a transcript ending
  `user(tool_result) → assistant(text) → system → system`, and a session recorded `working` in
  another repo ended the same way. The idle nudge is a sixty-second timer inside Claude Code.
  Nothing is written when it fires, so nothing can be read.
- **A permission prompt is also the same file, and this was already measured.** RAI-11's
  capture found that Claude Code writes a pending `tool_use` record with the timestamp the
  model emitted it and **does not flush it until the tool resolves** - two tools, dialogs
  confirmed open on screen, absent from the file 30s and 46s later. So during the block, which
  is the entire window this row would be rendered in, the transcript says nothing about the
  tool at all.

So *finished*, *waiting on a permission prompt*, *waiting on an idle nudge* and *the window was
closed an hour ago* are one signature. Any state word chosen from a quiet transcript is a
one-in-four guess presented as a fact, which is the single thing this page may not do.

**`working` is not the safe fallback either.** A dangling `tool_use` - a call with no result -
does distinguish itself in the file, and it is exactly what a session killed mid-tool leaves
behind for ever. Every other row on this page survives that because `registry.list()` probes
`host.pid`; an untracked row has no pid *by definition*, because a pid is something only a hook
reports. On Codex it is weaker still: RAI-21 measured that a tool call record is written when
the call is *issued* and that its `status` field says `completed` from that moment, so a
dangling call there means "issued", not "running".

The sharper way to say all of it, and the sentence the rest of this design follows from:

> **A hook record is evidence that a session exists. A recently-modified transcript is evidence
> only that one existed as recently as its mtime.** Every state word, every colour, the focus
> button and the liveness prune all hang off the first.

So the row carries **presence and identity**, and nothing that is a claim about now:

| On the row | Why |
| --- | --- |
| repo, path, branch | where it is - read from `.git`, as for any session |
| the name a human gave it | identity, and the only thing telling two apart on one repo |
| what it was about (`ai-title`) | past tense and safe; null for pi and Codex, which write none |
| when it last wrote | the entire basis of the row's existence, and quantified rather than asserted |
| `Found on disk, never reported - restart the session and Raise will follow it` | the remedy, which is the same whatever the cause. It sits beside the state word rather than under it - see the implementation notes |

| Deliberately absent | Why |
| --- | --- |
| a state word or colour | the four states are one file signature - above |
| `activity` | "Running Bash" is a present-tense claim, and beside "restart the session" it contradicts the row it sits on |
| `mode` | same - `plan` describes how the session is configured *now* |
| `Focus ↗` | there is no window identity at all. Affordance must match capability |
| the host chip | `unknown` renders as *no window*, which would be a confident wrong claim: it almost certainly has one, we just cannot name it |
| a pull request | honest but beside the point, and every extra attribute invites the row to be read as a tracked one |
| a pipeline, and any run attribution | see below |

**`attention` gains a seventh value, `untracked`, and it is the one entry that is not an
attention level.** Every row needs one - it drives sorting and the card class - so the absence
of evidence has to be spelled rather than left null. It sorts last, renders in `--faint`, and
is excluded from the coloured groups on the page. `ATTENTION_ORDER`'s semantic ordering is
otherwise unchanged.

---

## Bounding the scan

It is a blunt instrument and 1.4 says to bound it deliberately. Six bounds:

**1. Recent only - two hours.** Measured on the author's machine: 16 unregistered transcripts
inside eight hours, of which 14 were no-mistakes pipeline agents (excluded, below), one was a
genuine session nine minutes old and two were closed sessions from two and three hours back. An
hour would have been enough there and is too tight in general, because a session parked at a
prompt goes quiet the moment it asks. The window errs long on purpose: **the cost of being
over-inclusive is a grey row that says "2h ago" and sorts last, and the cost of being
under-inclusive is the empty page this ticket exists to fix.**

**2. Superseded the instant a hook record arrives**, matched on the **transcript path** rather
than a session id. Both sides have the path exactly - the registry stores what the hook
reported, the scan finds the file - where deriving an id would mean three filename conventions
and a guess per agent. Dedupe is re-done every tick against the live registry, so a session
that restarts loses its untracked row on the next poll without waiting for a rescan.

**3. Never a focus button, and never a `sessionId`.** `Row.sessionId` is what `/focus`,
`/dismiss` and `/recent` key on, all three of which read the registry; an untracked row is not
in it. It is null, exactly as it is on the unattributable-run card, so the page renders no
control and no expander.

**4. No run attribution, in either direction.** An untracked row claims no run and is not
folded into one. Ownership is decided from the process table by walking up to `host.pid`, which
an untracked session does not have, so claiming a run for one would be rank standing in for
evidence - the class of mistake AGENTS.md names four times - and it would put a parked gate on
a card nobody can focus. A run nobody can be shown to own already has a designed home: the
unattributable card that says so. Untracked sessions are also left out of that card's
`candidateSessions`, which counts *live* sessions and is only honest if it keeps meaning that.

**5. no-mistakes' own pipeline agents are excluded by path.** They are the dominant population -
14 of the 16 above - and each would arrive as a card titled with a bare run id, which is the
dead card AGENTS.md describes. 1.4 suggested `matchRunForAgentCwd`, and that is the right tool
when a run is in the reading and you want to *fold* an agent into its row; it is the wrong one
here, because a run that finished half an hour ago has left the reading while its worktree
transcript is still inside our window - the same failure, reached by the path that mechanism
does not cover. So the scan skips any cwd inside `noMistakesHome()`. It is a `startsWith`
against a string from `config.js`: no database, no subprocess, and on a machine without
no-mistakes nothing is ever under that path, so the test simply never fires. That keeps the
rule that an absent integration costs nothing and says nothing.

**6. A session Raise watched end is suppressed for as long as the window lasts.** Added by the
review rather than foreseen here - see *A closed session came back as one that never reported*
below. The registry keeps the transcript path of every removed session as an on-disk tombstone
and hands the scan the live paths and the unexpired tombstones as one set, so neither renderer
assembles the rule for itself. Retention is `UNTRACKED_WINDOW_MS`, the scan's own window, because
a tombstone is worth keeping exactly as long as the path could otherwise be resurfaced.

**The walk itself** covers all files, with no cap, and is re-run every 30 s rather than on the
1 s poll. Measured at **9.3 ms for 1,396 transcripts across 261 project directories** on a
heavily used machine, so a cap would be bounding something that is not expensive; the interval
is what keeps it off the hot path. The first scan runs on the first snapshot, so a page opened
straight after `raise serve` is populated immediately - the interval only delays *discovering*
a session that becomes untracked while the monitor runs. That case is real rather than
theoretical: **Codex's hooks are trust-gated**, so every Codex session is untracked until the
user approves the hook in Codex's own TUI. `raise status` is one-shot and scans inline.

---

## Codex is covered, and pi with it

1.4 predates RAI-21. A stranger with Codex windows open has exactly the same empty page, and
Codex has an extra reason to need this: per RAI-21 the hook file is written by
`raise install-codex` but **Codex silently runs nothing until the user trusts it**, so there is
a window - possibly a long one - in which Codex sessions exist and report nothing at all.

All three agents are scanned, from three roots:

| Agent | Root | Layout |
| --- | --- | --- |
| Claude Code | `~/.claude/projects` | `<slug>/<session-id>.jsonl` |
| pi | `~/.pi/agent/sessions` | `<slug>/<ts>_<uuid>.jsonl` |
| Codex | `~/.codex/sessions` | `YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` |

Each root is env-overridable through the agent's *own* variable, which `config.js` already
honours for two of the three (`PI_CODING_AGENT_DIR`, `CODEX_HOME`); `CLAUDE_CONFIG_DIR` is
added beside them on the same reasoning, and `bin/raise.js`'s `--settings` default now comes
from it too so there is one answer to "where is Claude Code's home".

**`state_5.sqlite` is not read, here either.** RAI-21 rules it out and nothing in this ticket
weakens that: the one thing this scan needs from a Codex session is its working directory, and
that is on line 1 of the rollout file itself.

### Finding the working directory

Without a cwd there is no repo name, no branch and no row, and the three agents keep it in
different places. Measured:

- **Claude Code** writes `cwd` on every `user`/`assistant` record, so the **tail** has it. The
  head does not reliably: the first record carrying one was 1.7 KB in for this session and
  **172 KB** in for the worst of the 1,396 on disk.
- **Codex** writes it once, in the `session_meta` on line 1, inside `payload.cwd`. Line 1 is
  **18.6 KB** (it carries the base instructions). A 128 KB tail of a real rollout contains no
  `cwd` at all.
- **pi** writes it once, on line 1, in a ~160-byte `session` record.

So: **read the tail first, and fall back to the head**, with one extractor that accepts
`record.cwd` or `record.payload.cwd`. The tail is the same 128 KB `TranscriptReader` already
uses, and the head budget is 64 KB - three and a half times Codex's observed line 1. For a file
shorter than the tail window the first read is the whole file and the fallback never runs.

This reads **raw** lines rather than going through the normalisers, deliberately: `cwd` is one
of the fields `pi-transcript.js` and `codex-transcript.js` exist to drop, and re-admitting it
there would put session metadata back into the record stream that `summariseTranscript` reads -
the `away_summary` trap, invited in by the front door.

**Only a positive answer is cached**, on the path, for the life of the entry - a session's
working directory cannot change. A file we could not place is retried on the next scan, which
is the same rule `nm-state.js` follows for the database appearing under a running monitor, and
for the same reason: caching the absence means never noticing when it stops being true.

---

## Where the code goes

| | |
| --- | --- |
| `src/untracked.js` | the scan, the cwd extractor, and the cache. The only new module |
| `src/config.js` | `claudeHome`, `claudeSettingsPath`, `claudeProjectsDir`, `piSessionsDir`, `codexSessionsDir` |
| `src/dashboard.js` | the `untracked` input, the `untracked` attention and row kind, and the kind ordering in `sortRows` |
| `src/server.js` | one `UntrackedScan`, resolved into the existing `branches` / `mainCheckouts` / `summaries` maps |
| `bin/raise.js` | the same for `raise status`, scanned inline, plus the rendered line |
| `public/index.html` | the trailing group, the faint state, and the explanation line |

Untracked entries are keyed into the existing per-session maps by their **transcript path**.
A session id is `[A-Za-z0-9_-]{1,128}` and a path contains `/`, so the two key spaces cannot
collide, and reusing the maps means the transcript cache, the `.git` cache and both prunes all
work unchanged rather than being duplicated for a second kind of row.

`sortRows` grows an explicit kind ordering - **session, then unattributable run, then
untracked**. A run we cannot place may still be parked at a gate somebody has to answer; an
untracked row is waiting on nothing we can name, so it goes last.

---

## Definition of done

- On a machine whose sessions all predate the hooks, the page is populated rather than empty,
  and every such row is grey, has no state word, has no `Focus ↗`, and says how to fix itself.
- A session that restarts loses its untracked row and gains a real one, within one poll.
- A no-mistakes pipeline agent never appears as an untracked row, whether or not its run is
  still in the reading.
- On a machine with no no-mistakes and no lavish: no warning, no subprocess, and the untracked
  rows still appear.
- `npm test`, `npm run lint`, `npm run typecheck`.
- 1.5's gate: a real manual run against a scratch `RAISE_HOME` and `NM_HOME`, eyeballed in a
  browser.

---

## Implementation notes

Built as specified. Nothing on the **deliberately absent** list was quietly included, and the
open question was settled the way the evidence pointed, which was also the way the ticket
leaned - no state word, no colour. Three things found after the spec was written that it did not
predict - two by the build, one by the review - all recorded in place rather than only here.

### A deleted working directory names the wrong branch

Found while eyeballing the manual run: a card for `/Users/mattw/work/money-webapp`, a directory
that does not exist on this machine, confidently labelled `master`.

`GitBranch.checkoutFor` walks up from whatever it is handed until something answers to `.git`.
For a registered session that is always right, because the path is a live process's own working
directory. For an untracked row it is not: the path comes from a *file*, and a session whose
worktree has since been deleted resolves to whichever ancestor is a checkout - which on this
machine is `$HOME`, the dotfiles repo, on `master`. A row is allowed to know nothing; it is not
allowed to name the wrong branch.

So `UntrackedScan` requires the working directory to still be a directory. The check is in the
scan and not in `git-branch.js` deliberately: the walk-up is correct behaviour for every other
caller, and narrowing it there would be fixing the general case for a problem only this one has.

### The suite was walking the developer's own machine

`createMonitorServer` reads the three agents' homes, and every server test built one - so the
first run of `npm test` after wiring it up took over two minutes and failed five assertions with
counts like `9 !== 2`, because `/state` had grown a row per session actually open on the machine.

The fix is in the `scratch()` helpers of `server.test.js` and `cli-serve.test.js`, which now set
and restore `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR` and `CODEX_HOME` alongside the temp
directory they already make - one place, so a test added later cannot forget. `AGENTS.md` states
the rule under *Testing and Quality*. Worth knowing that the failure was loud here only by luck:
had the developer's machine been quiet, the tests would have passed and gone on passing until
somebody ran them with sessions open.

### A closed session came back as one that never reported

Caught by the review, and by neither the spec nor the manual pass - the manual pass ran on a
scratch `RAISE_HOME` where nothing had ever ended, which is exactly the machine this cannot
happen on.

`registry.record` deletes a session's record on a terminal event and `registry.list` deletes it
when its pid stops answering, but its transcript is untouched and stays minutes old. So within
thirty seconds of closing a window, a card appeared under **Not reporting to Raise** reading
`Not tracked` and *"Found on disk, never reported - restart the session and Raise will follow
it"* - about a session Raise had watched from `SessionStart` to `SessionEnd`, and that the user
had deliberately closed. On an installed machine this is not an edge case but the scan's largest
population: a feature added to stop a stranger's first page being empty would have put a ghost of
every window finished today on an established one. It also cost the honest empty state, since
closing everything no longer reached "Nothing running" for two hours.

The severity is in *which* rule it breaks. Everywhere else this page refuses to state what it
cannot know; here the opposite applied - Raise saw the session end, so the row was not an
unknowable state guessed at but a known fact contradicted.

Softening the wording until it was true of both cases was considered and rejected: it keeps the
ghosts, keeps advising a restart of something deliberately closed, and still loses the empty
state. A distinct *ended* row was rejected too - a closed session is nowhere anyone can be taken,
so giving it a row reopens the affordance problem the untracked card was careful to avoid. The
tombstone is the only option that leaves README.md's *"nothing has ever reported that session"*
and this spec's own framing true as written, and both were re-read and left alone.

Three properties are load-bearing. It is **on disk**, because a restarted server is the moment a
stranger opens the page and in-memory tombstones would let every ghost return. It is written
inside `remove`, the one place a terminal event and a dead pid both pass through, so neither
route can drift from the other. And it is **one file per transcript** rather than one list:
`raise status` builds its own registry and its `list` prunes dead sessions too, so two processes
end sessions concurrently and a read-modify-write over a shared file would lose whichever entry
lost the race - which is the ghost this exists to prevent, reintroduced by its own fix.

### Two smaller decisions taken during the build

**The explanation moved onto the state line.** It started as a third line under the card, which
made the rows that say the least the tallest on the page - visible immediately in the manual run,
with three untracked cards standing taller than a red one. It now sits beside `Not tracked` as
`.msg`, which is the same slot and the same reasoning as the `dismissed` marker: the two halves
are one sentence. The wording lost its repetition in the same pass - `Found on disk, never
reported - restart the session and Raise will follow it`, which says where the row came from,
what is missing and what to do.

**`CLAUDE_CONFIG_DIR` reached `bin/raise.js` too.** `config.js` gained `claudeHome()` beside the
existing `piHome()` and `codexHome()`, and `DEFAULT_SETTINGS` now comes from it rather than
building `~/.claude/settings.json` by hand. A small tidy, taken because two answers to "where is
Claude Code's home" in one codebase is how the scan and the hook installer end up disagreeing on
a machine that has moved it.

### What was added

| | |
| --- | --- |
| `src/untracked.js` | the scan, the cwd extractor and the caches. The only new module |
| `src/config.js` | `claudeHome`, `claudeSettingsPath`, `claudeProjectsDir`, `piSessionsDir`, `codexSessionsDir` |
| `src/dashboard.js` | the `untracked` input, the `untracked` attention and row kind, `KIND_ORDER` in `sortRows` |
| `src/server.js` | one `UntrackedScan`, resolved into the existing per-session maps |
| `bin/raise.js` | the same for `raise status`, scanned inline, and the rendered line |
| `public/index.html` | the `Not reporting to Raise` group, the faint state, the explanation |

### Tests

786 total, up 30: `test/untracked.test.js` (17), seven in `dashboard.test.js`, four in
`registry.test.js` for the tombstone, and two end-to-end in `server.test.js` - one watching an
untracked row become a real one when a hook arrives, and one watching a closed session *not* come
back as one that never reported. Two of the seventeen are the evidence for the design rather than
tests of it - *a quiet transcript cannot
tell a finished turn from a session waiting on a human* and *a dangling tool call is not evidence
of a session that is still alive*.

**Those two record a measurement; they do not trip on a change.** Their fixtures are hand-written
copies of what was read off a real machine, so nothing in the suite re-takes the reading and
nothing fails on its own the day Claude Code starts flushing a pending `tool_use` eagerly. The
assertion fires only *after* a human has re-measured and edited the fixture, which is when it
stops the design being left as it is by inertia. A genuine tripwire would mean a test reading a
live transcript, and a test that touches the real machine does not belong in this suite.

So the recipes are recorded here, with their dates, because a measurement nobody can re-take is
just an assertion with a citation:

| Measured | When | How to re-take it |
| --- | --- | --- |
| the idle nudge writes nothing that a finished turn does not | 11/08/2026, live off the session registry | find a record whose state is `blocked` with `notificationType` `idle_prompt`, and compare the tail of its transcript against that of a session recorded `working` |
| a pending `tool_use` is not flushed while its dialog is open | RAI-11's capture | open a tool-approval dialog and look for the pending `tool_use` in the transcript while the dialog is still on screen - it was absent at +30s and +46s |

The symmetry is the point: this repo refuses to state what it cannot know about a session, and it
does not get to overclaim about its own test suite either.

### Verified live

`raise serve` on port 7791 with a scratch `RAISE_HOME`, `NM_HOME`, `CLAUDE_CONFIG_DIR`,
`PI_CODING_AGENT_DIR` and `CODEX_HOME`, no no-mistakes database and nothing installed under
either optional integration, eyeballed in Chrome in both colour schemes:

```
WAITING FOR YOU
  raise           RAI-4-first-run-shows-something   Waiting for you   tab   Focus ↗
NOT REPORTING TO RAISE
  firstmate       rates page  main    Not tracked  Found on disk, never reported - …
                  Fixing the interest rate rounding on the summary card          1m
  2/hexbattle     HXB-67-sea-depth-gradient   Not tracked  …                 2m  pi
  work/hexbattle  main                        Not tracked  …              3m  codex
```

All three agents found from their own roots, disambiguation working across a tracked and an
untracked card, the pi and Codex chips present, no `Focus ↗` and no expander on any of the three,
`doctor` reporting a missing no-mistakes as normal, and neither `no-mistakes` nor `lavish-axi`
run. The no-mistakes worktree fixture and the five-hour-old transcript were both correctly
absent, as was a fixture whose working directory does not exist.
