---
issue: 22
status: shipped
size: M
depends: 12
branch: fm/22-opt-in-commands
shipped: 2026-08-14
---
# 22 - Turning an optional feature on means hand-editing JSON, and the documented way can destroy it

Both of the features that reach the network - [pull request state](RAI-13-pr-state-from-forge.md)
and [the update check](12-version-notice.md) - are opted into by writing
`~/.raise/config.json` by hand, and the README documents each of them as a heredoc.

**`cat >` truncates.** The two recipes are sixty lines apart in the same document, and the
second one destroys everything the first one asked you to write. Somebody who has turned on
pull request state, minted a Bitbucket API token with `read:pullrequest:bitbucket` and put it
in that file, then reads down to the update check and follows its recipe, loses the credential
and the forge opt-in in one command. Nothing warns them, because from Raise's side nothing is
wrong: the file parses, the mode is right, and `forge.enabled` is simply not there any more -
which is the documented way of saying *off*. The badge quietly reverts to no-mistakes'
recollection, *"was open, last checked 3d ago"*, and the row goes on looking exactly as
confident as it did before.

That is the quiet staleness this whole tool exists to remove, caused by following its own
README.

The README does say, underneath, to add the block rather than replace the file. **That is
safety by vigilance**, which this codebase argues against everywhere else - the same argument
`src/hooks.js` opens with about `settings.json`, made about the one file we then declined to
write. And the `0600` is a second remembered step with a silent failure: forget the `chmod`
and `readUserConfig` refuses the whole file, correctly, so the cost of forgetting is the
feature not working with nothing on the page to say so. It is discoverable only by running
`raise doctor`, which is a thing you run when you already suspect something.

---

## What ships

```sh
raise enable update-check
raise disable pull-request-state
```

Two commands over a closed set of two feature names, each writing exactly one boolean into
`~/.raise/config.json`, merging rather than rewriting, and inheriting the contract
`install-hooks` already has: **show the diff, ask first, keep a `.raise-backup`, and be safe to
run twice.**

### The names are `raise doctor`'s, and that is the point

`doctor` prints its checks as **`Pull request state`** and **`Update check`** (`src/cli.js`,
`cmdDoctor`). The commands take the same two names kebab-cased - `pull-request-state` and
`update-check` - so that what you read in the diagnostic is what you type to fix it, with no
mapping table in between and nothing to keep in step. The doctor line that currently ends
*"(see ~/.raise/config.json)"* becomes the command instead, which is the whole of the fix
arriving where the problem is reported.

The JSON keys are `forge.enabled` and `updates.enabled`, and they stay as they are. The command
name is a name for the *feature*, not for the key: the key is an implementation detail of a
file the user may still hand-edit, and naming the command after it would be the second thing to
keep in step rather than the first thing avoided.

---

## The decisions

### 1. `hooks.js`'s `writeSettings` is not reused, and one of the two usual reasons is wrong

This was checked rather than assumed, because a plausible reason to write a second writer is
worth as little as a plausible bug. `writeSettings` does two things that matter here, and only
one of them is a problem:

| | Measured on 14/08/2026, Node 22 and 24 | Verdict |
| --- | --- | --- |
| `writeFileSync(path, data)` with no `mode` | `0664` under the umask of `002` this machine runs; `0666` under a umask of `000` | **Disqualifying.** `readUserConfig` refuses any file with `0o077` bits, so `writeSettings` would produce a file Raise itself then refuses - a command whose success message is followed by the feature not working. |
| `copyFileSync(src, dest)` for the backup | carries the source's `0600` through, **including onto a pre-existing `0664` destination**, because libuv opens the destination with the source's mode and chmods it | **Not a problem.** The suspicion that a backup of a file holding a Bitbucket token could land world-readable is wrong, and is recorded here so it is not re-raised. |

So the reason for a separate writer is the first row alone - but a third fact, found in the
same measurement, is what actually shapes it:

