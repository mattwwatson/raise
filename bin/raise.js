#!/usr/bin/env node
/**
 * The entry point, and deliberately almost nothing else.
 *
 * **Everything here exists so that a Node too old to run Raise is told so.** The
 * CLI itself is `src/cli.js`, reached below through `await import()`; this file
 * holds the version guard and the error handler and has no other job.
 *
 * ## Why the split, when a check at the top of the CLI looks equivalent
 *
 * It is not equivalent, and the reason is one step further along than the usual
 * "ES modules hoist" (issue 5). `src/cli.js` statically imports `src/nm-state.js`,
 * which statically imports `node:sqlite` - a module that existed from Node 22.5
 * but stayed behind `--experimental-sqlite` until 22.13.0. On 22.5 through 22.12
 * that specifier does not resolve, and an unresolvable `node:` specifier throws
 * while the graph is being **linked**, before any module body runs at all.
 *
 * So a guard written as the first *statement* of the CLI is too late, and so is
 * one written as its first *import*: neither module's body is ever reached. The
 * only arrangement that works is a guard whose own graph does not contain the
 * failing import - which means the CLI has to be behind a dynamic import, and
 * `src/node-support.js` has to keep importing nothing. Both halves are load
 * bearing; a static `import { main } from '../src/cli.js'` here would restore the
 * bug in full, and it would look like a tidy-up.
 *
 * Without it the user gets a stack trace naming a builtin they have never heard
 * of, and `raise doctor` - whose whole purpose is explaining a broken setup -
 * cannot print the one line that explains this one. `engines` keeps it away from
 * `npm install -g`, so the person who meets it is running from a checkout: the
 * contributor CONTRIBUTING.md sent here, at the worst possible moment.
 */

import { nodeVersionProblem } from '../src/node-support.js';

const problem = nodeVersionProblem(process.versions.node);
if (problem) {
  // stdout rather than stderr, and no colour. This is the answer to a question
  // the user is about to ask `raise doctor`, not a crash report, and it is read
  // by somebody whose setup is already misbehaving.
  console.log(`Raise cannot run on this Node.\n\n  Node ${problem}\n`);
  // `process.exitCode` and a natural end, never `process.exit()`. On macOS a
  // piped stdout is asynchronous, and `process.exit()` does not flush pending
  // writes - it cuts them off at the pipe buffer, measured at 64KB here. This
  // message is far short of that and would survive in practice, so this is
  // shape rather than a reproduced drop; the point is that the one sentence
  // this file exists to deliver must not depend on being small enough. There is
  // nothing else pending, so returning ends the process on its own.
  process.exitCode = 1;
} else {
  const { main } = await import('../src/cli.js');

  main().catch((err) => {
    console.error(`\x1b[31m${err.stack || err.message}\x1b[0m`);
    // `process.exit` is right here and wrong above: a failed `serve` may have a
    // listening server or a poll timer holding the loop open, and this has to
    // end regardless. Stderr loses the same race, which is the accepted cost of
    // guaranteeing the exit - and a stack trace is not the message the product
    // promises.
    process.exit(1);
  });
}
