---
ticket: RAI-21
status: in-progress
branch: RAI-21-codex-sessions
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

## The capture

Done 11/08/2026 against **codex-cli 0.147.0**, five throwaway `codex exec` sessions under a
scratch `CODEX_HOME` (`auth.json` copied in, the captain's own `~/.codex` untouched), with a
capture hook registered on all seven events that wrote its stdin and walked its own ancestry.
Everything below is measured. Where it contradicts the sections above, it wins, and the
paragraph it corrects says so.

### The hook payloads, field for field

Handed on **stdin**, as JSON, exactly as Claude Code does - so item 2's "to be confirmed" is
confirmed and `raise-hook.js` needs no change to how it reads or how long it waits.

```json
SessionStart      {"session_id","transcript_path","cwd","hook_event_name","model",
                   "permission_mode","source":"startup"}
UserPromptSubmit  {…,"turn_id","prompt":"<the user's words>"}
PermissionRequest {…,"turn_id","tool_name":"Bash",
                   "tool_input":{"command":"touch …","description":"Do you want to allow …"}}
PreToolUse        {…,"turn_id","tool_name","tool_input","tool_use_id"}
PostToolUse       {…,"turn_id","tool_name","tool_input","tool_response","tool_use_id"}
Stop              {…,"turn_id","stop_hook_active":false,"last_assistant_message":"DONE"}
SessionEnd        {"session_id","transcript_path","cwd","hook_event_name","reason":"other"}
```

`permission_mode` was `default` interactively and `bypassPermissions` under plain `codex exec`.
`SessionEnd` carries neither `model` nor `permission_mode`.

**`PermissionRequest` does carry a reason, and we still cannot show it.** The section above says
a Codex block "cannot say what it is for"; the truth is narrower and the outcome is identical.
Codex writes a human-sentence `description` - *"Do you want to allow creating
/Users/…/x outside the workspace?"* - but it writes it **inside `tool_input`**, which is the one
field `REPORTABLE_FIELDS` exists to drop, because for a `Write` the same field is the contents
of the file. RAI-11's test asks whether the page can do its job without it, and it can: the row
says a human is needed, which is the signal. So the boundary does not move, and the reason
stays on the machine that produced it. Also worth recording: Codex already reports its shell
tool to a hook as `tool_name: "Bash"`, so the two agents' payloads agree even there.

### The ancestry, and therefore the pid rule

```
/bin/sh <hook script>                                   ← the hook
  └── …/@openai/codex-darwin-arm64/vendor/…/bin/codex exec …   ← the agent, basename `codex`
        └── node /opt/homebrew/bin/codex exec …               ← the npm launcher
              └── the user's shell
```

The hook is a **direct child of the native binary**, not the grandchild `process-tree.js`
assumes for Claude Code - the extra `/bin/sh` here is only because our capture hook was a shell
script, and `isWrapper` already skips it either way. Both codex processes are long-lived, and
the native one is the nearer, so a nearest-ancestor-first walk reaches the right one.

`pickAgentPid` would in fact already answer correctly *by accident*, through its
`proc.tty` fallback - the native binary owns the controlling terminal in a real session. That
is exactly the incidental answer this module's own comment warns about, so `looksLikeCodex`
is added beside `looksLikeClaude` and the answer becomes positive evidence. Matched on the
basename `codex` and on the `@openai/codex` package path, never on the word appearing in argv,
for the same reason `isRunOwnerCommand` matches an executable: the session most likely to be
wrongly claimed is one working *on* Codex.

### Hooks are trust-gated, and nothing above knew it

**This is the one finding that changes a build item.** Writing `hooks.json` is not enough.
Codex 0.147.0 records a hash per hook entry in `config.toml`:

```toml
[hooks.state."/Users/mattw/.codex/hooks.json:session_start:0:0"]
trusted_hash = "sha256:93fbfa…"
```

and an entry with no matching hash is **parsed and then silently not run**. Measured directly:
with our capture hooks installed and untrusted, Codex still read the file (it printed a warning
about one of our timeouts) and fired nothing at all; the same run with
`--dangerously-bypass-hook-trust` fired all seven. The TUI is where a hook is trusted -
`TrustHook` / `SetHookTrusted` are its own operations, and it writes the hash itself.

So `raise install-codex` **writes `hooks.json` and says out loud that Codex will ask to trust
the hook the next time it starts**. It must not write `config.toml`, which the section above
already forbids for the feature flag and which now has a second and much sharper reason: that
file is where Codex records what the user has agreed to run, and a monitor that forges a
consent hash is a monitor that has installed a silent executable on somebody's behalf. The
`--dangerously-bypass-hook-trust` flag is the user's to pass, never ours to suggest.

The practical consequence for the user is the same shape as the existing "restart your open
sessions" note, and it goes in the same place: install, then start Codex, then approve.

### The SessionEnd timeout is clamped to 3s

`warning: clamping SessionEnd hook timeout to 3s in <path>` is printed on **every session
start** while an entry asks for more. Our own reporter is bounded at 2s, so our `SessionEnd`
entry is written with `timeout: 3` and the rest with `5`: causing a warning in somebody's
editing loop, once per session, forever, to ask for time we never use is the sort of noise
`raise-hook.js`'s rules exist to prevent.

### The rollout dialect

Every line is `{"type","timestamp","ordinal","payload"}` and **every line carries a
timestamp**, session metadata included - the `away_summary` trap in a third dialect, exactly as
predicted. The conversation is `type: "response_item"` and nothing else:

| `payload.type` | Shape |
| --- | --- |
| `message` | `{role: user\|assistant\|developer, content: [{type: input_text\|output_text, text}], phase?}` |
| `custom_tool_call` | `{name: "exec", call_id, input: "<a JS snippet>", status}` |
| `custom_tool_call_output` | `{call_id, output: [{type: "input_text", text}]}` |
| `function_call` | `{name: "wait", call_id, arguments: "<JSON string>"}` |
| `function_call_output` | `{call_id, output: [...]}` |
| `reasoning` | `{summary: [], encrypted_content}` - dropped, and unreadable anyway |

Everything else is dropped: `session_meta`, `turn_context`, `world_state`, and every
`event_msg`. `event_msg` is the sharp one - it **restates the conversation** (`user_message`,
`agent_message`, `item_completed`) with its own timestamps, so admitting it would double every
turn. `response_item` is the whitelist, and `event_msg` is why it is a whitelist.

Four more things, each of which decides a line of code:

- **`role: "developer"` is not the conversation.** Codex injects `<skills_instructions>`, a
  multi-agent preamble and `<plugins_instructions>` under that role, mid-turn as well as at
  startup. Dropped wholesale. One injection arrives under `role: "user"` instead -
  `<recommended_plugins>` - and is indistinguishable from a typed prompt by any structural
  field, so it is dropped by its wrapper tag, the same way Claude Code's `<system-reminder>`
  is. Codex will grow more of these; this one is what was observed, and it is named as such.
- **A tool call record is written when the call is issued, not when it returns.** Measured on a
  25-second command: the `custom_tool_call` landed at T+1s and its output at T+12s, with the
  file untouched in between. That is what makes the in-flight rule work on Codex at all -
  without it there would be no "what is it doing right now" and, far worse, nothing to disprove
  a stale block with.
- **`status` on that record says `completed` from the moment it is written**, while the tool is
  still running. It is a lie about progress and must never be read. The id match against the
  output record is the only truth, which is the rule everywhere else here.
- **Every tool goes through one `exec` tool.** 0.147.0 is in "code mode": `input` is a JS
  snippet calling `tools.exec_command({cmd: …})`, `tools.update_plan({…})` and so on, several
  per call. So the shell command has to be lifted out of the snippet, or a Codex session
  sitting in a `lavish-axi poll` is invisible and every card reads "Running exec". The
  `function_call` shape is the other half and is a plain name plus JSON arguments.

### There is no title, anywhere

`threads.title` in `state_5.sqlite` is the **first user message, verbatim** - identical to the
`first_user_message` column on all three sessions checked, including one whose title is a
340-word approval-review prompt. Codex generates nothing like Claude Code's `ai-title`, and no
rollout record carries one.

So `Row.summary` is null for a Codex session, exactly as it is for pi, and the card is carried
by its activity line. This also retires the last reason anyone might reopen the
`state_5.sqlite` question: the one field that looked like a reward for reading it is raw prompt
text, which is above the altitude a card is allowed to show and is precisely what
`REPORTABLE_FIELDS` keeps off the wire. A `threads.name` column and a `SetThreadName` operation
both exist, so Codex may have an equivalent of `/rename`; nothing was observed writing one, and
nothing is built on the guess.

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
