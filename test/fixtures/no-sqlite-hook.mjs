/**
 * The half of `old-node.mjs` that makes `node:sqlite` unavailable.
 *
 * A separate file because `module.register` loads its hooks on a worker thread
 * and so needs a specifier rather than a function.
 *
 * The error matches what Node itself raises for a builtin it will not hand over
 * - `ERR_UNKNOWN_BUILTIN_MODULE`, thrown during resolution - because the test
 * asserts that string never reaches the user, and a reproduction throwing some
 * other error would be asserting against a thing that cannot happen.
 */

/** @type {import('node:module').ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:sqlite') {
    throw Object.assign(new Error('No such built-in module: node:sqlite'), {
      code: 'ERR_UNKNOWN_BUILTIN_MODULE',
    });
  }
  return nextResolve(specifier, context);
}
