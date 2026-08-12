---
issue: 15
status: backlog
size: L
depends: -
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
