---
ticket: RAI-21
status: backlog
size: L
depends: -
---
# RAI-21 - Watch Codex CLI sessions alongside Claude Code and pi

**Self-contained brief.** No prior conversation needed. Written 10/08/2026 against
**codex-cli 0.147.0**, installed for this purpose. Every event name, payload field, storage
path and process shape below was read off that installation - the binary, its feature list and
its process table - rather than taken from the published docs, which are already a version or
two behind on both the event set and where a session is stored.

---

## The problem

Raise watches two agents. Codex CLI is a third, it is the one most likely to be running beside
Claude Code on this machine, and a Codex session is invisible to the page - no row, no state,
no focus. On a monitor whose one sentence is *tell me which session is waiting for me, and take
me there*, an agent it cannot see is not a gap in coverage so much as a wrong answer: the page
says nothing is waiting while a Codex window sits on an approval prompt.

pi established that this is cheap. Everything Raise computes keys off `cwd`, `transcriptPath`
or `host.pid` - the run match, the branch, the pull request, the Lavish gate, the pipeline
scan, every focus adapter, the dismissal - and none of it knows or cares which agent produced
those three. What a new agent needs is a **reporter** and a **transcript normaliser**.

---

## What Codex gives us, measured

### Hooks, and they are Claude Code's shape

Codex ships a hook system that is close enough to Claude Code's to be uncanny. The eleven event
names, read out of the 0.147.0 binary:

```
SessionStart  UserPromptSubmit  PreToolUse  PermissionRequest  PostToolUse
PreCompact    PostCompact       Stop        SessionEnd         SubagentStart  SubagentStop
```

Configured in `~/.codex/hooks.json` (and `<repo>/.codex/hooks.json`), in exactly the structure
`src/hooks.js` already writes into `~/.claude/settings.json`:

```json
{ "hooks": { "SessionStart": [ { "matcher": "", "hooks": [
  { "type": "command", "command": "…", "timeout": 10 } ] } ] } }
```

Every command hook is handed JSON on stdin carrying `session_id`, `transcript_path`, `cwd`,
`hook_event_name`, `model` and `permission_mode`, with `turn_id` on turn-scoped events,
`source` on `SessionStart` (`startup` / `resume` / `clear` / `compact`), `reason` on
`SessionEnd`, and `agent_id` / `agent_type` / `agent_transcript_path` on the subagent pair. The
first four are the same field *names* Raise already reads.

`hooks` is a **stable feature, on by default** (`codex features list` reports
`hooks  stable  true`), so nothing needs enabling and Raise must not write `config.toml`.

### There is a real permission prompt, and no notification of any kind

This is the substantive difference from pi, in both directions.

`PermissionRequest` fires when Codex is about to ask for approval - a shell escalation, a
managed-network request. So **a Codex row may go red**, on positive evidence, where a pi row
never can.

But there is no `Notification` event, which costs us two things Claude Code gives:

- **no reason text.** `PermissionRequest` in Claude Code carries no message either; what fills
  the gap there is the `Notification` catching up six to twelve seconds later. Codex has
  nothing to catch up, so a Codex block says *a human is needed* and cannot say what for. That
  is RAI-11's answer applied to a second agent: say what is known, and do not guess the rest.
- **no idle nudge, and we do not invent one.** `SessionEnd` fires on close *or* after 30
  minutes idle, which is not a nudge and must not be read as one. Escalating "the turn ended a
  minute ago" into a block was considered and rejected for pi, and the reasoning is unchanged:
  red that sometimes means nothing is wrong is how a page stops being believed.

There is also a `notify` program in `config.toml` which does fire `approval-requested` and
`agent-turn-complete`. It is **not** used: it is handed a bare JSON blob with no session id, so
nothing it says can be attributed to a row, and it would be a second reporter competing with
the first.

### Where a session is written

