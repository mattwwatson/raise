# TIP - RAI-14: Roadmap tooling: the board from disk, and a CI gate

> Living Technical Implementation Plan. Updated as decisions land; chunk statuses below.
> Status: planning - awaiting sign-off. All three opening questions resolved 06/08/2026.
> Deleted in a final commit before the PR. The durable record is
> [docs/tasks/RAI-14-roadmap-tooling.md](docs/tasks/RAI-14-roadmap-tooling.md).

## 1. Scope and context

The *what and why* lives in the spec, and this file does not restate it. Read the spec first.

This file carries only the three things a spec should not: **where delivery is up to**, **the
decision log as decisions land**, and **open questions**. At the endgame the decisions that
turned out to matter fold into the spec's `## Implementation notes` and this file is deleted.

One repo, one branch: `RAI-14-roadmap-tooling`.

## 2. Current state (surveyed 06/08/2026)

**The source being ported.** `/Users/mattw/work/hexbattle/scripts/tasks.ts` (325 lines) and
`scripts/check-task-links.ts` (78 lines). Zero dependencies, wired into that repo's
`bitbucket-pipelines.yml`, no tests. Read in full.

**This repo, as found.**

| | |
| --- | --- |
| `docs/tasks/` | 10 spec files. Frontmatter is exactly `ticket`, `status`, `size`, `depends` everywhere; `branch:` and `shipped:` are documented and present in **zero** files, so a strict validator would fail today's tree |
| Statuses in use | `backlog` and `in-progress` only. `shipped` and `wont-do` are unexercised |
| `depends:` | a single bare key or `-`. **No file uses a comma list**, though the format allows one |
| Jira | 17 issues, 10 with specs. RAI-4 to RAI-9 and RAI-14 have no spec. RAI-1 is an **Epic** |
| Spec references in the tree | exactly 4, all resolving. A clean baseline: if `tasks:links` is red on its first run, the port has a bug and the repo does not |
| `npm test` | 462 tests, ~2s, verified. Stated as 462 in `AGENTS.md:1007`, `AGENTS.md:1118`, `README.md:389` |
| `lint` | `oxlint src bin hooks public test` - no `scripts` |
| `tsconfig.json` `include` | `src bin hooks public` - no `scripts`, and `test/` is deliberately excluded |
| `package.json` `files` | `bin/ src/ public/ hooks/ README.md` - no `scripts`, which is why the tooling goes there |

## 3. Architecture decisions

### 3.0 Guiding principles

1. Every command is **pure core - result object - pure renderer**. One entry script owns disk,
   network, `argv` and `process.exitCode`.
2. `exitCode` is a field on the result, never a side effect, so exit behaviour is a pure test.
3. Reuse before writing: `GitBranch` for the branch, `defaultGitAccess`'s accessor shape for the
   filesystem, `probeHealth`'s `fetchImpl = fetch` for the network.
4. Fail in the direction that is safe for the thing being guarded, and say which way each guard
   fails in its own comment.

### 3.1 Where the code lives - **`scripts/`, npm scripts, not a `nmmon` subcommand** (decided 06/08/2026)

Considered: a `nmmon roadmap` subcommand (rejected - `nmmon` is a shipped product about agent
sessions; a dev-workflow board would enter `usage()`, README's Commands table and the published
`files` array); a `src/roadmap/` module (rejected for the same reason, `src/` is in `files`).
Reasoning in full in the spec.

### 3.2 Where the CI gate runs - **pull requests only** (decided 06/08/2026)

Considered: hexbattle's `[ "$BITBUCKET_BRANCH" != "main" ]` (rejected - this repo has a
`default:` pipeline hexbattle lacks, so it would fail every WIP push); a separate `&roadmap` step
anchor (rejected - costs an extra `npm ci` for two disk-only commands). Reasoning in the spec.

### 3.3 Module split (decided 06/08/2026)

| File | Holds |
| --- | --- |
| `scripts/tasks.js` | entry: dispatch, real deps, print, set `process.exitCode`. No logic |
| `scripts/task-files.js` | the real `node:fs` accessor and `repoRoot()`; owns `TaskFileAccess` |
| `scripts/task-specs.js` | frontmatter, `Spec` records, every structural fault, `findDependencyCycles` |
| `scripts/task-board.js` | the READY rule, sections, counts, column layout |
| `scripts/task-gate.js` | branch name to ticket key to shipped assertion |
| `scripts/task-jira.js` | credential assembly, the one `fetch`, failure classification, reconciliation |
| `scripts/task-links.js` | reference extraction, tree walk, resolution |
| `scripts/task-format.js` | `paint`/`dim`/`bold`/`pad`/`truncate`, colour as a parameter |

One test file per module, `test/task-*.test.js`, except the two edges (`tasks.js`,
`task-files.js`) which get none on the same terms as `bin/nmmon.js` and `src/exec.js`.

