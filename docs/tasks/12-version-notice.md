---
issue: 12
status: shipped
size: M
depends: -
branch: fm/12-version-notice
shipped: 2026-08-13
---
# 12 - Nothing tells anyone a new version exists

npm has no push mechanism. A published version sits in the registry and an existing install
stays on whatever it has until somebody reinstalls or happens to notice it in `npm outdated -g`.
For a monitor that is worse than the usual case: the fixes that matter most here are the ones
that stop a row asserting something untrue, and the people running the version that does it are
exactly the people who will never hear.

**And it cannot simply be added, which is the whole reason it is a ticket.** `README.md` says,
of the default configuration, that Raise makes no outbound network request of any kind. That
sentence sits beside *no runtime dependencies* and is aimed at the reader deciding whether to
let this program merge hooks into their agent's settings. An update check is an outbound
request, so adding one naively makes the strongest claim in that section false - the exact
failure this project is built against, turned on its own documentation.

The shape that survives it is the one [RAI-13](RAI-13-pr-state-from-forge.md) already settled
for the forge lookup, and it is followed here rather than re-derived: **off unless
`~/.raise/config.json` says otherwise, silent in every failure, exactly one host contacted, and
the README stating precisely what leaves the machine.** The claim about the default survives
because the feature is off by default, and the README's wording is scoped to say so rather than
left to be true by technicality.

---

## The two decisions the issue asked to be settled here

### 1. How often - at most one request a day, and a notice on every `serve` start

**Ruled: the *asking* is capped at once per `UPDATE_CHECK_INTERVAL_MS` (24 hours) across the
whole installation, remembered in `~/.raise/update-check.json`. The *telling* happens on every
`raise serve` start for as long as a newer version exists.**

Reading the code changed which of the issue's two options looked obvious, and it is worth saying
why. *Once per `serve` start* measures the wrong thing in both directions. The page left pinned
for days is **one** start and therefore one request - not too often at all, which is the
opposite of the worry the issue raised. The case that genuinely is too often is the mirror
image: `serve` restarted repeatedly - a changed `--port`, a crash loop, a login item plus a
manual run, a wrapper script - each restart another request for an answer that moves at most
every few weeks. Tying a request to a process start ties it to something with no relationship at
all to how fast the answer changes.

So the two questions the phrase collapses are separated, and each is tuned against the thing it
actually depends on:

| | Tuned against | Answer |
| --- | --- | --- |
| How often we **ask** | how fast npm's answer changes | once a day, cached on disk |
| How often we **tell** you | how the `serve` banner is read | every start, while it is true |

The cache is what makes the second free: restart `serve` ten times in an afternoon and you get
ten notices and one request. And every start is right rather than nagging - the banner is read
every start, a notice printed once and scrolled past is a notice nobody acted on, and it stops
the moment you upgrade.

This is `PR_STATE_FRESH_MS`'s shape, as the issue suggested, with one difference worth stating:
that constant is tuned against no-mistakes' observation cadence and re-tuning it means
re-measuring. This one is tuned against a release cadence, so it is deliberately coarse and a
day either way costs nothing. A notice up to 24 hours late is the right trade for a problem
measured in weeks.

**Rejected: re-checking on an interval inside the running server.** There is nowhere for the
answer to go. The banner has scrolled away, the page is ruled out by the issue and rightly so,
and a request whose answer nothing can print is a request with no consumer.

### 2. Where it surfaces - `serve` says it, `doctor` reports it and never asks

**Ruled: `raise serve` prints the notice. `raise doctor` reports the state from the cache and
makes no request of its own. `raise status` gets nothing, and the dashboard gets nothing.**

`serve` is the one that is read. It already prints a banner, and already uses that banner to say
a setup could be better - the hooks-missing and hooks-out-of-date blocks are the same register,
and one more line in it costs nothing to a reader who has upgraded while being exactly where the
reader who has not will see it.

