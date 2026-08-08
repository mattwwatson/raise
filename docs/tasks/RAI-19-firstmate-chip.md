---
ticket: RAI-19
status: shipped
size: S
depends: -
branch: RAI-19-firstmate-chip
shipped: 2026-08-07
---
# RAI-19 - Mark firstmate sessions on the card

**Self-contained brief.** No prior conversation needed. Written 07/08/2026. Every marker below
was read off a live firstmate installation rather than inferred from its documentation.

---

## The problem

[firstmate](https://github.com/kunchenguid/firstmate) runs a crew of agents on your behalf.
Each crewmate is an ordinary Claude Code session in a tmux window and a treehouse worktree, so
it registers through our hooks like anything else and every attribute we compute - the branch,
the run match, the pull request, focusing - already works on it unchanged.

That is the problem. On a page whose whole job is *which session needs me*, there is no way to
tell a session you started from one something else started for you.

---

## The evidence

**This is an identification problem, and identification here has one rule: positive evidence,
never absence.** The `HOST_LABELS` note in AGENTS.md records what happens otherwise - a kind we
failed to recognise used to default to `tab`, which turned every unplaceable session into a
confident claim about a window that was not there. A firstmate crewmate has no property that
*only it* lacks: no tty, a treehouse worktree, `--dangerously-skip-permissions` in argv are each
true of a handoff worker or a no-mistakes pipeline agent too.

Two markers do hold, and both are firstmate declaring itself.

### Crew: the tmux window name

`bin/fm-spawn.sh:966` names each crewmate's window `fm-<id>`, and
`bin/backends/tmux.sh:85-95` then pins it:

```sh
wid=$(tmux new-window -dP -F '#{window_id}' -t "$ses:" -n "$wname" -c "$proj_abs")
tmux set-window-option -t "$wid" automatic-rename off
tmux set-window-option -t "$wid" allow-rename off
```

The comment in that file says why: *"the captain's tmux may rename the window away from
fm-&lt;id&gt; once treehouse cd's into the worktree, which would break name-based targeting."*
firstmate's own targeting depends on the name surviving, so it is load-bearing for firstmate
rather than incidental, which is the property that makes it safe to key on.

Read live, with two crewmates running:

```
firstmate | win 0 | name=[First Mate]                             <- the captain
firstmate | win 1 | name=[fm-sls-87-push-subscription-ownership]  <- crew
firstmate | win 2 | name=[fm-sls-89-deploy-unpinned-install]      <- crew
handoff   | win 1 | name=[handoff-sls-75-4d7a]                    <- not crew
```

Three things, one field. Note the container **session** name is not the signal: the captain and
its crew share it, so keying on it would chip the captain as crew. And handoff uses the same
mechanism with a different prefix, which is the argument for the field being *which tool spawned
this window* rather than a firstmate boolean.

### The captain: firstmate's own session lock

The captain's window name is **not** equally trustworthy. Read from the live server:

| Window | `automatic-rename` | `allow-rename` |
| --- | --- | --- |
| crew (`fm-sls-87-…`) | off | **off** |
| captain (`First Mate`) | off | *on* |

`allow-rename` is what stops the program inside the pane retitling the window by escape
sequence, and Claude Code sets titles. So `First Mate` can drift, and a chip that silently stops
appearing is worse than one that was never there.

The cwd is not the answer either, and this is the trap worth recording: `~/work/firstmate` is
one machine's path, and **a session that merely has firstmate's source open would match it**.
Someone fixing firstmate is not the first mate.

`$FM_HOME/state/.lock` settles it. It holds one pid - the harness process holding that home's
session lock, resolved by `fm_harness_ancestry_pid` in `bin/fm-session-lock-lib.sh`:

```
$ cat ~/work/firstmate/state/.lock
49672
$ ps -o pid=,args= -p 49672
49672 claude --permission-mode acceptEdits fire up firstmate
```

and Raise already records exactly that number:

```
cwd=/Users/mattw/work/firstmate  host.pid=49672  tmux_pane=%0
```

So the captain is: the session's own cwd contains `state/.lock`, **and** that file holds this
session's `host.pid`. The path is not hardcoded - it comes from the session. And the lock is
precisely what separates *running* firstmate from *working on* it, because an editing session's
pid is not in it.

---

## The rule

| | Evidence |
| --- | --- |
| crew | the pane's window name starts `fm-` |
| captain | `<session cwd>/state/.lock` exists and holds this session's `host.pid` |
| anything else | no chip |

**One chip for both.** A secondmate goes through the same `fm-spawn.sh` path and gets an
`fm-<id>` window, so it reads as crew - decided deliberately rather than by accident. Telling
secondmates apart would mean reading `state/<id>.meta`, a much larger commitment to firstmate's
private layout than a window name and a pid file, for a distinction nobody has wanted.

**Titles do not change.** A crewmate already gets a readable pseudo-title
(`sls-89-pin-deploy-tool-install`) and a manual `/rename` already reaches the card, so it is
already consistent with every other session. This ticket adds a chip and touches nothing else.

---

## Where it goes

Follow the existing chip rules in AGENTS.md's *UI Rules* rather than inventing a style. The
agent chip is the closest precedent: outlined, `--faint`, quieter than the host chip beside it,
because provenance must not compete with where your window actually is. `AGENT_LABELS` has no
entry for Claude Code for the same reason a chip on every card is noise - so a session belonging
to nobody in particular gets nothing, which is most of them.

## Cost, and what is not free

The `fm-` name needs a `list-panes -a` read. RAI-18 introduced exactly that query, but on the
**focus click** path, not the poll loop that builds cards - so this does add something to the
poll path. The saving grace is that the name is pinned, so it is fixed for the life of the
window: resolve once when a session is first seen and cache, the way `git-branch.js` caches on
mtime and `lavish.js` fires at most once per refresh. A per-session lookup, not a per-second one.

The lock is one small file read, cached the same way.

## Deliberately not built

- **Any distinction between crew, scout and secondmate.** See above.
- **A chip on non-tmux backends.** firstmate also supports herdr, cmux, zellij and orca, where
  no `fm-<id>` window exists. Those get no chip. Guessing from a treehouse worktree path would
  chip handoff workers as crew, which is the exact false positive this spec exists to avoid.
- **Anything that runs when firstmate is absent.** Same rule as no-mistakes and Lavish: absence
  is a supported setup, not a degraded one. No lock and no `fm-` window means no chip, no
  banner, and no subprocess looking for one.

---

## Implementation notes

`src/firstmate.js` holds both markers and nothing else does. `FirstmateWatch.spawnedBy(session)`
returns `'firstmate'` or null, from the two positive markers above and no third source.

**Crew** comes from a tmux pane table - `list-panes -a -F '#{pane_id}\t#{window_name}'` - keyed
by the socket path out of `$TMUX`, through the `socketPath` that `-S` is built from, because a
pane id is only unique within a server and `$TMUX`'s last field is the *session* index rather
than anything about the server. A pane is resolved when it is first seen and then cached, so in
a steady state the query does not run at all; an unknown pane
can trigger at most one read per `REFRESH_MS`. The read is fired and never awaited, the way
`lavish.js` does its lookup, so the poll loop cannot stall on tmux - the chip appears on the next
tick. An empty or failed reading keeps the previous answer, because a reading we did not get is
not evidence, and dropping the chip off every card for one tick is exactly the flicker the
never-null rule on the pipeline marker exists to avoid.

**The captain** comes from `<cwd>/state/.lock` - the path built from the session's own cwd, never
hardcoded - cached on the lock's own mtime like `git-branch.js` caches HEAD. The *stat* is
deliberately not cached: the lock records the harness pid and so is written after the session
exists, and caching its absence would mean the captain never got a chip at all. A lock rewritten
by a restarted first mate is picked up on the next tick, so the old card stops claiming it.

`Row.spawnedBy` carries it to both renderers. The page has `SPAWNER_LABELS = { firstmate:
'firstmate' }` with no fallback, rendering the outlined `--faint` chip before the agent chip;
`raise status` prints the same word dimmed after the session name. Nothing else on the card moved
- no title, no ordering, no colour.

Tests are `test/firstmate.test.js` (both markers, both near-misses, the caching and rate-limiting
claims, two tmux servers not sharing a pane id and two sessions on one server sharing a single
table and a single read), three in `test/dashboard.test.js` for the
row field, and two in `test/server.test.js`: one end to end across a crewmate, the captain, a
`handoff-` window and a session with firstmate's source open, and one extending the existing
absence guard so `tmux` joins `no-mistakes` and `lavish-axi` as a command that must not run for a
session with no pane. 633 tests, lint and typecheck green.

Verified against the live installation this was written on: `%360 fm-rai-19-firstmate-chip` chips,
`%330 handoff-sls-75-4d7a` does not, and the captain's `First Mate` window - whose `allow-rename`
really is on - is identified by its lock rather than its name.
