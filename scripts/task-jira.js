/**
 * The one command here that talks to Jira, and the only one that can.
 *
 * `validate` answers a different question from the gate, and the difference is
 * the whole design. The gate asks *is this branch's spec ready to merge*, which
 * is a fact on disk. This asks *do disk and Jira still agree*, which they
 * routinely and correctly do not: a checkout describes what is merged **here**,
 * while Jira describes where the workflow is. An item somebody else started is
 * In Progress in Jira while this checkout still says backlog, and every item
 * mid-PR is In Review in Jira while its spec already says shipped.
 *
 * So this is a **report**. Divergence prints and exits 0. Only a structural
 * fault - a spec naming a ticket Jira has never heard of - exits 1, and only a
 * failure to *ask* exits 2. Wiring it into CI would therefore be a category
 * error twice over: it would fail on states that are correct, and it would put
 * a Jira credential in a pipeline. It is never run there, which is exactly why
 * the two commands that are can never fail on an expired token.
 *
 * Requests go through the `api.atlassian.com` gateway rather than a site URL,
 * because a scoped API token only works there while a classic one works against
 * both - one path serves either, and the scope needed is `read:jira-work` and
 * nothing else.
 *
 * Nothing here reads `process.env` or calls the global `fetch`. Both arrive as
 * parameters, so the credential assembly, the failure explanations and the
 * whole reconciliation are asserted with no network and no stubbing of globals.
 */

import { ANSI, cell, painter } from './task-format.js';
import { ticketNumber } from './task-specs.js';

/** @typedef {import('./task-specs.js').Spec} Spec */
/** @typedef {import('./task-specs.js').Fault} Fault */
/** @typedef {import('./task-specs.js').TaskStatus} TaskStatus */

/**
 * @typedef {object} JiraIssue
 * @property {string} key
 * @property {string} status the workflow status name, as Jira spells it
 * @property {string} summary
 * @property {boolean} isEpic
 */

/**
 * @typedef {object} JiraRequest
 * @property {string} url
 * @property {Record<string, string>} headers
 */

/**
 * One shape rather than a discriminated union of two.
 *
 * A union keyed on `ok: true | false` reads better and does not survive this
 * repository's deliberate `strict: false`: with `strictNullChecks` off, TypeScript
 * stops narrowing on a boolean discriminant, so `if (!result.ok)` leaves the
 * failure branch still typed as the success member and the checker objects to
 * the code that is correct. Optional-by-convention fields, documented as such,
 * are what the rest of this port already does - `Board` and `ValidationReport`
 * both carry their `exitCode` the same way.
 *
 * @typedef {object} JiraFetchResult
 * @property {boolean} ok
 * @property {JiraIssue[]} issues empty unless `ok`
 * @property {number} exitCode 0 when `ok`, otherwise 2
 * @property {string} reason empty when `ok`
 * @property {string[]} detail empty when `ok`
 */

/**
 * @typedef {object} ValidationReport
 * @property {{spec: Spec, jiraStatus: string, expected: TaskStatus}[]} diverged
 * @property {{key: string, jiraStatus: string}[]} unmapped
 * @property {{key: string, isEpic: boolean}[]} orphans
 * @property {number} exemptEpics
 * @property {Fault[]} faults
 * @property {number} specCount
 * @property {number} issueCount
 * @property {number} exitCode
 */

export const JIRA_GATEWAY = 'https://api.atlassian.com/ex/jira';
export const JIRA_SEARCH_PATH = 'rest/api/3/search/jql';

/**
 * The site and the project this repository's roadmap lives on.
 *
 * Defaulted inline on purpose, and the line being drawn is *project identity*
 * versus *somebody's credential*, not "no literals in source". These two name
 * the board that `AGENTS.md` already links to; a fork overrides them exactly as
 * it would that link. `JIRA_EMAIL` and `JIRA_TOKEN` identify a person and get
 * no default at all - a hardcoded email works perfectly for one human and
 * silently does nothing for everybody else.
 */
export const DEFAULT_CLOUD_ID = 'd327fd1a-d3be-4320-8bf0-39afb74e7b8c';
export const DEFAULT_PROJECT = 'RAI';

/** Jira's own page size. It caps this well below 200; the loop does the rest. */
export const PAGE_SIZE = 100;

/**
 * A bound on the paging loop. Reaching it is a failure rather than a short
 * answer - see `fetchJiraIssues`.
 */
