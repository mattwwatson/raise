/**
 * A modern Node made to behave like one in the 22.5-22.12 gap.
 *
 * Loaded with `node --import ./test/fixtures/old-node.mjs <entry>`, so it runs
 * before the entry point's module graph is linked - which is the whole point,
 * because that is where the failure it simulates happens.
 *
 * Issue 5 is a bug that only exists on Node versions CI will never run: `engines`
 * says `>=22.13.0`, so npm refuses to install Raise anywhere the bug bites, and
 * a runner on 22.9 could not `npm ci` the devDependencies to reach the suite. A
 * test that only passes because the local Node is modern proves nothing, so the
 * environment is faked instead of the code - two changes, both to Node and
 * neither to Raise:
 *
 * 1. `process.versions.node` reports 22.9.0, so the version guard sees a version
 *    it must refuse.
 * 2. `node:sqlite` throws `ERR_UNKNOWN_BUILTIN_MODULE` on resolution, which is
 *    exactly what 22.5 through 22.12 do to that specifier - the module existed,
 *    but stayed behind `--experimental-sqlite` until 22.13.0.
 *
 * Nothing Raise owns is stubbed. The entry point under test is the real one,
 * reached the real way, linking its real graph - the only thing that has moved
 * is the Node underneath it.
 *
 * `test/cli-node-version.test.js` checks this harness bites before it trusts it,
 * because a simulated reproduction that has quietly stopped simulating anything
 * is worse than no reproduction at all.
 */

import { register, registerHooks } from 'node:module';

import { resolve } from './no-sqlite-hook.mjs';

// Writable and configurable on every Node this runs on; if that ever stops
// being true the control test fails loudly rather than the guard silently
// passing on a version it was never shown.
Object.defineProperty(process.versions, 'node', {
  value: '22.9.0',
  configurable: true,
  writable: true,
});

// `registerHooks` runs the hook synchronously in this thread and is the
// supported API; `register` is deprecated from Node 26 (DEP0205) and prints a
// warning on every run, which is noise the suite should not teach anyone to
// skim past. But `registerHooks` only arrived in 22.15, and `engines` floors us
// at 22.13 - so the deprecated path stays as the fallback for the two versions
// in between rather than the floor being quietly raised to suit a test.
if (typeof registerHooks === 'function') registerHooks({ resolve });
else register('./no-sqlite-hook.mjs', import.meta.url);
