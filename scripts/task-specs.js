/**
 * A file in `docs/tasks/`, read as a work item.
 *
 * The roadmap workflow keeps the *ordering* of work in Jira and the
 * *specification* on disk, with a copy of the status in each spec's
 * frontmatter. That copy is what lets the board, and the CI gate that matters,
 * work with no network and no credential - so this module is the floor
 * everything else here stands on.
 *
 * Frontmatter is a fixed `key: value` shape written by us, so it is parsed
 * directly rather than by pulling in a YAML library: `dependencies` in
 * `package.json` stays empty, and that applies to a dev script as much as to
 * anything under `src/`.
 *
 * Nothing here reads a file. `collectSpecs` takes documents that have already
 * been read, and `readSpecs` is the thin shell that fetches them through an
 * injected accessor. A structural problem is a `Fault` in the returned set, not
 * a throw and not a `console.error`, because the caller decides whether it is
 * worth an exit code - the board still prints every good spec beside the bad
 * one, which is the whole reason faults are collected rather than fatal.
 */

import { join } from 'node:path';

/** @typedef {import('./task-files.js').TaskFileAccess} TaskFileAccess */

/** @typedef {'backlog'|'in-progress'|'shipped'|'wont-do'} TaskStatus */

/**
 * @typedef {'no-ticket'|'unknown-status'|'duplicate-ticket'|'unknown-depends'
 *           |'depends-cycle'|'unreadable'|'no-jira-issue'} FaultCode
 */

/**
 * @typedef {object} Spec
 * @property {string} file the name inside `docs/tasks/`, not a path
 * @property {string} ticket
 * @property {string} title the H1, with its own leading `KEY - ` removed
 * @property {TaskStatus} status
 * @property {string} size `?` when the frontmatter omits it
 * @property {string[]} depends empty for `-` and for no key at all
 * @property {string|null} branch
 * @property {string|null} shipped `YYYY-MM-DD`
 */

/**
 * A structural problem with the specs themselves.
 *
 * `code` exists so a test can assert on the fault rather than on an English
 * sentence that is free to be reworded; `message` is for the human reading the
 * output and is not a contract.
 *
 * @typedef {object} Fault
 * @property {FaultCode} code
 * @property {string|null} file
 * @property {string|null} ticket
 * @property {string} message
 */

/**
 * @typedef {object} SpecSet
 * @property {Map<string, Spec>} byTicket
 * @property {Fault[]} faults
 * @property {string[]} skipped files carrying no frontmatter: prose, not work items
 */

/** The four a spec may say. Anything else is a fault, never a guess. */
export const STATUSES = Object.freeze(
  /** @type {TaskStatus[]} */ (['backlog', 'in-progress', 'shipped', 'wont-do']),
);

/** Relative to the repository root. */
export const TASKS_DIR = 'docs/tasks';

export const SPEC_EXTENSION = '.md';

/**
 * The frontmatter block, requiring a closing `---` on a line of its own.
 *
 * The original matched `\n---` anywhere, so any body line merely *starting*
 * `---` closed the block early - a horizontal rule written `----` among them.
 * The specs in this repository open with `---` rules between sections, so that
 * is a live shape and not a hypothetical one.
 */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const FIELD = /^([a-z][a-z0-9-]*):\s*(.*)$/;

/** A trailing `# ...`, introduced by whitespace. See `parseFrontmatter`. */
const TRAILING_COMMENT = /\s+#.*$/;

/** The first `# ` heading. `## ` cannot match, the second character not being whitespace. */
const HEADING = /^#\s+(.+)$/m;

/** A heading that repeats its own ticket key, which the board column does not need. */
const OWN_KEY_PREFIX = /^[A-Z][A-Z0-9]*-\d+\s+-\s+/;

/** The trailing number of a ticket key, for ordering. */
const TICKET_NUMBER = /-(\d+)$/;

/**
 * The frontmatter fields, or null when the file has no frontmatter block.
 *
 * A trailing `# ...` is stripped, because the canonical frontmatter block in
 * the `roadmap-workflow` skill documents each field with an inline comment
 * naming its legal values. Copying that block - which is what the skill is for
 * - would otherwise produce a `status` of `backlog          # backlog |
 * in-progress | shipped | wont-do` and a fault on a correctly written file. No
 * field here has a value that can legitimately contain a hash.
 *
 * @param {string} text
 * @returns {Record<string, string>|null}
 */