export const MAX_PAGES = 20;

/**
 * Jira workflow status to the disk status that corresponds to it.
 *
 * Both `In Progress` and `In Review` map to `in-progress`, because the spec has
 * no third word and a branch under review is still a branch being worked on.
 * A status absent from this map is reported as *unmapped* rather than as
 * divergence: a word we have never seen is new, not wrong, and the same
 * fail-soft rule the dashboard applies to an unrecognised run status.
 *
 * @type {Record<string, TaskStatus>}
 */
export const JIRA_STATUS_TO_DISK = Object.freeze({
  'To Do': 'backlog',
  'In Progress': 'in-progress',
  'In Review': 'in-progress',
  Done: 'shipped',
});

/**
 * The request to make, or the names of the variables that stop us making it.
 *
 * Every missing variable is named at once rather than one per run, because
 * finding out about the second one only after fixing the first is how a
 * two-minute task becomes four.
 *
 * @param {{email?: string, token?: string, cloudId?: string, project?: string,
 *          pageToken?: string|null}} credentials
 * @returns {{request: JiraRequest|null, missing: string[]}}
 */
export function buildJiraRequest({ email, token, cloudId, project, pageToken = null } = {}) {
  /** @type {string[]} */
  const missing = [];
  if (!email) missing.push('JIRA_EMAIL');
  if (!token) missing.push('JIRA_TOKEN');
  if (missing.length > 0) return { request: null, missing };

  const site = cloudId || DEFAULT_CLOUD_ID;
  const jql = `project = ${project || DEFAULT_PROJECT}`;
  const query = new URLSearchParams({
    jql,
    fields: 'status,issuetype,summary',
    maxResults: String(PAGE_SIZE),
  });
  // Epics are queried like anything else. The original excluded them, which
  // here would report `RAI-1-open-source-release.md` as a permanent fault:
  // this repository gives an epic a spec, and that spec is not going away.
  if (pageToken) query.set('nextPageToken', pageToken);

  return {
    request: {
      url: `${JIRA_GATEWAY}/${site}/${JIRA_SEARCH_PATH}?${query}`,
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
        Accept: 'application/json',
      },
    },
    missing,
  };
}

/**
 * What a failed response actually means.
 *
 * The two 401s are the point. They are byte-identical to look at and have
 * completely different fixes, and guessing wrong costs a rotation of a healthy
 * token.
 *
 * @param {number} status
 * @param {string} body
 * @param {string} [email]
 * @returns {string[]}
 */
export function explainJiraFailure(status, body, email) {
  const text = String(body || '');
  if (/scope does not match/i.test(text)) {
    return ['The token is scoped but lacks Jira read access - it needs read:jira-work.'];
  }
  if (status === 401) {
    return [
      `Credential rejected. Check that ${email || 'JIRA_EMAIL'} is the account that owns`,
      'the token - a valid token under the wrong email fails exactly like a bad one.',
    ];
  }
  if (status === 404) {
    return ['No Jira at that cloud id. Check JIRA_CLOUD_ID names a site this account can see.'];
  }
  return [text.slice(0, 300)];
}

/**
 * One page of search results, normalised.
 *
 * An epic is identified by `hierarchyLevel` rather than by the type being
 * called "Epic", because the name is renameable in Jira's own settings and the
 * level is structural. The name is kept as a fallback for a payload that
 * carries no level.
 *
 * @param {unknown} payload
 * @returns {{issues: JiraIssue[], nextPageToken: string|null, isLast: boolean}}
 */
export function issuesFromSearch(payload) {
  const page = /** @type {Record<string, any>} */ (payload || {});
  const rows = Array.isArray(page.issues) ? page.issues : [];
  const issues = rows
    .map((row) => {
      const type = row?.fields?.issuetype || {};
      const level = typeof type.hierarchyLevel === 'number' ? type.hierarchyLevel : null;
      return {
        key: String(row?.key || ''),
        status: String(row?.fields?.status?.name || ''),
        summary: String(row?.fields?.summary || ''),
        isEpic: level === null ? String(type.name || '') === 'Epic' : level > 0,
      };
    })
    .filter((issue) => issue.key);
  return {
    issues,
    nextPageToken: page.nextPageToken ? String(page.nextPageToken) : null,
    isLast: page.isLast === true,
  };
}