`transcript_path` on the hook payload is the handle, and it is the only one this ticket uses.
Worth recording all the same, because the published docs are wrong about it and the next person
will search for the old answer: 0.147.0 keeps a **SQLite index** of sessions -
`~/.codex/state_5.sqlite`, whose `threads` table carries `id`, `rollout_path`, `cwd`, `title`,
`updated_at` - alongside the rollout JSONL files themselves. The docs describe only
`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`.

**The index is deliberately not read.** `nm-state.js` is the whole argument: reading somebody
else's database is a schema probe, a fallback, a mode ladder and a version-mismatch story, and
that price is worth paying once for pipeline state that has no other source. A session's title
and cwd both reach us for free - the cwd on every hook payload, the title from the transcript
the way both other agents' titles already come. A numbered filename (`state_5`) is a schema
that has been replaced five times.

### How it looks in the process table

```
node /opt/homebrew/bin/codex exec …
  └── …/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex exec …
```

An npm launcher under `node`, and a native binary child whose basename is `codex`. Both are
long-lived, so `process-tree.js` has something to record - but which of the two it settles on,
and whether a Codex hook is the grandchild `process-tree.js` assumes, must be **captured from a
real session before the walk is written**. Recording the wrong pid is the one failure that mode
has: a session pinned to a process that exits is pruned within a tick and the page silently
goes empty.

---

## What gets built

1. **`AgentKind` widens to `'claude' | 'pi' | 'codex'`**, and `CODEX_EVENT_STATES` joins
   `EVENT_STATES` and `PI_EVENT_STATES` in `registry.js`:

   | event | state |
   | --- | --- |
   | `SessionStart` | idle |
   | `UserPromptSubmit` | working |
   | `PermissionRequest` | blocked |
   | `Stop` | idle |
   | `SessionEnd` | ended |

   `PreToolUse` / `PostToolUse` map to `working` but are **not installed**, on the rule
   `src/hooks.js` already states: a hook process per tool call, inside the user's editing loop,
   to learn something the transcript already holds.

2. **One reporter, not two.** `hooks/raise-hook.js` already receives this payload shape; a
   second script would be a fork of the never-fail, exit-0, bounded-timeout rules that are the
   most load-bearing lines in the repo. The hook *command* is ours to write, so the agent kind
   is declared there - `node …/raise-hook.js --agent codex` - which is the same trick pi's
   extension uses when it sets `agent: 'pi'` in the body, moved to the one place Codex gives us
   to put it. Claude Code stays the silent default.

   To be confirmed on capture: that Codex passes the payload on **stdin** the way Claude Code
   does, and that its timeout semantics do not need a different `TIMEOUT_MS`.

3. **`src/codex-transcript.js`, a normaliser and never a second summariser.** It rewrites
   rollout lines into the plain records `transcript.js` already reads, exactly as
   `pi-transcript.js` does, so `summariseTranscript` runs on all three agents unchanged. A
   parallel summariser would fork the in-flight tool rule, the `lastActivityAt` whitelist and
   all three pull-request guards, and the copy that missed the next fix would be the one
   putting a confident wrong answer on the page.

   The three traps are known in advance, each already paid for once:

   - **every rollout line carries a timestamp**, session metadata included, so anything that is
     not the conversation is dropped rather than passed through with a timestamp attached. This
     is `away_summary` and pi's `model_change` in a third dialect, and it is the trap that
     matters most here, because on Codex the transcript is the *only* thing that can clear a
     stale block.
   - **a tool result is a `user` record**, because a returning tool is a session working.
   - **tool names are mapped, not passed through.** `describeToolUse` picks a verb by name and
     `summariseTranscript` keys on `Bash` to notice a `lavish-axi poll`; Codex's shell tool
     under its own name would render as a bare word and hide a review gate.

4. **A stale block is cleared by the transcript, and nothing else.** Codex has no event for an
   approval being answered - `PostToolUse` would say so but is not installed, for the reason
   above. That is precisely Claude Code's situation, `blockDisproved` already handles it, and
   it means item 3 is load-bearing for *correctness* here, not just for the summary line. A
   Codex block is never dismissible either: `isIdleNudge` fails closed, and a Codex block is
   always a genuine approval request, so the `Not for me` control correctly never appears.

