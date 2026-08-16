---
issue: 1
status: shipped
size: M
depends: -
branch: fm/1-stale-page-code
shipped: 2026-08-17
---
# 1 - A pinned dashboard never picks up UI changes

**The immediate symptom has a one-key fix. The underlying gap is a real design problem** and is
the reason this is a ticket rather than a note.

## The reported symptom

Session names were merged in PR #11 (`44621a5`, *"show the name you gave a session on its
card"*). Three sessions had names. **No name appeared on any card.**

## It was not a bug in the feature

Established by measurement, in this order - repeat any of it if you doubt the conclusion:

1. **The `custom-title` record is present and correctly shaped.** Pulled from a live transcript:
   ```json
   {"type": "custom-title", "customTitle": "Open source Planning and Roadmap", "sessionId": "..."}
   ```
   Exactly what `lastOf(records, 'custom-title', 'customTitle')` in `src/transcript.js` expects.
2. **It is inside the tail window.** Nine occurrences in the last 128KB (`TAIL_BYTES`) of a
   1.45MB transcript. The re-appending behaviour that `src/transcript.js` documents and depends
   on is still happening, so the documented failure mode there has *not* occurred.
3. **The server emits it.** `GET /state` returned `sessionName` populated on three of four rows.
4. **The server serves the new page.** The HTML returned by `GET /` contains the `sessionName`
   rendering code.
5. **`cache-control: no-store` is set** in `servePage`, so a browser cache is not involved.

**The whole pipeline works.** The fault is entirely in the long-lived browser tab.

## What actually happened

The dashboard is a page you leave **pinned** - that is the stated product shape. It loads its
HTML and JavaScript once, when the tab is opened, and then lives for days.

When the server restarts with new code, `public/connection.js` transparently reopens the event
stream. Data keeps flowing, rows keep updating, the liveness dot stays green - and **the tab
carries on rendering with the JavaScript it loaded before the change**. New fields arrive in the
state frame and are silently ignored by old rendering code.

Nothing is broken, nothing errors, and nothing indicates the page is out of date.

**Immediate workaround: reload the tab.** The data is already there.

## Why this deserves a fix rather than a README note

The product's premise is *a page you leave pinned and glance at*. The failure follows directly
from using it exactly as intended, and it applies to **every future UI change**. The better the
reconnect logic works, the longer a tab survives, and the more stale its code becomes.

There is also an uncomfortable symmetry. `AGENTS.md` is emphatic that the page must never assert
something it can no longer stand behind:

> The liveness dot is positive evidence (a `ping` within `STALE_AFTER_MS`), never the absence of
> an error. When stale, dim the page - it is a snapshot of the past.

That rule is applied rigorously to **data** and not at all to **code**. A page rendering with
superseded logic is showing a snapshot of the past in precisely the sense that rule exists to
prevent - and, as here, doing it under a confident green dot.

## Direction, not a prescription

The existing liveness mechanism is the model: the page already knows how to notice it is out of
date and say so honestly. This is the same idea applied to code rather than data.

Roughly: the server states which build it is serving, the page remembers what it loaded with, and
a mismatch surfaces a small, honest, non-blocking affordance.

Decisions for whoever picks this up - **bring these back rather than choosing alone**:

1. **What identifies a build?** It must change when `public/` changes and must not require a
   build step - there is no bundler and `index.html` must still open as a file. Options include
   an mtime, a content hash computed at startup, or the package version. A content hash is the
   most honest and the most work; the package version is cheapest and wrong exactly when someone
   edits the page without bumping it, which is most of the time.
2. **Where does it ride?** The `ping` event and the state frame are both candidates. Changing
   either is a protocol change: *"Do not change the SSE frame shape, event names or `/api`
   responses without updating `public/` in the same change - they are one protocol."*
3. **Never reload automatically.** An auto-reloading dashboard would discard whatever the user
   has expanded, at an arbitrary moment, on a page they are watching precisely because something
   needs them. Offer, do not act.
4. **Where does it appear?** It must not compete with `blocked` red. This is a housekeeping
   notice, not an attention signal, and the colour ordering in `AGENTS.md` is deliberate.
5. **Is it worth it at all?** A defensible answer is no - document the reload and move on. Say so
   if that is your conclusion, but weigh it against this being invisible to the user by
   construction: they cannot tell it is happening, so they cannot know to reload.

