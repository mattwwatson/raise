---
ticket: RAI-8
status: shipped
shipped: 2026-08-12
size: S
depends: RAI-6
branch: RAI-6-readme-RAI-7-tools-RAI-8-contribution
---
# RAI-8 - Decide the contribution posture and write it down

The decision itself is **Phase 0.3** of [`RAI-1-open-source-release.md`](RAI-1-open-source-release.md),
taken before publishing rather than under pressure afterwards: **yes to contributions, with a
stated bar.** This ticket writes it down. Three files land - `CONTRIBUTING.md`, `SECURITY.md`,
and the amendments to `AGENTS.md` that [RAI-2] deliberately left soft pending this decision.

Third item on `RAI-6-readme-RAI-7-tools-RAI-8-contribution`, at Matt's request. The branch names
every key it carries, so Jira links and transitions all three; `tasks:gate` still reads only the
first, so this file saying `shipped` is held by convention rather than by CI. See RAI-7's spec,
which records the shape once for all three.

## The bar, and why it is that bar

A new terminal is **one entry in `src/focus/terminals.js`** - a `name`, a `label`, an optional
`termProgram`, an `isAvailable`, a `focus`, and an optional `focusByTitle` that a terminal
hosting tmux in control mode needs. That is the whole `Terminal` interface. The
architecture was shaped for this, so the bar can afford to be specific:

1. **The entry, and nothing else in the codebase moves.** If adding a terminal needs a change
   anywhere else, the abstraction is being broken - and the contributor should say so rather
   than working around it, because that is a bug in the seam and not in their patch.
2. **A test using the injected command runner.** `test/focus.test.js` has `fakeExec`, which
   answers from a table and records what it was asked. This is what lets the suite assert on
   the AppleScript that *would* have run without stealing the runner's focus mid-test.
3. **You are running the terminal you are adding.** This is the resolution of a tension in
   `AGENTS.md`, not a new rule - see below.

### The tension this resolves

`AGENTS.md` says an adapter for a terminal nobody is on *"cannot be exercised against a real
session, so it is guesswork in the shape of support"*. That is correct and stays. Read as a
contribution policy it says the opposite of what is intended, which is what [RAI-2] softened
without being able to fix.

The resolution is that **a contributor adding Ghostty is, by definition, somebody who is on
Ghostty.** The objection was never to the terminal - it was to writing support nobody can
exercise. So the rule becomes a requirement on the contributor rather than a refusal of the
contribution, and `AGENTS.md` now says so and points here.

The same reasoning carries to a **Linux focus path**, which Phase 0.4 declined to build for
launch on the grounds that X11 needs `wmctrl`/`xdotool` and Wayland has no portable answer.
Declining to build it speculatively is not declining a patch from somebody running it. The
scope boundaries that genuinely stay closed are different in kind and are listed as such -
auth, multi-user and remote access each turn a local page into a service.

## Decisions taken on pickup

### Issues and pull requests are named as GitHub, ahead of the repository existing

`https://github.com/mattwwatson/raise`. Matt's call. This is the opposite of the call made for
the README's install block, which stayed on the working Bitbucket clone URL rather than
promising an unpublished npm package - and the two are worth holding side by side, because the
inconsistency is real for as long as it lasts.

The difference that justifies it: the install command is something a reader **runs**, so it
fails in their terminal, whereas a contribution destination is something they **read** before
deciding to write anything. **[RAI-5] closes the gap in both directions** and must not ship
without doing so - see the hand-off below.

### `SECURITY.md` is written here, not left to RAI-5

Phase 3.4 only said *consider*. It is in scope because this tool runs `osascript`, merges hooks
into somebody's agent and reads their transcripts, and a reader who wants to report something
about that looks for exactly that filename. The README's Security section already carries the
substance; what it has never had is a **route**, and a disclosure route invented in the moment
somebody needs it is one nobody uses.

**Private reporting goes through GitHub's own advisory flow rather than an email address**, so
no personal address is published, and it is the route a security-minded reader tries first. It
must be switched on for the repository - see the hand-off.

### The roadmap link in the README is replaced, because it was a dead end

Found while writing this: `README.md` pointed every reader at the Jira board, which is on a
personal Atlassian site. Verified anonymously on 12/08/2026 - the board URL returns HTTP 200
because Jira serves a single-page shell to anyone, and the project API underneath returns
`No project could be found with key 'RAI'`. So a stranger following the one link the README
offers about future work meets a login wall.

The specs in `docs/tasks/` are in the repository and readable by anyone, so the section now
points there and says plainly that ordering lives in a tracker that is not public. Saying it is
private is the part that matters: a reader who is told where the priority order lives is
informed, and one who is silently handed a login screen concludes the project is careless.

