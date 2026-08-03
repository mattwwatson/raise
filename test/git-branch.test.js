import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GitBranch, branchFromHead, gitDirFromLink } from '../src/git-branch.js';

/**
 * A fake filesystem that counts reads, so the cache can be asserted on directly
 * rather than inferred from timing. Entries are either files (text) or
 * directories (`dir: true`).
 */
function fakeFiles(initial = {}) {
  const files = new Map(Object.entries(initial));
  const reads = { count: 0 };
  return {
    reads,
    set(path, text, mtimeMs = 1) {
      files.set(path, { text, mtimeMs });
    },
    dir(path) {
      files.set(path, { dir: true, text: '', mtimeMs: 1 });
    },
    remove(path) {
      files.delete(path);
    },
    access: {
      stat(path) {
        const file = files.get(path);
        if (!file) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { size: file.text.length, mtimeMs: file.mtimeMs, isDirectory: Boolean(file.dir) };
      },
      readText(path) {
        const file = files.get(path);
        if (!file) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        reads.count += 1;
        return file.text;
      },
    },
  };
}

test('branchFromHead reads the branch a HEAD points at', () => {
  assert.equal(branchFromHead('ref: refs/heads/main\n'), 'main');
  assert.equal(branchFromHead('ref: refs/heads/feat/thing-with/slashes\n'), 'feat/thing-with/slashes');
});

test('a detached HEAD is not a branch', () => {
  // A bare sha would render where a branch name goes, and worse, would be
  // compared against a pull request's branch - where it can only mislead.
  assert.equal(branchFromHead('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n'), null);
  assert.equal(branchFromHead(''), null);
  assert.equal(branchFromHead(null), null);
});

test('gitDirFromLink follows a worktree .git file', () => {
  assert.equal(
    gitDirFromLink('gitdir: /Users/x/work/repo/.git/worktrees/feature\n'),
    '/Users/x/work/repo/.git/worktrees/feature',
  );
  assert.equal(gitDirFromLink('not a gitdir line'), null);
});

test('reads the branch of an ordinary repo', () => {
  const files = fakeFiles();
  files.dir('/repo/.git');
  files.set('/repo/.git/HEAD', 'ref: refs/heads/main\n');
  const git = new GitBranch({ files: files.access });
  assert.equal(git.branchFor('/repo'), 'main');
});

test('walks up from a subdirectory to find the repo', () => {
  // A session's cwd is very often somewhere under the repo root, not at it.
  const files = fakeFiles();
  files.dir('/repo/.git');
  files.set('/repo/.git/HEAD', 'ref: refs/heads/main\n');
  const git = new GitBranch({ files: files.access });
  assert.equal(git.branchFor('/repo/src/deeply/nested'), 'main');
});

test('resolves a worktree, whose .git is a file pointing elsewhere', () => {
  // Worktrees are the normal case here - no-mistakes and Treehouse both use
  // them - and they are the checkouts most likely to be on their own branch.
  const files = fakeFiles();
  files.set('/trees/ab12/thing/.git', 'gitdir: /repo/.git/worktrees/thing\n');
  files.set('/repo/.git/worktrees/thing/HEAD', 'ref: refs/heads/feat/hexes\n');
  const git = new GitBranch({ files: files.access });
  assert.equal(git.branchFor('/trees/ab12/thing'), 'feat/hexes');
});

test('a directory outside any repo has no branch', () => {
  const files = fakeFiles();
  const git = new GitBranch({ files: files.access });
  assert.equal(git.branchFor('/tmp/scratch'), null);
  assert.equal(git.branchFor(null), null);
});

test('answers from cache while HEAD has not moved', () => {
  // The server asks once per session per poll. Re-reading an unchanged HEAD
  // every second is the cost this cache exists to avoid.
  const files = fakeFiles();
  files.dir('/repo/.git');
  files.set('/repo/.git/HEAD', 'ref: refs/heads/main\n');
  const git = new GitBranch({ files: files.access });

  assert.equal(git.branchFor('/repo'), 'main');
  assert.equal(git.branchFor('/repo'), 'main');
  assert.equal(git.branchFor('/repo'), 'main');
  assert.equal(files.reads.count, 1);
});

test('picks up a branch change', () => {
  const files = fakeFiles();
  files.dir('/repo/.git');
  files.set('/repo/.git/HEAD', 'ref: refs/heads/main\n', 1);
  const git = new GitBranch({ files: files.access });
  assert.equal(git.branchFor('/repo'), 'main');

  files.set('/repo/.git/HEAD', 'ref: refs/heads/feat/new\n', 2);
  assert.equal(git.branchFor('/repo'), 'feat/new');
});

test('a directory known not to be a repo is not walked again', () => {
  // Walking up to twenty-four levels once a second, per session, for a
  // directory that will never be a repo, is the one case this could get
  // expensive in.
  const files = fakeFiles();
  const stats = [];
  const counting = {
    stat(path) {
      stats.push(path);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    readText: () => assert.fail('nothing to read'),
  };
  const git = new GitBranch({ files: counting });
  git.branchFor('/tmp/a/b/c');
  const afterFirst = stats.length;
  git.branchFor('/tmp/a/b/c');
  assert.equal(stats.length, afterFirst, 'the second ask cost nothing');
});

test('a deleted worktree is re-resolved rather than answered from cache', () => {
  const files = fakeFiles();
  files.set('/wt/.git', 'gitdir: /repo/.git/worktrees/wt\n');
  files.set('/repo/.git/worktrees/wt/HEAD', 'ref: refs/heads/gone\n');
  const git = new GitBranch({ files: files.access });
  assert.equal(git.branchFor('/wt'), 'gone');

  files.remove('/repo/.git/worktrees/wt/HEAD');
  files.remove('/wt/.git');
  assert.equal(git.branchFor('/wt'), null);
});

test('prune forgets directories whose sessions have gone', () => {
  const files = fakeFiles();
  files.dir('/repo/.git');
  files.set('/repo/.git/HEAD', 'ref: refs/heads/main\n');
  const git = new GitBranch({ files: files.access });
  assert.equal(git.branchFor('/repo'), 'main');
  assert.equal(files.reads.count, 1);

  git.prune(new Set(['/other']));
  assert.equal(git.branchFor('/repo'), 'main');
  assert.equal(files.reads.count, 2, 'the entry was dropped, so it had to be read again');
});