## What the investigation measured

Taken on 17/08/2026 against this checkout, before any of the five decisions below were
settled. Each one is repeatable; the method is named so it can be repeated rather than
believed.

**The package version has never moved.** `git log` over `package.json` across all 238 commits
returns exactly one distinct version, `0.1.0`, set in the very first commit. 24 commits have
touched `public/` since, PR #11 among them. **A version-derived build identity would have
detected none of them** - not "would often miss", but a measured zero for zero.

**Only about one restart in ten is a page change.** 24 of 236 commits since that first one
touched `public/`; the rest changed `src/`, tests or docs and still mean a restart. So an
identity derived from the *server* having restarted - `server.json`'s `startedAt`, the
cheapest option of all and already written to disk - would have been wrong on roughly 90% of
the occasions it fired. It is cheaper than mtime and worse than it on the only axis that
matters.

**`servePage` re-reads `index.html` on every request, so the served build changes with no
restart.** Measured directly: a server was started, `GET /` returned `<title>Raise</title>`,
`public/index.html` was edited in place with the process still running, and the very next
`GET /` returned the edited title. `serveModule` reads `connection.js` the same way. This is
the fact that rules on option 1: an identity *captured at startup* - the spec's own suggestion
- is not an identity of what is being served. It reports the boot-time build while the server
hands out a newer one, so two tabs opened either side of an edit run different code and both
claim the same build. That is a false negative, in the same quiet-staleness direction as the
bug this ticket is about.

**Hashing is not the expensive option.** Reading and `sha256`-ing both files in `public/`
(67,206 bytes) costs **0.052ms**, mean over 1000 iterations; `stat`-ing both costs **0.0024ms**.
A stamp recomputed only when an mtime moves - the cache `src/transcript-reader.js` already
implements for transcripts - therefore costs two `stat` calls per poll in the steady state and
one 0.05ms hash on the ticks where the page actually changed. The spec's "most honest and the
most work" trade-off does not survive the measurement.

**The state frame is delivered immediately on stream open; the ping is not.** Two SSE clients
were attached to one server and every frame timestamped. Client A connected at 28ms and got
its `state` frame at 28ms; client B connected at 8031ms and got its `state` frame at 8031ms.
**Both got their first `ping` at 20002ms** - the keepalive is one server-wide `setInterval`
started in `start()`, not a per-client timer, so a client's wait for its first ping is anywhere
from 0 to `KEEPALIVE_MS`. A restart is exactly a reconnect, and `openStream` pushes a `state`
frame unconditionally as its second write.

**A constant field in the state payload causes no extra broadcasts, and a changed one causes
exactly one.** `broadcast(false)` compares `stableJson(payload)`, so a build stamp that does
not move is invisible to the change gate, and a stamp that moves pushes a frame by itself.
Verified against `stableJson` directly. The mechanism that announces the change is therefore
the one already there.

## The five decisions, as ruled

**The captain decided all five, and all five went the way the investigation recommended.** They
were put to him with the evidence and the competing reading on each; his answer was to go with
the recommendations. He is the decider of record on every one of them - not the agent that
proposed them and not firstmate, which relayed them. The reasoning below is kept as it was put
to him, because the competing reading is the part a future session needs in order to know what
was weighed rather than merely what was chosen.



Recorded here with the competing reading on each, because the answer to each is a rule rather
than a preference and the rule is what a future session needs.

### 1. What identifies a build

**The rule underneath: an identity must be a property of the thing at the moment it is
asserted, not of a proxy for it.** The package version is a declaration of intent, `startedAt`
is the process's lifetime, and a hash taken at startup is a snapshot of a file the server goes
on re-reading. All three are correlates. The bytes being served are the thing itself. This is
the same rule as *the branch comes from `.git/HEAD`, and from nowhere else*.

The competing reading is that this is a single-user local monitor, where a proxy that is right
most of the time costs one unnecessary reload when it is wrong - which favours a bare mtime,
about eight lines shorter. It survives the false-negative test (a write always moves an mtime)
and fails only by over-reporting when a file is rewritten with identical content, as
`git checkout` and `npm install` both do.

**Recommendation: a content hash of the two files the server actually serves, recomputed only
when an mtime moves** - the cache `src/transcript-reader.js` already implements, for the same
reason. The measurements above delete both arguments against it: hashing costs 0.05ms and only
on the ticks where the page changed, and the startup variant the spec proposed is measurably
not an identity of what is served.