**`writeFileSync(path, data, { mode: 0o600 })` does not change the mode of a file that already
exists.** The `mode` option is passed to `open(2)`, which applies it at creation and ignores it
otherwise. A file already sitting at `0644` stays at `0644` through any number of writes that
ask for `0600`. The issue asks the command to *repair* a wrong mode, and the natural-looking way
to do it silently does nothing: it would report success over a file Raise still refuses, which
is the failure mode of the feature reproduced inside the fix for it.

**So `writeUserConfig` in `src/user-config.js` writes with `mode: 0o600` for the create case and
then `chmodSync`s unconditionally for the repair case.** Two calls, because they cover two
different states, and neither covers the other.

It lives in `user-config.js` rather than beside the commands because the `0600` rule is a
property of *the file*, which is the argument that module's header already makes about the read
- and a writer that could produce a file the reader in the same module refuses is exactly the
split that rule exists to prevent.

### 2. The objection in `src/config.js` is answered, not deleted

`updateCachePath`'s header carries a direct objection to this feature, written when the update
check shipped:

> Beside the config file rather than in it: that one is the user's to write and this one is
> ours, and a tool that edits the file it tells you to hand-edit is one that will eventually
> reformat your comments away.

**It stands, and the decision it was written to justify stands with it.** The update-check cache
still lives in its own file, and nothing machine-written moves into `config.json`. What the
objection rules out is Raise treating the user's file as a place to keep its own state, and
that is not what this does.

What it costs, stated plainly rather than argued away: a round trip through `JSON.parse` and
`JSON.stringify` **does** normalise the file. Key order survives - `JSON.stringify` preserves
insertion order - but indentation and blank lines do not, and JSON has no comments to lose. The
answer is not that the cost is zero; it is that the user sees the diff and says yes before any
of it happens, and a `.raise-backup` sits beside the file afterwards. That is the same bargain
`install-hooks` has struck with `settings.json` since the beginning, over a file with far more
of somebody else's content in it.

The header gains a sentence recording that this was weighed, so the next person to read it
finds the objection *and* its answer rather than an objection the code appears to ignore.

### 3. No credential ever reaches the command line

There is no `--token` flag, now or later. A token in argv is a token in shell history and in
every `ps` on the machine, which is the whole reason `forge-config.js` puts it in a `0600` file
instead of the environment - the argument does not survive being moved to a flag. An interactive
prompt is the only acceptable route and is deliberately not built here.

`raise enable pull-request-state` therefore turns on the GitHub half, which needs no credential
because `gh` authenticates itself, and says in its own output that Bitbucket still needs a
credential written by hand. **The heredocs leave the README; the JSON shape stays**, because
that is now the only thing the reader is being asked to type.

### 4. No generic `raise config set`

The two switches are a closed set. A general-purpose JSON writer aimed at a file holding a
credential is a machine for making typos succeed: `raise config set forge.enable true` would
report success and do nothing, and the reader would have Raise's word that the feature is on.
An unknown feature name is refused, and the error names both valid ones.

### 5. `disable` writes `false` rather than deleting the key

`enabled: false` and a missing block read identically to `readForgeConfig` and
`readUpdateConfig`, both of which require the boolean `true`. Writing `false` is chosen because
the file is a record of decisions the user has made, and a key that says `false` is a decision
where an absent key is indistinguishable from never having heard of the feature. It also makes
`raise enable` → `raise disable` → `raise enable` a stable cycle in the diff, rather than one
that adds and removes structure.

`disable` never removes a `forge.bitbucket` credential. Turning the lookup off is not a request
to destroy a token, and re-enabling would otherwise silently need the token minted again.

### 6. Where the diff comes from

The diff shown is the same shape `install-hooks` prints: a list of changes in words, not a
textual patch. `enable update-check` on a file with no `updates` block says `add
updates.enabled: true`; on one that already says `false` it says `change updates.enabled: false
-> true`. A file already saying `true` prints `Already enabled` and writes nothing, which is
what makes it safe to run twice, and it is the mode-repair case that keeps that honest: if the
boolean is already right but the file is `0644`, there **is** something to do, and the command
says `repair mode 0644 -> 0600` and does it.

### 7. A file Raise refuses is a file Raise will not write either

If `config.json` exists and does not parse, `enable` refuses and says so, exactly as
`readSettings` does for `settings.json`. Overwriting a broken file would discard whatever the
user was in the middle of typing, including a credential.

