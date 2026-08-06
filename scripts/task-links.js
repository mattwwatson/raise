/**
 * Every reference to a spec file must resolve to a spec file that exists.
 *
 * Spec filenames carry their Jira key, and a live item's filename is rewritten
 * when it is captured - `draft-stale-page.md` becomes `RAI-12-stale-page-code.md`
 * the moment the ticket exists. So a reference goes stale silently: nothing
 * fails, nothing warns, and the rot is invisible until somebody follows the
 * link and finds nothing there. That is the whole reason this runs in CI, and
 * it runs unconditionally rather than only on pull requests, because a dangling
 * reference is just as broken on `main`.
 *
 * **Resolution is membership of the walked set, not a filesystem call.** The
 * walk has already listed every file in the tree, so asking the filesystem
 * again - once per reference - would be both slower and untestable. It also
 * means the whole check is a pure function of `{file, text}[]`, which is what
 * lets the suite assert on a tree that does not exist.
 *
 * The tree is walked rather than shelled out to `git ls-files`, because nothing
 * reachable from here may run a subprocess and because a CI image is not
 * guaranteed to ship git.
 */

import { ANSI, painter } from './task-format.js';

/** @typedef {import('./task-files.js').TaskFileAccess} TaskFileAccess */

/**
 * @typedef {object} Reference
 * @property {string} file the referring file, relative to the repository root
 * @property {number} line 1-indexed, so the report is openable
 * @property {string} target the spec path the reference resolves to
 */

/**
 * @typedef {object} LinkReport
 * @property {Reference[]} broken
 * @property {number} checked how many references were resolved
 * @property {number} scanned how many files were read
 * @property {number} exitCode
 */

/** Where the specs live, relative to the repository root. */
export const TASKS_PREFIX = 'docs/tasks/';

/**
 * Directories never walked.
 *
 * `.claude` is deliberately absent: the `roadmap-workflow` skill lives there
 * and refers to spec files by path, which makes it exactly the kind of document
 * that goes stale unnoticed.
 *
 * **`test` is deliberately present, and it is not a convenience.** A test's job
 * is to contain fabricated data - a `docs/tasks/<gone>.md` is written precisely
 * *because* nothing is there, and this module's own suite cannot assert that a
 * broken reference is caught without writing one down. Reading
 * that as a claim about the tree is a category error, and one that makes the
 * check permanently red the day it is first run. The cost is that a genuine
 * stale reference inside a test is missed; the benefit is a check anybody
 * believes.
 */
export const SKIP_DIRS = Object.freeze(
  new Set([
    'node_modules',
    '.git',
    'coverage',
    'dist',
    '.nmmon',
    '.lavish',
    'test',
    'tests',
    '__tests__',
    'fixtures',
  ]),
);

/** Extensions read. A reference in any of these is as real as one in prose. */
export const SCANNED_EXTENSIONS = Object.freeze([
  '.md',
  '.js',
  '.json',
  '.yml',
  '.yaml',
  '.sh',
  '.html',
  '.css',
]);

/**
 * A reference that names the directory, with any number of `../` in front of
 * it. Matched anywhere in any scanned file, because a spec path inside a code
 * comment rots exactly like one in a link.
 *
 * The examples in this comment are written with an angle-bracket placeholder
 * rather than a plausible filename, so that documenting the pattern does not
 * trip it: `docs/tasks/<name>.md`, `tasks/<name>.md`.
 */
export const SPEC_REFERENCE = /(?:\.\.\/)*(?:docs\/)?tasks\/([A-Za-z0-9._-]+\.md)/g;

/**
 * A bare markdown link, `](X.md)`, with an optional anchor.
 *
 * Only meaningful inside `docs/tasks/` itself, where a sibling spec is
 * legitimately linked by filename alone. Applied anywhere else it would claim
 * every relative markdown link in the repository.
 */
