/**
 * One real `fm-fleet-snapshot.sh --json` reading, reduced to three tasks and
 * redacted.
 *
 * **The reading is real and what was kept from it is its SHAPE.** It was taken
 * off a live firstmate installation on 19/08/2026, the same machine and the same
 * day `docs/tasks/25-firstmate-pending-decisions.md` measured, so that the two
 * cases this item turns on are asserted against what firstmate actually emits
 * rather than against a shape somebody imagined. What is exact is the structure:
 * the field names, the nesting, the schema id, how many decisions sit on one
 * task, the two verbs and which of them is last, the order they arrive in, and
 * the reconciled-away case. What is invented is every string that named
 * anything: the task ids, the decision keys, the summaries, the worktree paths,
 * the pull request URLs and the home.
 *
 * **What was removed is the crewmates' own words, and they are not coming
 * back.** The four summaries were written about a client engagement: they named
 * a private repository and its pull requests, quoted source paths and code from
 * it, and described an unfixed defect in a product not ours to discuss. **This
 * repository is public.** Nothing in the suite needs the real prose - the reader
 * keeps a summary as written and a test asserts it survives, which any non-empty
 * string proves.
 *
 * **The stand-ins are invented rather than paraphrased, and that distinction is
 * the point.** They are about a dependency audit, a cache rewrite, a CLI flag
 * and a schema migration - subject matter with no relationship to the original
 * at all. An earlier pass swapped the identifying nouns out of the real
 * discussion and left its defects, its follow-ups and its recommendations
 * standing, which reads as redacted and is not: what a crewmate was arguing
 * about is itself the confidential part. Only the length is kept from the
 * originals, so the fixture still exercises a realistic payload.
 *
 * **Do not replace the stand-in text with realistic-looking client content**,
 * however much a fixture full of real-sounding engineering detail looks like an
 * improvement over one that is obviously invented. It is not: the shape above is
 * the whole of what this file is evidence for, and the prose is the one part of
 * a fleet snapshot that can never be published. If a future reading is ever
 * needed for a new case, redact it on the way in - and invent the words rather
 * than rewording the ones that were there.
 *
 * **How to sweep one before publishing it, because the obvious method does not
 * work.** This is the check to run on any fixture built from a real reading, and
 * it has two halves:
 *
 *   - **Sweep the branch's ADDED lines only** - `git diff <base>..HEAD` and read
 *     what the change introduces, separately from what the repository already
 *     contained. A repository-wide grep buries a new identifier among hundreds
 *     of pre-existing hits, and you stop reading.
 *   - **WIDEN the patterns each pass; never re-run the ones that have already
 *     matched.** Re-grepping strings you already know about only confirms what
 *     you already know. It cannot find the thing you have not thought of, which
 *     is by definition the thing that gets published. Go from the names you
 *     redacted to the *categories* they belonged to: repository names, ticket
 *     keys, hostnames and URLs, absolute paths and usernames, commit hashes,
 *     people's names, product and domain vocabulary.
 *
 * That is not hypothetical advice. It is how the identifiers in this very file
 * were found, in three separate passes - the prose, then the surrounding fields
 * and a copy of one name that had reached the README, then the task ids and
 * decision keys. Each pass found something the one before it had missed, and
 * each time the file had already been declared clean.
 *
 * The two cases the fixture exists for:
 *
 *   - **`apx-412-build-and-cache-cleanup` carries four open decisions.**
 *     Three `needs-decision` and one `blocked`. Four rulings on a single
 *     crewmate is the ordinary case, not an edge one, and a renderer built for
 *     one would have shown a quarter of what was waiting.
 *
 *     Four is what upstream's fold returned from the status log this was read
 *     off, and the copy of firstmate on that machine returned one - it is 115
 *     commits behind, and its `_fm_decision_key` reads only the text before the
 *     colon while every crew line on disk writes the `[key=...]` token after it,
 *     so all four collapse onto the key `default`. Upstream fixed exactly that,
 *     citing its own issue #2109. **Nothing here works around it and nothing
 *     patches it**: against the older fold this feature is correct and merely
 *     under-reports, and a local change would be a divergence from a repository
 *     we do not own. The fold was reproduced independently to establish that the
 *     count is four rather than one; the keys below are invented, and what they
 *     preserve is that there are four of them, distinct, namespaced by their
 *     task, with the `blocked` one last.
 *
 *   - **`zed-207-nightly-index-rebuild` carries none.** Its status log held
 *     seven `needs-decision` lines that no `resolved` ever closed, and
 *     `open_decisions` is empty anyway, because firstmate reconciled the fold
 *     against live crew state and the run-step underneath it supersedes them.
 *     This is the case that makes consuming the snapshot right and folding the
 *     file ourselves wrong: a Raise that read the file would have shown seven
 *     ruling requests that no longer existed.
 *
 * `raise-25-firstmate-pending-decisions` keeps its real name. It is this
 * repository's own issue and this branch, so it identifies nobody's work but
 * ours, and renaming a public repository's reference to its own issue would cost
 * legibility for no privacy at all.
 *
 * `current_state` is carried even though nothing reads it, because it is the
 * evidence for the second case and a fixture that dropped it would leave the
 * test looking like an assertion about an empty array.
 */

