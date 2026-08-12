/**
 * The roadmap commands, and the only place here that touches the world.
 *
 *   npm run tasks            the board
 *   npm run tasks:links      every docs/tasks reference resolves
 *   npm run tasks:gate       CI: this branch's spec says shipped
 *   npm run tasks:validate   the board, plus an issue reconciliation REPORT
 *
 * The issue tracker owns the ordering - the backlog's order, and any blocker set
 * on an issue deliberately - and the repository owns the specification and
 * carries a copy of the status, which is what lets three of these four run with
 * no network and no credential. `depends:` stays on disk because what can run in
 * parallel is an implementation fact, but a blocker stated on the issue
 * overrides it, that one having been set by hand.
 *
 * Everything above this file is pure and returns a result carrying its own
 * `exitCode`; this is the only file that reads a directory, makes a request,
 * writes a line or assigns `process.exitCode`. That is what makes "a spec left
 * backlog fails the gate" an assertion about a function rather than about a
 * subprocess.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { GitBranch } from '../src/git-branch.js';
import { buildBoard, renderBoard } from './task-board.js';
import { defaultTaskFiles, repoRoot } from './task-files.js';
import { gateBranch, renderGate, renderGateFaults } from './task-gate.js';
import { fetchIssues, reconcile, renderFetchFailure, renderValidation } from './task-github.js';
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
  console.error('  validate  the board, plus how disk and the issues differ (a report)');
}

/**
 * The branch this checkout is on.
 *
 * The environment first, because on a pull-request build the checkout is **not**
 * on the branch: GitHub checks out the merge commit, so `.git/HEAD` is detached
 * and reading it alone would make the gate report `no-branch` and fail every
 * pull request it was written to guard. `GITHUB_HEAD_REF` is set only on
 * `pull_request` events and holds the *source* branch, which is the one carrying
 * the ticket key; `GITHUB_REF_NAME` is the branch on an ordinary push.
 *
 * This is why the Bitbucket-to-GitHub move could not be a rename of
 * `BITBUCKET_BRANCH`. That variable was set on every Bitbucket build, so one
 * name did both jobs; here they are two different events with two different
 * variables, and the fallback order is what tells them apart.
 *
 * Otherwise `.git/HEAD`, read through the module the server already uses - which
 * handles a linked worktree and costs no subprocess. A detached HEAD with no
 * environment to go on has no branch, and the gate says so.
 *
 * @returns {string|null}
 */
function currentBranch() {
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF;
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME;
  return new GitBranch().checkoutFor(repoRoot()).branch;
}

/**
 * Run a command and collect what it said.
 *
 * `spawnSync` is fine here and is not fine in `src/`: the rule in AGENTS.md
 * against synchronous child processes protects the server's poll loop, its event
 * stream and its 2s hook posts, none of which exist in a one-shot script that
 * has nothing else to do while it waits.
 *
 * Never through a shell, so nothing in an argument can be read as one. A command
 * that is not installed rejects as an ordinary failure rather than throwing -
 * `validate` is the only command needing `gh`, and it has to say so rather than
 * produce a stack trace.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {{ok: boolean, stdout: string, stderr: string}}
 */
function runCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) {
    const reason = /** @type {NodeJS.ErrnoException} */ (result.error).code === 'ENOENT'
      ? `${command} is not installed, or not on PATH`
      : result.error.message;
    return { ok: false, stdout: '', stderr: reason };
  }
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
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

  const fetched = fetchIssues({ run: runCommand });
  if (!fetched.ok) {
    write(renderFetchFailure(fetched, { colour }));
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
