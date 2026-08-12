/**
 * Every claim the documentation makes about this repository has to be true.
 *
 * Two kinds of claim live here, both about the same three documents: a path
 * that must exist, and an inventory that must match the thing it inventories.
 *
 * ## Paths
 *
 * `AGENTS.md` is now mostly an *index*: one row per decision, naming the file
 * whose own header carries the reasoning. That is only worth having if a
 * pointer cannot rot. A renamed or deleted module leaves the index quietly
 * pointing at nothing, and a reader who follows it concludes the rule was
 * dropped rather than moved - which is the exact failure the split was designed
 * to avoid.
 *
 * `npm run tasks:links` does **not** cover this. It scans the whole repo but
 * only resolves references *into* `docs/tasks/`, so a dead `src/…` mention is
 * invisible to it.
 *
 * `README.md` is covered for the same reason and not as an afterthought: it is
 * the document a stranger reads first, and the split left it naming a file
 * nothing else does - the roadmap-workflow skill.
 *
 * ## Inventories
 *
 * `CONTRIBUTING.md` restates several bars that `AGENTS.md` owns - the three
 * devDependencies, the `REPORTABLE_FIELDS` boundary, the
 * no-synchronous-child-process rule, the terminal-adapter conditions. **That
 * duplication is deliberate and stays**: the document exists to state a
 * self-contained bar for somebody who has *not* read `AGENTS.md`, and replacing
 * a bullet with a pointer into a 120KB file would send them there to find out
 * whether their patch will land. See
 * [docs/tasks/6-contributing-drift.md](../docs/tasks/6-contributing-drift.md).
 *
 * The risk it carries is one-sided: when one side moves, the copy that goes
 * stale is the one whose only reader is the person who never sees both. So the
 * goal is drift that is **detectable**, not drift that is impossible - and only
 * one of those four items can honestly be pinned, the devDependency list, which
 * is enumerable. The other three are prose that is allowed to be reworded, and a
 * string match on a paragraph would fail when somebody improves a sentence,
 * which is how a check gets learned-around rather than fixed.
 *
 * `REPORTABLE_FIELDS` is the one worth re-checking if that copy changes: its
 * contents *are* enumerable from `src/hook-payload.js`, so the moment
 * `CONTRIBUTING.md` names the fields rather than describing the rule, this same
 * test shape applies to it. Today it names only the constant.
 *
 * Deliberately real files rather than a fake tree, unlike most tests here. The
 * claim under test is about this repository's actual contents, so a fake
 * filesystem would assert nothing at all - and there is no clock, no
 * subprocess and no network involved, so it stays deterministic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The documents that carry pointers into the source tree. */
const DOCS = ['AGENTS.md', 'CONTRIBUTING.md', 'README.md'];

/**
 * The directories a path has to start with to be a claim about this repo.
 *
 * An allowlist, so prose mentioning `~/.claude/settings.json` or somebody
 * else's `state/.lock` is not read as a promise about our own tree. A `~/` path
 * cannot reach it whatever the prefix says: `~` is outside the character class
 * the extractor matches on, so the user's own settings files never become a
 * claim about this repo.
 *
 * `.claude/` is in it for one pointer that matters more than most - the
 * roadmap-workflow skill, which now owns everything cut from *Roadmap and task
 * tracking* and which `AGENTS.md` tells every agent to load before touching
 * `docs/tasks/`.
 */
const OWNED = [
  'src/',
  'bin/',
  'hooks/',
  'public/',
  'test/',
  'scripts/',
  'docs/',
  '.github/',
  '.claude/',
];

/**
 * Every repo-relative path a document names.
 *
 * Matched inside backticks and inside markdown links, which is how this
 * codebase writes them - a bare path in running prose would be against the
 * house style anyway. Trailing punctuation is trimmed because a path routinely
 * ends a sentence.
 *
 * A file extension is required, so a bare directory (`docs/tasks/`) is prose
 * rather than a claim and needs no exemption list.
 *
 * @param {string} text
 * @returns {Map<string, number>} path -> first line it appears on
 */
export function pathsIn(text) {
  /** @type {Map<string, number>} */
  const found = new Map();
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(/[`([]([A-Za-z0-9_.@/-]+\.[A-Za-z0-9]+)[`)\]]/g)) {
      const path = match[1].replace(/[.,;:]+$/, '');
      if (!OWNED.some((prefix) => path.startsWith(prefix))) continue;
      if (!found.has(path)) found.set(path, index + 1);
    }
  }
  return found;
}

test('pathsIn takes paths out of backticks and links, and ignores foreign ones', () => {
  const text = [
    'the rule lives in `src/exec.js` and nowhere else.',
    'see [CONTRIBUTING.md](CONTRIBUTING.md) and `~/.claude/settings.json`.',
    'the adapter is `src/focus/terminals.js`, one entry.',
  ].join('\n');
  const found = pathsIn(text);
  assert.deepEqual([...found.keys()].sort(), ['src/exec.js', 'src/focus/terminals.js']);
  assert.equal(found.get('src/exec.js'), 1);
});

test('pathsIn trims the full stop a path picks up at the end of a sentence', () => {
  assert.deepEqual([...pathsIn('it is `src/server.js`.').keys()], ['src/server.js']);
});

for (const doc of DOCS) {
  test(`every source path ${doc} names exists on disk`, () => {
    const text = readFileSync(join(ROOT, doc), 'utf8');
    const missing = [];
    for (const [path, line] of pathsIn(text)) {
      if (!existsSync(join(ROOT, path))) missing.push(`${doc}:${line} -> ${path}`);
    }
    assert.deepEqual(
      missing,
      [],
      `${doc} points at ${missing.length} path(s) that are not there:\n  ${missing.join('\n  ')}`,
    );
  });
}