export function parseFrontmatter(text) {
  const block = FRONTMATTER.exec(String(text || ''));
  if (!block) return null;
  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of block[1].split(/\r?\n/)) {
    const field = FIELD.exec(line);
    if (!field) continue;
    fields[field[1]] = field[2].replace(TRAILING_COMMENT, '').replace(/^"(.*)"$/, '$1').trim();
  }
  return fields;
}

/**
 * The title a spec goes by, falling back to its filename.
 *
 * @param {string} text
 * @param {string} file
 * @returns {string}
 */
export function titleOf(text, file) {
  const heading = HEADING.exec(String(text || ''));
  if (!heading) return file;
  return heading[1].trim().replace(OWN_KEY_PREFIX, '').trim() || file;
}

/**
 * The number in a ticket key, so RAI-2 orders before RAI-10.
 *
 * @param {string} ticket
 * @returns {number}
 */
export function ticketNumber(ticket) {
  const match = TICKET_NUMBER.exec(String(ticket || ''));
  return match ? Number(match[1]) : 0;
}

/**
 * @param {FaultCode} code
 * @param {string|null} file
 * @param {string|null} ticket
 * @param {string} message
 * @returns {Fault}
 */
function fault(code, file, ticket, message) {
  return { code, file, ticket, message };
}

/**
 * One document, read as a spec, a fault, or neither.
 *
 * `skipped` is a file that is not claiming to be a work item at all - no
 * frontmatter, or frontmatter carrying neither a ticket nor a status. The skill
 * is explicit that such a file is reference prose and the board passes over it.
 * Frontmatter that names one of the two and not the other *is* claiming to be a
 * work item and gets a fault, because a half-declared item is the case that
 * silently drops off the board.
 *
 * @param {string} file
 * @param {string} text
 * @returns {{spec: Spec|null, fault: Fault|null, skipped: boolean}}
 */
export function parseSpec(file, text) {
  const fields = parseFrontmatter(text);
  if (!fields) return { spec: null, fault: null, skipped: true };
  if (!fields.ticket && !fields.status) return { spec: null, fault: null, skipped: true };

  if (!fields.ticket) {
    const message = `${file}: no "ticket:" - every work item needs a Jira key`;
    return { spec: null, fault: fault('no-ticket', file, null, message), skipped: false };
  }
  if (!STATUSES.includes(/** @type {TaskStatus} */ (fields.status))) {
    const message =
      `${file}: unknown status "${fields.status || ''}" (want ${STATUSES.join(' | ')})`;
    return { spec: null, fault: fault('unknown-status', file, fields.ticket, message), skipped: false };
  }

  /** @type {Spec} */
  const spec = {
    file,
    ticket: fields.ticket,
    title: titleOf(text, file),
    status: /** @type {TaskStatus} */ (fields.status),
    size: fields.size || '?',
    depends:
      fields.depends && fields.depends !== '-'
        ? fields.depends
            .split(',')
            .map((key) => key.trim())
            .filter(Boolean)
        : [],
    branch: fields.branch || null,
    shipped: fields.shipped || null,
  };
  return { spec, fault: null, skipped: false };
}

/**
 * Every ring in the dependency graph, each reported once, in a stable rotation.
 *
 * The original catches a self-dependency and an unknown key and stops there, so
 * a ring of three renders as three items permanently blocked with nothing
 * saying why - and "blocked" is indistinguishable from an item that is merely
 * waiting its turn. A ring is reported as a fault instead, because nothing in
 * it can ever become ready without somebody editing a `depends:` line.
 *
 * A self-dependency is a ring of one and needs no separate rule.
 *
 * @param {Map<string, Spec>} byTicket
 * @returns {string[][]}
 */