### 2. Where the identity rides

**The rule underneath: carry the fact on the channel whose delivery is guaranteed at the moment
the fact becomes true.** The stamp changes on exactly two occasions, and the state frame covers
both without anything new: a restart is a reconnect, and `openStream` pushes a `state` frame
unconditionally; an edit under a running server changes the payload, and the change gate turns
that into a broadcast by itself.

The competing reading is that the ping is the page's liveness channel and this is liveness of
code, so it belongs there. That is a grouping argument, and it costs a wait of 0 to
`KEEPALIVE_MS` (measured: a client attached at 8.0s waited until 20.0s) plus a change to the
ping's *shape*, from a bare number to JSON, where the state payload is already an object with
many fields.

**Recommendation: the state frame.**

### 3. Never reload automatically

**Already ruled, restated so it is on the record and not re-opened.** Offer, do not act. The
notice is a control the user presses; nothing reloads on a timer, on a mismatch, or on a
reconnect. A dashboard that reloads itself discards whatever is expanded, at an arbitrary
moment, on a page being watched precisely because something needs a human.

### 4. Where the notice appears

**The rule underneath: a message about the page belongs where the page's other self-descriptions
are, and a message about the work belongs among the cards.** The header already carries the
liveness dot and the alerts button - both facts about the page's relationship with the server,
neither about any session. The `#notice` slot inside `<main>` carries `payload.warning`, which
is about the *data* being degraded. This notice is about the page's own code, so it is the
header's kind of fact.

The competing reading is to reuse `#notice` with a quiet variant, keeping every page-level
message in one slot. It costs a `.notice` variant and puts a housekeeping line above the cards,
taking vertical space at the top of a page whose ordering is the product.

**Recommendation: the header, left of the connection indicator, as a `<button>` in the existing
quiet header-button style.** That style is already `--muted` on `--panel` with a `--border`
edge, so this introduces **no new colour custom property at all** - which is the cleanest
possible way to satisfy "must not compete with `blocked` red", since it never enters the
attention palette to begin with, and it leaves the *"add a variable to both blocks or neither"*
rule with nothing to arbitrate.

### 5. Whether to build it

**The rule underneath is the one the ticket already names: a failure the user cannot detect is
one the tool has to detect for them.** That is the liveness dot's own rule, applied to code
instead of data.

The competing reading is that this is a single-user tool whose user is also its developer, so a
README line saying "reload after upgrading" is proportionate. Against it: a README line is read
once, and the condition arises silently months later - PR #11 shipped a feature that looked
broken, and it took the five measurements recorded at the top of this file to establish that
nothing was.

**Recommendation: build it.** 24 of the last 236 commits touched `public/`, so this recurs on
roughly one commit in ten, and it is invisible every time.

## Secondary finding, unrelated but noticed

Two `raise serve` processes were running:

| pid | started | cwd | port |
| --- | --- | --- | --- |
| 33592 | 09:56 | `/Users/mattw/work/no-mistakes-monitor` | **7717 (live)** |
| 8290 | 08:47 | `~/.no-mistakes/worktrees/bafbee75ff42/01KZ9YENQCQZNWYPQAW4FZ0YVD` | none |

The second is a stray started inside a **no-mistakes pipeline worktree** - presumably by a test
or an agent during a run - and it was still alive holding no port. This is the case `README.md`
already documents (*"a leftover started under a different `RAISE_HOME`"*), so the diagnosis
works, but it is worth asking why a pipeline run leaves a server behind at all. A monitor that
accumulates orphan copies of itself on a machine it is meant to be watching is its own small
problem. **Investigate separately; do not fold it into this fix.**

## Constraints (from AGENTS.md, non-negotiable)

- `public/index.html` stays **self-contained** - inline CSS, one module import of
  `connection.js`, no build step, opens as a file.
- `public/connection.js` is **pure, no DOM, injected clock**, and directly unit tested. Keep it
  that way.
- Colour comes from the `:root` custom properties, with a `prefers-color-scheme: dark` block.
  **Add a variable to both blocks or neither.**
- Zero runtime dependencies.
- Protocol coherence: server and `public/` change together.

## Definition of done

```sh
npm test
npm run typecheck
npm run lint
```

