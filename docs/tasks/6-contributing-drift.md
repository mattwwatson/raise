---
issue: 6
status: shipped
shipped: 2026-08-13
size: S
depends: -
branch: fm/raise-6-contributing-drift
---
# 6 - CONTRIBUTING.md restates inventories AGENTS.md owns, and nothing catches them drifting

`CONTRIBUTING.md` states four bars verbatim that `AGENTS.md` also states: the exact three
devDependencies, the `REPORTABLE_FIELDS` privacy boundary, the no-synchronous-child-process
rule, and the terminal-adapter conditions. All four are true today.

The risk is one-sided in a way that matters. When one side moves, the copy that goes stale is
the one written specifically for somebody who has **not** read `AGENTS.md` - so the only reader
positioned to notice the contradiction is the one reader who never sees both.

## The duplication stays

Turning those bullets into pointers would solve the drift by deleting what made them useful:
sending a first-time contributor into a 120KB architecture file to find out whether their patch
will land is the opposite of what a contribution policy is for. `CONTRIBUTING.md` states a
self-contained bar on purpose.

**So the goal is to make drift detectable, not impossible.**

## Only one of the four can honestly be pinned

- **The devDependency list is enumerable**, so a test can assert it against `devDependencies` in
  `package.json`. That is exactly the "a fourth devDependency arrives" case, caught precisely,
  on disk, with no dependency and no network - the same shape as `tasks:links`, which exists for
  the same class of problem: a true statement going quietly stale.
- **The three prose rules cannot be.** Pinning them would mean a brittle string match on a
  paragraph that is *allowed* to be reworded, and a check that fails when somebody improves a
  sentence is one the next person learns to ignore. They stay as deliberate duplication with the
  risk stated here.

`REPORTABLE_FIELDS` was the one worth checking rather than assuming, because its contents *are*
enumerable from `src/hook-payload.js`. **Today `CONTRIBUTING.md` only describes the rule** - it
names the constant and the file and says it is an allowlist, and never lists a field. So there
is nothing to pin, and the check is not extended speculatively. If that copy ever names the
fields, the same test shape applies to it.

## Non-goals

- **Any general keep-two-documents-in-sync mechanism.** Three of the four items are prose. A
  check that can only honestly cover one of four should cover that one and say so, rather than
  growing into something that looks comprehensive and is not.
- **Extending the assertion to `AGENTS.md`'s own copy of the list.** It carries the same three
  names and could be anchored identically, but it is the owner of record rather than a copy, and
  its reader is the person who would notice. The failure this item is about is a stale claim in
  front of a reader who cannot notice; adding a second assertion here would be that general
  mechanism arriving through the back door.

## Where the check lives: `test/`, not a fifth `scripts/tasks.js` command

The issue left this open and named both sides: it is a documentation check rather than product
behaviour, which argues for `scripts/`; it needs no tracker, no credential and no tree walk, and
is one less command to remember, which argues for `test/`.

Reading the code settles it in favour of `test/`, and more specifically in favour of an existing
file. **`test/docs-claims.test.js` already owns this exact job** - "every claim these three
documents make about the repository has to be true" - and already reads the real `AGENTS.md`,
`CONTRIBUTING.md` and `README.md` off disk rather than a fake tree, for the reason stated in its
own header: the claim under test is about this repository's actual contents. A second mechanism
asserting a second kind of claim about the same three files would be the split the placement
rule exists to prevent.

The `scripts/` alternative also carries a cost the issue did not weigh: `tasks:gate` and
`tasks:links` run in CI because they are named in `.github/workflows/ci.yml`, so a fifth command
means an npm script, a CI step and a line in two documents - more moving parts than the check.

## Making it fail for the right reason

A test that parses prose can fail because somebody reworded a sentence, and that is the failure
mode to design against. Five choices do the separating:

1. **The bullet is found by its bold lead-in containing the word "devDependency"**, not by
   position or by matching the sentence. The surrounding prose can be rewritten freely.
2. **Only the enumerating sentence is read** - the bullet text up to its first sentence end.
   That is where the names are; the sentences after it are about formatters and bundlers and
   are allowed to say anything.
3. **Only npm-package-shaped backticked tokens count.** `` `npm run typecheck` `` contains
   spaces and is not one, so it is skipped without needing an exemption list.
4. **A token ending in a file extension is not a package name.** `` `package.json` `` is
   package-name-shaped on every character, and the neighbouring bullet already writes it, so a
   rewording that mentions the file inside the enumerating sentence would otherwise yield a
   fourth name and a failure telling the author to fix a list that is correct. This is a rule
   about **shape** and deliberately not the package-name exemption list rejected in item 3 - an
   exemption list is a second inventory to keep in step, an extension is not, and a scoped name
   like `` `@types/node` `` keeps its slash segment and has no dot to match on.
5. **A name written twice in that sentence counts once.** A repetition in prose is never an
   inventory of two, and reporting one as drift is the same false failure as item 4.

And the anchor failing is itself a failure, loudly: if the bullet is ever renamed away, the test
says the check needs re-anchoring rather than passing over a document it can no longer read. A
silent no-op check is the quiet staleness this project is built against, wearing a green tick.

**A parse that finds the anchor and no names is the same failure and gets the same message.** It
is reachable by a rewording the design promises to survive - a bold lead-in carrying no full stop
of its own leaves the sentence split holding the clause after it, so the names sit one sentence
further on. Reported as an empty list it would blame the document for drift when what happened is
that the parser lost the sentence, which is the one failure a check like this cannot afford: the
whole of its value is that its message can be trusted.

## Acceptance

- Adding a fourth devDependency to `package.json` without updating `CONTRIBUTING.md` fails
  `npm test`, and the failure names both lists.
- Removing or renaming the anchor bullet fails with a message saying so.
- Rewording the prose around the list - the sentences about formatters, the trailing clause -
  does not fail.
- `npm test`, `npm run lint`, `npm run typecheck` green.

## Implementation notes

Shipped 13/08/2026, as seven tests in `test/docs-claims.test.js` - six on the parser and one on
the real documents - plus a paragraph in `AGENTS.md`'s *Maintaining this file*, beside the
sentence that already describes what that test file pins.

**Three of those six parser tests came from the pipeline's own review, not the first draft**,
and so did separators 4 and 5 above. The draft had the three separators the issue named and
treated an empty parse as a list, so a lead-in with no full stop in it and a sentence mentioning
`package.json` both reported a correct document as drift; a name repeated in the sentence did the
same. Each is a rewording the design had already promised to survive, which is worth recording
because the three were all the *same* mistake - the parser answering confidently about a sentence
it had not actually read. That is the failure this item exists to prevent, arriving in the check
written to prevent it.

**The drift was reproduced before the check was written**, per the house rule: adding a fourth
devDependency to `package.json` and running the suite. The failure names both lists in one
sentence and diffs them, so the message says which side moved without anybody opening two files.

**`CONTRIBUTING.md` is unchanged.** Nothing in it was wrong - the whole finding was that nothing
was watching it - and adding "this list is machine-checked" would be a sentence for the
maintainer inside the document written for the contributor.

**The branch is `fm/raise-6-contributing-drift`**, so its key is not in an anchored position and
`tasks:gate` reads it as untracked and passes. The spec says `shipped` anyway, because the
convention is about the item rather than about what the gate happens to be able to see.
