/**
 * Every source path the documentation names has to exist.
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
const DOCS = ['AGENTS.md', 'CONTRIBUTING.md'];

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

test('AGENTS.md names a real file for every row of the decision index', () => {
  const text = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  // Bounded at the next top-level heading, or the placement table under
  // *Maintaining this file* - itself a table with no file in it - gets read as
  // part of the index.
  const index = (text.split('### Decision index')[1] || '').split('\n## ')[0];
  assert.ok(index, 'AGENTS.md has no decision index - the split has been undone');
  // Every row is `| decision | owner |`, and the owner column is the whole
  // point of the row: a row that names no file is a rule with nowhere to go.
  const rows = index
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.startsWith('| ---') && !line.includes('Owner'));
  assert.ok(rows.length > 40, `expected a populated index, found ${rows.length} rows`);
  const ownerless = rows.filter((row) => pathsIn(row.split('|')[2] || '').size === 0);
  assert.deepEqual(ownerless, [], 'index rows naming no owning file');
});
