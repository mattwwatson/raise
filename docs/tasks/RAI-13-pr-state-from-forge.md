---
ticket: RAI-13
status: backlog
size: L
depends: RAI-10
---
# RAI-13 - Read pull request state from the forge

**Self-contained brief.** No prior conversation needed. Written 06/08/2026.

**Prerequisite: `PR-STATE-FRESHNESS.md` lands first.** That fixes the symptom cheaply, with no
network and no credentials. This is the larger follow-on, and it should not be used to justify
skipping the small fix - a correct answer that needs no network is better than one that does.

**Design first, implement second.** Several decisions below are the user's, not yours. Bring
them back before writing the network layer.

---

## What and why

Today, pull request state comes from no-mistakes' database - a reading no-mistakes took at some
point and stopped refreshing when its run ended. The state word therefore ages, and the
existing design goes to some trouble to avoid asserting it once it cannot be trusted.

**The forge knows the answer for certain.** Asking GitHub or Bitbucket directly whether a pull
request is open, merged or closed replaces a cached guess with fact.

### This reorders a documented design decision

`AGENTS.md` currently ranks the sources: *live no-mistakes run > frozen database history >
transcript sighting.* A direct forge query outranks all three.

It also differs in kind from the transcript. The transcript **may only ever clear a block,
never assert one**, because it is indirect evidence. The forge is the opposite - it is the
authority on its own pull requests, so it **may assert**. That distinction should be written
into `AGENTS.md`, because the "only ever disprove" rule is load-bearing elsewhere and someone
will reasonably wonder why this source is allowed to do more.

---

## Design constraints

All from `AGENTS.md`, all non-negotiable.

**Off the poll path.** The precedent is `lavish-axi`, which takes ~1.7s and is therefore fired
at most once per `REFRESH_MS`, with the page using the last answer. A network round trip per
pull request per second is not acceptable. The work is naturally bounded - only pull requests
currently rendering a chip need checking, typically nought to three.

**Asynchronous only.** `execAsync` / `tryExecAsync`, never `spawnSync`. The server polls on a
1s timer, pushes a stream and answers hook posts that time out in 2s; one blocking call stalls
all three. `server.test.js` injects an `exec` that fails the test if called - **do not weaken
that guard.**

**Injected runner.** Never import `src/exec.js` from the module that shells out. Take the
runner as a parameter and default it at the edge (`bin/`, `server.js`), so the suite asserts on
the command that *would* have run without touching the network. A test that hits a real forge
does not belong in this repo.

**Zero runtime dependencies.** `dependencies` in `package.json` stays empty. That means the
`gh` CLI for GitHub and Node's built-in `fetch` for Bitbucket's REST API. No octokit, no SDK.

**Degrade silently and completely.** No `gh` installed, no credentials configured, no network,
a private repo, a rate limit - every one of these returns to exactly today's behaviour. No
warning banner, no repeated retries, no log spam. A user who never configures this must not be
able to tell the feature exists.

**Cache negative answers too.** A repo the user cannot authenticate to must not be re-queried
every interval forever.

---

## Credentials: the rule this feature exists under

**Never assume anything about the author's machine.** This is being prepared as an open source
tool, and the author's personal environment - his shell profile, his keychain, his
`~/.secrets.conf` - is not a specification. Hardcoding a variable name from it would work
perfectly for one person and silently do nothing for everyone else.

The line is *not* "no environment variables". It is **no assumptions drawn from one machine**:

| | |
| --- | --- |
| **Best - GitHub** | The `gh` CLI handles its own authentication. We store no credential, see no token, and have nothing to leak. Prefer this precisely because it keeps credentials out of our hands entirely |
| **Acceptable** | `GH_TOKEN` / `GITHUB_TOKEN` - genuine ecosystem conventions that any GitHub user may already have, not one person's setup |
| **Bitbucket** | No ubiquitous CLI exists, so this needs explicit configuration: opt-in, documented, minimum scopes (pull request read - confirm the actual minimum against Bitbucket's docs rather than guessing), never logged, never echoed |
| **Forbidden** | Any variable name taken from the author's own configuration and treated as universal |

**Tempting shortcut to refuse: no-mistakes already holds Bitbucket credentials.** Borrowing
them would re-couple this tool to the one that Phase 1 deliberately made optional, and would
break for every user who does not run no-mistakes. Do not do it.

**Never print a token to verify it.** `${VAR:+SET}${VAR:-UNSET}` looks like a presence check
and is not - `:-` substitutes only when unset, so a set variable prints its value.

---

## Privacy: this changes a claim the README makes

`README.md` currently states, of the transcript feature: *"Nothing leaves your machine."*
`AGENTS.md` draws the same boundary: *"Reading a transcript is not the same as sending one, and
the difference is the rule."*

**This feature makes the first outbound network request in the product's history.** Querying
your own pull request is entirely defensible, but the claim as written stops being true, and
quietly weakening a privacy statement is worse than the feature is valuable.

Requirements:

1. **Opt-in.** Off by default. Turning it on is a deliberate act.
2. **The README says what is sent and to whom** - a pull request URL or id, to the forge that
   hosts it, and nothing else. No transcript content, no prompt text, no file contents, ever.
3. **The existing sentence is amended, not deleted.** The transcript boundary has not moved and
   should still be stated plainly; what changes is that one narrowly-scoped, opt-in lookup now
   exists alongside it.

---

## Open decisions - bring these back, do not choose them alone

1. **Is `gh` a hard requirement for GitHub support, or is a token path needed too?** `gh` is
   cleaner but not universally installed.
2. **Where does configuration live?** A file under the state directory is the obvious answer,
   but it will hold a Bitbucket token, so file mode matters - the existing token is written
   `0600`, and this should match.
3. **What happens when a forge answer contradicts no-mistakes?** Recommended: the forge wins
   and it is not worth surfacing the disagreement. Confirm.
4. **Does this run for pull requests with no live run at all** - the "was open, last checked 3d
   ago" case? That is arguably where it is most useful, since that reading is the most stale.
   It also widens the query set beyond the nought-to-three bound above.

---

## Definition of done

```sh
npm test          # no network in the suite - assert on the command that would have run
npm run typecheck
```

Plus: the feature fully disabled must produce byte-identical behaviour to today, and there must
be a test proving it.

Report the design decisions taken, the minimum scopes required for Bitbucket, and the exact
wording proposed for the README's privacy section.
