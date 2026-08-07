---
ticket: RAI-18
status: in-progress
size: S
depends: -
branch: RAI-18-tmux-linked-window-focus
---
# RAI-18 - Focus raises the wrong tab when a tmux window belongs to two sessions

**Self-contained brief.** No prior conversation needed. Written 07/08/2026.

Reported live, with five agent sessions open on this machine. Every measurement below was
taken from that running tmux server rather than reasoned about.

---

## The symptom

One parent session (`SLS-75`) with four detached workers spawned from it (`SLS-83`, `84`,
`85`, `86`), each in its own iTerm2 tab. Clicking `Focus ↗` on **any** of the four:

1. raises the **SLS-75** tab, not the worker's;
2. switches what that tab is showing to the worker, and **leaves it there** - going back to
   the 75 tab still shows 86, and the only way to get 75 back is to click 75 in nmmon;
3. leaves the worker's own tab drawing at half width, the remainder filled with `.`, until
   the mouse moves over it.

---

## The cause

**A tmux window can belong to more than one session.** `link-window` puts one window in
several sessions at once, and a grouped session (`new-session -t`) does the same. The
`handoff` skill builds exactly that shape on purpose: the worker runs in a window of the
parent session, and that same window is then linked into a per-worker viewer session whose
sole content it is, which is what the terminal tab attaches to.

```
$ tmux list-panes -a -F '#{pane_id}\t#{session_id}\t#{window_id}\t#{session_windows}\t#{session_name}'
%356  $191  @349  5  hv-sls-75-4d7a 🔔      <- parent, 5 windows, client /dev/ttys018
%356  $204  @349  1  hv-sls-86-fb9d 🔔      <- the viewer, client /dev/ttys035 - the tab in front of you
```

Both rows are true. `src/focus/tmux.js`'s `sessionForPane` asks the question as though only
one could be:

```
tmux display-message -p -t %356 '#{session_name}'
```

which returns an arbitrary one of them. At the time of the report it returned the **parent**
for all four worker panes:

```
%356 -> hv-sls-75-4d7a 🔔      %352 -> hv-sls-75-4d7a 🔔
%354 -> hv-sls-75-4d7a 🔔      %350 -> hv-sls-75-4d7a 🔔
```

**And an hour later, on the same server with the same topology, it returned the viewer
instead** - `%350 -> hv-sls-85-dfe4 🔔`, `%354 -> hv-sls-84-5d55 🔔`. Nothing about the
sessions changed; what changed was which of them had most recently been active. That is worth
recording because it is the reason the symptom is **intermittent** rather than constant, which
is how it was described: sometimes the click lands correctly and sometimes it does not, with
nothing the user did to explain the difference. A resolution that reads the whole candidate
table and ranks it cannot vary that way.

The three symptoms follow in order:

1. `clientsForSession` is then asked about the parent, so it hands back `/dev/ttys018` and
   the terminal adapters raise the SLS-75 tab.
2. `selectPane` runs `select-window -t %356`, which is session-ambiguous in exactly the same
   way. tmux picks a session and moves **that** client's current window - persistently. This
   is the symptom that lingers, and the reason the 75 tab keeps showing 86.
3. Two clients now display window `@349` at different sizes (166x81 and 335x82). tmux's
   default `window-size latest` sizes a window to the most recently used client, so the
   worker's 335-column tab draws at the parent's 166 and fills the rest with `.` - and snaps
   back the instant the mouse makes it "latest" again. Entirely downstream of (1) and (2).

A **second, separable bug** in the same function: the detached hint is built as
`` `tmux attach -t ${session}` ``, which for these names emits
`tmux attach -t hv-sls-86-fb9d 🔔` - two shell arguments. Session names are user data; a bell
plugin on this machine renames them. Fixed here because it is the same code and the same
lesson.

---

## The rule

Resolve the pane to **every** session it lives in, weigh every client against those, and
choose one:

1. **A client already displaying the pane's window.** Raising it moves nothing inside tmux,
   which is the whole failure above.
2. Failing that, the client on the candidate session holding the **fewest windows**. A
   session holding only this window is a viewer dedicated to it; a session holding five is
   somebody's working view that merely happens to be parked here.

Then aim everything after that at **that client's session, by id** - `select-window -t
'$204:@349'`, never `-t %356`.

**Two picks come out of that one ranking, not one.** The best client overall answers *is this
pane living in a native terminal tab tmux cannot see* (`controlMode`); the best **plain**
client answers *which tty do I raise, and in which session do I select*. They are the same
client in every ordinary case, and collapsing them would lose the control-mode-plus-plain-client
fallback that `src/focus/index.js` already depends on. `firstmate` on this machine is a live
`tmux -CC` session, so that is not hypothetical.

### Why no `needsSelect` flag

When the chosen client already displays the window, `select-window` is simply a no-op - tmux's
`session_set_current` returns without touching the session's current window or its last-window
stack. A flag to skip it would be state to keep true for no gain.

---

## Verified primitives

Every one of these was run against the live tmux server, not inferred.

| Primitive | Result |
| --- | --- |
| `list-panes -a -F '#{pane_id}…#{session_name}'` | one row **per session** a linked window belongs to |
| `list-clients -F '…#{session_id}\t#{window_id}'` | `#{window_id}` in client context is the client's **session's** current window - tmux keeps no per-client one, so rule 1 discriminates only *between* candidate sessions, never within one |
| `select-window -t '$204:@349'` vs `'$191:@349'` | the same window, with the correct per-session context (index 1 vs index 3) |
| `list-clients -t 'hv-sls-7'` | matches `hv-sls-75-4d7a 🔔` - **a name target prefix-matches**, so `-t` on a name is dropped entirely |
| `list-panes -a` size | 514 bytes / 14 rows here; `MAX_OUTPUT_BYTES` is 1MB, so it would take ~25,000 panes to matter |

Session names carry a space and an emoji (`hv-sls-86-fb9d 🔔`), emitted **last** in the format
so a tab inside a name cannot eat a field boundary. After this change no `-t` target is ever a
name - only `$id` and `@id`, and tmux forbids `:` and `.` in session names, so `$204:@349`
cannot mis-split.

---

## Acceptance

- Focusing each of four workers raises **that worker's own** tab.
- The parent's client stays on **exactly the window it was on**. Nothing else moves.
- A tmux session with several windows and one client behaves exactly as before: select the
  window, then raise.
- The detached hint is pasteable for a session name containing a space and an emoji.
- A regression test built from the real ids above fails before the fix and passes after.

## Deliberately not built

- **Clearing a size clamp that is already on screen.** This stops nmmon *creating* the
  two-clients-one-window state; one already showing resolves itself on the next redraw. The
  tmux-side lever is `window-size`, and it belongs to whatever set the session up, not here.
- **`handoff`.** Its link-window topology is deliberate and correct; nmmon was the half
  asking a question with one answer where there are two.
- **A most-recently-used tie-break** (`#{client_activity}`). The two rules above resolve every
  case observed, and a third would be one more field and one more test for none of them.
