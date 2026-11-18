import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTES_END,
  NOTES_START,
  classify,
  extractNotes,
  isShipped,
  latestTag,
  nextVersion,
  planRelease,
  recordedPullRequests,
  releaseBody,
  renderNotes,
} from '../scripts/release-notes.js';

const FILES = ['bin/', 'src/', 'public/', 'hooks/', 'README.md'];

/**
 * @param {Partial<import('../scripts/release-notes.js').PullRequest>} overrides
 * @returns {import('../scripts/release-notes.js').PullRequest}
 */
function pr(overrides = {}) {
  return {
    number: 1,
    title: 'feat(cli): do a thing',
    files: [{ path: 'src/cli.js' }],
    closingIssuesReferences: [],
    ...overrides,
  };
}

function releasePr(overrides = {}) {
  return {
    ...pr({ number: 50, title: 'release: 0.2.0', headRefName: 'release/0.2.0' }),
    mergedAt: '2026-11-18T00:00:00Z',
    body: releaseBody('### Features\n\n- A thing (#1)', [1]),
    ...overrides,
  };
}

/** The workflow's input for a release of 0.2.0 after 0.1.0, with overrides. */
function plan(overrides = {}) {
  return planRelease({
    version: '0.2.0',
    tags: ['v0.1.0'],
    released: false,
    shipping: [1],
    pullRequests: [releasePr()],
    ...overrides,
  });
}

test('a directory entry covers everything under it, and a file entry only itself', () => {
  assert.equal(isShipped('src/focus/terminals.js', FILES), true);
  assert.equal(isShipped('README.md', FILES), true);
  assert.equal(isShipped('docs/README.md', FILES), false);
  assert.equal(isShipped('srcx/thing.js', FILES), false);
  assert.equal(isShipped('scripts/release.js', FILES), false);
});

test('a glob in files is refused rather than guessed at', () => {
  assert.throws(() => isShipped('src/a.js', ['src/*.js']), /pattern/);
});

test('only pull requests that changed shipped code are in the notes', () => {
  const { included, markdown } = renderNotes({
    version: '0.2.0',
    previousTag: 'v0.1.0',
    files: FILES,
    prs: [
      pr({ number: 1 }),
      pr({ number: 2, title: 'docs: capture a spec', files: [{ path: 'docs/tasks/2-x.md' }] }),
      pr({ number: 3, title: 'ci: a workflow', files: [{ path: '.github/workflows/ci.yml' }] }),
    ],
  });
  assert.deepEqual(included.map((p) => p.number), [1]);
  assert.ok(!markdown.includes('#2') && !markdown.includes('#3'));
});

test('a pull request that changed only the README is not news', () => {
  // README.md ships, but a feature's README change always comes with its code,
  // and every README-only change since 0.1.0 was contribution process.
  const { included } = renderNotes({
    version: '0.2.0',
    previousTag: 'v0.1.0',
    files: FILES,
    prs: [
      pr({ number: 8, title: 'docs: contribution process', files: [{ path: 'README.md' }] }),
      pr({ number: 9, files: [{ path: 'README.md' }, { path: 'src/cli.js' }] }),
    ],
  });
  assert.deepEqual(included.map((p) => p.number), [9]);
});

