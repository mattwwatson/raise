---
issue: 5
status: shipped
shipped: 2026-08-13
size: S
depends: -
branch: fm/5-doctor-node-guard
---
# 5 - `raise doctor` cannot report a wrong Node version on the versions where it matters

`raise doctor` checks the Node version, and on the versions where that check matters the
process is already dead. `bin/raise.js` statically imports `src/nm-state.js`, which statically
imports `node:sqlite`; that module existed from 22.5 but stayed behind `--experimental-sqlite`
until 22.13.0, and nothing here passes flags. So on **22.5 through 22.12** a user runs
`raise doctor` and gets a stack trace naming a builtin they have never heard of, and the one
message that would explain their setup is the one message that cannot print.

**The check itself is correct.** The floor of 22.13 and its reasoning were settled in `124ce64`
and nothing here revisits them. This is about the line being unreachable.

## The failure is at link time, not evaluation time, and that decides the fix

The tempting fix - move the guard to the top of `bin/raise.js` - does not work, and it is worth
recording *why*, because the reason is one step further along than the usual "ES modules hoist".

Hoisting alone would already defeat a guard written as the first statement: every static import
is fully evaluated before any of the importing module's own body runs. But the failure here is
earlier still. An unresolvable `node:` specifier throws while the graph is being **linked**, so
even a guard written as a side-effecting *first import* - a module whose body prints and exits,
imported above everything else - never runs either. Measured, not reasoned about:

```
$ cat main.mjs
import './guard.mjs';   # prints GUARD RAN, then process.exit(3)
import './bad.mjs';     # imports node:definitely-not-a-builtin
$ node main.mjs
Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:definitely-not-a-builtin
    at ModuleJob.syncLink (node:internal/modules/esm/module_job:163:33)
exit=1
```

`GUARD RAN` does not appear, and the stack names `syncLink`.

**The absolute this establishes is narrow, and it is worth stating exactly, because a slightly
wider version of it is false.** What is ruled out is *guarding in front of the import*: no
arrangement of static imports can do that, so any fix keeping the guard and the failing import in
one statically-linked graph cannot work, whatever order they are written in. What is **not** ruled
out is removing the failing import from that graph, and both directions the issue lists do exactly
that - one by deferring the whole CLI behind `await import()`, the other by deferring
`node:sqlite` itself. **Both would avoid this throw.** The choice below is therefore about which
shape is better, not about which one is possible.

## The decision: a thin shim, not a dynamic `node:sqlite`

The issue offered two directions and asked for one to be chosen rather than assumed.

**Taken: (1) `bin/raise.js` becomes a thin shim.** It imports one dependency-free module,
`src/node-support.js`, checks `process.versions.node`, prints the message and exits 1 - and only
then `await import('../src/cli.js')`, which is the previous contents of `bin/raise.js` unchanged,
static imports and all.

**Rejected: (2) making the `node:sqlite` import dynamic inside `src/nm-state.js`.** It would
work - see above - so these are reasons to prefer the other one rather than reasons it could not
be done. In order of weight:

- **It puts the guard in the wrong place to be complete.** It fixes the one import that happens
  to fail today. The next version-gated builtin, or the next dependency that reaches one, brings
  the trap straight back - and brings it back invisibly, because the symptom is a stack trace
  from a module nobody was thinking about. The shim is one guard covering every future import in
  the whole graph.
- **It costs `nm-state.js` its synchronous surface.** `probe()`, `read()` and `close()` are
  synchronous and are called synchronously from `cmdDoctor` and from the server's 1s poll. A
  dynamic import makes construction or first read asynchronous, which ripples into `server.js`
  and every test that reads state.
- **It adds a fourth path to a module already keeping three straight.** `sqlite`, `cli` and
  `absent` are load-bearing and carefully distinguished; "the builtin would not load" is a
  fourth condition that is not about no-mistakes at all.

The cost of (1) is the one the issue flagged: `bin/raise.js` splits, and the CLI's 981 lines move
to `src/cli.js`. That is a move rather than a rewrite - the file is unchanged below its new
`export` - and `src/` is where the product already lives, so the entry point becomes what the
name suggests it is.

**The threshold moves out of `cmdDoctor` and into `src/node-support.js`, which both callers
read.** The shim and the doctor line were two copies of one number and one sentence the moment
the shim existed, and the whole issue is a wrong Node version being reported wrongly.

## Reproducing it on a modern Node

The repo's rule is reproduce-as-a-test-first, and here that means exercising the real entry
point in a way that does not depend on the developer's Node being an old one. A test that only
passes because the local Node is modern proves nothing, and neither does one that only runs on
22.9 - CI has no such runner and never will, since `engines` refuses the install.

`test/cli-node-version.test.js` spawns `bin/raise.js` under `test/fixtures/old-node.mjs`, which
makes a modern Node behave like 22.9 in the two ways that matter:

- `Object.defineProperty(process.versions, 'node', { value: '22.9.0' })`, so the guard sees an
  unsupported version.
- A `module.register` resolve hook that throws `ERR_UNKNOWN_BUILTIN_MODULE` for `node:sqlite`,
  which is what 22.5 through 22.12 do to that specifier.

**The harness proves itself before it proves anything else.** One test spawns
`test/fixtures/imports-sqlite.mjs` under the same harness and asserts it dies with
`ERR_UNKNOWN_BUILTIN_MODULE`. If a future Node stops routing builtin specifiers through resolve
hooks, that control turns red rather than the real assertion quietly passing for the wrong
reason - which is the failure mode a simulated reproduction most has to guard against.

