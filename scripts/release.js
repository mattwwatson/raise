/**
 * Releasing Raise, and the only release file that touches the world.
 *
 *   npm run release -- <patch|minor|major> [--dry-run]
 *       prepare a release: a pull request carrying the version bump, whose
 *       description is the release notes, for a person to review and merge
 *
 *   node scripts/release.js check
 *       `release-check.yml`'s half on a pull request: fail a release pull
 *       request whose notes miss a shipping pull request, while it can still be
 *       closed and redone
 *
 *   node scripts/release.js ci
 *       the workflow's half, run on every push to `main`: decide whether this
 *       commit is a release, or a release that still needs its GitHub Release,
 *       and say so to GitHub Actions
 *
 * Publishing is not here, and that is the point of the split. It happens in
 * `.github/workflows/release.yml` through npm Trusted Publishing, so no npm
 * credential exists anywhere, the tarball is built from the merged commit and
 * nothing else, and npm attaches provenance. A laptop never publishes.
 *
 * Every rule - what goes in the notes, what counts as a release, what is refused
 * - is in `release-notes.js`, where it is tested. This file asks `git` and `gh`
 * and writes. See `docs/tasks/39-release-process.md`.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from './task-files.js';
import {
  BUMPS,
  RELEASE_BRANCH_PREFIX,
  checkReleasePullRequest,
  REPO,
  latestTag,
  nextVersion,
  planRelease,
  releaseBody,
  renderNotes,
  shippingPullRequests,
} from './release-notes.js';

/**
 * Run a command and collect what it said. Synchronous, and never through a
 * shell - see `runCommand` in `tasks.js` for why both are right in a one-shot
 * script and wrong in `src/`.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string}} [options]
 * @returns {{ok: boolean, stdout: string, stderr: string}}
 */
function run(command, args, { cwd } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd });
  if (result.error) {
    return { ok: false, stdout: '', stderr: `${command}: ${result.error.message}` };
  }
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

/** Run it, and stop the release with what it said if it fails. */
function must(command, args, options) {
  const result = run(command, args, options);
  if (!result.ok) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

function readPackage(root) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
}

function releaseTags(root) {
  return must('git', ['tag', '--list', 'v*'], { cwd: root }).split('\n').filter(Boolean);
}

/**
 * The pull requests merged into `main` between a tag and a commit.
 *
 * Matched on merge commits that are in `tag..head`, not on dates: a date range
 * would catch a pull request merged a minute after the tag was cut from an older
 * commit, and miss nothing it should not - but "the commits between two points"
 * is the exact question, so ask it.
 *
 * @returns {import('./release-notes.js').PullRequest[]}
 */
function mergedSince(root, tag, head) {
  const range = tag ? `${tag}..${head}` : head;
  const commits = new Set(
    must('git', ['rev-list', range], { cwd: root }).split('\n').filter(Boolean),
  );
  const listed = JSON.parse(
    must('gh', [
      'pr', 'list', '--repo', REPO, '--state', 'merged', '--base', 'main', '--limit', '500',
      '--json', 'number,title,files,closingIssuesReferences,headRefName,mergeCommit',
    ]),
  );
  return listed.filter((pr) => pr.mergeCommit && commits.has(pr.mergeCommit.oid));
}