An unsafe *mode* is different and is the one case that is not a refusal: the whole point of the
command is that it repairs that. The file is read, merged and rewritten `0600` - the credential
in it was already exposed, and leaving the mode wrong helps nobody.

---

## The sweep

*"Raise never writes the config file"* is asserted in several places and becomes false the
moment this ships. Enumerated up front rather than fixed where remembered, because the
alternative is finding them one review round at a time.

| Where | Claim | After |
| --- | --- | --- |
| `src/config.js:115` | *"The one file the user writes rather than one Raise generates."* | **False.** `raise enable` creates it when it is absent. |
| `src/config.js:131` | *"a tool that edits the file it tells you to hand-edit…"* | **Stands as a decision, needs its answer.** See decision 2. |
| `src/user-config.js:2` | *"Reading the one file a user writes…"* | **Stale.** The module gains a writer, so the header describes both. |
| `src/user-config.js:4` | *"the only file here that Raise never generates"* | **False.** |
| `src/user-config.js:130` | *"This file is the user's to write, and the README tells them to write it"* - the reason `watchUserConfig` exists | **Still true and now stronger.** `raise enable` in a second terminal changes the file under a running `serve`, which is a change the watch was already built to catch. |
| `src/update-check.js:122` | *"read-only: the config file is the user's to write and Raise never writes it"* | **False.** |
| `src/server.js:136` | *"`~/.raise/config.json` is the one file the user writes"* | **Stale**, same shape. |
| `test/forge.test.js:237`, `test/forge-config.test.js:138` | the same sentence justifying the watch tests | **Stale**, same shape. |
| `README.md:551`, `README.md:610` | the two `cat >` heredocs | **Removed.** They are the bug. |
| `README.md:620` | *"add `updates` beside `forge` rather than replacing it"* | **Removed.** Safety by vigilance, and there is nothing left to be vigilant about. |
| `README.md:139`, `README.md:153` | *"Turning it on is one config file"* / *"the same config file"* | Becomes the command. |
| `README.md:156` | *"every write to a settings file keeps a `.raise-backup` beside it"* | **True and incomplete.** Extended to cover this write, since it is a promise in the Security section. |
| `README.md:430` | the flags line under Commands | `--dry-run` and `--yes` now apply to two more commands; the table gains a row. |
| `AGENTS.md:147` | the `src/user-config.js` row in the module table | Names the writer too. |

Three near-misses that are **not** in the family and stay exactly as they are, checked so that
nobody re-checks them:

- `AGENTS.md:350` - *"Raise never writes `config.toml`"* is about **Codex's** config and its
  trust gate. Untouched by this.
- `docs/tasks/RAI-13-pr-state-from-forge.md:188,453` - *"Raise simply never writes"* is about
  the Bitbucket **API scope**, not about a file.
- `docs/tasks/12-version-notice.md:122` quotes `user-config.js`'s header as it read when that
  item shipped. **Shipped specs are dated records and are not retconned**; the quote was true
  on 13/08/2026 and the spec says when it was written.

---

## Shape

| File | Change |
| --- | --- |
| `src/user-config.js` | `writeUserConfig` - the `0600`-by-construction writer with the `chmod` repair - and `setFeature`, the pure merge that produces the new object and the list of changes |
| `src/cli.js` | `cmdEnableFeature` / `cmdDisableFeature` over one shared implementation, the `enable`/`disable` cases, usage text, and the two `doctor` lines that now name the command |
| `README.md` | the heredocs out, the commands in, the JSON shape kept for the Bitbucket credential |
| `AGENTS.md` | the module-table row, and a decision-index row per decision above |
| `test/user-config.test.js` | the merge, the mode on creation, the mode repair, the refusal to parse |
| `test/cli-enable.test.js` | the commands end to end against a scratch `RAISE_HOME` |

`setFeature` is pure and is tested directly, per AGENTS.md's rule about pure logic and I/O; the
writer is the only part that touches the filesystem, and it takes its path from `config.js` like
everything else, so the suite never goes near a real installation.

---

## Definition of done

