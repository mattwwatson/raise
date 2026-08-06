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

import { buildBoard, renderBoard } from './task-board.js';
import { defaultTaskFiles, repoRoot } from './task-files.js';
import { readSpecs, TASKS_DIR } from './task-specs.js';

/** Subcommands, in the order `usage` lists them. */
const COMMANDS = ['board'];

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
  const specs = readSpecs(join(repoRoot(), TASKS_DIR), defaultTaskFiles);

  const board = buildBoard(specs);
  write(renderBoard(board, { colour }));
  process.exitCode = board.exitCode;
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