/**
 * Every issue in the project, following Jira's paging to the end.
 *
 * The original asked for `maxResults=200` and stopped, which this endpoint
 * makes worse than it sounds: the response carries no `total` at all, only
 * `isLast` and a `nextPageToken`, so a truncated read is indistinguishable from
 * a complete one. Every spec past the cut would then read as *"does not exist
 * in Jira"* - a fault, exit 1, and a confident wrong answer of exactly the kind
 * this repository keeps having to design against.
 *
 * Running past `MAX_PAGES` is therefore a **failure**, not a short answer. A
 * partial reading is not evidence.
 *
 * @param {{env: Record<string, string|undefined>, fetchImpl?: typeof fetch}} deps
 * @returns {Promise<JiraFetchResult>}
 */
export async function fetchJiraIssues({ env, fetchImpl = fetch }) {
  /**
   * @param {string} reason
   * @param {string[]} detail
   * @returns {JiraFetchResult}
   */
  const unavailable = (reason, detail) => ({ ok: false, issues: [], exitCode: 2, reason, detail });

  const credentials = {
    email: env.JIRA_EMAIL,
    token: env.JIRA_TOKEN,
    cloudId: env.JIRA_CLOUD_ID || DEFAULT_CLOUD_ID,
    project: env.JIRA_PROJECT || DEFAULT_PROJECT,
  };

  const { missing } = buildJiraRequest(credentials);
  if (missing.length > 0) {
    return unavailable(`tasks:validate needs ${missing.join(' and ')}`, [
      'Never export the token - command substitution keeps it out of your history:',
      '',
      '  JIRA_EMAIL=you@example.com \\',
      '    JIRA_TOKEN=$(secret-get JIRA_PERSONAL_API_TOKEN) npm run tasks:validate',
    ]);
  }

  /** @type {JiraIssue[]} */
  const issues = [];
  /** @type {string|null} */
  let pageToken = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { request } = buildJiraRequest({ ...credentials, pageToken });
    if (!request) break;

    let response;
    try {
      response = await fetchImpl(request.url, { headers: request.headers });
    } catch (err) {
      return unavailable('Could not reach Jira', [String(err?.message || err)]);
    }

    if (!response.ok) {
      const body = await response.text();
      const status = response.status;
      return unavailable(
        `Jira returned ${status}`,
        explainJiraFailure(status, body, credentials.email),
      );
    }

    const read = issuesFromSearch(await response.json());
    issues.push(...read.issues);
    if (read.isLast || !read.nextPageToken) {
      return { ok: true, issues, exitCode: 0, reason: '', detail: [] };
    }
    pageToken = read.nextPageToken;
  }

  return unavailable(`Jira is still paging after ${MAX_PAGES} pages`, [
    'Refusing to report on a partial reading: every spec past the cut would',
    'look like a ticket that does not exist. Raise MAX_PAGES if the project',
    `really holds more than ${MAX_PAGES * PAGE_SIZE} issues.`,
  ]);
}

/**
 * Disk against Jira.
 *
 * Three things are deliberately not divergence, and each would otherwise be
 * permanent noise on this project as it stands today:
 *
 * - a `wont-do` spec, because Jira has no state that corresponds to it
 * - an **epic**, because an epic's status follows its children - `RAI-1` reads
 *   To Do in Jira and in-progress on disk, and both are right
 * - a Jira status this map has never seen, which is reported as *unmapped*
 *
 * A Jira issue with no spec file is an **orphan**, reported and not faulted:
 * the workflow says an epic's children need no spec until one is picked up, so
 * orphans are the documented design rather than a gap.
 *
 * @param {Map<string, Spec>} byTicket
 * @param {JiraIssue[]} issues
 * @returns {ValidationReport}
 */