- `raise enable update-check` on a machine with no config file creates one, `0600`, holding
  only that block.
- `raise enable update-check` on a file already holding a `forge` block **and a Bitbucket
  credential** leaves both intact. This is the regression the issue is about and it is a test.
- A file at `0644` is repaired to `0600`, and the command says it did.
- Running either command twice writes nothing the second time and says so.
- `--dry-run` writes nothing; `--yes` skips the prompt; a refused prompt writes nothing.
- A `config.json` that does not parse is refused rather than overwritten.
- An unknown feature name is refused and both valid names are printed.
- No `--token` flag exists, and no credential is accepted on the command line.
- `npm test`, `npm run lint`, `npm run typecheck` pass.
- The sweep above is applied in full.

---

## Implementation notes

**A leak was found in the fix for the leak, and it is the reason the backup is chmodded.**
`copyFileSync` carries the *source's* mode onto the backup - which is right when the source is
`0600`, and is the whole problem during a **mode repair**, where the source is `0644` by
definition. The first working version of `raise enable` therefore secured `config.json` and
left `config.json.raise-backup` sitting beside it, world-readable, holding the same Bitbucket
token, under a name that says Raise put it there. It was caught by running the command against
a scratch home with a credential in it rather than by reading the code, and it is worth noting
that the measurement which cleared `copyFileSync` earlier in this spec is the same measurement
that hid this: the mode is inherited faithfully, so it is only wrong when what it inherits is.
`writeUserConfig` now chmods both files, and `test/user-config.test.js` and
`test/cli-enable.test.js` each pin it.

**What shipped differs from the plan in one place.** The `problem` message in
`readUserConfig` - the sentence `raise doctor` prints over a file it has refused - now names
`raise enable` and `raise disable` as things that repair the mode, alongside `chmod 600`. It
was not in the shape above, and it belongs to the same argument: the diagnostic that reports a
problem should name the command that fixes it, which is the reason the feature names are
`doctor`'s in the first place.

**`--token` is asserted absent rather than merely not written.** `test/cli-enable.test.js` runs
`raise enable pull-request-state --token secret --yes` and asserts that nothing from it reaches
the file. A non-goal recorded only in prose is one a later change can violate without anything
going red; this one now has a test, because the cost of getting it wrong is a credential in
every `ps` on the machine.

**The doctor assertion in `cli-enable.test.js` shells out**, which is the established pattern -
`cli-codex.test.js` and `cli-serve.test.js` both run `raise doctor` end to end - and what it
asserts, that the diagnostic names the command, is the naming decision this item turns on. The
precedent is the *shell-out*, and it comes with an obligation this first version missed: both
of those files point the homes `doctor` reads at their own scratch directory,
`cli-codex.test.js` passing `NM_HOME` and `CODEX_HOME` and `cli-serve.test.js` isolating all
three agent homes. With `RAISE_HOME` alone the test read the developer's live installation, and
inside this pipeline a live no-mistakes database. `cli-enable.test.js`'s helper now sets
`NM_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR` and `CODEX_HOME` too.

**"Nothing to restart" is a property of the feature, and saying it of both was wrong.** The
first version printed one closing line after every write. It is true of the forge, whose block
`watchForgeConfig` re-reads on the poll loop, and false of the update check, which `newerVersion`
asks exactly once at `raise serve` startup and never again - so `raise enable update-check`
against a running server made a confident false claim, in a tool whose entire purpose is
removing those. `CONFIG_FEATURES` now carries `watched`, so the fact sits beside the feature
definition rather than in a `block` comparison in `cli.js`, and `cli-enable.test.js` pins both
sentences.

**`~/.raise` is created `0700` by the writer, not just `0600` by the file.** `writeUserConfig`
created the directory with no `mode`, so on a machine where `raise enable` ran before anything
else the credential-holding directory landed at `0755` under an ordinary umask - and because
`mkdirSync` with `recursive: true` will not tighten an existing directory, the mode became a
function of which command a user happened to run first. It now passes `mode: 0o700`, the mode
`ensureDirs` uses.

**Test count 846 → 874.** The two new files are 13 tests each, plus one apiece for the two
corrections above.