test('notes are grouped into features and fixes, with the prefix stripped', () => {
  const { markdown } = renderNotes({
    version: '0.2.0',
    previousTag: 'v0.1.0',
    files: FILES,
    prs: [
      pr({ number: 37, title: 'feat(focus): bring Ghostty sessions to the front' }),
      pr({ number: 29, title: 'fix(firstmate): re-read the snapshot' }),
    ],
  });
  const features = markdown.indexOf('### Features');
  const fixes = markdown.indexOf('### Fixes');
  assert.ok(features !== -1 && fixes > features);
  assert.match(markdown, /- Bring Ghostty sessions to the front \(\[#37\]/);
  assert.match(markdown, /- Re-read the snapshot \(\[#29\]/);
});

test('a shipping pull request with no recognised prefix goes under Other, never dropped', () => {
  const { markdown } = renderNotes({
    version: '0.2.0',
    previousTag: 'v0.1.0',
    files: FILES,
    prs: [pr({ number: 17, title: 'docs: move reasoning into the code' })],
  });
  assert.match(markdown, /### Other\n\n- Docs: move reasoning into the code/);
});

test('each entry links its pull request and every issue it closes', () => {
  const { markdown } = renderNotes({
    version: '0.2.0',
    previousTag: 'v0.1.0',
    files: FILES,
    prs: [pr({ number: 21, closingIssuesReferences: [{ number: 12 }, { number: 13 }] })],
  });
  assert.ok(markdown.includes('[#21](https://github.com/mattwwatson/raise/pull/21)'));
  assert.ok(
    markdown.includes(
      'closes [#12](https://github.com/mattwwatson/raise/issues/12), [#13](https://github.com/mattwwatson/raise/issues/13)',
    ),
  );
});

test('the notes end with the comparison against the previous release', () => {
  const { markdown } = renderNotes({ version: '0.2.0', previousTag: 'v0.1.0', files: FILES, prs: [pr()] });
  assert.ok(markdown.endsWith('https://github.com/mattwwatson/raise/compare/v0.1.0...v0.2.0'));
});

test('a release with no shipping change says so rather than being empty', () => {
  const { markdown, included } = renderNotes({
    version: '0.2.1',
    previousTag: 'v0.2.0',
    files: FILES,
    prs: [pr({ files: [{ path: 'docs/x.md' }] })],
  });
  assert.equal(included.length, 0);
  assert.match(markdown, /No change to the installed package/);
});

test('classify reads a breaking-change marker and keeps an unscoped prefix', () => {
  assert.deepEqual(classify('feat!: drop Node 20'), { kind: 'feat', text: 'Drop Node 20' });
  assert.deepEqual(classify('fix: a typo'), { kind: 'fix', text: 'A typo' });
  assert.deepEqual(classify('7: require a signature'), { kind: 'other', text: '7: require a signature' });
});

test('the notes come back out of the release body exactly, and only from between the markers', () => {
  const body = releaseBody('### Fixes\n\n- One', [18, 21]);
  assert.equal(extractNotes(body), '### Fixes\n\n- One');
  assert.deepEqual(recordedPullRequests(body), [18, 21]);
  const edited = `Reviewer chatter\n${NOTES_START}\nEdited notes\n${NOTES_END}\n## Pipeline\nnoise`;
  assert.equal(extractNotes(edited), 'Edited notes');
});

test('a body without both markers, or with them reversed, has no notes', () => {
  assert.equal(extractNotes('just text'), null);
  assert.equal(extractNotes(`${NOTES_END}\nx\n${NOTES_START}`), null);
  assert.equal(extractNotes(`${NOTES_START}\n   \n${NOTES_END}`), null);
  assert.equal(extractNotes(null), null);
});

test('nextVersion bumps each part and refuses anything but a plain version', () => {
  assert.equal(nextVersion('0.1.0', 'patch'), '0.1.1');
  assert.equal(nextVersion('0.1.3', 'minor'), '0.2.0');
  assert.equal(nextVersion('0.2.3', 'major'), '1.0.0');
  assert.throws(() => nextVersion('0.2.0-rc.1', 'patch'), /major\.minor\.patch/);
  assert.throws(() => nextVersion('0.2.0', 'huge'), /unknown bump/);
});

test('latestTag ranks numerically and ignores tags that are not releases', () => {
  assert.equal(latestTag(['v0.9.0', 'v0.10.0', 'v0.2.0', 'nightly', 'v1.0.0-rc.1']), 'v0.10.0');
  assert.equal(latestTag([]), null);
});

test('an ordinary push to main is not a release', () => {
  const result = plan({ version: '0.1.0', tags: ['v0.1.0'], released: true, pullRequests: [] });
  assert.equal(result.action, 'skip');
});

test('a merged release pull request is released with the notes from its description', () => {
  assert.deepEqual(plan(), {
    action: 'release',
    tag: 'v0.2.0',
    notes: '### Features\n\n- A thing (#1)',
    pr: 50,
  });
});

test('a version that is not newer than the last release is refused', () => {
  const result = plan({
    version: '0.1.5',
    tags: ['v0.1.0', 'v0.2.0'],
    pullRequests: [releasePr({ headRefName: 'release/0.1.5' })],
  });
  assert.equal(result.action, 'refuse');
  assert.match(result.action === 'refuse' ? result.reason : '', /not newer than the latest release v0\.2\.0/);
});

test('a version bump that did not come through a release pull request is refused', () => {
  // Somebody bumped package.json in an ordinary pull request: there are no
  // reviewed notes, so publishing would ship a release nobody described.
  const result = plan({ pullRequests: [releasePr({ headRefName: 'fix/something' })] });
  assert.equal(result.action, 'refuse');
});

test('an unmerged pull request for the release branch does not count', () => {
  const result = plan({ pullRequests: [releasePr({ mergedAt: null })] });
  assert.equal(result.action, 'refuse');
});

test('a release pull request whose markers were deleted is refused rather than released bare', () => {
  const result = plan({ pullRequests: [releasePr({ body: 'notes went here' })] });
  assert.equal(result.action, 'refuse');
  assert.match(result.action === 'refuse' ? result.reason : '', /#50 has no release notes/);
});

test('a shipping pull request merged after the notes were written is refused, by number', () => {
  // The release branch was brought up to date after #7 merged, so #7 is in the
  // tagged commit but not in the notes - and no later release could list it.
  const result = plan({ shipping: [1, 7] });
  assert.equal(result.action, 'refuse');
  assert.match(result.action === 'refuse' ? result.reason : '', /#7 changed the package after/);
});

test('a line deleted from the notes in review is still released', () => {
  const body = releaseBody('### Features\n\n- A thing (#1)', [1, 2]);
  const edited = body.replace('\n- A thing (#1)', '');
  const result = plan({ shipping: [1, 2], pullRequests: [releasePr({ body: edited })] });
  assert.equal(result.action, 'release');
});

test('notes that do not record which pull requests they came from are refused', () => {
  const body = `${NOTES_START}\n### Features\n\n- A thing (#1)\n${NOTES_END}`;
  const result = plan({ pullRequests: [releasePr({ body })] });
  assert.equal(result.action, 'refuse');
  assert.match(result.action === 'refuse' ? result.reason : '', /does not record/);
});

test('a tag with no GitHub Release creates only the Release', () => {
  // The run stopped after staging and tagging; staging again would be refused.
  const result = plan({ tags: ['v0.1.0', 'v0.2.0'], released: false });
  assert.deepEqual(result, {
    action: 'release-only',
    tag: 'v0.2.0',
    notes: '### Features\n\n- A thing (#1)',
    pr: 50,
  });
});

test('a tag with no GitHub Release on a later commit is refused rather than skipped', () => {
  const result = plan({ tags: ['v0.1.0', 'v0.2.0'], released: false, pullRequests: [] });
  assert.equal(result.action, 'refuse');
});

test('a version with both its tag and its GitHub Release is skipped', () => {
  const result = plan({ tags: ['v0.1.0', 'v0.2.0'], released: true });
  assert.equal(result.action, 'skip');
});

test('a release branch never reads as a tracked item to the roadmap gate', async () => {
  // The release pull request ships no item, so `tasks:gate` must pass it as
  // untracked. `release/10.0.0` has a path element starting with digits, which
  // is what an issue key looks like - a change to that pattern would block every
  // release, so the two are pinned together here.
  const { ticketFromBranch } = await import('../scripts/task-gate.js');
  for (const version of ['0.2.0', '1.0.0', '10.0.0', '12.3.45']) {
    assert.equal(ticketFromBranch(`release/${version}`), null, `release/${version}`);
  }
});