**Line count accepted at ~985 source, against the ticket's "about 400"** (decided 06/08/2026).
Considered consolidating to 4 modules by folding `task-format.js` into its callers and merging
board into specs; rejected because the render/logic split is the thing that makes the port
testable and merging them hides it. The multiplier is module comments, JSDoc typedefs, that
split, and four new guards - the executable logic is barely larger than the original.

### 3.5 Jira credentials - **cloud id inline, email and token required** (decided 06/08/2026)

The line is **project identity versus somebody's credential**, not "no literals in source".
`JIRA_PROJECT` and `JIRA_CLOUD_ID` name this project's board and the site it lives on - the same
class of fact as the board URL already in `AGENTS.md` - so they are defaulted inline and a fork
overrides them. `JIRA_EMAIL` and `JIRA_TOKEN` identify a person and get no default.

Considered: no defaults at all (rejected - a three-variable daily invocation to avoid publishing
a fact that is already in `AGENTS.md`); a gitignored `.jira.json` (rejected - one more file and
one more thing to explain, for one command run occasionally).

### 3.4 Four bugs in the original, fixed rather than ported (decided 06/08/2026)

Listed with their reasoning in the spec. In short: the gate regex accepts the branch shape it
exists to reject; a truncated Jira page reads as data; the JQL excludes epics that have specs;
`depends` cycles are undetected.

### 3.x Stubs and placeholders register

*Empty.* Anything intentionally fake goes here and must be gone before the endgame.

## 4. Skills and conventions

- `roadmap-workflow` (this repo's own skill) - the workflow being automated. Its `## Tooling`
  section currently says "There is none yet, deliberately" and is part of the deliverable.
- `AGENTS.md` "Coding Conventions", "Testing and Quality", "Safe-Change Rules".
- `local-test` is **skipped**: Moroku/MongoDB-specific. Definition of done here is `npm test`,
  `npm run lint`, `npm run typecheck`.
- Commit subjects start with the key: `RAI-14: <what changed>`. No tool attribution.

## 5. Local dev and test environment

Nothing to run. `npm test` needs no network, no database and no build step. Coverage needs Node
24 (`PATH="$(brew --prefix node@24)/bin:$PATH" npm run coverage`) but is not part of the gate.

The only command needing anything is `tasks:validate`:

```sh
JIRA_EMAIL=mattw.watson@gmail.com \
  JIRA_TOKEN=$(secret-get JIRA_PERSONAL_API_TOKEN) npm run tasks:validate
```

## 6. Delivery approach

Chunk, then repo definition of done (`npm test`, `npm run lint`, `npm run typecheck` all green),
then **stop** for a local e2e pass, then commit only on explicit approval. Runs of consecutive
TIP-only commits get squashed at the end; this file is deleted in a final commit. Ends with
`/no-mistakes` validating and shipping the PR.

## 8. Chunk breakdown

1. **Core and board** - `task-format.js`, `task-files.js`, `task-specs.js`, `task-board.js`,
   `tasks.js` with the board command, their tests, `npm run tasks`. *pending*
   *E2E*: shows all 10 RAI items; RAI-3 blocked by RAI-2, RAI-13 blocked by RAI-10, the rest READY.
2. **Links** - `task-links.js` + tests + `npm run tasks:links`. *pending*
   *E2E*: passes on the tree; renaming a referenced spec makes it fail and name the referrer.
3. **Gate** - `task-gate.js` + tests + `npm run tasks:gate`. *pending*
   *E2E*: fails on this branch while the spec says `in-progress`; passes when flipped to
   `shipped`; `fix/RAI-14-x` is rejected for putting the key second.
4. **Validate** - `task-jira.js` + tests + `npm run tasks:validate`. *pending*
   *E2E*: real run against RAI - RAI-4 to RAI-9 read as orphans, RAI-1 as an exempt epic, nothing
   as a fault.
5. **Wiring and docs** - `package.json`, `tsconfig.json`, `bitbucket-pipelines.yml`, `AGENTS.md`,
   `README.md` test count, `roadmap-workflow` SKILL.md, spec to `shipped` with
   `## Implementation notes`. *pending*

## 10. Follow-up register

- **One stale reference, corrected in chunk 2 rather than chased with a wider pattern**
  (decided 06/08/2026). `docs/tasks/RAI-13-pr-state-from-forge.md:11` says *"Prerequisite:
  `PR-STATE-FRESHNESS.md` lands first"*; that file is now
  `docs/tasks/RAI-10-pr-state-freshness.md`. The ported pattern misses it - no `tasks/` prefix.
  Considered widening to bare `` `NAME.md` `` mentions inside `docs/tasks/`; rejected because it
  would fire on any capitalised filename in prose, and a checker that cries wolf is one people
  stop reading. The pattern already catches every reference that names a directory, which is the
  shape the workflow actually writes.

## 11. Open questions

*None outstanding.* Nothing here may be silently answered in code - anything that arises during a
chunk comes back here before it becomes a decision in section 3.
