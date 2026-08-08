---
ticket: RAI-11
status: in-progress
branch: RAI-11-question-vs-permission
size: S
depends: -
---
# RAI-11 - A question is reported as a permission prompt

**Self-contained brief.** No prior conversation needed. Written 06/08/2026.

**Investigate before changing anything.** One unanswered question decides whether this costs
three lines or requires widening a privacy boundary. Do not start coding until it is answered.

---

## The symptom

Observed on a row for `1/no-mistakes-monitor`, branch `fix/own-path-run-branch-match`:

> **Waiting for you** - Claude needs your permission

The session was not waiting for a permission grant. It was sitting at a **no-mistakes review
gate**, asking which of several findings to act on - a question with options, not a tool
approval.

**Note what is and is not wrong here.** The *state* is correct: the session genuinely is
blocked on a human, and the row belongs at the top of the page. Only the *reason* is wrong. That
makes this a smaller bug than a wrong state, but it is still the page making a confident,
specific, false claim - and the whole design rests on not doing that.

---

## What is already established

Read from the source, not assumed:

1. **The wording is not ours.** `src/dashboard.js:637` passes the message through verbatim:
   ```js
   message: state === 'blocked' ? session.message || null : null,
   ```
   Nothing in `public/index.html` or `src/` contains the string. It is Claude Code's own
   `Notification` text.

2. **`PermissionRequest` carries no message**, so it cannot be the source of the wording. It
   sets the state; the `Notification` arriving a few seconds later supplies the reason.

3. **The likely cause: `AskUserQuestion` rides Claude Code's permission system.** A question
   with options is delivered through the same machinery as a tool approval, so Claude Code
   describes it in permission language. If so, Claude Code is being literally accurate about its
   own internals and misleading about what the user actually faces.

4. **The payload is a strict allowlist** (`src/hook-payload.js`), currently:
   `session_id`, `hook_event_name`, `agent`, `cwd`, `transcript_path`, `message`,
   `notification_type`.

---

## Question 1 - answer this first, it decides everything

**What `notification_type` does Claude Code send for an `AskUserQuestion`?**

`notification_type` is *already* in the allowlist and already reaching the registry - it was
added recently to distinguish `permission_prompt` from `idle_prompt` (see `isIdleNudge` in
`src/dashboard.js`).

- **If `AskUserQuestion` produces a distinct value** (something like `question`), the fix is
  small and needs **no payload change at all**: map that value to different row text. Prefer
  this outcome; stop looking for anything cleverer.
- **If it reuses `permission_prompt`**, `notification_type` cannot tell the two apart, and see
  Question 2.

How to find out: capture a real event. `AskUserQuestion` can be triggered deliberately, and the
hook can be observed without guessing - do not infer this from documentation alone, since the
field is new enough that the docs may not enumerate every value.

---

### Answer - captured 08/08/2026 against Claude Code 2.1.226

**`AskUserQuestion` sends `notification_type: "permission_prompt"`, and its `Notification` is
byte-identical to a real tool approval's.** Question 1 comes back unhelpful, so Question 2 is
live.

Captured from a live interactive session in an isolated tmux server, with `Notification` and
`PermissionRequest` hooks writing raw stdin to a file. Both cases below are real events, not
inferences:

| Trigger | `PermissionRequest.tool_name` | `Notification.notification_type` | `Notification.message` |
| --- | --- | --- | --- |
| a question with options | `AskUserQuestion` | `permission_prompt` | `Claude needs your permission` |
| a genuine tool approval | `Bash` | `permission_prompt` | `Claude needs your permission` |

The `Notification` records differ in **no field at all**. `tool_name` on the earlier
`PermissionRequest` is the only thing anywhere in either payload that separates them.

Confirmed in the 2.1.226 binary, which explains why:

- **`notification_type` cannot grow a value for this.** The enumerated set is fixed at
  `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`,
  `elicitation_complete`, `elicitation_response`, `agent_needs_input`, `agent_completed`.
  There is no question type, and the interactive dialog host hardcodes the argument - one call
  site, `fzr(message, "permission_prompt")`, for **every** dialog kind it renders.
- **The wording is a shared constant, not a description of the tool.** One string,
  `"Claude needs your permission"`, is the notification message for a dozen distinct dialog
  kinds. Claude Code has a *separate* label map that calls some of those kinds `input needed`
  rather than a permission prompt - so it knows the difference internally and does not put it
  in the payload.
- **`agent_needs_input` is not this.** It belongs to background agents in the multi-agent view
  (`<label> needs your input: …`), and never fires for an in-session `AskUserQuestion`.

**What would disprove this:** a future Claude Code that either adds a question-shaped value to
that enum, or stops routing `AskUserQuestion` through the shared dialog host. Re-run the capture
against the installed binary before assuming this still holds.

**Also observed, and it is the allowlist's own argument made concrete:** the `PermissionRequest`
for a question carried the entire question text - every prompt, header, option label and option
description - in `tool_input`. `src/hook-payload.js` already refuses that field, and this is
what it is refusing.

### The transcript cannot stand in for the payload, and the reason is a flush

The obvious way to avoid widening the payload is to read the tool name off the transcript,
which Raise already tails and already has the path to. **It does not work, and the measurement
that kills it is worth keeping** - because the failure is invisible to any test written after
the fact.