5. **An installer for `~/.codex/hooks.json`.** Closer to `hooks.js` than to `pi-extension.js` -
   same nested shape, different file - so `mergeHooks` is generalised rather than copied. Every
   obligation in the safe-change rules carries over verbatim: show a diff, ask first, back up to
   `.raise-backup`, leave foreign entries untouched, safe to run twice. **This machine is the
   test fixture**: `~/.codex/hooks.json` already holds three foreign `SessionStart` groups
   (`lavish-axi`, `chrome-devtools-axi`, `gh-axi`), and all three must survive install,
   reinstall and uninstall in place.

6. **CLI and config.** `raise install-codex` / `raise uninstall-codex` beside the pi pair;
   `CODEX_HOOKS` in `config.js`, env-overridable and honouring `CODEX_HOME` the way Codex
   itself does. `doctor` reports the Codex hooks **only when Codex is installed**, the same
   silence no-mistakes and Lavish are held to - a machine without Codex gets no line, no
   warning and no subprocess.

7. **The page.** `AGENT_LABELS.codex` and `AGENT_NAMES.codex`. The chip is worth showing for
   the same reason pi's is: what a state can mean differs per agent, and a reader needs to know
   a red Codex row carries no reason and a quiet one will never escalate.

8. **README and AGENTS.md.** A third agent changes documented flows in both.

---

## Deliberately not built

- **Subagents as rows.** `SubagentStart` / `SubagentStop` and `agent_transcript_path` would let
  us register every subagent as a session. no-mistakes' pipeline agents already taught this
  lesson: a card for an agent nobody can focus is a dead card, and the answer was to fold it
  into the row that owns it. If Codex subagents are worth showing they are worth folding, and
  that is its own ticket.
- **Reading `state_5.sqlite`.** See above.
- **The `notify` program.** No session id, so nothing it reports can be attributed.
- **`PreCompact` / `PostCompact`, `PreToolUse` / `PostToolUse`.** Cost per turn or per tool
  call, for state the transcript already carries.
- **Codex Desktop, `codex cloud`, `codex remote-control`.** Raise watches one machine.
- **Any widening of `REPORTABLE_FIELDS`.** Codex's payloads carry `prompt` and
  `last_assistant_message` too, and the allowlist already drops them - which is the allowlist
  doing its job for an agent it was not written for. `reason` and `permission_mode` are not
  added unless the page cannot do its job without them, which is RAI-11's test.

---

## Before any code: the capture

Codex is installed but not logged in, and every remaining unknown needs one real session.
`codex login`, then a throwaway session under a scratch `CODEX_HOME` with a hook that appends
its stdin to a file, doing one thing that needs approval. What that has to yield, and what goes
in this file the way RAI-11's capture did:

- a real payload for each of `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `Stop`,
  `SessionEnd`, field for field
- the ancestor chain from the hook process up to the agent, so the pid rule is written against
  a walk rather than a guess
- ten or twenty lines of a real rollout file, including a tool call and its result, and the
  record that carries the session title

---

## Definition of done

- A live Codex session appears on the page with its repo, branch and title, and `Focus ↗`
  raises its window.
- An approval prompt turns the row red within a poll; answering it clears the row within
  three seconds, from the transcript.
- A finished turn reads `Idle` and never escalates.
- `raise install-codex` merges into a `~/.codex/hooks.json` that already has three foreign
  hooks, twice in a row, changing nothing the second time; `raise uninstall-codex` leaves those
  three exactly as it found them.
- On a machine with no Codex installed: no doctor line, no warning, no subprocess. The
  `server.test.js` guard that asserts an unconfigured Raise runs nothing still passes.
- `npm test`, `npm run lint`, `npm run typecheck`.