The reproduction itself asserts what a user sees: the exit code is 1, stdout carries the
`Raise needs 22.13 or newer` sentence, and nothing anywhere in the output says
`ERR_UNKNOWN_BUILTIN_MODULE`. Before the fix all three fail; the third is the bug.

Two things the harness deliberately does **not** do:

- **It does not stub anything Raise owns.** The only injections are to the Node environment, so
  the entry point under test is the real one, reached the real way, running its real graph.
- **It does not assert on the stack trace's shape.** That is Node's, not ours.

Alongside it, `test/node-support.test.js` unit-tests the predicate directly - 22.4, 22.5, 22.12,
22.13, 23.4, 24, 26 - which is where the boundary is actually pinned. The spawned test proves
the guard is *reachable*; the unit test proves it is *right*.

## Deliberately not done

- **No change to the threshold or the message.** Both were settled by RAI-5 and re-checked here.
- **No guard in `hooks/raise-hook.js` or `hooks/raise-pi-extension.js`.** Neither imports
  `nm-state.js`, so neither has the fault, and both are governed by "never fail, never block" -
  a version check that exits non-zero inside somebody's live session is the opposite of that.
- **No `engines` change.** `package.json` already says `>=22.13.0`, and the whole point is that
  the people this reaches are the ones npm never got to refuse.

## Acceptance

- On a Node in the 22.5-22.12 gap, `raise doctor` prints the Node line and exits 1 rather than
  throwing.
- `bin/raise.js` reaches no module that statically imports `node:sqlite`.
- `npm test`, `npm run lint` and `npm run typecheck` pass.

## Implementation notes

Three files carry the change, and one of them is a move.

- **`src/node-support.js`** is new and imports nothing. `supportsNode`, `nodeVersionProblem`,
  `MIN_NODE_MAJOR`, `MIN_NODE_MINOR`. Its emptiest property is its most important one: an import
  here - a Node builtin included - puts the guard back behind a graph, silently, on the versions
  nobody will test. The header says so.
- **`bin/raise.js`** is now 61 lines: import the guard, refuse, or `await import('../src/cli.js')`
  and run `main`. The `main().catch` error handler stayed here rather than moving, because the
  entry point is the only thing still running when the CLI fails to load.
- **`src/cli.js`** is the old `bin/raise.js`, moved with `git mv` so the history follows it.
  `main` is exported instead of self-invoked, the relative imports lost a `../`, and `cmdDoctor`
  reads `nodeVersionProblem` instead of its own inline comparison. Nothing else changed.

An unexpected non-change: `HERE` resolves `hooks/raise-hook.js` and `package.json` as
`resolve(HERE, '..', …)`, and `bin/` and `src/` are both one level under the package root - so
the hook path `install-hooks` writes and the version `--version` prints are unaffected by the
move. Verified by hand rather than assumed, since a hook path pointing at nothing is silent.

**`cmdDoctor` keeps its Node line even though the guard makes the failing branch unreachable
from the entry point.** `doctor` reports on the whole setup, and a check whose result is never
printed is one the reader cannot see was made; it is also what still answers if the guard is
ever moved. The threshold and the sentence are read from `node-support.js` by both, so there is
one copy of the number.

### On the test

`node --test test/cli-node-version.test.js` fails on the parent commit with the real stack
trace, which is the reproduction doing its job:

```
AssertionError: the version guard has fallen back behind a static import of node:sqlite
  actual: "Error: No such built-in module: node:sqlite ... ERR_UNKNOWN_BUILTIN_MODULE"
```

The fourth test in that file is the other side of the control: `raise --version` on the Node
actually running the suite must exit 0. Without it, a guard that refused *every* version would
satisfy everything above it.

Thirteen tests were added, 799 to 812.

### Two findings from the pipeline review, both taken

Both were info-level and neither gated, but the first is a real defect in the one line this
change exists to deliver, so both were fixed rather than waved through.

**The guard set `process.exit(1)` immediately after `console.log`.** On macOS a piped stdout is
asynchronous, and `process.exit()` does not flush pending writes - it cuts them off at the pipe
buffer, measured at 64KB on this machine (`console.log('X'.repeat(200000))` delivers 65,536 bytes
under `process.exit()` and all 200,001 under `process.exitCode`). **This is shape, not a
reproduced drop**: the real message is around 120 bytes, fits the buffer, and would survive in
practice. It is still worth changing, because the sentence this file exists to print must not
depend on being small enough, and the failure would be silent - the exact outcome the whole issue
is about. The guard now sets `process.exitCode = 1` and lets the process end naturally.

`process.exit()` **stays** in the `main().catch` handler, and the asymmetry is deliberate: a
failed `serve` may hold the loop open with a listening server or a poll timer, so that path has
to end regardless, and losing the tail of a stack trace is a smaller cost than not exiting. The
comment beside each says which reasoning applies.

**The reproduction spawned the entry point with no arguments** while being named for `raise
doctor`, which is also what the acceptance criterion above says. The guard fires before argv is
parsed, so it was not a false pass - but a test exercising something adjacent to its own title is
one nobody can check. It now passes `doctor`, and a fifth test runs the guard through a real
shell pipeline, since `execFile` gives the child a pipe but `raise doctor | tee` is what a user
types.

One unrelated tidy-up came out of running it: `module.register` is deprecated from Node 26
(DEP0205) and printed a warning on every suite run. The harness now prefers `registerHooks` and
falls back to `register`, because `registerHooks` only arrived in 22.15 and `engines` floors us
at 22.13 - the floor does not get raised to suit a test fixture.
