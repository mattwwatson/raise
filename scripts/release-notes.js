/**
 * What a release contains, and whether a commit on `main` is one.
 *
 * Every rule of the release process lives here, because each of them is a
 * decision a test can pin; `release.js` only fetches and writes. See
 * `docs/tasks/39-release-process.md` for the reasoning in full.
 *
 * **A pull request is in the notes if, and only if, it changed a file the
 * package ships.** The list is `files` in `package.json`, passed in by the
 * caller rather than copied here, so the day somebody adds a directory to the
 * package the notes follow without anybody remembering to. Docs, CI and roadmap
 * work change nothing a user installs, and listing them would bury the one line
 * they wanted under eleven they did not. It is a mechanical test on purpose: a
 * label convention is something a contributor forgets.
 *
 * **`README.md` ships and still does not count**, decided on 18/11/2026 on the
 * first real notes. Of the two pull requests since 0.1.0 that changed only the
 * README, both were contribution process, and a feature's README change always
 * arrives with its code - so counting it added noise and never news. See
 * `NOT_NEWS`.
 *
 * **Nothing that passes the test is dropped for having the wrong title.** A pull
 * request with no `feat` or `fix` prefix goes under Other. Leaving out a change
 * that reached users because its title did not parse would be a release note
 * that quietly lies by omission, which is this project's least favourite kind of
 * failure.
 *
 * **The notes that ship are the ones a person read.** The preparing script puts
 * them in the release pull request between two markers, and the workflow takes
 * them back out of the *merged* description. So an edit made in review is what
 * the GitHub Release says, and anything outside the markers - a reviewer's
 * comment, a pipeline section - is not.
 *
 * **The notes may lose a line in review, and may not miss a pull request.** The
 * notes are written when the release branch is cut, and main's branch
 * protection makes the maintainer bring that branch up to date before it can
 * merge, which can pull in a shipping pull request the notes never saw. It is
 * then an ancestor of the new tag, so no later release could list it either.
 * So the preparing script records the numbers it rendered in a hidden comment
 * below the end marker, outside the region reviewers are told to edit, and the
 * pre-merge check and the workflow both refuse when a shipping pull request
 * merged since the last release is not on that list. The check is against the
 * recorded list, not the rendered lines, so deleting a line in review is still
 * allowed.
 */

import { isNewerVersion } from '../src/update-check.js';

/** The repository releases are made from, for links. */
export const REPO = 'mattwwatson/raise';

/** A release pull request comes from this branch, with the version after it. */
export const RELEASE_BRANCH_PREFIX = 'release/';

export const NOTES_START = '<!-- raise-release-notes:start -->';
export const NOTES_END = '<!-- raise-release-notes:end -->';

/** The hidden list of pull requests the notes were rendered from. */
const RECORDED_PATTERN = /<!-- raise-release-prs:([\d,\s]*)-->/;

/**
 * Entries in `files` that ship but whose changes are not news on their own. A
 * pull request changing only these is left out of the notes.
 */
export const NOT_NEWS = ['README.md'];

/** The bumps `npm version` takes that a maintainer may ask for. */
export const BUMPS = ['patch', 'minor', 'major'];

/**
 * A merged pull request, as `gh pr list --json` describes one. GitHub's shape,
 * kept apart from anything of ours.
 *
 * @typedef {object} PullRequest
 * @property {number} number
 * @property {string} title
 * @property {{path: string}[]} files
 * @property {{number: number}[]} [closingIssuesReferences]
 * @property {string} [headRefName]
 */

/**
 * Whether a repository path is inside the package.
 *
 * An entry ending in `/` is a directory and covers everything under it; any
 * other entry is one file. That is the subset of npm's `files` syntax this
 * package uses, and anything else (a glob) is refused rather than guessed at,
 * because a guess here decides what users are told.
 *
 * @param {string} path
 * @param {string[]} files
 * @returns {boolean}
 */
export function isShipped(path, files) {
  for (const entry of files) {
    if (/[*?[\]{}!]/.test(entry)) {
      throw new Error(`files entry "${entry}" is a pattern; release notes only understand plain paths`);
    }
    if (entry.endsWith('/') ? path.startsWith(entry) : path === entry) return true;
  }
  return false;
}

/**
 * @param {PullRequest} pr
 * @param {string[]} files
 * @returns {boolean}
 */
export function touchesPackage(pr, files) {
  return (pr.files || []).some((file) => isShipped(file.path, files));
}

/**
 * Which heading a pull request goes under, and its title without the prefix.
 *
 * `feat(focus): bring Ghostty sessions to the front` is a feature reading
 * "Bring Ghostty sessions to the front". Anything else keeps its whole title.
 *
 * @param {string} title
 * @returns {{kind: 'feat'|'fix'|'other', text: string}}
 */
export function classify(title) {
  const match = /^(feat|fix)(?:\([^)]*\))?!?:\s*(.+)$/i.exec(String(title).trim());
  if (!match) return { kind: 'other', text: capitalise(String(title).trim()) };
  return { kind: /** @type {'feat'|'fix'} */ (match[1].toLowerCase()), text: capitalise(match[2]) };
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const HEADINGS = /** @type {const} */ ([
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['other', 'Other'],
]);

