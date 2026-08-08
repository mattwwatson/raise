---
ticket: RAI-2
status: shipped
shipped: 2026-08-06
size: S
depends: -
branch: RAI-2-correct-doc-framing
---
# RAI-2 - Correct what the documentation says this tool is

**Most of this ticket was completed by the work merged as PR #13** (`5cd4fbc`, *"make a
session the unit and no-mistakes an attribute of one"*), which rewrote both documents while
this ticket sat in the backlog. What follows is an audit of 06/08/2026 against the merged
state, not the original scope.

**It is now a small ticket.** Four items, three of them one line each. Do not re-do the parts
that are already right.

## Why this ticket exists at all

`AGENTS.md` and `README.md` are agent context. Every Claude Code or pi session that opens this
repository reads them before doing anything, so stale framing produces wrong work
continuously - it was observed doing exactly that, with sessions drawing no-mistakes-centric
assumptions that stopped being true when no-mistakes became optional.

That is also why this lands **before** the rename ([RAI-3]): renaming prose you have just been
told is wrong, while relying on it to understand the repository, is how a rename turns into a
rewrite.

## Already done - verify, do not repeat

- `README.md` opens on *"every agent session on your machine - Claude Code, Claude Desktop and
  pi"*, with no-mistakes in a subordinate clause. Correct.
- `README.md` **Requirements** no longer demands no-mistakes. It lists Node, an agent, and
  macOS-for-focusing, then has an explicit *"Optional, and independently so"* table. Correct,
  and better than what this ticket originally asked for.
- `AGENTS.md` **Project Overview** describes agent sessions across three hosts and carries a
  new *"the session is the unit, and everything else is an attribute of one"* section that
  states the repositioning outright. Correct.
- Test counts are **462** in all three places and match `npm test`. Correct.

## What is left

### 1. "one developer's machine"

`AGENTS.md:11` still opens:

> `raise` is a single-page monitor for **one developer's machine**.

The sentence following it is now accurate; this clause is not. It predates the decision to
publish and reads to a contributor as *this is not for you*.

Reframe rather than delete - the useful half of the claim is that it monitors **one machine**,
which is a real architectural boundary (no auth, no remote access, no multi-user). Say that,
without saying it is for one person.

### 2. The speculative-features constraint reads as "contributions unwelcome"

`AGENTS.md:44`:

> Personal tool, macOS-only for focusing (monitoring itself is portable). Do not add
> cross-platform focus adapters, auth, multi-user support or remote access speculatively.

**Keep the substance; it is right.** No auth, no multi-user, no remote access are genuine
scope boundaries and should stay firm.

What needs separating is the focus-adapter clause, which is doing two different jobs. The
intent was *do not build for platforms nobody has asked for*. As written, with "personal tool"
in front of it, it reads as *do not contribute a terminal*. Those are opposite messages, and
the second one is wrong: `src/focus/terminals.js` is deliberately shaped to accept exactly
that contribution - one availability check, one focus function, nothing else moves.

See [RAI-8], which decides the contribution posture and writes the bar into `CONTRIBUTING.md`.
This ticket only needs to stop the constraint contradicting it. **If RAI-8 has not been
decided yet, soften rather than promise** - remove the "contributions unwelcome" reading
without committing to terms that RAI-8 has not set.

### 3. The Architecture table still leads with no-mistakes

`AGENTS.md`, *Four sources of truth*, lists the no-mistakes SQLite database first and the
agent hooks second. Reading order is an editorial claim about what matters.

The hooks answer *is the agent blocked waiting for a human?* - the one question this tool
exists for, and the only source that works on a machine with no no-mistakes at all. It goes
first. The database is now an optional source and belongs below the transcript.

Nothing about the table's content is wrong. This is ordering only.

### 4. Sweep for anything the audit missed

The four items above came from a targeted audit, not a full read. Before closing, read both
documents through once looking for the same class of error: a sentence that was true when
no-mistakes was the subject and is not now.

Two known-good areas to leave alone:

- **"Design decisions worth knowing" is accurate and is the most valuable content in the
  repository.** It is also the section most at risk from a broad "modernise the framing" pass.
  Do not touch it.
- The **Roadmap and task tracking** section is new and correct.

## Explicitly out of scope

These belong to later tickets and must not be pulled forward:

- The related-tools section - [RAI-7]
- Install-for-strangers polish, moving the security section up, the support matrix - [RAI-6]
- Anything mentioning the new name - [RAI-3]
- `CONTRIBUTING.md` itself - [RAI-8]

## Definition of done

```sh
npm test
npm run typecheck
npm run lint
```

No code changes, so all three should be untouched by this work - if any of them moves,
something has gone wrong.

Read both documents end to end afterwards and confirm no sentence still frames this as a
no-mistakes tool or as a private one.

## Implementation notes

Four edits, no code. **Item 4's audit was already stale on one point** - the test counts it
records as `462` read `596` everywhere by the time this was picked up, and match `npm test`, so
nothing was needed there. The other three landed as written.

**Item 1 kept the architectural half and dropped the audience.** `AGENTS.md:11` now reads *"a
single-page monitor for the machine it runs on"*. That says the same true thing about scope - one
machine, nothing remote - without a clause a contributor reads as *not for you*, and it needed no
sentence of its own because line 12 onwards already says what it monitors.

**Item 2 split the constraint in two, because it was doing two jobs.** The scope boundaries -
no auth, no multi-user, no remote access - keep their own paragraph and are stated more firmly
than before: each of them turns a local page into a service. Focusing gets a second paragraph
saying that macOS-only is *where it has been run, not a position the design takes*, pointing at
the existing one-entry terminal rule under **Architecture** rather than restating it, and
refusing only the adapter for a platform nobody is on - because that one cannot be exercised
against a real session.

That is deliberately a softening and not a promise. [RAI-8] was still `To Do` when this shipped,
and it is what decides the contribution posture and writes the bar down; this ticket only had to
stop the paragraph contradicting whatever RAI-8 settles on. So the words *contribute* and
*contribution* do not appear, and neither does a link to a ticket that has not been decided.

**Item 3 reordered the sources table and said why in the document.** Hooks, transcript, process
table, database - the database last, being the only optional one. An unexplained reorder is one a
later pass reverts on aesthetic grounds, so the ordering is now claimed out loud as editorial,
with the reason (the hooks are the only source that works on a machine with nothing else
installed) and a "do not reorder them back".

**The sweep found one thing, in `README.md`.** Under *What it watches*, a paragraph derived a
general property of Raise from an optional dependency: *"`no-mistakes` keeps a single daemon and
a single SQLite database for the whole machine, so Raise reads every repo's state from one place.
You do not register repos with it and there is nothing to configure per project."* The
zero-configuration claim is true and does not come from no-mistakes - sessions report themselves
through the agent's hooks - so it now leads on that, and the no-mistakes fact is the subordinate
clause about the pipeline half. That is exactly the class item 4 describes: a sentence that was
correct while no-mistakes was the subject.

Nothing else surfaced. **Design decisions worth knowing** was read and not touched, per the
ticket.

[RAI-3]: https://mattwwatson.atlassian.net/browse/RAI-3
[RAI-6]: https://mattwwatson.atlassian.net/browse/RAI-6
[RAI-7]: https://mattwwatson.atlassian.net/browse/RAI-7
[RAI-8]: https://mattwwatson.atlassian.net/browse/RAI-8