`doctor` gets a line too, because a diagnostic that silently omits a check is one the reader
cannot see was made - the same reason the Node line stays in `doctor` after `bin/raise.js` made
it unreachable. But it is a different act from `serve`'s: **doctor reads the cache and never asks
the registry.** Doctor is where you go when something is already wrong, which is frequently with
no network, and a doctor that pauses to time out a request nobody is blocked on is a doctor
people stop running. It also keeps the request count honest - the number of outbound requests is
a function of elapsed time and never of how many commands you typed.

`status` is deliberately silent. It is a one-shot summary of sessions, it is the command most
likely to end up in a loop or a script, and a version notice printed above somebody's session
list is precisely the nag this is trying not to be.

---

## What leaves the machine, exactly

One HTTPS `GET` to **`https://registry.npmjs.org/raise-cli/latest`**, at most once a day, and
nothing else ever. One header of ours, `accept: application/json`, which says nothing about the
machine it came from. No query string, no version number, no machine or user identifier, no
package list.

What the registry can therefore see is an IP address, a timestamp, and the fact that somebody
asked about `raise-cli` - which, since nobody else has a reason to ask about that package, is as
good as saying that a machine at that address has Raise installed. It cannot see **which**
version: the comparison happens locally, against the `version` in the installed
`package.json`.

That is a small disclosure and it is not nothing, and the README section that makes a virtue of
sending nothing states it in those terms rather than leaving a reader to discover it. It is the
second outbound request in the product's history and the second one that is off by default; the
sentence about the default is rescoped to cover both rather than quietly narrowed to stay true
of one.

---

## Shape

**`src/user-config.js` (new) owns `~/.raise/config.json` and its safety rule.** That read - stat,
refuse a group- or other-readable mode, parse - was `forge-config.js`'s, and its own header
describes it as *"reading the one file a user writes, and refusing to read it when it is
unsafe"*, which was always a fact about the file rather than about the forge. There are two
consumers now, so it moves to a module that owns the file and `forge-config.js` interprets its
own block out of what that returns. `config.js`'s `forgeConfigPath` becomes `userConfigPath` for
the same reason.

**The whole file is still refused when its mode is unsafe, update block included, even though
that block holds no credential.** A safety rule with an exception is one nobody can state in a
sentence, and it is the exception the next person deletes while tidying. One file, one rule.

**`src/update-check.js` (new) owns the opt-in, the query, the cache and the comparison.**
Everything external is injected - `fetch`, the clock, the file access - so the suite asserts on
the request that *would* have gone out without one going out.