/** Everything that must be true before a release branch is cut. */
function preflight(root) {
  const branch = must('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  if (branch !== 'main') throw new Error(`run this on main, not ${branch}`);
  if (must('git', ['status', '--porcelain'], { cwd: root })) {
    throw new Error('the working tree has uncommitted changes');
  }
  must('git', ['fetch', '--quiet', '--tags', 'origin', 'main'], { cwd: root });
  const head = must('git', ['rev-parse', 'HEAD'], { cwd: root });
  const remote = must('git', ['rev-parse', 'origin/main'], { cwd: root });
  if (head !== remote) throw new Error('main is not the same as origin/main - pull or push first');
  must('gh', ['auth', 'status']);
}

/**
 * @param {string[]} args
 */
function prepare(args) {
  const dryRun = args.includes('--dry-run');
  const bump = args.find((arg) => !arg.startsWith('--'));
  if (!BUMPS.includes(bump)) {
    throw new Error(`say which bump: npm run release -- <${BUMPS.join('|')}> [--dry-run]`);
  }

  const root = repoRoot();
  if (!dryRun) preflight(root);

  const pkg = readPackage(root);
  const version = nextVersion(pkg.version, bump);
  const previousTag = latestTag(releaseTags(root));
  const prs = mergedSince(root, previousTag, 'HEAD');
  const { markdown, included } = renderNotes({ version, previousTag, prs, files: pkg.files });

  console.log(`${pkg.version} -> ${version}, since ${previousTag ?? 'the beginning'}`);
  console.log(`${included.length} of ${prs.length} merged pull requests changed the package\n`);
  console.log(markdown);
  if (dryRun) return;

  const branch = `${RELEASE_BRANCH_PREFIX}${version}`;
  must('git', ['switch', '--create', branch], { cwd: root });
  must('npm', ['version', bump, '--no-git-tag-version'], { cwd: root });
  must('git', ['commit', '--all', '--message', `release: ${version}`], { cwd: root });
  must('git', ['push', '--set-upstream', 'origin', branch], { cwd: root });
  const url = must('gh', [
    'pr', 'create', '--repo', REPO, '--base', 'main', '--head', branch,
    '--title', `release: ${version}`,
    '--body', releaseBody(markdown, included.map((pr) => pr.number)),
  ]);
  console.log(`\nRelease pull request: ${url}`);
  console.log('Review the notes, merge it, then approve the staged package on npmjs.com.');
}

/**
 * Whether a tag has a GitHub Release. Only "not found" is an answer of no; any
 * other failure stops the job, since guessing either way is wrong.
 */
function hasRelease(tag) {
  const result = run('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'tagName']);
  if (result.ok) return true;
  if (/not found/i.test(result.stderr)) return false;
  throw new Error(`gh release view ${tag} failed:\n${result.stderr.trim()}`);
}

/**
 * The workflow's question: is the commit it was started for a release?
 *
 * Writes `publish` (stage and tag), `release` (create the GitHub Release), `tag`
 * and `notes-file` to `$GITHUB_OUTPUT`. The notes come
 * from a pull request description, which anybody who can open one controls, so
 * they reach the workflow as a file path and are never interpolated into a
 * `run:` block - the same rule `no-mistakes-required.yml` follows.
 */
function ci() {
  const root = repoRoot();
  const sha = process.env.GITHUB_SHA || must('git', ['rev-parse', 'HEAD'], { cwd: root });
  const { version, files } = readPackage(root);
  const tags = releaseTags(root);
  const tag = `v${version}`;
  const released = tags.includes(tag) && hasRelease(tag);
  const pullRequests = JSON.parse(
    must('gh', ['api', `repos/${REPO}/commits/${sha}/pulls`]),
  ).map((pr) => ({
    number: pr.number,
    title: pr.title,
    files: [],
    headRefName: pr.head?.ref,
    mergedAt: pr.merged_at,
    body: pr.body,
  }));

  const previousTag = latestTag(tags.filter((name) => name !== tag));
  const shipping = shippingPullRequests(mergedSince(root, previousTag, sha), files).map(
    (pr) => pr.number,
  );

  const plan = planRelease({ version, tags, released, shipping, pullRequests });
  const output = process.env.GITHUB_OUTPUT;
  const say = (line) => (output ? appendFileSync(output, `${line}\n`) : console.log(line));

  if (plan.action === 'skip') {
    console.log(`Not a release: ${plan.reason}.`);
    say('publish=false');
    say('release=false');
    return;
  }
  if (plan.action === 'refuse') throw new Error(`Refusing to release: ${plan.reason}`);

  const notesFile = join(process.env.RUNNER_TEMP || root, 'release-notes.md');
  writeFileSync(notesFile, `${plan.notes}\n`);
  const publish = plan.action === 'release';
  console.log(
    publish
      ? `Releasing ${plan.tag} from #${plan.pr}.`
      : `${plan.tag} is tagged with no GitHub Release; creating only the Release from #${plan.pr}.`,
  );
  say(`publish=${publish}`);
  say('release=true');
  say(`tag=${plan.tag}`);
  say(`notes-file=${notesFile}`);
}

/**
 * The pre-merge check, run by `release-check.yml` on every pull request. The branch and
 * number come from the environment; the description is read with `gh` and never
 * passes through a `run:` block.
 */
function check() {
  const branch = process.env.GITHUB_HEAD_REF || '';
  if (!branch.startsWith(RELEASE_BRANCH_PREFIX)) {
    console.log(`Not a release pull request: ${branch || 'no branch'}.`);
    return;
  }
  const root = repoRoot();
  const number = process.env.PR_NUMBER;
  if (!number) throw new Error('PR_NUMBER is not set');
  const { body } = JSON.parse(must('gh', ['pr', 'view', number, '--repo', REPO, '--json', 'body']));
  const previousTag = latestTag(releaseTags(root));
  const { files } = readPackage(root);
  const shipping = shippingPullRequests(mergedSince(root, previousTag, 'HEAD'), files).map(
    (pr) => pr.number,
  );
  const problem = checkReleasePullRequest(body, shipping);
  if (problem) throw new Error(problem);
  console.log(`#${number} lists every shipping pull request since ${previousTag ?? 'the beginning'}.`);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'ci') return ci();
    if (command === 'check') return check();
    return prepare([command, ...args].filter(Boolean));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

main();
