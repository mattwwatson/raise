/**
 * The roadmap commands, and the only place here that touches the world.
 *
 *   npm run tasks            the board
 *   npm run tasks:links      every docs/tasks reference resolves
 *   npm run tasks:gate       CI: this branch's spec says shipped
 *   npm run tasks:validate   the board, plus a Jira reconciliation REPORT
 *
 * Jira owns the ordering - backlog rank, epics, explicitly-set blockers - and
 * the repository owns the specification and carries a copy of the status, which
 * is what lets three of these four run with no network and no credential.
 * `depends:` stays on disk because what can run in parallel is an
 * implementation fact, but an explicit `is blocked by` link in Jira overrides
 * it, that one having been set deliberately.
 *
 * Everything above this file is pure and returns a result carrying its own
 * `exitCode`; this is the only file that reads a directory, makes a request,
 * writes a line or assigns `process.exitCode`. That is what makes "a spec left
 * backlog fails the gate" an assertion about a function rather than about a
 * subprocess.
 */

import { join } from 'node:path';

import { GitBranch } from '../src/git-branch.js';
import { buildBoard, renderBoard } from './task-board.js';
import { defaultTaskFiles, repoRoot } from './task-files.js';
import { gateBranch, renderGate, renderGateFaults } from './task-gate.js';
import { fetchJiraIssues, reconcile, renderJiraFailure, renderValidation } from './task-jira.js';
import { checkLinks, readTree, renderLinks } from './task-links.js';
import { readSpecs, TASKS_DIR } from './task-specs.js';

/** Subcommands, in the order `usage` lists them. */
const COMMANDS = ['board', 'links', 'gate', 'validate'];

const DEFAULT_COMMAND = 'board';

/**
 * @param {{out: string[], err: string[]}} lines
 */
function write({ out, err }) {
  for (const line of out) console.log(line);
  for (const line of err) console.error(line);
}

function usage() {
  console.error('Usage: node scripts/tasks.js [%s]', COMMANDS.join(' | '));
  console.error('');
  console.error('  board     what is ready, what is blocked, what shipped');
  console.error('  links     every docs/tasks reference resolves');
  console.error('  gate      CI: this branch\'s spec says shipped');
  console.error('  validate  the board, plus how disk and Jira differ (a report)');
}

/**
 * The branch this checkout is on.
 *
 * `BITBUCKET_BRANCH` first, because on a pull-request build it is the source
 * branch and the checkout may not be on it. Otherwise `.git/HEAD`, read through
 * the module the server already uses - which handles a linked worktree and
 * costs no subprocess. A detached HEAD has no branch, and the gate says so.
 *
 * @returns {string|null}
 */
function currentBranch() {
  if (process.env.BITBUCKET_BRANCH) return process.env.BITBUCKET_BRANCH;
  return new GitBranch().checkoutFor(repoRoot()).branch;
}

async function main() {
  const command = process.argv[2] || DEFAULT_COMMAND;
  if (!COMMANDS.includes(command)) {
    console.error(`Unknown command: ${command}`);
    console.error('');
    usage();
    process.exitCode = 2;
    return;
  }

  const colour = process.stdout.isTTY === true && !process.env.NO_COLOR;
  const root = repoRoot();

  // `links` reads the tree rather than the specs, and answers on its own.
  if (command === 'links') {
    const report = checkLinks(readTree(root, defaultTaskFiles));
    write(renderLinks(report, { colour }));
    process.exitCode = report.exitCode;
    return;
  }

  const specs = readSpecs(join(root, TASKS_DIR), defaultTaskFiles);

  // The gate is one assertion and deliberately prints no board.
  if (command === 'gate') {
    const result = gateBranch(currentBranch(), specs.byTicket);
    write(renderGateFaults(specs.faults, { colour }));
    write(renderGate(result, { colour, today: new Date().toISOString().slice(0, 10) }));
    process.exitCode = Math.max(result.exitCode, specs.faults.length > 0 ? 1 : 0);
    return;
  }

  const board = buildBoard(specs);
  write(renderBoard(board, { colour }));
  process.exitCode = board.exitCode;

  if (command !== 'validate') return;

  const fetched = await fetchJiraIssues({ env: process.env });
  if (!fetched.ok) {
    write(renderJiraFailure(fetched, { colour }));
    // A failure to *ask* is not a failure of the repository, so it gets its own
    // code rather than being folded into the structural 1.
    process.exitCode = fetched.exitCode;
    return;
  }

  const report = reconcile(specs.byTicket, fetched.issues);
  write(renderValidation(report, { colour }));
  process.exitCode = Math.max(board.exitCode, report.exitCode);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
