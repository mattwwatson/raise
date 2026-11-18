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
 */

import { isNewerVersion } from '../src/update-check.js';

/** The repository releases are made from, for links. */
export const REPO = 'mattwwatson/raise';

/** A release pull request comes from this branch, with the version after it. */
export const RELEASE_BRANCH_PREFIX = 'release/';

export const NOTES_START = '<!-- raise-release-notes:start -->';
export const NOTES_END = '<!-- raise-release-notes:end -->';

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
 * @param {PullRequest} pr
 * @param {string} text
 * @returns {string}
 */
function entry(pr, text) {
  const link = `[#${pr.number}](https://github.com/${REPO}/pull/${pr.number})`;
  const issues = (pr.closingIssuesReferences || []).map(
    (issue) => `[#${issue.number}](https://github.com/${REPO}/issues/${issue.number})`,
  );
  return `- ${text} (${link}${issues.length ? `, closes ${issues.join(', ')}` : ''})`;
}

/**
 * The release notes for the pull requests merged since the last release.
 *
 * @param {{version: string, previousTag: string|null, prs: PullRequest[], files: string[]}} input
 * @returns {{markdown: string, included: PullRequest[]}}
 */
export function renderNotes({ version, previousTag, prs, files }) {
  const counted = files.filter((file) => !NOT_NEWS.includes(file));
  const included = prs
    .filter((pr) => touchesPackage(pr, counted))
    .sort((a, b) => a.number - b.number);

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
 * workflow reads them back from, and a note to the reviewer outside them.
 *
 * @param {string} notes
 * @returns {string}
 */
export function releaseBody(notes) {
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
 * What the workflow should do with a commit that has landed on `main`.
 *
 * Every push to `main` asks this, and nearly every answer is `skip`: the version
 * in `package.json` already has its tag. Only a version with no tag is a release,
 * and then each way it could be one nobody reviewed is a refusal - which fails
 * the job, visibly, rather than publishing or quietly doing nothing.
 *
 * @param {{version: string, tags: string[], pullRequests: (PullRequest & {body?: string, mergedAt?: string|null})[]}} input
 *   `pullRequests` are the ones GitHub associates with the commit
 * @returns {{action: 'skip', reason: string}
 *   | {action: 'refuse', reason: string}
 *   | {action: 'release', tag: string, notes: string, pr: number}}
 */
export function planRelease({ version, tags, pullRequests }) {
  const tag = `v${version}`;
  if (tags.includes(tag)) return { action: 'skip', reason: `${tag} is already tagged` };

  const previous = latestTag(tags);
  if (previous && !isNewerVersion(previous.slice(1), version)) {
    return {
      action: 'refuse',
      reason: `package.json says ${version}, which is not newer than the latest release ${previous}`,
    };
  }

  const pr = pullRequests.find(
    (candidate) => candidate.headRefName === `${RELEASE_BRANCH_PREFIX}${version}` && candidate.mergedAt,
  );
  if (!pr) {
    return {
      action: 'refuse',
      reason:
        `package.json says ${version} but this commit came from no merged ` +
        `${RELEASE_BRANCH_PREFIX}${version} pull request, so there are no reviewed notes ` +
        'to release with. Prepare releases with `npm run release`.',
    };
  }

  const notes = extractNotes(pr.body);
  if (!notes) {
    return {
      action: 'refuse',
      reason: `#${pr.number} has no release notes between its markers; restore them and release again`,
    };
  }
  return { action: 'release', tag, notes, pr: pr.number };
}