/** @type {any} */
export const FLEET_SNAPSHOT =
{
  "schema": "fm-fleet-snapshot.v1",
  "generated": "2026-08-19T12:15:52Z",
  "fm_home": "/Users/x/work/firstmate",
  "tasks": [
    {
      "id": "apx-412-build-and-cache-cleanup",
      "kind": "ship",
      "paths": {
        "worktree": {
          "path": "/Users/x/.treehouse/example-webapp-09aa4f/1/example-webapp",
          "present": true
        }
      },
      "current_state": {
        "state": "parked",
        "source": "status-log",
        "detail": "needs-decision",
        "freshness": "fresh"
      },
      "endpoint": {
        "target": "firstmate:fm-apx-412-build-and-cache-cleanup",
        "exists": true
      },
      "pr": {
        "url": "https://bitbucket.org/example/example-webapp/pull-requests/318",
        "source": "meta"
      },
      "hints": {
        "pending_decision": true,
        "blocked_event": true,
        "open_decisions": [
          {
            "key": "apx-412-review-gate",
            "verb": "needs-decision",
            "summary": "Stand-in text. The dependency audit has parked the run on a choice I will not make for you. Four of the seven transitive packages we pull in only for the docs build have no maintained release, and the two ways out are not equivalent: pin the whole tree and carry the advisories with a documented exception, or drop the docs build to plain markdown and lose the generated API index nobody has opened in months. The pin is an hour and a recurring argument; the drop is a day and the argument stops. I have written both branches far enough to compare. The run stays parked until you pick one."
          },
          {
            "key": "apx-412-numbers-confirmed",
            "verb": "needs-decision",
            "summary": "Stand-in text. The cache rewrite is applied and the numbers hold: cold start is unchanged, warm start is down from 4.1s to 900ms, and the eviction test that used to fail once in twenty now runs a thousand times clean. Two things came back from the fix review. The first is mine and I am taking it: the key still includes the absolute path, so two checkouts of the same commit never share an entry, which is free to fix and halves the disk. The second is yours, because it changes behaviour a user can see - whether a corrupt entry is deleted silently or reported once. Silent is kinder and hides a real disk problem."
          },
          {
            "key": "apx-412-flag-ticket",
            "verb": "needs-decision",
            "summary": "Stand-in text. You asked in the session for the flag to be raised as its own ticket rather than folded in here. I have not filed it, because my brief says I do not write to the tracker myself. The drafted text: --dry-run currently prints what would change and then still writes the lockfile, because the writer is called from the exit handler rather than the command body, so the flag never reaches it. It is pre-existing, it predates this change, and the fix is to move the write into the command. Repro steps, the two affected subcommands and a proposed test are ready. Tell me to file it, or file it yourself."
          },
          {
            "key": "apx-412-migration-order",
            "verb": "blocked",
            "summary": "Stand-in text. Everything on this run is answerable except the migration ordering, which is the single thing holding the gate. The new index has to exist before the backfill reads through it, but the backfill is in the same migration, so on a large table the index build and the read contend and the whole thing times out at ten minutes. Splitting it into two migrations fixes the timeout and means a deploy can land between them, with the second not yet run - the state nobody has decided what should happen in. My recommendation is two migrations and a guard that refuses to start the backfill without the index. Yes or no and I will answer the gate."
          }
        ]
      }
    },
    {
      "id": "zed-207-nightly-index-rebuild",
      "kind": "ship",
      "paths": {
        "worktree": {
          "path": "/Users/x/.treehouse/example-scheduling-e90b80/1/example-scheduling",
          "present": true
        }
      },
      "current_state": {
        "state": "working",
        "source": "run-step",
        "detail": "validating",
        "freshness": "fresh"
      },
      "endpoint": {
        "target": "firstmate:fm-zed-207-nightly-index-rebuild",
        "exists": true
      },
      "pr": {
        "url": "https://bitbucket.org/example/example-scheduling/pull-requests/83",
        "source": "meta"
      },
      "hints": {
        "pending_decision": false,
        "blocked_event": false,
        "open_decisions": []
      }
    },
    {
      "id": "raise-25-firstmate-pending-decisions",
      "kind": "ship",
      "paths": {
        "worktree": {
          "path": "/Users/x/.treehouse/raise-758175/1/raise",
          "present": true
        }
      },
      "current_state": {
        "state": "working",
        "source": "pane",
        "detail": "harness busy",
        "freshness": "fresh"
      },
      "endpoint": {
        "target": "firstmate:fm-raise-25-firstmate-pending-decisions",
        "exists": true
      },
      "hints": {
        "pending_decision": false,
        "blocked_event": false,
        "open_decisions": []
      }
    }
  ]
};

/** The snapshot as the command prints it, which is what the reader is handed. */
export function fleetSnapshotJson() {
  return JSON.stringify(FLEET_SNAPSHOT);
}

/** The task ids in the reading, so a test naming one cannot drift from it. */
export const APX_412 = 'apx-412-build-and-cache-cleanup';
export const ZED_207 = 'zed-207-nightly-index-rebuild';
export const RAISE_25 = 'raise-25-firstmate-pending-decisions';

/**
 * The worktree paths in the reading, redacted along with everything else, so a
 * test joining a session onto one cannot drift from the fixture.
 */
export const APX_412_WORKTREE = '/Users/x/.treehouse/example-webapp-09aa4f/1/example-webapp';
export const ZED_207_WORKTREE =
  '/Users/x/.treehouse/example-scheduling-e90b80/1/example-scheduling';