export function findDependencyCycles(byTicket) {
  /** @type {string[][]} */
  const rings = [];
  /** @type {Set<string>} */
  const settled = new Set();
  /** @type {Map<string, number>} */
  const depth = new Map();
  /** @type {string[]} */
  const path = [];
  /** @type {Set<string>} */
  const reported = new Set();

  /** @param {string} ticket */
  const visit = (ticket) => {
    const at = depth.get(ticket);
    if (at !== undefined) {
      const ring = rotateToLowest(path.slice(at));
      const key = ring.join(',');
      if (!reported.has(key)) {
        reported.add(key);
        rings.push(ring);
      }
      return;
    }
    if (settled.has(ticket)) return;
    const spec = byTicket.get(ticket);
    // An unknown key is not a ring; `collectSpecs` reports it on its own terms.
    if (!spec) return;
    depth.set(ticket, path.length);
    path.push(ticket);
    for (const dependency of spec.depends) visit(dependency);
    path.pop();
    depth.delete(ticket);
    settled.add(ticket);
  };

  for (const ticket of byTicket.keys()) visit(ticket);
  return rings;
}

/**
 * One rotation of a ring, so the same ring reached from two entry points reads
 * the same and is reported once.
 *
 * @param {string[]} ring
 * @returns {string[]}
 */
function rotateToLowest(ring) {
  let lowest = 0;
  for (let index = 1; index < ring.length; index += 1) {
    if (ring[index] < ring[lowest]) lowest = index;
  }
  return [...ring.slice(lowest), ...ring.slice(0, lowest)];
}

/**
 * Documents in, one indexed set of specs out.
 *
 * The first file to claim a ticket keeps it and the second is the fault, so one
 * duplicate costs one spec rather than both of them.
 *
 * @param {{file: string, text: string}[]} documents
 * @returns {SpecSet}
 */
export function collectSpecs(documents) {
  /** @type {Map<string, Spec>} */
  const byTicket = new Map();
  /** @type {Fault[]} */
  const faults = [];
  /** @type {string[]} */
  const skipped = [];

  for (const document of documents) {
    const read = parseSpec(document.file, document.text);
    if (read.skipped) {
      skipped.push(document.file);
      continue;
    }
    if (read.fault) {
      faults.push(read.fault);
      continue;
    }
    if (!read.spec) continue;
    const claimed = byTicket.get(read.spec.ticket);
    if (claimed) {
      const message = `${document.file}: ${read.spec.ticket} is already claimed by ${claimed.file}`;
      faults.push(fault('duplicate-ticket', document.file, read.spec.ticket, message));
      continue;
    }
    byTicket.set(read.spec.ticket, read.spec);
  }

  for (const spec of byTicket.values()) {
    for (const dependency of spec.depends) {
      // A self-dependency is a ring, and is reported as one below.
      if (dependency === spec.ticket || byTicket.has(dependency)) continue;
      const message = `${spec.file}: depends on ${dependency}, which no spec claims`;
      faults.push(fault('unknown-depends', spec.file, spec.ticket, message));
    }
  }

  for (const ring of findDependencyCycles(byTicket)) {
    const shape = ring.length === 1 ? `${ring[0]} depends on itself` : ring.join(' -> ');
    const message = `dependency ring: ${shape} - nothing in it can become ready`;
    faults.push(fault('depends-cycle', byTicket.get(ring[0])?.file ?? null, ring[0], message));
  }

  return { byTicket, faults, skipped };
}

/**
 * The spec set as it stands on disk.
 *
 * A file that cannot be read is a fault rather than an exception: one
 * unreadable spec must not take the board down, for the same reason a malformed
 * one does not.
 *
 * @param {string} dir the absolute `docs/tasks` path
 * @param {TaskFileAccess} files
 * @returns {SpecSet}
 */
export function readSpecs(dir, files) {
  /** @type {{name: string, isDirectory: boolean}[]} */
  let entries;
  try {
    entries = files.readDir(dir);
  } catch {
    const message = `${dir}: cannot be read - is this a checkout of the repository?`;
    return { byTicket: new Map(), faults: [fault('unreadable', dir, null, message)], skipped: [] };
  }

  /** @type {{file: string, text: string}[]} */
  const documents = [];
  /** @type {Fault[]} */
  const unreadable = [];
  const names = entries
    .filter((entry) => !entry.isDirectory && entry.name.endsWith(SPEC_EXTENSION))
    .map((entry) => entry.name)
    .sort();

  for (const name of names) {
    try {
      documents.push({ file: name, text: files.readText(join(dir, name)) });
    } catch {
      unreadable.push(fault('unreadable', name, null, `${name}: could not be read`));
    }
  }

  const set = collectSpecs(documents);
  return { ...set, faults: [...unreadable, ...set.faults] };
}