**The check runs in `src/cli.js`'s `serve` command and nowhere else in the running product.**
`server.js` gained no code, so the `fetch: () => assert.fail('no outbound requests from the
server')` guard sitting beside the `exec` guard on every server test is exactly as it was and
still proves what it proved before. What did change there is two comments, narrowed once it was
clear the guard proves a server whose `forge` block is off makes no request rather than that
the server never makes one - the history is under
[Implementation notes](#implementation-notes). Nothing under `hooks/` imports any of this: the
hook and the pi extension run inside somebody else's agent and are governed by stricter rules,
and a notifier there was a non-goal of the issue.

**The notice is fired and never awaited.** `serve` starts the lookup as soon as the server is
listening, prints its banner without waiting, and prints the notice when the answer arrives -
which for the overwhelmingly common cached case is the same tick. It lands below `Ctrl-C to
stop` rather than inside the banner block, because a line that has to wait for an answer cannot
be printed before one.

### Every failure is silent, and is remembered

Offline, a timeout, a 404, a rate limit, a body that is not JSON, a version string neither side
can parse: each prints nothing and leaves `serve` byte-identical to today. The attempt is
stamped in the cache whether or not it answered, so a machine that is offline makes one attempt
a day rather than one per `serve` start. There is deliberately no shorter failure interval - the
forge's `FAILURE_BACKOFF_MS` exists because that lookup retries on a one-minute cadence, and
here a second constant would be a second thing to reason about for an answer nobody is waiting
on.

### Comparing versions without a dependency

`isNewerVersion` compares `major.minor.patch` numerically and treats a pre-release as lower than
its own release. Anything it cannot parse on either side returns `false` - fail closed, because
the cost of saying nothing is that somebody upgrades a week later and the cost of guessing is a
monitor asserting something untrue about itself.

---

## Definition of done

```sh
npm test
npm run lint
npm run typecheck
```

Plus: with no `~/.raise/config.json`, `raise serve` and `raise doctor` make no request at all,
and there is a test that fails if either does.

---

## Implementation notes

### What the building changed

**`~/.raise/config.json` gained a second reader, so the file grew a module of its own.**
`src/user-config.js` is new and holds the stat, the mode refusal and the parse;
`forge-config.js` keeps the `forge` block and `update-check.js` reads `updates`.
`config.js`'s `forgeConfigPath` is now `userConfigPath`. Nothing about the rule changed, which
was the point of moving it: a safety rule enforced in two places is one that eventually is not.

One property had to be carried across deliberately. `ForgeState#observe` notices a changed file
by comparing config objects **by identity**, so `watchForgeConfig` caches its interpretation
against the `UserConfig` object `watchUserConfig` returns rather than re-deriving it each poll.
Without that every poll would look like a change and drop the fifteen-minute failure backoff,
which is the one thing that backoff exists to prevent - a bug the existing forge tests would
not have caught, since none of them polls twice over an unchanged file.

That gap is now closed rather than only noted. `test/forge-config.test.js` asserts the identity
directly, with `assert.equal` on two successive reads of an unchanged file and `assert.notEqual`
across a change - the converse mattering just as much, since a cache that never invalidated
would satisfy the first assertion alone. The parse count the neighbouring test asserts could
never have caught it: re-deriving from a cached read costs no read.

**The mode-refusal sentence now says a credential *can* be there, not that it is.** It is
printed by every feature the file turns on, and one of them holds nothing secret, so a file
carrying only `{"updates": {"enabled": true}}` was being told it held a credential. What makes
the mode wrong is what the file is for.

`raise doctor` prints that one sentence twice when the mode is unsafe, once per feature, and
that is deliberate rather than an oversight. A reader scanning the list for `Update check` gets
its answer on its own line instead of having to correlate it with another; the duplication is
the same call the untracked-row explanation makes.

**The `forVersion` field the design sketched was dropped, because it was solving nothing.**
`latest` is a property of the registry rather than of this install, so a record written under
0.1.0 stays exactly as true after an upgrade, a downgrade, or on a checkout whose version is
ahead of anything published - `isNewerVersion` answers all three correctly from the same two
numbers. The cache is `{checkedAt, latest}` and nothing else.

**The doctor line carries its own age**, because *"up to date"* read off a cache is a claim
about somewhere else made from a reading taken some time ago - the quiet staleness this codebase
is built against, in its smallest possible form. It reads `0.1.0 is the latest, as of 3h ago`.
Two cases that have no age of their own say so instead: enabled but never yet asked, because
`serve` has not run since it was turned on, and a check that ran and got no answer. That last
one is a `warn` rather than an `ok` for the same reason - Raise does not know, and saying `ok`
would be claiming it does - even though there is nothing for the reader to do, which the detail
says.

**A fourth case joined them: a version `doctor` could not read.** `packageVersion` returns
`UNKNOWN_VERSION` when it does not come back with a usable version string, and `isNewerVersion`
fails closed on anything it cannot rank - correctly, since that is what keeps `serve` quiet
rather than nagging off a number it does not have. Read as a report, though, that same `false`
reached the "up to date" branch and printed `unknown is the latest, as of 3h ago`: a green claim
that this install
is current, made from a version Raise never read. `raise --version` printing `unknown` is not
the same act - it reports ignorance honestly. The failing-closed rule is unchanged; what changed
is that one reader no longer mistakes it for currency.

**Keying that branch on the sentinel was the wrong axis, though, and review caught it.** An
unreadable version is only one of the two ways `isNewerVersion` returns `false` without having
compared anything: it also declines to rank two pre-releases of the same release, so a machine
on `0.2.0-rc.1` against a `latest` of `0.2.0-rc.2` got the same green *"is the latest"* the
sentinel case had just been rescued from. The branch is therefore gated on **rankability**
rather than on the sentinel, through `canCompareVersions` beside `isNewerVersion`, and the
sentinel falls out of it for free - `unknown` is a string no `SEMVER` parses. The honest word is
*"cannot be ranked against it"* and not *"could not be read"*, because the two roads to this
branch are one fact: there is no comparison to report. `serve` needs none of this; staying quiet
is the right answer to both, and only a report has to tell them apart.

Identical pre-releases are the one pair let through: they are the same version, so somebody
sitting on exactly the published release candidate is told they are current rather than fobbed
off with a refusal. That is knowable without ranking anything.

Chasing that down moved the sentinel itself. `packageVersion` only produced `unknown` from its
`catch`, which is the *unreachable* half - the file it reads is the one Node resolves
`"type": "module"` from, so a `package.json` that will not parse takes the process down before
`src/cli.js` is imported at all. The reachable half is a `package.json` that parses and carries
no `version`: that returned `undefined`, which `raise --version` printed as the word and
`doctor` compared as a version. Both are the same fact - there is no version to be had - so
they now return the same sentinel, checked on the value rather than only on the read.

**The same false-currency shape had a third site, in the cache read.** `readUpdateCache`'s
JSDoc said a record stamped in the future was discarded, and it was not: the discard lived in
`newerVersion`'s `age >= 0`, so `doctor` - the other caller, which reports what it reads -
trusted a stamp from next week and dated it *"as of 0m ago"*, `ago` having clamped the negative
age into something that looked like a fresh reading. The rule now lives in `readUpdateCache`,
which takes an injected `now`, so both callers get it and the sentence is true where it is
written; `newerVersion`'s guard is gone as redundant, and the discarded record correctly reaches
doctor's "nothing asked yet" branch. Where a rule lives decides who obeys it.

**The claim about the `fetch` guard needed narrowing at three sites, and the first attempt at it
widened the claim instead.** `server.test.js`'s `fetch: () => assert.fail(...)` was described as
proving that Raise makes no outbound request; rewritten to say *this server* makes none,
configured or not, it became false, because `createMonitorServer` hands that injected `fetch`
straight to `ForgeState` and the poll calls `observe` on it every second. What the guard proves
is that a server whose `forge` block is off makes no request - it passes because every
`scratch()` points `RAISE_HOME` at an empty directory, not because the poll path cannot reach
the network. `src/server.js`'s header and the comment beside the injection say that, and
`AGENTS.md`'s safe-change rule, which is the canonical carrier, was the third site and says it
too. The update check is the one that genuinely lives outside the server.

### What was verified by hand

Exercised against a scratch `RAISE_HOME` on 13/08/2026, since the suite necessarily injects
everything: the default writes no cache file and makes no request at all; a seeded cache makes
`serve` print the notice and `doctor` warn; a real lookup answered from `registry.npmjs.org` in
under a second, wrote `{"checkedAt":…,"latest":"0.1.0"}` at mode `0600`, and correctly said
nothing; and a `0644` config file is refused with both features reporting it.

### Deliberately not built

- **No auto-update, and no offer of one.** The notice names the command and stops.
- **Nothing on the dashboard**, per the issue - the page is for sessions.
- **Nothing in the hook or the pi extension.** Neither imports any of this.
- **Nothing in `raise status`.** It is the command most likely to end up in a loop or a script,
  and a version notice above somebody's session list is the nag this is trying not to be.
- **No `serve`-time recheck on an interval.** The banner has scrolled away by then, so the
  answer would have nowhere to go.
- **Not the cheaper thing the issue names.** Cutting tagged GitHub releases so that watchers are
  told, and so that there is somewhere for release notes to live, costs no runtime code and no
  outbound request - and it is worth doing whether or not this shipped, since it reaches the
  people who never turn this on. It is a separate item and was not built here.
</content>
</invoke>
