---
issue: 31
status: backlog
size: M
depends: -
---
# 31 - A forge credential that cannot see the repository fails silently, forever

**Self-contained brief.** No prior conversation needed. Written 26/08/2026.

---

## What and why

`ForgeState` treats every unsuccessful response the same way, and says so in a comment that is
right about the case it was written for:

```js
// 401, 403, 404 and 429 all mean the same thing on this page: we do not know.
// None of them is worth a distinct behaviour, and none of them is worth
// telling the user about on a row - the backoff is what stops it repeating.
if (!response.ok) return null;
```

That is correct for a *transient* failure. It is wrong for a *permanent* one, and nothing
today tells the two apart. A credential that will never be able to read a repository produces
a silent no-answer on every cycle, for as long as the monitor runs, and the page looks exactly
like one where the forge was never switched on.

**This is quiet staleness in the one component built to prevent it.** The forge exists to
settle a reading that no-mistakes can no longer refresh. When it cannot, the row falls back to
a frozen `pr_state`, ages past `PR_STATE_FRESH_MS`, drops `current`, and the chip disappears.
The user sees no pull request, no error and no explanation, and the honest reading of that page
is "there is no pull request" - which is false.

### The case that produced it

On 26/08/2026 the Bitbucket credential in `~/.raise/config.json` was an Atlassian API token
minted on the user's **personal** account. It cannot see the `moroku` workspace. Every lookup
against it had been returning 404 since the feature was switched on:

```
moroku/money-webapp#320          HTTP 404
moroku/money-webapp#319          HTTP 404
moroku/money-api#402             HTTP 404
mattw_watson/sls-scheduling#95   HTTP 200   {"state":"OPEN","draft":false}
```

The personal-workspace repository answers; all three work repositories 404. So the forge had
**never once** answered for the majority of rows on the page, and there was no way to discover
that from Raise - it took reading the config, extracting the credential and querying Bitbucket
by hand.

Bitbucket's message for this is itself misleading, which is why the silence costs so much:

> You may not have access to this repository or it no longer exists in this workspace. If you
> think this repository exists and you have access, make sure you are authenticated.

It reads as a deleted repository or a revoked permission. It is a token minted on the wrong
account, and the same wording appears for a repository-scoped token used across a workspace.
Somebody debugging this from the page alone has nothing at all to go on.

---

## What will visibly change

When the forge cannot answer for a repository and that is not a passing failure, Raise says so
once, in `raise doctor`, naming the workspace and repository it cannot read. The rows
themselves stay exactly as they are.

---

## Design questions to settle before writing code

### 1. Persistence is the signal, not the status code

Do not branch on 401 versus 403 versus 404. The skill notes for this machine record that those
codes are individually misleading here - a 403 is proof the credential paired correctly, a 401
can mean the wrong authentication scheme rather than a dead token, and a repository-scoped
token used workspace-wide reports a missing repository. Reading a single response tells you
very little that is reliable.

**What is reliable is repetition.** One failure is a hiccup. N consecutive failures for the
same repository, with no success in between, is a configuration that will not fix itself.

There is precedent in this codebase for exactly that shape:
`MAX_CONSECUTIVE_FAILURES` in `src/firstmate-decisions.js`, which drops a reading after enough
consecutive non-answers on the ground that a re-dispatch that always fails is not evidence.
Follow it rather than inventing a second pattern.

### 2. Count per repository, not per pull request and not per forge

Per pull request is too fine: a single deleted pull request would look like a broken
credential. Per forge is too coarse: a credential can legitimately read one workspace and not
another, which is precisely the case above. The repository is the unit at which access is
actually granted, so it is the unit to count at.

### 3. Where it is said, and the outbound-request rule this must not break

**`raise doctor` must not make a forge request to answer this.** `AGENTS.md` records that
there are exactly two outbound requests in the product, that the count is part of the rule, and
that `doctor` reports the update check without ever making one. A probe from `doctor` would
break both halves of that, and the README's Security section is written to be honest rather
than technically true.

So the reading has to come from the process that is already asking - `raise serve` - which
means `doctor` reads it rather than takes it. Settle which:

- **a route on the running server** that `doctor` queries, alongside the `/health` probe it
  already makes. Costs a route; gives a live answer.
- **a line written into `~/.raise/`** by the poll, which `doctor` reads off disk. Costs a
  file; works with no server running, and is one more piece of state to keep honest.

**Recommendation: the route.** `doctor` already asks the port rather than a file to find out
whether Raise is running, on the documented ground that the file is not the source of truth. The
same argument applies here, and with no server running there has been nothing asking the forge
anyway, so there is no answer to report.

### 4. What it must not do

- **Not a row-level indicator.** The existing comment is right that none of these is worth
  telling the user about *on a row*, and a per-card warning would be the second opinion the
  source ranking exists to avoid. This is a configuration problem, and `doctor` is where
  configuration problems are reported.
- **Not a guess at the cause.** Say what was observed - this many consecutive failures reading
  this repository - and let the user diagnose. Naming a probable cause would be asserting from
  indirect evidence, and the codes are individually misleading, so any guess would be wrong
  often enough to mislead.
- **Not a `fail` in `doctor` when the forge is switched off.** An optional integration's
  absence is not a degraded state. This reports only where the forge is on and asking.

### 5. Does the backoff change?

Probably not, and confirm it. The existing `FAILURE_BACKOFF_MS` already stops a failing lookup
repeating quickly. Whether a repository that has failed N times in a row should be asked less
often, or dropped entirely until the config changes, is worth a sentence either way - the
argument for dropping it is that we already know the answer, and the argument against is that a
credential can be fixed while the server runs, and the config watch would have to un-drop it.

---

## Deliberately not in scope

- **Diagnosing the credential.** Raise does not know which Atlassian account a token belongs
  to and should not try to find out - that would be a third outbound request, to a third host.
- **Any change to what is asked of a forge.** The scope stays `read:pullrequest:bitbucket`, and
  GitHub keeps going through the user's own `gh`.
- **Repairing the config.** `raise enable forge` already declines to accept a token on the
  command line, deliberately, and this item does not reopen that.

---

## Acceptance

- A repository whose lookups have failed N consecutive times with no success is reported by
  `raise doctor`, naming the workspace and repository.
- A single failure, or a failure followed by a success, is reported nowhere - asserted by a
  test, since it is the absence of an alarm and would otherwise be lost.
- `doctor` makes no forge request of its own, asserted by the same `fetch: () => assert.fail()`
  guard the server tests use.
- A machine with the forge switched off reports nothing about it, and runs nothing looking for
  it.
- `npm test`, `npm run lint` and `npm run typecheck` pass.
