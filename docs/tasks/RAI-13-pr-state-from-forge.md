---
ticket: RAI-13
status: shipped
size: L
depends: RAI-10
branch: RAI-13-pr-state-from-forge
shipped: 2026-08-08
---
# RAI-13 - Read pull request state from the forge

**Self-contained brief.** No prior conversation needed. Written 06/08/2026.

**Prerequisite: [RAI-10](RAI-10-pr-state-freshness.md) lands first.** That fixes the symptom cheaply, with no
network and no credentials. This is the larger follow-on, and it should not be used to justify
skipping the small fix - a correct answer that needs no network is better than one that does.

> **RAI-10 has shipped, and it narrows this.** It asked whether a useful freshness threshold
> exists, on the understanding that if none did, the forge query became the only honest fix.
> One does: no-mistakes re-observes a live pull request every ~2 minutes (worst case measured
> at 112s), so a five-minute gate catches a dead monitor without ever firing on a healthy run.
> Two residuals are left for this item, and they are the whole of its remaining case:
>
> - the ~2 minutes between a merge and no-mistakes noticing, where the reading is honestly
>   fresh and honestly wrong;
> - **any pull request nobody is monitoring** - once the run finishes, or for one opened by
>   hand, there is no observer at all, and the page correctly goes quiet rather than guessing.
>
> The second is the bigger prize and is the one to design around. Read RAI-10's implementation
> notes before starting: the source ranking below is now stated in terms of `PullRequest.current`
> rather than `live`, and the measurements are recorded there.

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

## Investigation - what is established, before anything is chosen

Nothing here is a decision. It is the ground the four decisions stand on, and each item was
checked rather than recalled. Dated 07/08/2026, because two of them have a shelf life.

**1. Which forge is decided by the URL, and nothing new has to be read to know it.**
`PullRequest.url` is already on every row from all three existing sources. `github.com` goes
one way, `bitbucket.org` the other, and any other host gets nothing at all. No remote parsing,
no extra `.git` read, no new failure mode in `git-branch.js`.

**2. `gh` needs authentication even for a public pull request.** With no stored login and no
token, `gh pr view <public url>` exits **4** with *"To get started with GitHub CLI, please run:
gh auth login"*. So the test is never "is `gh` on PATH" - it is "did `gh` answer", which is the
same fail-closed shape the rest of the codebase uses.

**3. `gh` implements the `GH_TOKEN` / `GITHUB_TOKEN` convention itself**, in that precedence,
and says so in `gh help environment`. This is the fact decision 1 turns on: for anyone who has
`gh`, a token path in *our* code cannot change the answer, because `gh` already read the same
variable out of the same environment.

**4. The GitHub command is cheap and needs no checkout.**
`gh pr view <url> --json state,number,url` answers from any working directory - the URL carries
the repository - and returned in **0.55s** warm. States are `OPEN`, `CLOSED`, `MERGED`.