## Deliberately not done

- **No CLA and no DCO.** MIT, and a line saying a contribution is offered under it. Anything
  heavier is process for a project with no contributors yet, and it deters the first one.
  `CONTRIBUTING.md`'s closing line is backed by the `LICENSE` file
  [`RAI-3-rename-to-raise.md`](RAI-3-rename-to-raise.md) added in its packaging pass, so nothing
  here cites a licence the repository does not carry.
- **No pull request template and no code of conduct.** Each is defensible and neither is
  load-bearing before there is any traffic. Add them on evidence.
- **No issue templates, and the `contact_links` entry that would intercept a vulnerability filed
  as a public issue goes to [RAI-5]** along with the rest of the GitHub move. `SECURITY.md` only
  reaches somebody who thinks to look for it, so that entry is worth having - but GitHub does not
  document whether the chooser it renders in appears at all for a repository with a `config.yml`
  and no templates, so it needs a real template beside it and is more than one file.
- **No promise about response times.** An unmet one is worse than none.

## Hands to RAI-5

**Private vulnerability reporting is enabled**, verified `{"enabled": true}` on 12/08/2026, so
the `/security/advisories/new` route this ticket documents resolves rather than 404s. It requires
the repository to stay public. `github.com/mattwwatson/raise` exists, is public and is empty.

Everything else this ticket could not close is **recorded on [RAI-5] as a comment**, that being
where the Bitbucket-to-GitHub move actually happens - Matt's call on 12/08/2026, and Bitbucket is
not kept. In short: the README's install block must move to GitHub, closing the inconsistency
above in both directions. The comment also carries what the move itself touches - the pipeline
file, the no-mistakes push target and the spec-link convention - none of which is this ticket's
to start.

## Acceptance

- `CONTRIBUTING.md` states the terminal bar, the three gates, and the zero-runtime-dependency
  rule as non-negotiable rather than as a preference.
- `SECURITY.md` gives a private route and describes the trust boundary honestly.
- `AGENTS.md` no longer reads as refusing a real contribution, and points at `CONTRIBUTING.md`.
- No link in any of the three, or in the README, lands a reader on something they cannot open -
  except the GitHub repository itself, which is [RAI-5]'s to create.
- `npm test`, `npm run lint`, `npm run typecheck` and `npm run tasks:links` all pass, and the
  first three are untouched, this being documentation only.

## Implementation notes

`CONTRIBUTING.md` and `SECURITY.md` landed as specified, along with the two `AGENTS.md`
amendments. Three things happened that the spec did not anticipate, and one of them is a defect
this ticket fixed on the way past.

**The README's roadmap link was a dead end, and it was found by asking rather than assuming.**
The section invited every reader to a Jira board on a personal Atlassian site. The board URL
returns HTTP 200 to anyone, because Jira serves a single-page shell before it checks anything -
so a casual look says the link is fine. The project API underneath returns
`No project could be found with key 'RAI'` anonymously, which is what settles it. **A 200 is not
evidence that a page works**, and that is worth carrying: this is the documentation equivalent of
the liveness rule the product itself is built on, where the absence of an error is never taken
for positive evidence.

**Private vulnerability reporting was off, so `SECURITY.md` documented a route that 404'd.**
Enabled by Matt during the work and verified `{"enabled": true}` rather than assumed. It requires
the repository to stay public, which is now a standing condition on a file in the repository -
noted here because nothing in the codebase can check it.

**The spec-link convention turned out never to have worked**, discovered while attaching the
links this ticket's own spec would need. 14 tickets carry one; 13 name the pre-rename slug and
would 404 for the maintainer, and all 14 point into a private Bitbucket repository that answers
404 anonymously. Not one has ever resolved for a reader. The rule the skill was missing - the
link follows the *spec*, not the ticket, so an epic child correctly has none until it is picked
up - is now written down, along with an instruction not to add Bitbucket links while the move is
pending. Rewriting the set is [RAI-5]'s, on the GitHub URL that makes them resolve.

**The `contact_links` idea was raised, explained and parked.** It would intercept somebody about
to file a vulnerability as a public issue, which is the one reader `SECURITY.md` cannot reach.
It is on [RAI-5] with the caveat that decides its shape: GitHub does not document whether the
chooser it renders in appears at all for a repository with a `config.yml` and no templates, so it
needs a real template beside it and cannot be verified until the code is on GitHub.

[RAI-2]: https://mattwwatson.atlassian.net/browse/RAI-2
[RAI-5]: https://mattwwatson.atlassian.net/browse/RAI-5