export const BARE_SPEC_LINK = /\]\(([A-Za-z0-9._-]+\.md)(?:#[\w-]+)?\)/g;

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isScannedFile(name) {
  return SCANNED_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isScannedDir(name) {
  return !SKIP_DIRS.has(name);
}

/**
 * Every spec reference in one file, already resolved to a root-relative path.
 *
 * @param {string} file the referring file, relative to the repository root
 * @param {string} text
 * @returns {Reference[]}
 */
export function referencesIn(file, text) {
  /** @type {Reference[]} */
  const found = [];
  const insideTasks = file.startsWith(TASKS_PREFIX);
  const lines = String(text || '').split('\n');

  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(SPEC_REFERENCE)) {
      found.push({ file, line: index + 1, target: `${TASKS_PREFIX}${match[1]}` });
    }
    // A bare `](x.md)` is relative to the referring file's own directory, which
    // inside docs/tasks is docs/tasks.
    if (!insideTasks) continue;
    for (const match of line.matchAll(BARE_SPEC_LINK)) {
      found.push({ file, line: index + 1, target: `${TASKS_PREFIX}${match[1]}` });
    }
  }
  return found;
}

/**
 * Every scanned file in the tree, as root-relative paths.
 *
 * @param {string} root
 * @param {TaskFileAccess} files
 * @returns {string[]}
 */
export function walkTree(root, files) {
  /** @type {string[]} */
  const found = [];

  /** @param {string} dir @param {string} prefix */
  const walk = (dir, prefix) => {
    /** @type {{name: string, isDirectory: boolean}[]} */
    let entries;
    try {
      entries = files.readDir(dir);
    } catch {
      // A directory that vanished under us is not a broken link.
      return;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (isScannedDir(entry.name)) walk(`${dir}/${entry.name}`, relative);
      } else if (isScannedFile(entry.name)) {
        found.push(relative);
      }
    }
  };

  walk(root, '');
  return found.sort();
}

/**
 * The tree, read. A file that cannot be read is skipped rather than failing the
 * run: an unreadable file is not a broken link either.
 *
 * @param {string} root
 * @param {TaskFileAccess} files
 * @returns {{file: string, text: string}[]}
 */
export function readTree(root, files) {
  /** @type {{file: string, text: string}[]} */
  const documents = [];
  for (const file of walkTree(root, files)) {
    try {
      documents.push({ file, text: files.readText(`${root}/${file}`) });
    } catch {
      continue;
    }
  }
  return documents;
}

/**
 * Which references do not resolve.
 *
 * The set of files that were read is the existence oracle - see the module
 * comment. Every reference names a `.md`, and `.md` is scanned, so a spec that
 * exists is necessarily in the set.
 *
 * @param {{file: string, text: string}[]} documents
 * @returns {LinkReport}
 */
export function checkLinks(documents) {
  const present = new Set(documents.map((document) => document.file));
  /** @type {Reference[]} */
  const broken = [];
  let checked = 0;

  for (const document of documents) {
    for (const reference of referencesIn(document.file, document.text)) {
      checked += 1;
      if (!present.has(reference.target)) broken.push(reference);
    }
  }

  return { broken, checked, scanned: documents.length, exitCode: broken.length > 0 ? 1 : 0 };
}

/**
 * @param {LinkReport} report
 * @param {{colour?: boolean}} [options]
 * @returns {{out: string[], err: string[]}}
 */
export function renderLinks(report, { colour = false } = {}) {
  const paint = painter(colour);

  if (report.broken.length === 0) {
    const plural = report.checked === 1 ? 'reference' : 'references';
    return {
      out: [
        paint(
          ANSI.green,
          `spec links OK - ${report.checked} ${plural} across ` +
            `${report.scanned} files all resolve`,
        ),
      ],
      err: [],
    };
  }

  const plural = report.broken.length === 1 ? 'reference' : 'references';
  /** @type {string[]} */
  const err = ['', paint(ANSI.red, `${report.broken.length} broken spec ${plural}:`), ''];
  for (const reference of report.broken) {
    err.push(`  ${reference.file}:${reference.line}`);
    err.push(paint(ANSI.dim, `    -> ${reference.target}`));
  }
  err.push('');
  err.push(paint(ANSI.dim, '  A spec filename is rewritten when its item is captured, so a'));
  err.push(paint(ANSI.dim, '  reference to the old name goes stale without anything failing.'));
  err.push('');

  return { out: [], err };
}
