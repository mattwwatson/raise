---
ticket: RAI-20
status: in-progress
size: S
depends: -
branch: RAI-20-dismiss-idle-nudge
---
# RAI-20 - Dismiss a "Waiting for you" that is really just an idle session

**Self-contained brief.** No prior conversation needed. Written 07/08/2026.

---

## The symptom

A session finishes a turn, nobody types, and a minute later the card turns red and says
**Waiting for you**. Nothing is gated. It stays that way until you go and touch the session.

Caught live, two at once:

```
work/firstmate     state=blocked  for=5s     type=idle_prompt  "Claude is waiting for your input"
1/sls-scheduling   state=blocked  for=749s   type=idle_prompt  "Claude is waiting for your input"
```

Both are `idle_prompt` - Claude Code's **idle nudge**, fired after sixty seconds of quiet - and
not a permission prompt. The second had been red for over twelve minutes.

---

## Why this is not a bug, and why it will not fix itself

Both halves are already documented in AGENTS.md and both are deliberate.

**The escalation is wanted.** *"A quiet `Stop` becoming a loud 'waiting for you' a minute later
is how a finished session asks for its next instruction."* Removing it would lose the signal
this tool exists to give.

**It cannot clear itself.** `blockDisproved` retires a stale block when the transcript runs past
it - a session writing records is self-evidently not waiting for a human. An idle session writes
nothing. So the one mechanism that clears a block has no evidence to work with, by construction,
in exactly the case where the block is least meaningful.

The existing disproof for this signal is narrower still: a live pipeline disproves the nudge,
and *only* the nudge, because `axi respond` running in the background is positive evidence of
work. There is no equivalent for a session that is genuinely doing nothing.

**But there is one more source of evidence, and it is the best one available: you.** The page
claims a human is needed. You are that human. If you have looked and nothing is needed, that is
a stronger reading than the sixty-second timer's - so let it be recorded.

---

## The rule

A dismissal answers **one announcement**, not a session.

- Store the session's `blockAnnouncedAt` at the moment of dismissal.
- While the stored value equals the session's current `blockAnnouncedAt`, the row renders
  `idle`.
- The moment they differ, the dismissal is spent and the row is red again.

`blockAnnouncedAt` is the right key and already exists: AGENTS.md records that it *"moves on
every event that says blocked"*, which is exactly the property needed. It is deliberately not
`stateSince`, which does **not** move while the state is unchanged - keying on that would make a
dismissal permanent.

The consequence to state plainly: a real permission prompt arriving on a dismissed session
announces a new block, so the row comes back red immediately. A dismissal can never hide
something that matters.

**Only an idle nudge is dismissible.** `isIdleNudge` already tells them apart from
`notification_type`, and it fails closed - anything unrecognised stays a hard block. A session
stopped at a permission prompt genuinely cannot proceed without you, so no control is offered on
one. This follows the affordance rule: never render a control that might not work, and never one
whose working is the wrong outcome.

---

## Two constraints that are the whole design

**Server-side, not browser storage.** `nmmon status` and the page are one protocol; a dismissal
only the browser knows about would have the CLI and the page disagreeing about the same session.
It belongs with the session record, alongside the other state the registry holds.

**The dismissal must be visible on the row.** This is the load-bearing one. The failure mode
this product cares about most is quiet staleness - *"a confident green dot over state that
stopped updating is worse than one that is visibly down, because you stop checking."* A signal
you silently hid is the same failure wearing different clothes. The row must say it was
dismissed, so *nothing is waiting* and *I told it to stop saying so* are never confusable.

---

## Acceptance

- An `idle_prompt` row can be dismissed and drops to `idle`, out of the waiting-for-you group.
- A new block announcement on that session - a permission prompt above all - re-reds it without
  any further action.
- A permission-prompt row offers no dismiss control at all.
- `nmmon status` and the page agree about a dismissed session.
- A dismissed row visibly says so.
- The dismissal survives a page reload, and does not survive a genuinely new block.

## Deliberately not built

- **Dismissing a permission prompt.** See above. Narrowing later is hard; widening is easy.
- **A timeout that clears a nudge on its own.** That would be inventing evidence. The whole
  point is that a human looked; nothing else knows.
- **Any change to the sixty-second escalation itself.** It is right, and it is Claude Code's
  behaviour rather than ours.
- **Automatic disproof for a session that is idle by design** - a first mate supervising a crew,
  say. It was considered alongside this and dropped: one mechanism that works for every session,
  including handoff workers, beats a second one coupled to another tool's behaviour. See
  [[RAI-19]] for the identification that would have made it possible if it is ever wanted.
