---
ticket: RAI-3
status: backlog
size: M
depends: RAI-2
---
# RAI-3 - Rename the project to raise

**Self-contained execution plan.** No prior conversation needed. Written 05/08/2026.

You are renaming this project. The name was chosen after checking npm, GitHub and domain
availability; it is settled, so do not relitigate it. Do the work, get both gates green, stop.

---

## ⚠️ Read this first - the mistake that ruins the whole job

This repo contains **218 references to `no-mistakes`** and only **11 to
`no-mistakes-monitor`**. `no-mistakes` is a **separate, external tool** that this one reads the
state of. Its name is not changing.

**A blanket find-replace of `no-mistakes` will destroy this repository.** It would break
`NM_HOME`, the `~/.no-mistakes` database path, the `no-mistakes axi status` fallback command,
and every design note explaining how the two tools relate.

Only these three tokens change:

- `nmmon` (lower) → `raise`
- `NMMON` (upper) → `RAISE`
- `no-mistakes-monitor` (the full repo/package name, all 11) → `raise`

**Never touch bare `no-mistakes`.** Verify before committing:

```sh
grep -roE "no-mistakes(-monitor)?" --include="*.js" --include="*.md" --include="*.json" \
  --include="*.html" . | grep -v node_modules | sed 's/.*://' | sort | uniq -c
# must print 218 no-mistakes and 0 no-mistakes-monitor
```

Also unchanged: `NM_HOME`, `src/nm-state.js`, `test/nm-state.test.js`, and every `nm-state`
identifier. Those name the *other* tool.

---

## Preconditions - the human does these, not you

Do not proceed until confirmed. If you are an agent and these are not done, **stop and say
so** - starting early leaves the user's live installation in a state they must repair by hand.

1. **Every outstanding pull request is merged.** This touches nearly every file in the repo,
   so anything still in flight will conflict with all of it.
2. **The documentation pass correcting the tool's stated purpose has landed** - see the note
   under *Documentation* below. Renaming stale framing means doing the work twice.
3. **The npm package name and `raise.dev` are claimed.**
4. **`uninstall-hooks` has been run against the live installation**, from the checkout the
   installed hooks actually point at. On this machine that was a treehouse worktree, not the
   main checkout - check `~/.claude/settings.json` for the real path. The pi extension in pi's
   settings needs the same treatment.
5. **Any running server is stopped.**

**Why the order is fixed.** `HOOK_MARKER` (`src/hooks.js`) and `EXTENSION_MARKER`
(`src/pi-extension.js`) are how install/uninstall recognise their own entries in someone
else's settings file. Rename the hook file *and* the marker while entries are still installed
and those entries become invisible to both commands: uninstall cannot find them, install will
not replace them, and you end up with two registrations - one pointing at a file that no
longer exists. Because the hook exits 0 quietly on every path by design, that orphan then
fails **silently, forever**.

**You must not run `install-hooks` or `uninstall-hooks` yourself.** They write to the user's
`~/.claude/settings.json`, which every one of their running sessions shares - including
possibly the one you are in.

---

## The rename map

| Old | New | Notes |
| --- | --- | --- |
| `nmmon` | `raise` | command name |
| `NMMON_HOME` | `RAISE_HOME` | |
| `NMMON_PORT` | `RAISE_PORT` | |
| `~/.nmmon` | `~/.raise` | holds `token`, `server.json`, `sessions/` |
| `x-nmmon-token` | `x-raise-token` | **wire protocol - see below** |
| `.nmmon-backup` | `.raise-backup` | settings backup suffix |
| `bin/nmmon.js` | `bin/raise.js` | `git mv` |
| `hooks/nmmon-hook.js` | `hooks/raise-hook.js` | `git mv` |
| `hooks/nmmon-pi-extension.js` | `hooks/raise-pi-extension.js` | `git mv` |
| `test/nmmon-pi-extension.test.js` | `test/raise-pi-extension.test.js` | `git mv` |
| `HOOK_MARKER` value | `'raise-hook.js'` | must match the new filename |
| `EXTENSION_MARKER` value | `'raise-pi-extension.js'` | must match the new filename |
| package `name` | `raise-cli` | **not** `raise` - that name is squatted on npm |
| package `bin` key | `{ "raise": "bin/raise.js" }` | the command is `raise`; the package name need not match |

---

## One protocol, one commit

`x-nmmon-token` is a four-way contract. All four change together or the dashboard dies:

- `src/security.js` - reads the header
- `hooks/raise-hook.js` - sends it
- `hooks/raise-pi-extension.js` - sends it
- `public/index.html` - sends it from the browser

AGENTS.md: *"Do not change the SSE frame shape, event names or `/api` responses without
updating `public/` in the same change - they are one protocol."* This is that rule.

---

## Surface inventory

