---
ticket: RAI-12
status: backlog
size: M
depends: -
---
# RAI-12 - A pinned dashboard never picks up UI changes

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