/**
 * An npm package name, and nothing that merely sits in backticks beside one.
 *
 * `npm run typecheck` shares the sentence and contains spaces, so it fails this
 * without needing an exemption list - which is the point: an exemption list is a
 * second inventory to keep in step, and this file exists because inventories
 * drift.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9-][a-z0-9-._]*\/)?[a-z0-9-][a-z0-9-._]*$/;

/**
 * The devDependencies a document names, from the bullet that enumerates them.
 *
 * Written to fail when the lists genuinely disagree and not when somebody
 * rewords the paragraph around them, because a check that fires on an improved
 * sentence is one the next person learns to ignore. Three things do that
 * separating:
 *
 * 1. The bullet is found by its **bold lead-in mentioning devDependency**,
 *    never by position and never by matching the sentence itself.
 * 2. Only the **enumerating sentence** is read - the bullet up to its first
 *    sentence end. What follows is about formatters and bundlers and may say
 *    anything, including naming a package as an example.
 * 3. Only **package-shaped backticked tokens** count, per `PACKAGE_NAME`.
 *
 * Returns null when the anchor is not there, which the caller must fail on:
 * a parser that quietly finds nothing is a green tick over an unread document,
 * which is this project's own failure mode wearing a passing test.
 *
 * @param {string} text
 * @returns {string[]|null} names as written, or null if the bullet is gone
 */
export function devDependenciesNamedIn(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^[-*] \*\*[^*]*devDependenc[^*]*\*\*/i.test(line));
  if (start === -1) return null;
  // A bullet runs to the next list item or the next blank line; its
  // continuation lines are indented, which is what this repo's markdown does.
  const bullet = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    bullet.push(line.trim());
  }
  const body = bullet.join(' ').replace(/^[-*] \*\*[^*]*\*\*/, '');
  // The lead-in ends in a full stop of its own, so it is stripped before the
  // sentence split rather than counted as the first sentence.
  const sentence = body.split(/(?<=\.)\s+(?=[A-Z])/)[0];
  return [...sentence.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1])
    .filter((token) => PACKAGE_NAME.test(token));
}

test('devDependenciesNamedIn reads the enumerating sentence and nothing after it', () => {
  const text = [
    '- **A runtime dependency.** `dependencies` stays empty.',
    '- **A fourth devDependency.** They are `typescript`, `@types/node` and `oxlint`, for',
    '  `npm run typecheck` and `npm run lint`. A formatter such as `prettier` needs raising',
    '  in an issue first.',
    '',
    'Some later paragraph naming `oxlint` again.',
  ].join('\n');
  assert.deepEqual(devDependenciesNamedIn(text), ['typescript', '@types/node', 'oxlint']);
});

test('devDependenciesNamedIn survives the prose around the list being rewritten', () => {
  const text = [
    '- **We will not take a fourth devDependency, and here is why.** The list is',
    '  `typescript`, `@types/node` and `oxlint` - nothing else, ever. Raise it in an issue.',
  ].join('\n');
  assert.deepEqual(devDependenciesNamedIn(text), ['typescript', '@types/node', 'oxlint']);
});

test('devDependenciesNamedIn returns null when the bullet it anchors on is gone', () => {
  assert.equal(devDependenciesNamedIn('- **A runtime dependency.** `dependencies` is empty.'), null);
});

test('CONTRIBUTING.md names exactly the devDependencies package.json has', () => {
  const named = devDependenciesNamedIn(readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8'));
  assert.ok(
    named,
    'CONTRIBUTING.md has no bullet whose bold lead-in mentions devDependency - the check ' +
      'above cannot find the list it is meant to be pinning, and needs re-anchoring rather ' +
      'than deleting',
  );
  const actual = Object.keys(
    JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).devDependencies,
  );
  assert.deepEqual(
    [...named].sort(),
    [...actual].sort(),
    `CONTRIBUTING.md says the devDependencies are ${named.join(', ')}; package.json has ` +
      `${actual.join(', ')}. Both are meant to be the whole list - fix the document, or if ` +
      'the fourth dependency was agreed, say so there too.',
  );
});

test('AGENTS.md names a real file for every row of the decision index', () => {
  const text = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  // Bounded at the next top-level heading, or the placement table under
  // *Maintaining this file* - itself a table with no file in it - gets read as
  // part of the index.
  const index = (text.split('### Decision index')[1] || '').split('\n## ')[0];
  assert.ok(index, 'AGENTS.md has no decision index - the split has been undone');
  // Every row is `| decision | owner |`, and the owner column is the whole
  // point of the row: a row that names no file is a rule with nowhere to go.
  //
  // The header is skipped by anchoring on the start of the line, never by
  // asking whether the word `Owner` appears anywhere in it. The substring
  // version read correctly and quietly exempted two real rows - the ones
  // naming `isRunOwnerCommand` and `RunOwners` - from the assertion below,
  // which is a guard that silently stops guarding exactly where a decision is
  // about ownership.
  const rows = index
    .split('\n')
    .filter(
      (line) =>
        line.startsWith('|') && !line.startsWith('| ---') && !line.startsWith('| Decision'),
    );
  assert.ok(rows.length > 40, `expected a populated index, found ${rows.length} rows`);
  const ownerless = rows.filter((row) => pathsIn(row.split('|')[2] || '').size === 0);
  assert.deepEqual(ownerless, [], 'index rows naming no owning file');
});
