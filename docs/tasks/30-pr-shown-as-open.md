---
issue: 30
status: backlog
size: M
depends: -
---
# 30 - A draft pull request is shown as open

**Self-contained brief.** No prior conversation needed. Written 26/08/2026.

---

## What and why

Raise speaks three words about a pull request: `open`, `merged` and `closed`. A draft is none
of them, so it is rendered as `open` - and `open` on this page means a review that is waiting
on somebody. A draft is the opposite: it is waiting on its author, and there is nothing for a
reviewer to do.

That is the failure this product exists to avoid, in the one place it is easiest to miss. The
card is not blank and it is not stale; it is confidently wrong about who is holding the work.

### The case that produced it

On 26/08/2026, `2/money-webapp` carried
[money-webapp#319](https://bitbucket.org/moroku/money-webapp/pull-requests/319). Bitbucket's
own answer for it:

```json
{ "state": "OPEN", "draft": true }
```

Raise had it as `open`. The sibling row's
[#320](https://bitbucket.org/moroku/money-webapp/pull-requests/320) is `"state": "OPEN",
"draft": false` and is genuinely awaiting a reviewer's approval. The two rows read identically
and mean different things.

### Both forges say so, and we throw it away

| Forge | Where | Raise asks for it? |
| --- | --- | --- |
| Bitbucket | `draft` boolean on the pull request object | **no** - `#lookupBitbucket` requests `fields=state` |
| GitHub | `isDraft` on `gh pr view --json` | **no** - `#lookupGitHub` requests `--json state` |

Neither field crosses the network today. This is not a limit of what we can know; it is a
field we decline to ask for.

---

## What will visibly change

A pull request that is a draft says `draft` on its card and in `raise status`, instead of
`open`.

---

## Design questions to settle before writing code

These are the user's decisions, not the implementer's. Bring them back.

### 1. Is `draft` a fourth state word, or a marker beside `open`?

The two candidates, and they are not equivalent:

- **A fourth word in `PullRequest.state`.** `'open'|'draft'|'merged'|'closed'`. One field, one
  answer, and every renderer that already switches on the state word gains it with no new
  concept. It costs a widened union that `normaliseForgeState` must produce, and the three
  sources that are not the forge have no way to say `draft` at all - see question 3.
- **A separate `draft: boolean` beside the existing state.** Keeps the state vocabulary
  closed and models the forges accurately, since both of them genuinely report a draft as
  `OPEN` plus a flag. It costs a second field every renderer has to remember to read, and a
  renderer that forgets it reproduces exactly the bug being fixed.

**Recommendation: the fourth word.** The page's own rule is that a card states what we know in
one place, and a reader is not reconciling two fields at a glance. The precedent is the
`dismissed` marker, which is deliberately *not* a state and sits beside one because it explains
a state rather than replacing it - a draft replaces it.

### 2. Where does `draft` rank, and does it change attention at all?

A pull request's state is a chip, not an attention level, so the likely answer is that nothing
in `ATTENTION_ORDER` moves. Confirm that, because the argument the other way is real: a draft
means this row is *not* waiting on a human, and a row that has been sitting in draft for two
days is arguably worth less of your attention than one awaiting approval, not the same amount.

**Recommendation: no attention change.** Ranking by pull request state would make the chip do
two jobs, and the attention level is already decided by the session, which is the unit.

### 3. The three local sources cannot say `draft`, and must not be made to guess

Only the forge knows. no-mistakes' `pr_state` does not carry a draft flag, and the transcript
sighting is a URL somebody wrote down. So:

- a pull request whose state came from anywhere but the forge says `open`, exactly as today;
- a `draft` reading may therefore only ever come from a forge answer;
- and it is subject to the same `PullRequest.current` gate as any other forge reading.

**This means the fix is only visible when the forge is switched on and working.** Which is the
whole of the sibling item - see
[31-forge-credential-fails-silently.md](31-forge-credential-fails-silently.md). Worth stating
in the issue so the two are not mistaken for one.

### 4. What happens when a draft is published

The forge starts answering `draft: false`, the reading ages through the ordinary gate, and the
word changes from `draft` to `open` on the next successful lookup. Nothing special is needed,
but it should have a test: a state word that gets stuck on `draft` after publication is the
same bug pointing the other way.

---

## Deliberately not in scope

- **Marking a draft in any way beyond the state word.** No separate colour, no icon, no
  ordering change. If `draft` needs more than a word to be understood, the word is wrong.
- **Anything about GitHub's "ready for review" transition**, or Bitbucket's, as an event. This
  item reads a state; it does not watch for a change in one.
- **Telling the user that their own pull request is still a draft.** That is a nudge, and this
  page reports rather than advises.

---

## Acceptance

- `normaliseForgeState` produces the agreed shape for a Bitbucket `OPEN` + `draft: true` and
  for GitHub's `isDraft`, with a unit test per forge covering draft and non-draft.
- Both lookups request the field, and the Bitbucket one keeps its narrow `fields=` list - it
  gains `draft` and nothing else, because the reason that list is narrow has not changed.
- A row whose pull request state came from no-mistakes or a transcript sighting still says
  `open`, asserted by a test - a local source may never produce `draft`.
- The page and `raise status` render the same word for the same row. They are one protocol and
  a state word on one and not the other is the two disagreeing.
- `npm test`, `npm run lint` and `npm run typecheck` pass.