If the answer is "document the reload and do nothing", that is a complete outcome - write the
reasoning into the spec and mark it `wont-do`.

## Implementation notes

Four pieces, and the seam between them is the protocol: the server states which build it is
serving, the page remembers which build it loaded with, and a pure rule decides whether they
still agree.

**`src/build-stamp.js`** computes the identity: a SHA-256 over the two files `servePage` and
`serveModule` actually read, truncated to twelve hex characters, recomputed only when a `stat`
shows a size or mtime has moved. That is the cache `src/transcript-reader.js` already
implements, chosen for the same reason - a stat is a syscall and hashing is not. Each file's
name and length go into the hash with its bytes, so moving a character across the boundary
between the two, or swapping their contents, cannot hash to the build it replaced. A file it
cannot read yields `null` rather than a hash of what survived, because a stamp derived from a
failed read would differ from the one every open tab holds and would tell all of them at once
that they were stale.

**`src/server.js`** carries it both ways. `snapshot()` puts it on the state frame; `servePage`
substitutes it into the HTML beside `__RAISE_TOKEN__`. Baking it into the served bytes is what
makes the page's half first-hand: a tab that merely remembered the first stamp it was *sent*
could take its HTML from one build and its first frame from the next, and would then agree with
the server forever while running superseded code. An unreadable build substitutes the empty
string rather than leaving the placeholder, because a literal `__RAISE_BUILD__` compares unequal
to every real stamp and would put the notice on every current page.

**`public/connection.js`** gains `createBuildWatch`, pure and DOM-free like everything else
there, and holds the one rule worth protecting: **a frame that states no build says nothing and
never clears a mismatch already known.** An older server - one predating the field - sends
frames with nothing in them, and silence must not read as disagreement. It is deliberately not
sticky beyond that: a server that returns to the build a tab holds genuinely agrees with it
again, so the notice goes away rather than persisting as a claim nobody can act on.

**`public/index.html`** renders it as a hidden `<button>` in the header, between the alerts
button and the connection indicator, in the existing quiet header-button style. That style is
already `--muted` on `--panel` with a `--border` edge, so **this change adds no colour custom
property at all** - which is why the "add a variable to both blocks or neither" rule had nothing
to arbitrate here, and why the notice cannot compete with `blocked` red: it never enters the
attention palette. Pressing it reloads; nothing else does.

### What the tests pin, and where

The reproduction lives in `test/server.test.js` as *"a tab can tell the page it loaded is no
longer the page being served"*, and it is written against the seam rather than the symptom:
the stamp is injected, the served build is moved underneath a page already fetched, and the two
are asserted to diverge. Injected rather than real, because the alternative is a test that
edits the product's own `public/index.html` on the developer's disk.

`test/build-stamp.test.js` covers the identity itself against a fake filesystem, including the
two cases that are cheap to get subtly wrong in opposite directions - a file rewritten with
identical bytes is the *same* build, and a file that cannot be read is *no* build. It also
carries the drift guard: it reads `src/server.js`, extracts every `join(PUBLIC_DIR, '…')` it
serves, and fails if one is missing from `SERVED_FILES`. A third served file left out of that
list would be a change no tab could notice, which is this ticket's own bug reintroduced through
the blind spot of its fix - so it is made detectable rather than merely documented, the same
bargain `test/docs-claims.test.js` strikes with `CONTRIBUTING.md`.

`test/connection.test.js` covers the page-side rule directly, silence and unknown-either-side
included.

### Exercised in a real browser

Not only in the suite. A scratch server was started on a spare port with `RAISE_HOME`, `NM_HOME`
and the three agent homes pointed at a temporary directory, the page opened and left sitting,
and `public/index.html` then edited underneath it. The pinned tab picked up the changed stamp on
the next poll and grew the notice without being reloaded, while the connection indicator
correctly stayed **live** - the data was never in doubt, only the code. Pressing the button
cleared it. Checked in light and dark, where the button inherits both palettes with no new
variable.

### Deliberately not done

The stamp covers what is served, not everything in `public/`. A file nobody is sent is not part
of the code a tab is running, and stamping it would offer a reload that changes nothing on
screen; the drift guard above is what keeps the two lists equal instead.

The secondary finding above - the stray `raise serve` inside a pipeline worktree - stays out of
this change, as the spec directed. Nothing learned while working on this bears on it.