/**
 * One line of the notes, linked to its pull request and to every issue it closed.
 *
 * **The issues are introduced by "issue", never by "closes".** These notes are the
 * release pull request's description, and GitHub reads "closes [#12](...)" as a
 * closing keyword even inside a Markdown link. On 18/11/2026 that linked the 0.2.0
 * release pull request to seven issues already closed, and the board's
 * linked-pull-request automation moved all of them from Done back to In Review.
 * A pull request title can still carry a keyword of its own; the release check
 * does not police titles, so read the notes before merging.
 *
 * @param {PullRequest} pr
 * @param {string} text
 * @returns {string}
 */
function entry(pr, text) {
  const link = `[#${pr.number}](https://github.com/${REPO}/pull/${pr.number})`;
  const issues = (pr.closingIssuesReferences || []).map(
    (issue) => `[#${issue.number}](https://github.com/${REPO}/issues/${issue.number})`,
  );
  if (issues.length === 0) return `- ${text} (${link})`;
  const label = issues.length === 1 ? 'issue' : 'issues';
  return `- ${text} (${link}, ${label} ${issues.join(', ')})`;
}

/**
 * The pull requests that belong in the notes, in number order: the ones that
 * changed a shipped file other than `NOT_NEWS`. The notes and the workflow's
 * check both ask this, so they cannot disagree about what counts.
 *
 * @param {PullRequest[]} prs
 * @param {string[]} files
 * @returns {PullRequest[]}
 */
export function shippingPullRequests(prs, files) {
  const counted = files.filter((file) => !NOT_NEWS.includes(file));
  return prs.filter((pr) => touchesPackage(pr, counted)).sort((a, b) => a.number - b.number);
}

/**
 * The release notes for the pull requests merged since the last release.
 *
 * @param {{version: string, previousTag: string|null, prs: PullRequest[], files: string[]}} input
 * @returns {{markdown: string, included: PullRequest[]}}
 */
export function renderNotes({ version, previousTag, prs, files }) {
  const included = shippingPullRequests(prs, files);

  const lines = [];
  if (included.length === 0) {
    lines.push('No change to the installed package since the last release.');
  }
  for (const [kind, heading] of HEADINGS) {
    const group = included
      .map((pr) => ({ pr, ...classify(pr.title) }))
      .filter((item) => item.kind === kind);
    if (group.length === 0) continue;
    lines.push(`### ${heading}`, '', ...group.map((item) => entry(item.pr, item.text)), '');
  }
  if (previousTag) {
    lines.push(
      `Full list of changes: https://github.com/${REPO}/compare/${previousTag}...v${version}`,
    );
  }
  return { markdown: lines.join('\n').trimEnd(), included };
}

/**
 * The release pull request's description: the notes, between the markers the
 * workflow reads them back from, a note to the reviewer, and below it the
 * numbers of the pull requests the notes were rendered from in a hidden comment.
 *
 * @param {string} notes
 * @param {number[]} recorded
 * @returns {string}
 */
export function releaseBody(notes, recorded) {
  return [
    NOTES_START,
    notes,
    NOTES_END,
    '',
    '---',
    '',
    'Edit the notes above the line as you like - what is between the markers when',
    'this merges is what the GitHub Release says. Merging stages the package on npm;',
    'it is public once you approve it with `npm stage approve` or on npmjs.com.',
    '',
    'The line below records which pull requests these notes cover - do not remove it.',
    `<!-- raise-release-prs: ${recorded.join(',')} -->`,
  ].join('\n');
}

/**
 * The notes back out of a merged release pull request's description.
 *
 * @param {string|null|undefined} body
 * @returns {string|null} null when the markers are missing or out of order
 */
export function extractNotes(body) {
  const text = String(body || '').replace(/\r\n/g, '\n');
  const start = text.indexOf(NOTES_START);
  const end = text.indexOf(NOTES_END);
  if (start === -1 || end === -1 || end < start) return null;
  const notes = text.slice(start + NOTES_START.length, end).trim();
  return notes || null;
}

/**
 * The pull request numbers a release body says its notes were rendered from.
 *
 * @param {string|null|undefined} body
 * @returns {number[]|null} null when the body carries no list
 */
export function recordedPullRequests(body) {
  const match = RECORDED_PATTERN.exec(String(body || ''));
  if (!match) return null;
  return match[1].split(',').map((n) => n.trim()).filter(Boolean).map(Number);
}

/**
 * The version a bump produces. Only plain `major.minor.patch` is accepted: a
 * pre-release is out of scope, and the bump is refused rather than mangled.
 *
 * @param {string} current
 * @param {string} bump
 * @returns {string}
 */