export function reconcile(byTicket, issues) {
  const jira = new Map(issues.map((issue) => [issue.key, issue]));

  /** @type {ValidationReport['diverged']} */
  const diverged = [];
  /** @type {ValidationReport['unmapped']} */
  const unmapped = [];
  /** @type {Fault[]} */
  const faults = [];
  let exemptEpics = 0;

  for (const spec of byTicket.values()) {
    const issue = jira.get(spec.ticket);
    if (!issue) {
      faults.push({
        code: 'no-jira-issue',
        file: spec.file,
        ticket: spec.ticket,
        message: `${spec.file}: ${spec.ticket} does not exist in Jira`,
      });
      continue;
    }
    if (spec.status === 'wont-do') continue;
    if (issue.isEpic) {
      exemptEpics += 1;
      continue;
    }
    const expected = JIRA_STATUS_TO_DISK[issue.status];
    if (!expected) {
      unmapped.push({ key: spec.ticket, jiraStatus: issue.status });
      continue;
    }
    if (expected !== spec.status) diverged.push({ spec, jiraStatus: issue.status, expected });
  }

  // Sorted by ticket number, not left in Jira's order - it answers newest
  // first, so an unsorted list reads backwards and is harder to scan against
  // the board above it, which is sorted the other way.
  const orphans = issues
    .filter((issue) => !byTicket.has(issue.key))
    .map((issue) => ({ key: issue.key, isEpic: issue.isEpic }))
    .sort((a, b) => ticketNumber(a.key) - ticketNumber(b.key));

  return {
    diverged,
    unmapped,
    orphans,
    exemptEpics,
    faults,
    specCount: byTicket.size,
    issueCount: issues.length,
    exitCode: faults.length > 0 ? 1 : 0,
  };
}

const STATUS_WIDTH = 12;

/**
 * @param {ValidationReport} report
 * @param {{colour?: boolean}} [options]
 * @returns {{out: string[], err: string[]}}
 */
export function renderValidation(report, { colour = false } = {}) {
  const paint = painter(colour);
  /** @type {string[]} */
  const out = [];

  out.push(
    `${paint(ANSI.bold, 'validate')} - ` +
      `${report.specCount} specs against ${report.issueCount} Jira issues`,
  );
  out.push('');

  if (report.diverged.length > 0) {
    out.push(paint(ANSI.dim, '  Jira and disk differ. Expected while work is in flight -'));
    out.push(paint(ANSI.dim, '  disk describes what is merged HERE, Jira describes the workflow.'));
    out.push('');
    for (const { spec, jiraStatus } of report.diverged) {
      out.push(
        `  ${paint(ANSI.yellow, cell(spec.ticket, 8))} ` +
          `Jira ${paint(ANSI.cyan, cell(jiraStatus, STATUS_WIDTH))} ` +
          `disk ${paint(ANSI.yellow, cell(spec.status, STATUS_WIDTH))} ${paint(ANSI.dim, spec.file)}`,
      );
    }
    out.push('');
  } else {
    out.push(paint(ANSI.green, '  every item matches Jira'));
    out.push('');
  }

  if (report.exemptEpics > 0) {
    const plural = report.exemptEpics === 1 ? 'epic' : 'epics';
    out.push(paint(ANSI.dim, `  ${report.exemptEpics} ${plural} not compared, because an epic's`));
    out.push(paint(ANSI.dim, '  status follows its children rather than its own spec.'));
    out.push('');
  }

  if (report.unmapped.length > 0) {
    for (const { key, jiraStatus } of report.unmapped) {
      out.push(paint(ANSI.dim, `  ${key} is "${jiraStatus}" in Jira, a status this does not map.`));
    }
    out.push(paint(ANSI.dim, '  Reported rather than treated as divergence: a word we have'));
    out.push(paint(ANSI.dim, '  not seen is new, not wrong. Add it to JIRA_STATUS_TO_DISK.'));
    out.push('');
  }

  if (report.orphans.length > 0) {
    const keys = report.orphans.map((orphan) => orphan.key).join(', ');
    const plural = report.orphans.length === 1 ? 'issue' : 'issues';
    out.push(paint(ANSI.dim, `  ${report.orphans.length} Jira ${plural} with no spec file: ${keys}`));
    out.push(paint(ANSI.dim, "  Expected rather than a gap - an epic's children need no spec"));
    out.push(paint(ANSI.dim, '  until one of them is picked up.'));
    out.push('');
  }

  /** @type {string[]} */
  const err = [];
  for (const problem of report.faults) err.push(paint(ANSI.red, `  ! ${problem.message}`));
  if (report.faults.length > 0) err.push('');

  return { out, err };
}

/**
 * A failure to ask, which is not a failure of the repository.
 *
 * @param {{reason: string, detail: string[]}} failure
 * @param {{colour?: boolean}} [options]
 * @returns {{out: string[], err: string[]}}
 */
export function renderJiraFailure(failure, { colour = false } = {}) {
  const paint = painter(colour);
  return {
    out: [],
    err: ['', paint(ANSI.red, failure.reason), '', ...failure.detail.map((line) => `  ${line}`), ''],
  };
}
