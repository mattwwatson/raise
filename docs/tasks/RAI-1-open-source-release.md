---
ticket: RAI-1
status: in-progress
size: L
depends: -
---
# RAI-1 - Open source release

The spec for the [RAI-1](https://mattwwatson.atlassian.net/browse/RAI-1) epic, and the
shared background for every item under it. Individual children get their own spec when they
are picked up; until then this is where their reasoning lives.

Kept current as the work proceeds. When a decision here is superseded, amend it in place
rather than deleting the reasoning - most of what follows was arrived at the hard way, and
the record of *why* is the part worth keeping.

## The decision

`raise` today is framed as an accessory to `no-mistakes`. The pi work makes that framing
wrong: once two harnesses are supported it is a category, not a plugin. The generic product
is one sentence:

> **Which of my AI coding sessions is blocked, what is each one doing, and take me to it.**

That sentence needs only Claude Code. `no-mistakes`, `lavish-axi` and `pi` become **optional
signal sources that light up if you have them**. Nothing about the architecture fights this -
four sources already join into one list, and `nm-state.js` already has a schema probe and a
fallback. The work is making "absent" a first-class case alongside "present but different",
and then saying so in the docs.

### What success means

Not stars. The realistic goal is that the right fifty or so people - the ones running several
agents at once and losing track - find it useful, and that a few of them notice the standard
it is built to. That changes what to optimise: the README and a demo matter more than feature
breadth, and one person filing a thoughtful issue is worth more than a hundred drive-by stars.

---

## Phase 0 - decisions and prerequisites

Nothing below can start until these are settled. They are cheap to decide and expensive to
change later.

### 0.1 Land pi support first

`src/pi-transcript.js`, `test/pi-transcript.test.js` and the changes to `dashboard.js` /
`transcript.js` are uncommitted. Do not start a rename on top of an unlanded branch - the
rename touches nearly every file and the merge would be miserable. Land pi through the normal
pipeline, then begin.

### 0.3 Decide the contribution posture now

The first four issues will be Ghostty, WezTerm, Kitty and the VS Code terminal.
`src/focus/terminals.js` is exactly the right shape to accept them - one availability check
and one focus function per terminal. Decide before publishing whether that is a yes.

Recommendation: **yes, with a stated bar** - a new terminal needs its entry plus a test using
the injected command runner, and nothing else in the codebase may move. Write that into
`CONTRIBUTING.md`. Saying yes is cheap. Being ambushed by it after launch is not.

### 0.4 Decide the Linux position

macOS-only focusing is the single biggest disqualifier and it currently sits as a bullet in
Requirements. Two honest options:

- **A.** Ship macOS-only, state it in the first screenful, accept that half the audience
  bounces. Cheap, honest, and the monitoring half still works everywhere.
- **B.** Add a Linux focus path before launch. Real work - the tmux half largely transfers,
  but raising a window means `wmctrl`/`xdotool` on X11 and effectively nothing portable on
  Wayland.

Recommendation: **A for launch**, with an explicit "PRs welcome, here is the interface"
pointer. Option B on evidence of demand, not speculation. Do not let it delay the launch.

### 0.5 pi's event mechanism - answered

pi has an `extensions` array in its own `settings.json`, and the working tree already
registers into it: `src/pi-extension.js` installs the path, `hooks/raise-pi-extension.js`
posts the same wire format the Claude Code hook posts. So there is no missing plumbing and no
second parser. This is not an open question any more.

**What is still true, and belongs in the docs rather than in a fix:** pi has no permission
prompt, so it has no `blocked` state to report. `PI_EVENT_STATES` deliberately contains no
`blocked` at all, and the reasoning in `registry.js` is right - inferring one from "the turn
ended a while ago" would put pi rows in competition with real permission prompts on the
strength of a guess.

That is a **cleaner story than the one I assumed**. It is not "we cannot see pi's blocks", it
is "pi does not have that state". A pi session still reaches the top of the list honestly,
through its pipeline: parked, failed, or waiting on a review.

Consequence for Phase 3: the support matrix says exactly this, in one line, without apology.
Do not let it read as a gap, and do not paper over it by inventing an inferred block later.

---

## Phase 0.9 - fix what the documentation says this tool is

**Reordered 06/08/2026, ahead of the rename, and ahead of most other work.**

The original plan filed documentation under Phase 3, as a launch artefact. That was wrong.
`AGENTS.md` and `README.md` are **agent context**: every Claude or pi session that opens this
repo reads them before doing anything. Stale framing is therefore not a cosmetic problem
waiting for launch day - it is actively producing wrong work, now, on every session.

Observed in practice: sessions make no-mistakes-centric assumptions drawn from the docs,
those assumptions are wrong since Phase 1 made no-mistakes optional, and the work goes round
in loops.

**It compounds for the rename specifically.** `RENAME.md` instructs the executing agent to
leave positioning alone - which, in the old ordering, would have had it renaming documentation
it had just been told was wrong, while relying on that same documentation to understand the
repo.

**Shipped 06/08/2026 as RAI-2.** The scope - what this tool *is*, not how it is promoted -
what was deliberately left to Phase 3, and what the documents actually said by the time it was
picked up are all in [`RAI-2-what-this-tool-is.md`](RAI-2-what-this-tool-is.md). The audit that
used to sit here describes a state that no longer exists.

**Everything in "Design decisions worth knowing" stays exactly as it is**, for the rename and
for Phase 3 as much as it did here. That section is the reason the codebase is worth showing
anyone, and it is already accurate.

**Sequencing:** all outstanding PRs merge → this → rename → Phase 3. Confirmed with the user
06/08/2026.

---

## Phase 1 - decouple, so a bare machine works

The goal is a clean Mac with Claude Code and nothing else installed getting a working
dashboard. This phase is entirely test-driven and does not touch naming.

### 1.1 no-mistakes becomes optional

- Test first: a scratch `NM_HOME` with **no database at all**. Assert the server starts, the
  poll loop runs, sessions appear, and nothing warns or degrades visibly. The absent case is
  different from the present-but-wrong-schema case that `nm-state.js` already handles.
- Audit `src/nm-state.js`, `src/poll-watch.js`, `src/dashboard.js` and `bin/raise.js` for
  paths that assume a run table exists.
- `raise doctor` must report a missing no-mistakes as **normal**, not as a fault.
- Check the `no-mistakes axi status` fallback does not shell out pointlessly when the binary
  is absent.

### 1.2 lavish-axi becomes optional

- Same shape: no `lavish-axi` binary, no `.lavish` directories, everything else works.
- `src/lavish.js` and the poll scan in `src/poll-watch.js` are the surfaces.
- The `review` attention state simply never fires. `ATTENTION_ORDER` is unchanged.

### 1.3 Harness detection becomes explicit

Right now "which harness" is implicit in which transcript parser runs. Make it a stated
concept so the dashboard can label a row and the docs can be honest about what each harness
supports. Keep it small - a field, not a plugin system.

### 1.4 The empty first run - launch-blocking

**Shipped 11/08/2026 as RAI-4.** The proposal below is what was built - a scan for recently
modified transcripts with no hook record, rendered as plain, non-focusable rows - and the open
question at the end was settled the way it leaned, but on evidence rather than caution: the four
states worth telling apart write byte-identical transcripts, so there is no state word that is
not a one-in-four guess. That measurement, the five bounds put on the scan, the decision to cover
Codex (which needs it more than the other two, its hooks being trust-gated) and two things the
build turned up are all in
[`RAI-4-first-run-shows-something.md`](RAI-4-first-run-shows-something.md).

The reasoning is kept below because it is what the design answers to.

Both harnesses register at session start (`SessionStart` → `idle`, `session_start` → `idle`),
so a **new** session appears with no activity required. That is already better than the
neighbours, where a session does not read as active until clicked.

The gap is elsewhere: **a session already running when the hooks were installed never fired
`SessionStart`**, so it stays invisible until its next `UserPromptSubmit`. Today that is a
README footnote telling you to restart your sessions, which is fine for the one user who
wrote it.

**For a stranger it is close to fatal.** They install, run `install-hooks`, open the dashboard
and see an empty page, because every session they have open predates the hooks. The obvious
conclusion is that it does not work - drawn at the exact moment they have the most sessions
running and the least patience. First impressions of a monitor are made in about four seconds.

Proposed fix, which fits the existing rules rather than fighting them: scan for **transcripts
modified recently that have no hook record**, and render them as **plain, non-focusable rows**
- exactly what pipeline-only rows already do. "Affordance must match capability" holds,
because there genuinely is no window identity to focus. The page is populated on first run and
gets better as sessions restart.

A filesystem scan is a blunt instrument and needs bounding deliberately: recent transcripts
only, superseded the instant a hook record arrives, and never a focus button. Its usual
failure - worktrees and pipeline agents arriving as separate entries - is already handled here
by `titlePath` disambiguation and `matchRunForAgentCwd`.

> The pipeline-agent half of that last sentence did not survive contact. `matchRunForAgentCwd`
> places an agent against a run that is *in the reading*, and a run that finished half an hour
> ago has left it while its worktree transcript is still recent - the same dead card, reached by
> the path that mechanism does not cover. It is a path test against `noMistakesHome()` instead.
> `titlePath` disambiguation carried over untouched.

Open question worth settling with a test: can such a row honestly show state at all, or only
"seen recently, restart to track it"? The transcript can say what a session was doing, but
`lastActivityAt` going quiet cannot distinguish *finished* from *waiting on a human*, and the
whole design forbids guessing between those. Leaning towards: no state word, no colour, just
presence and a hint - which is still infinitely better than a blank page.

> **Answered: no state word, no colour.** And the reason is sharper than "cannot distinguish".
> A finished turn, the sixty-second idle nudge, a session stopped at a permission prompt and a
> window closed an hour ago write the *same records* - the nudge writes nothing at all, and per
> RAI-11's capture a pending `tool_use` is not flushed until the tool resolves. `working` is not
> a safe fallback either: a dangling tool call is what a session killed mid-tool leaves behind,
> and there is no pid to probe because a pid is something only a hook reports.
> `test/untracked.test.js` asserts the indistinguishability directly, so the day Claude Code
> flushes eagerly the suite says so.

### 1.5 Gate

`npm test` and `npm run typecheck` green, plus a **manual run on a scratch `RAISE_HOME` and
`NM_HOME` with no no-mistakes and no lavish**, eyeballed in the browser. The test suite cannot
tell you the page looks sane with three sources missing.

Run for RAI-4 on 11/08/2026 and it earned its place twice over: the browser is where the
untracked cards turned out to be the tallest on the page, and where a card appeared for a
directory that does not exist, confidently labelled with `$HOME`'s branch. Neither was visible
from the suite. Both are written up in that ticket's implementation notes.

---

## Phase 2 - rename and repackage

**Shipped 08/08/2026 as RAI-3**, in one commit so bisect stays useful. The surfaces it touched,
the rename map, the four-way token contract and the naming convention it had to settle - `Raise`
the product, `raise` the command - are all in
[`RAI-3-rename-to-raise.md`](RAI-3-rename-to-raise.md), and the convention itself now lives under
*Coding Conventions* in `AGENTS.md`. The inventory that used to sit here named a set of files
that no longer exists under those names.

### 2.1 The migration trap

The reasoning is kept because it is what decided the shape of the hand-back. Anyone already
running the old binary had an installed hook pointing at `hooks/nmmon-hook.js` and a token in
`~/.nmmon/`, and a rename silently breaks both - the failure mode being the worst one this tool
has: **a dashboard that looks fine and reports nothing**.

With one existing user, the answer was not a migration shim but `uninstall-hooks` on the old
name and `install-hooks` on the new one, done deliberately, with no compatibility code. AGENTS.md
already forbids shims for versions we do not support. RAI-3 found a second thing that does not
regenerate - the forge `config.json` RAI-13 had put in the same directory - so the steps a human
has to run are written out in README's *Upgrading from `nmmon`* section, which owns them.

### 2.2 Packaging

Done in the same pass: `"private": true` removed, `"license": "UNLICENSED"` → `MIT` with a
`LICENSE` file, and the `files` array checked against the renames. The package is `raise-cli`
with `bin: { raise: ... }`, because `raise` is squatted on npm.

Outstanding:

- Publish to npm so install is `npx raise-cli serve` rather than a Bitbucket clone. The clone
  URL in the README is deliberately unchanged until then - the git repository is not being
  renamed here, and guessing at a future URL is worse than an outdated one.
- New public GitHub repo. Decide whether to carry the git history across - it is good history
  and the commit messages are readable, but check it for anything repo-private first.

---

## Phase 3 - documentation rewrite

The README is the strongest asset here and better than most funded projects'. It is being
restructured, not rewritten.

### 3.1 README changes

1. **Open with the generic sentence**, not with no-mistakes. First screenful: what it is, the
   GIF, the constraint (macOS for focusing), the install.
2. **Requirements shrinks to Node 22.5+ and one supported harness.** no-mistakes, lavish-axi
   and pi move to an "Optional signals" section that says plainly what each adds and that
   nothing breaks without them.
3. **macOS-only focusing moves up**, stated in the first screenful. Finding out three minutes
   in is worse than being told immediately.
4. **Security moves up.** Strangers are being asked to let this merge hooks into their
   `settings.json` and read their transcripts. The existing section answers it well; it is
   just too far down the page. The zero-runtime-dependencies fact belongs here as well as in
   Requirements - it is a trust argument, not just a technical one.
5. **Strip the personal specifics**: `hexbattle`, `moroku-skills`, `money-webapp`, the
   `bitbucket.org:mattw_watson` clone URL. Replace with neutral repo names.
6. Add a **harness support matrix** - which signals work for Claude Code vs pi. Per 0.5, the
   honest line is that pi has no permission prompt and therefore no "waiting for you", and
   that this is pi's design rather than a limitation here. State it flatly. An overclaim in
   this table is the exact quiet-staleness failure the tool exists to prevent, turned on its
   own docs.

### 3.2 AGENTS.md changes

**Mostly moved to Phase 0.9**, which happens before the rename - the "what is this tool"
corrections are agent context and could not wait for a launch phase.

What remains here, after the rename has landed:

- ~~Add the new name and command throughout~~ - done by RAI-3, which also had to pick the prose
  convention `raise` being a verb forces. It is recorded under *Coding Conventions* in
  `AGENTS.md`; follow it rather than re-deciding it.
- Contributor-facing framing: the terminal adapter path per 0.3, and a pointer to
  `CONTRIBUTING.md`.

Everything in "Design decisions worth knowing" stays exactly as it is, in both passes.

### 3.3 A "related tools" section, written generously

Acknowledge the neighbours in the README rather than pretending the space is empty. They work
in a similar *space* while doing a genuinely different *job*, and saying so plainly is both
accurate and the strongest possible framing - it defines the category and stakes this tool's
corner of it in the same paragraph.

Tone: recommend them for what they are better at. Cross-session search is real and this will
never have it. A reader who wants an archive should be sent there without hedging.

This is a **link, not a comparison**. Recommend them plainly, say what this one is, and stop.
No table, no "unlike", no gap.

Draft shape:

> **Related tools.** Others are working on this too, and they are worth your time.
> [Switchboard](https://github.com/doctly/switchboard) browses and searches across all your
> past coding sessions - if you want to find *where you did that thing*, its cross-session
> search does something nothing here does.
> [signalbox](https://github.com/dwmkerr/signalbox) is a menubar app that jumps between live
> agent sessions across Claude Code, Cursor, Codex, opencode and pi, and it goes further than
> this does - there is a mobile app.
>
> This one is a page you leave pinned on a second monitor, and it is built around one
> question: **which session has stopped and needs a human right now.**

Three rules for this section:

- **Do not claim they lack something without checking it that week.** Both were pushed the day
  before this was written. A confident wrong statement about a neighbour is the same failure
  mode as a confident wrong row, and it would be an unusually bad look for a tool whose whole
  pitch is not asserting what it cannot stand up.
- **Never phrase the difference as a deficiency in theirs.** *Different question*, not
  *missing feature*.
- **Name at least one thing they do better and mean it.** Cross-session search and the mobile
  app both qualify. A related-tools section that somehow finds every neighbour lacking is a
  comparison wearing a disguise, and readers can tell.

### 3.4 New files

- `LICENSE` (MIT)
- `CONTRIBUTING.md` - the terminal adapter bar from 0.3, the test/typecheck gate, the
  zero-dependency rule stated as non-negotiable
- Consider `SECURITY.md`, given the tool runs `osascript` and reads transcripts

---

## Phase 4 - the demo

**This is not a nice-to-have. It is the pitch, and it outweighs everything written above.**

A 20-second GIF or screen recording: four sessions working across repos, one goes red, click
it, the terminal window comes to the front. That single asset works in a README, a Show HN, a
Discord message and a tweet with no accompanying prose.

Make it with real sessions, not mocks. Pixel-check it - if the page looks off in the recording
it looks off to everyone who ever sees the project.

Second asset, cheaper: a still of the expanded row panel, which is the feature people will not
expect and is the one that reads as "someone thought about this".

---

## Risks worth naming

| Risk | Mitigation |
| --- | --- |
| **Support burden.** Terminals, harnesses and Linux requests arrive faster than they can be served | 0.3 sets the bar up front. It is fine for the answer to be "PR welcome, here is the interface" |
| **Trust surface.** It merges hooks into `~/.claude/settings.json` and reads transcripts. Someone will read this uncharitably | The behaviour is already correct - diff, confirm, backup, reversible. Phase 3.1 raises it to where people will see it before they worry |
| **Overclaiming pi support.** pi has no `blocked` state (0.5) | A support matrix stating that plainly, as pi's design rather than a gap here. Never close it later by inferring a block from an idle turn |
| **The rename breaks my own install silently** | 2.2. Deliberate uninstall/reinstall, no shim |
| **Launch pulls focus from other work** | Phases 0-4 are bounded and mostly mechanical. Promotion is the open-ended part - time-box it |
| **Other tools already exist in this space** | **Do not compete.** Ship on form factor and rigour, link them generously (3.3), chase none of their features, and do not benchmark against them. The advantages that look sharpest are usually days of work for someone else to close, and naming one publicly is a feature request with a deadline |
| **Drifting into feature-matching** once someone asks "how is this different?" | Answer on shape - a pinned page, and a refusal to assert what cannot be stood behind - then stop. This project's success does not require a defensible advantage, so a closed gap costs nothing |

---

## Immediate next actions

1. ~~Land pi support through the pipeline.~~ **Done** - merged to `main` as PR #6 (`dd815c9`)
   on 04/08/2026. Working tree clean, 362 tests passing, typecheck clean. Note `AGENTS.md` and
   `README.md` still say 314 tests.
2. ~~Survey the neighbouring tools~~ **done 04/08/2026.** Conclusion: ship on form factor and
   rigour, link them generously, and do not compete. See 3.3 for how they are referred to.
3. ~~Verify and adopt `PermissionRequest`.~~ **Built, in the no-mistakes gate 04/08/2026** on
   `feat/permission-request-hook` (`d4ef4ae`), 378 tests passing. Two changes, and the second
   is the better one:
   - `PermissionRequest` → `blocked`, firing 6-12s before the `Notification` and **only when a
     prompt is genuinely required** - permission rules, `bypassPermissions` and the auto-mode
     classifier all settle it first.
   - `isIdleNudge` now reads Claude Code's own `notification_type` (`idle_prompt` vs
     `permission_prompt`) instead of regex-matching message text, with the regex kept only for
     older versions. **This needs no hook reinstall**, so unlike the new hook it fixes sessions
     that are already open - which was the whole objection to `PostToolUse`.
   - The transcript disproof survives intact, as required: it still covers the idle nudge,
     which no permission hook reports.
4. Claim `raise` on npm - take the package name. Verified 04/08/2026: npm `raise` declares no
   bin; re-checked 08/08/2026: `raise-cli` free, `raise` taken at 0.0.0 with no command in it.
   RAI-3 has since named the package `raise-cli` with `bin: { raise: ... }`, so what is left is
   registering it - which no longer blocks Phase 2, but does block publishing, and availability
   is perishable.

   **No domain is being claimed.** This step used to require registering `raise.dev` as well.
   Withdrawn 08/08/2026: the name is not going to carry a site, so a domain buys nothing the
   npm name does not, and leaving it here would block a later reader on a requirement nobody
   intends to meet. The npm half stands - that is what `bin: { raise: ... }` needs.
5. Decide 0.3 and 0.4 - terminal PRs yes/no, Linux at launch yes/no.