**5. Bitbucket app passwords are gone, not going.** Brownouts ran from 09/06/2026 and removal
completed **28/07/2026**. What is left is an Atlassian **API token with scopes**, sent as HTTP
Basic auth with the account email (`--user '{email}:{token}'`, per Atlassian's own example), or
a repository / workspace access token. Repository access tokens are scoped to one repository by
design, so they are useless to a monitor that watches every repo on the machine.

**6. The minimum Bitbucket scope is `read:pullrequest:bitbucket`, on its own.** Atlassian's API
token permission reference: *"Allows viewing of pull requests, plus the ability to comment on
pull requests"*, and explicitly *"does not imply the `read:repository:bitbucket` scope"*. That
non-implication is the good news - reading a pull request needs **no** repository read, no
source access and no workspace access. `GET /2.0/repositories/{workspace}/{repo}/pullrequests/{id}`
lists `pullrequest` (the classic name for the same thing) as its required scope. There is no
narrower option: Atlassian bundles commenting into the read scope, and Raise simply never writes.

**7. The Bitbucket credential is a *pair*, not an opaque string.** Basic auth needs the
Atlassian account email as well as the token. That is a design input for decision 2 rather than
a detail - it rules out "one line in a file", the shape `~/.raise/token` uses.

**8. Rate limits.** GitHub: 5000/hour authenticated. Bitbucket: **1000/hour** baseline for
repository data, measured against the user id on a one-hour rolling window. Bitbucket is the
binding constraint, and the volumes under decision 4 are nowhere near it.

**9. `src/exec.js` spawns with no `env` option, so every child inherits Raise's entire
environment.** That is `ps`, `tmux`, `osascript`, `gh`, `lavish-axi` and `no-mistakes axi
status` - several of them on the poll loop, every second. Anything in raise's environment is
handed to all of them. This is the fact decision 2 turns on, and it inverts the intuitive answer.

**10. No forge speaks Raise's vocabulary.** Bitbucket says `OPEN` / `MERGED` / `DECLINED` /
`SUPERSEDED`; GitHub says `OPEN` / `CLOSED` / `MERGED`; Raise and no-mistakes say `open` /
`merged` / `closed` / `none`. Two normalising boundaries, so two typedefs for data arriving from
outside, per the convention in `AGENTS.md`.

---

## The four decisions, with the rule each turns on

**Decided. All four were put to the captain with the recommendations below, and all four came
back as recommended - with one narrowing, on decision 1: `gh` is the whole GitHub path and no
token path was built.** What is recorded below is the reasoning as it was put; the
[implementation notes](#implementation-notes) record what changed in the building.

### 1. Is `gh` a hard requirement, or is a token path needed too?

*Reading A:* `gh` is the whole GitHub path. One route, and no credential ever enters our process.
*Reading B:* `gh` first, with a REST call on `GH_TOKEN` / `GITHUB_TOKEN` when `gh` is absent.

**The rule is not "how many paths" - it is whether Raise ever holds a GitHub credential it was
not already handed.** Paths are cheap here: the Bitbucket half needs a `fetch` client regardless,
so GitHub over REST is one URL and two fields on top of something already built. Custody is what
is expensive, and it is what the spec's preference for `gh` is actually about.

By that rule the two readings are identical on the thing that matters - neither stores anything -
and **fact 3** separates them: `gh` reads `GH_TOKEN` and `GITHUB_TOKEN` out of the environment we
would hand it anyway, so reading the same variable ourselves takes no custody `gh` was not already
taking. The env path is therefore not a second way to answer the question; it is the same answer
when the CLI is not installed.

*Recommended:* B, as one branch - `gh` first, the REST call only when `gh` is absent.

**Ruled: A. `gh` is the whole GitHub path, and the reason given is a better one than the
recommendation's.** Not custody, which the analysis above shows the two readings tie on -
*durability*. `gh` is the interface most likely to keep working across changes to GitHub's own
rules, and a second path built against the REST API is a second thing to keep current for a
case `gh` already covers. So there is no GitHub token path, and adding one later is a decision
to reopen rather than a gap to fill.

### 2. Where does configuration live?

The pieces are an opt-in switch and, from **fact 7**, a Bitbucket credential that is a pair.

*Reading A:* one file, `~/.raise/config.json`, `0600`, holding switch and credential.
*Reading B:* no file at all - switch and credential are both environment variables Raise
documents by name.
*Reading C:* split - the file holds the switch and the email, the environment holds the secret.

**The rule is fact 9.** Raise's own `exec.js` spawns children with the inherited environment,
on the poll loop, into `ps`, `tmux`, `osascript`, `gh`, `lavish-axi` and `no-mistakes`. **A
credential in Raise's environment is a credential handed to every one of those processes, for
as long as the monitor runs.** A credential read out of a `0600` file into a variable and put
into a `fetch` header is in one process and in no environment at all.

So the reading that *looks* safest - store nothing, use the environment - is the one that spreads
the secret furthest, and the only fix for it would be to make `exec.js` filter its environment:
changing the one place that runs commands to contain a credential we chose to put there. That is
the problem inverted.

*Recommended, and **ruled: A**.* `~/.raise/config.json`, written `0600` exactly as `readOrCreateToken`
already writes `token`, is the only place a Bitbucket credential lives. Raise **refuses to read
the file at all if its mode is group- or other-readable** and says so once - the ssh rule, and the
only thing that makes a documented `0600` more than a comment, since a file can be created
correctly and chmodded later. There is deliberately **no environment fallback for the Bitbucket
token**, so there is no accidental route into the child processes' environment.

The asymmetry with decision 1 is intended and worth stating in `AGENTS.md`: **GitHub's credential
may come from the environment because it is already there and `gh` would read it regardless;
Bitbucket's may not, because we would be the one putting it there.**

Two consequences that follow: `raise doctor` reports whether the feature is configured and whether
the file's mode is safe, and never any part of a value; and the configuration never enters the SSE
frame, which already excludes it by construction since only `Row` crosses.

### 3. What happens when a forge answer contradicts no-mistakes?

*Recommended, and **ruled: confirmed** - the forge takes precedence, and the disagreement is not
surfaced.* Two qualifications below are
the actual mechanism, and without them "the forge wins" reintroduces the bug RAI-10 just fixed.

**The rule is that the page shows one answer per fact.** This codebase refuses a second opinion
every time it has been tempted: an unplaceable run gets one card that admits it rather than three
that quietly disagree; a host we cannot name gets no chip rather than a guessed one. A "the forge
says merged, no-mistakes says open" annotation is a second opinion with nothing the reader can do
about it, and a page that argues with itself is one you stop believing - the same failure as a
confident wrong chip, wearing different clothes.

And there is nothing to surface anyway. A disagreement means exactly one thing - no-mistakes'
reading is older than the forge's - which `observedAt` already records and `current` already acts
on. It is not news.

1. **A forge answer ages exactly like no-mistakes' does.** *Forge wins* must not become *the forge
   answer wins forever*. A forge reading carries its own `observedAt` and goes through the same
   `prStateIsCurrent` rule; once it is older than the threshold it stops being presentable as
   current, and the row degrades the way everything else does.
2. **A failed lookup is not an answer.** No credential, no network, a rate limit, a 404 on a
   repository the token cannot see - none of those contradict no-mistakes, they say nothing. The
   row falls back to precisely today's behaviour. That is "degrade silently and completely" in its
   most literal form, and it is the case the negative cache exists for.

### 4. Does this run for pull requests with no live run at all?

*Recommended, and **ruled: yes**. It is the reason to build this at all.*

**The rule is that a source is worth adding where nothing else is answering.** RAI-10's
implementation notes settle where that is: a live run's reading is already bounded to the ~2 minute
observation cadence, while an **unwatched pull request has no observer whatsoever** - which is why
the page correctly goes quiet and offers only *"was open, last checked 3d ago"*. Restricting the
query to live runs would spend the product's first outbound request on the one case that is
already handled, and leave the case RAI-10 named as the bigger prize untouched.

**On the widening: the "nought to three" bound was a count of live runs, and the query set is not
that.** It is the set of **distinct pull request URLs currently on the page** - one `pr` per row,
deduplicated by URL because two sessions on one checkout carry the same review - which is bounded
by the row count and is single digits in practice.

Two rules bound it further, and both belong in the design:

- **A terminal answer is cached long.** A merged pull request does not un-merge, so once the forge
  says merged there is nothing left to ask. A closed one can be reopened, so it is cached long
  rather than forever. Only genuinely open pull requests are re-asked on the short interval - and
  those are exactly the ones the feature is for.
- **Negative answers are cached too**, per the spec. A repository the credential cannot see is
  asked once and then left alone, never re-asked every interval for the rest of the day.

At a 60s refresh over five open Bitbucket pull requests that is 300 requests an hour against the
1000/hour limit in fact 8, and noise against GitHub's 5000. The interval is the tunable if that is
ever wrong.

---

## Shape of the implementation, for veto before it is built

- **`src/forge.js`**, following `LavishState` exactly: constructed with `{execAsync, fetch,
  config}`, fired at most once per interval **off** the poll path, never awaited, the page using
  the last answer. Neither `exec.js` nor `globalThis.fetch` is imported there; both are defaulted
  at the edge in `server.js` and `bin/raise.js`.
- **`buildRows` gains a map of forge readings keyed by URL**, consulted ahead of the three existing
  sources. It stays pure - the readings arrive as a parameter, like `reviewUrls` does.
- **`server.test.js` gains a sibling to its `exec` guard**: `fetch: () => assert.fail('no outbound
  requests from the server')`. With the feature unconfigured that guard passing *is* the proof the
  Definition of done asks for, in the same shape the repo already trusts for `exec`.
- **`AGENTS.md`** gains the reordering the spec calls for - the forge outranks all three sources,
  and unlike the transcript it **may assert and not merely disprove**, because it is the authority
  on its own pull requests rather than indirect evidence about them.

## Proposed README wording

Two edits, neither of them a deletion.

**In "Every row says what it is about"**, replacing the last sentence of the paragraph at
`README.md:68`:

> That comes from the transcript Claude Code already writes, so it is quoted rather than guessed
> at. The transcript never leaves your machine: the server reads a local file and renders it on
> your own dashboard, in your own browser. Nothing else leaves it either, unless you deliberately
> turn on the one feature that asks a forge about a pull request - see [Security](#security).

**In "Security"**, a new paragraph after the one about the hook payload:

> **One optional feature sends anything at all, and it is off until you configure it.** Raise can
> ask GitHub or Bitbucket whether a pull request already on your dashboard is still open - once a
> no-mistakes run ends nothing is watching it, so a stored "open" can be days old. What goes out is
> that pull request's own URL, the one the row already links to, to the forge that hosts it.
> Nothing else: no transcript, no prompt text, no file contents, no branch names, no list of your
> repositories, and no request to any host other than the forge in the URL. With it off - which is
> the default - Raise makes no outbound network request of any kind. GitHub goes through your own
> `gh` login, so Raise never sees a GitHub credential at all; Bitbucket needs an API token with the
> single scope `read:pullrequest:bitbucket`, which grants no access to your source code, kept
> `0600` in `~/.raise/config.json`, never logged, never echoed, and never sent anywhere but
> Bitbucket.

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

---

## Implementation notes

### The shape it took

`src/forge.js` follows `LavishState` closely enough that the comparison is the fastest way in:
`observe` both answers and schedules, requests are fired and never awaited, and the page uses
the last answer. `src/forge-config.js` is separate because reading the file is a different
concern from using it, and because the mode refusal wanted tests of its own.

The one shape decision not in the design above: **the forge settles the state of a pull request
the existing chain has already identified, rather than being a fourth entry in that chain.**
`withForgeState` wraps the chain's result. Identifying *which* pull request a row has is
branch-gated, slug-checked local work that a forge lookup has nothing to add to - and making it
a fourth source would have meant the forge deciding identity, which is the failure mode the
three-source ranking spent RAI-15 and RAI-16 - now issues #2 and #3 - learning to avoid.

### Two things the building changed

**A `fetch` guard, on every server test rather than one.** The Definition of done asks for a
test proving the disabled feature is byte-identical. The pure half is one `assert.deepEqual` in
`dashboard.test.js`; the half that matters is `fetch: () => assert.fail('no outbound requests
from the server')` sitting beside the existing `exec` guard on all sixteen other server tests.
That is the arrangement `AGENTS.md` already trusts for `exec`, and it is what will catch the
future change that makes a request unconditionally rather than the one that makes it on purpose.

**The clock bug the tests caught, which is `lavish.js`'s documented mistake made again.**
Readings and backoffs were being stamped with `Date.now()` on the *return* of a request whose
window had been opened on the *injected* clock. Every test that moved time forward then saw a
backoff that had already expired, or one that never would. Everything is stamped from the
caller's clock at dispatch now, which is what `lavish.js` says to do and why. It also
understates a reading's freshness by however long the request took - the safe direction for the
field that decides whether we may assert.

### Three things review changed

**Decision 1 needed one exception, and it is the same sentence: freshness exists because an
answer can change.** *A forge answer ages exactly like no-mistakes' does* combined badly with
*a merged pull request is never asked again* - the one immutable fact became the only reading
guaranteed to expire, so the MERGED chip went five minutes after the merge was seen and stayed
gone. `merged` is now exempt from the gate; `open` and `closed` keep it. The general form of
that is the acceptance criterion the exception was found by: **this may never leave a row less
current than it found it**, so a stale forge reading does not displace a fresh local one either.

**The config file is re-read while the monitor runs.** It was read once when the server was
constructed, which meant `raise doctor` - which re-reads it every time - could report an opt-in
the poll loop had never seen. Three surfaces, one story: `ForgeState` takes a reader
(`watchForgeConfig`), the cost is one `stat` per poll, and only the positive case is cached so a
file written later is still noticed. A changed file also clears the failure backoff, so a
corrected credential is not a fifteen-minute wait.

**A settled lookup is no longer retained.** `#pending` existed for the one-shot CLI's `settle`,
which the server never calls - so `raise serve` accumulated a promise per lookup per pull
request per minute, forever. Each entry now removes itself.

### The minimum Bitbucket scope, and why it is better news than expected

**`read:pullrequest:bitbucket`, on its own.** Atlassian's API token permission reference:
*"Allows viewing of pull requests, plus the ability to comment on pull requests"*, and
explicitly *"does not imply the `read:repository:bitbucket` scope"*. That non-implication is
the part worth knowing - a token minted for Raise **cannot read the user's source code**, which
is a much easier thing to ask somebody to create. There is no narrower option: Atlassian bundles
commenting into the read scope, and Raise simply never writes.

Two facts with a shelf life, both checked on 07/08/2026 rather than recalled:

- **App passwords are gone**, not going: brownouts from 09/06/2026, removal completed
  28/07/2026. The credential is an Atlassian API token, sent as HTTP Basic auth with the
  account email - so it is a **pair**, which is why the config block has two fields and why
  `~/.raise/token`'s one-line shape could not be reused.
- **Rate limits**: Bitbucket 1000/hour keyed on the user, GitHub 5000/hour. Bitbucket binds, and
  the cadence chosen (a minute for open pull requests, never again once merged, fifteen minutes
  after a failure) puts a realistic page an order of magnitude under it.

### What is deliberately not built

- **No GitHub token path.** Ruled, and see decision 1 - it is a decision to reopen, not a gap.
- **No page marker saying an answer came from the forge.** One answer per fact; the chip has
  always been gated on one boolean and the forge just makes it true where nothing else could.
- **No warning banner.** A `problem` from the config reader reaches `raise doctor` and nowhere
  else, and is set only when somebody has evidently tried to configure this and it is not
  working. The page stays silent, the way it does about no-mistakes and Lavish.
- **No forge beyond github.com and bitbucket.org.** A GitHub Enterprise host is not github.com,
  and guessing would mean an outbound request to a machine the user never expected us to reach.