**A pending tool's `tool_use` record is not on disk while the tool is pending.** Claude Code
writes it with the timestamp at which the model emitted it, but does not flush it until the
tool resolves - so during the block, which is the entire window Raise needs, the transcript
says nothing about the tool at all. Measured twice in one session:

| Tool | emitted (record timestamp) | still absent from the file at | appeared on disk |
| --- | --- | --- | --- |
| `Bash` (curl, real approval) | 08:36:19 | 08:36:49 (+30s) | after the human declined at 08:37:03 |
| `AskUserQuestion` | 08:37:11 | 08:37:57 (+46s) | after the human answered at 08:38:13 |

In both cases the dialog was confirmed open on screen, and the `PermissionRequest` and
`Notification` hooks had already fired, while the file held no trace of the tool. The record
then appeared within about six seconds of the human answering, carrying its original emission
timestamp.

**This is the trap that makes the avenue look viable.** Read the transcript *after* the fact -
which is what an investigation naturally does - and both tools are plainly there, in flight,
distinguishable, with timestamps that appear to span the block. The first pass here concluded
exactly that. The timestamps are emission times, not write times, so they cannot be used to
infer what was readable when.

Two consequences beyond this ticket, neither chased here:

- **`transcript.js`'s "the tool with no result yet" rule cannot see a tool awaiting approval.**
  It describes tools that are *running*, and a tool blocked on a dialog has not started.
- **`blockDisproved` is unaffected and is if anything reinforced.** It works off conversation
  records continuing to arrive, and a session stopped at a dialog genuinely writes none.

**What would disprove this:** a Claude Code that flushes the `tool_use` eagerly. The avenue
reopens the moment it does, so re-measure rather than re-reason.

---

## Question 2 - only if Question 1 comes back unhelpful

Distinguishing them would then require **`tool_name`** on the `PermissionRequest` payload -
Claude Code knows the tool being requested, and `AskUserQuestion` is a tool like any other.

**This is a widening of a privacy boundary and is therefore the user's decision, not yours.**

`AGENTS.md`, *Safe-Change Rules*: *"The hook payload is a privacy boundary. Session id, cwd,
transcript path, event name, Claude's own notification message, and window identity. Never
prompt text, transcript content or file contents. **Do not widen it.**"*

The honest case for and against, which should be put to the user rather than resolved
unilaterally:

- **For:** `tool_name` is a bare tool identifier - `Bash`, `Edit`, `AskUserQuestion`. It is
  arguably *less* revealing than `message`, which is already sent and says things like
  *"permission to use Bash"*.
- **Against:** the rule exists precisely so that each widening is deliberate. A boundary that
  moves whenever a field looks harmless is not a boundary.

**Absolutely not `tool_input`.** `src/hook-payload.js` already warns that on a
`PermissionRequest` this contains, for `Write` and `Edit`, **the contents of the file being
written**. It is the exact reason the allowlist exists. Do not read it, do not forward it, do
not log it.

If the user approves `tool_name`, it goes in `REPORTABLE_FIELDS` **and** in the `HookPayload`
typedef in `src/registry.js`, **and** the privacy paragraph in `README.md` gets updated in the
same change - the README enumerates what the hook sends, and an unlisted field makes that
statement false.

---

## What the fix should and should not do

- **Do not change the state.** `blocked` is correct. The row belongs where it is.
- **Change only the reason text**, and only when the source is known. A question should read as
  a question.
- **Fail closed, exactly as `isIdleNudge` does.** An unrecognised or absent
  `notification_type` must keep today's behaviour. The existing precedent is explicit: *"an
  unrecognised or absent message stays a hard block"*, because the cost of guessing wrong on
  this signal is far higher than the cost of being vague.
- **Vague is acceptable; wrong is not.** If the two genuinely cannot be told apart, neutral
  wording that covers both is a legitimate outcome and better than a specific claim that is
  false half the time. Propose it if the alternatives are worse.
- **pi is unaffected** - it has no permission prompt and `PI_EVENT_STATES` contains no
  `blocked` at all. Do not touch it.

---

## Reproduce as a test first

Per `AGENTS.md` and the user's standing preference: reproduce as a permanent test before fixing.
`dashboard.js` is pure and directly testable - see the `run()` / `session()` factory pattern at
the top of `test/dashboard.test.js`, and the existing `notification_type` cases in
`test/dashboard.test.js` and `test/registry.test.js` for the shape.

---

## Constraints (from AGENTS.md, non-negotiable)

- **The hook runs inside a live session.** Every path exits 0, quietly, within `TIMEOUT_MS`.
- **The allowlist is an allowlist, never a denylist.** A forgotten allow is a feature that
  quietly does not work; a forgotten deny is somebody's source code on a socket.
- **Pure modules stay pure.** Inject the clock; do not import it.
- **Zero runtime dependencies.**
- **Protocol coherence**: `/api` shape, the SSE frame and `public/` change together.
- **A new hook event or field changes nothing for existing sessions** until `install-hooks` is
  re-run *and* every open session restarts. If the fix depends on a payload change, say so
  plainly in the summary - it is the difference between "fixed" and "fixed for sessions you
  start tomorrow".

---

## Definition of done

```sh
npm test
npm run typecheck
```

Report: the `notification_type` value observed for `AskUserQuestion`, whether a payload change
was needed, and - if it was - stop and ask before making it.
