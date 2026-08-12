/**
 * The control for the harness in `old-node.mjs`.
 *
 * Under a real Node 22.13+ this prints `imported` and exits 0. Under the harness
 * it must die on the import, which is what proves the harness is still doing
 * something - if a future Node stops routing builtin specifiers through resolve
 * hooks, this goes green where it should be red, and the reproduction beside it
 * would otherwise pass for entirely the wrong reason.
 */

import 'node:sqlite';

console.log('imported');