Roughly 250 occurrences across 30 files. Highest density: `test/server.test.js` (59),
`bin/nmmon.js` (49), `README.md` (43), `AGENTS.md` (23), `test/cli-serve.test.js` (21),
`test/cli-args.test.js` (16).

Regenerate the current list with:

```sh
grep -rlE "nmmon|NMMON|no-mistakes-monitor" --include="*.js" --include="*.json" \
  --include="*.md" --include="*.html" . | grep -v node_modules
```

`package-lock.json` carries the package name too - regenerate it rather than hand-editing.

---

## Packaging, same pass

In `package.json`:

- `"name"` → `"raise-cli"`
- `"bin"` → `{ "raise": "bin/raise.js" }`
- `"description"` - rewrite; the current one leads with no-mistakes, and this tool now
  supports Claude Code and pi with no-mistakes as an optional signal
- **remove `"private": true`**
- `"license": "UNLICENSED"` → `"MIT"`, and add a `LICENSE` file (MIT, Matthew Watson, 2026)

---

## Documentation is a rewrite, not a replace

`README.md` and `AGENTS.md` carry the name in running prose. Two problems a `sed` will not
solve:

1. **`raise` is a verb.** *"raise shows you which session is waiting"* reads as an instruction.
   Sentences where the name is the subject need capitalising (*"Raise shows you…"*) or
   rewording. Pick one convention, apply it consistently, and say which you chose.
2. **A separate pass has already corrected what these documents say this tool *is*** - that
   no-mistakes is an optional signal source rather than the subject, and that this monitors
   Claude Code and pi sessions. That pass ran deliberately *before* this one, because
   `AGENTS.md` and `README.md` are the context every agent session reads, and renaming
   documentation you have been told is wrong - while relying on it to understand the repo -
   is how a rename turns into a rewrite.

   **So treat the current prose as correct and change only the name.** If you find a statement
   about the tool's purpose that reads as wrong, **stop and report it** rather than fixing it
   here. Two changes tangled together stop being reviewable, and a purpose correction
   smuggled into a rename commit is invisible to review.

Check whether the test count in both files matches what `npm test` reports, and correct it if
not - that is a fact, not a framing decision.

Also in `README.md`: the install section has a `git clone` URL pointing at Bitbucket. Leave it
unless the user has given you the new one - guessing a repository URL is worse than an
outdated one.

---

## Do not change

- Bare `no-mistakes`, `NM_HOME`, `~/.no-mistakes`, `nm-state.*`
- `lavish-axi`, `.lavish`, anything Lavish
- `LAVISH_*`, `PI_*`, pi's `~/.pi/agent` paths
- Behaviour of any kind. **This is a rename. If a test needs its assertions changed rather
  than its strings, stop and ask** - that means the rename has altered behaviour, which it
  must not.

---

## Constraints (from AGENTS.md, non-negotiable)

- **Zero runtime dependencies.** Node builtins only; `dependencies` stays empty.
- **`src/hooks.js` writes to a user's settings file.** It must keep showing a diff, asking
  first, backing up, leaving foreign hooks untouched, and being safe to run twice.
- **`hooks/raise-hook.js` runs inside a live Claude session.** Every path exits 0, quietly,
  within `TIMEOUT_MS`.
- **Nothing reachable from the server may run a synchronous child process.**
- Conventions: 2-space indent, single quotes, semicolons, trailing commas, ~100 columns, named
  exports only, JSDoc without TypeScript syntax.

---

## Definition of done

```sh
npm test          # all green - note the count, it should not change
npm run typecheck # tsc --noEmit
```

Plus, all of these must return nothing:

```sh
grep -rn "nmmon\|NMMON" --include="*.js" --include="*.json" --include="*.html" . | grep -v node_modules
grep -rn "no-mistakes-monitor" . | grep -v node_modules | grep -v "^./.git"
```

And this must still return 218:

```sh
grep -roE "no-mistakes(-monitor)?" --include="*.js" --include="*.md" --include="*.json" \
  --include="*.html" . | grep -v node_modules | sed 's/.*://' | sort | uniq -c
```

**Test count must not change.** A rename that changes it has changed behaviour.

Commit as one commit - it touches nearly every file, and splitting it makes `git bisect`
useless across the boundary.

---

## Hand back to the human

When the gates are green, tell the user they need to:

1. `install-hooks` with the new binary
2. Install the pi extension with the new binary
3. **Restart every open Claude Code and pi session** - hooks are read at session start, so
   nothing already running reports itself until it restarts
4. Note that `~/.nmmon/` is now orphaned. The new binary uses `~/.raise/` and will mint a fresh
   token. `~/.nmmon/` can be deleted once the new install is confirmed working - it holds only
   a token, a `server.json` and session records, all of which regenerate.

Do not do any of these for them.