export function nextVersion(current, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) throw new Error(`cannot bump "${current}": only major.minor.patch is supported`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown bump "${bump}": use ${BUMPS.join(', ')}`);
}

/**
 * The latest release tag, from a list of tag names. Tags that are not `v` and a
 * plain version are ignored rather than ranked.
 *
 * @param {string[]} tags
 * @returns {string|null}
 */
export function latestTag(tags) {
  let best = null;
  for (const tag of tags) {
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) continue;
    if (best === null || isNewerVersion(best.slice(1), tag.slice(1))) best = tag;
  }
  return best;
}

/**
 * What is wrong with a release pull request's description, if anything: no
 * notes between the markers, no recorded list, or a shipping pull request the
 * list does not name. The open pull request and the merged one are both judged
 * by this, so the check before the merge and the one after it cannot disagree.
 *
 * @param {string|null|undefined} body
 * @param {number[]} shipping the pull requests merged since the last release
 *   that belong in the notes
 * @returns {{kind: 'notes' | 'list' | 'missing', reason: string} | null}
 */
export function notesProblem(body, shipping) {
  if (!extractNotes(body)) return { kind: 'notes', reason: 'has no release notes between its markers' };
  const recorded = recordedPullRequests(body);
  if (!recorded) {
    return { kind: 'list', reason: 'does not record which pull requests its notes were written from' };
  }
  const missing = shipping.filter((number) => !recorded.includes(number));
  if (missing.length) {
    return {
      kind: 'missing',
      reason:
        `does not list ${missing.map((n) => `#${n}`).join(', ')}, which changed the package ` +
        'after its notes were written',
    };
  }
  return null;
}

/**
 * The pre-merge check on an open release pull request: why it must not merge,
 * or null when it may. The remedy is the one open to somebody who has not
 * merged yet.
 *
 * @param {string|null|undefined} body
 * @param {number[]} shipping
 * @returns {string|null}
 */
export function checkReleasePullRequest(body, shipping) {
  const problem = notesProblem(body, shipping);
  if (!problem) return null;
  return (
    `This release pull request ${problem.reason}. Close it and run ` +
    '`npm run release -- <bump>` again from an up-to-date main.'
  );
}

/**
 * What the workflow should do with a commit that has landed on `main`.
 *
 * Every push to `main` asks this, and nearly every answer is `skip`: the version
 * in `package.json` already has its tag and its GitHub Release. Only a version
 * with no tag is a release, and then each way it could be one nobody reviewed is
 * a refusal - which fails the job, visibly, rather than publishing or quietly
 * doing nothing.
 *
 * A tag with no GitHub Release is a release that stopped after staging and
 * tagging, and the answer is `release-only`: create the Release, and do not
 * stage or tag again. Skipping it would leave the version with no changelog,
 * and nothing would say so.
 *
 * @param {{
 *   version: string,
 *   tags: string[],
 *   released: boolean,
 *   shipping: number[],
 *   pullRequests: (PullRequest & {body?: string, mergedAt?: string|null})[],
 * }} input
 *   `released` is whether the tag has a GitHub Release; `shipping` is the
 *   numbers of the pull requests merged since the last release that belong in
 *   the notes; `pullRequests` are the ones GitHub associates with the commit
 * @returns {{action: 'skip', reason: string}
 *   | {action: 'refuse', reason: string}
 *   | {action: 'release' | 'release-only', tag: string, notes: string, pr: number}}
 */
export function planRelease({ version, tags, released, shipping, pullRequests }) {
  const tag = `v${version}`;
  const tagged = tags.includes(tag);
  if (tagged && released) return { action: 'skip', reason: `${tag} is already released` };

  const previous = latestTag(tags);
  if (!tagged && previous && !isNewerVersion(previous.slice(1), version)) {
    return {
      action: 'refuse',
      reason: `package.json says ${version}, which is not newer than the latest release ${previous}`,
    };
  }

  const pr = pullRequests.find(
    (candidate) => candidate.headRefName === `${RELEASE_BRANCH_PREFIX}${version}` && candidate.mergedAt,
  );
  if (!pr) {
    if (tagged) {
      return {
        action: 'refuse',
        reason:
          `${tag} is tagged but has no GitHub Release, and this commit is not its release ` +
          'pull request. Re-run the workflow run for the release merge.',
      };
    }
    return {
      action: 'refuse',
      reason:
        `package.json says ${version} but this commit came from no merged ` +
        `${RELEASE_BRANCH_PREFIX}${version} pull request, so there are no reviewed notes ` +
        'to release with. Prepare releases with `npm run release`.',
    };
  }

  const problem = notesProblem(pr.body, tagged ? [] : shipping);
  if (problem?.kind === 'notes') {
    return {
      action: 'refuse',
      reason: `#${pr.number} ${problem.reason}; restore them and release again`,
    };
  }
  const notes = /** @type {string} */ (extractNotes(pr.body));
  if (tagged) return { action: 'release-only', tag, notes, pr: pr.number };
  if (problem) {
    return {
      action: 'refuse',
      reason:
        `#${pr.number} ${problem.reason}, so ${version} will not be published. Prepare the ` +
        'next release with `npm run release -- <bump>` from main, whose notes cover everything ' +
        `since ${previous ?? 'the beginning'}.`,
    };
  }
  return { action: 'release', tag, notes, pr: pr.number };
}
