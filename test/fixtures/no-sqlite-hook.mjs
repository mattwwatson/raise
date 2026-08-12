/**
 * The half of `old-node.mjs` that makes `node:sqlite` unavailable.
 *
 * A separate file because the `module.register` fallback loads its hooks on a
 * worker thread and so needs a specifier rather than a function. `registerHooks`
 * takes the function directly and imports this the ordinary way.
 *
 * It returns `nextResolve(...)` without awaiting, so the one function satisfies
 * both: asynchronous under `register`, synchronous under `registerHooks`, which
 * requires a hook that does not return a promise.
 *
 * The error matches what Node itself raises for a builtin it will not hand over
 * - `ERR_UNKNOWN_BUILTIN_MODULE`, thrown during resolution - because the test
 * asserts that string never reaches the user, and a reproduction throwing some
 * other error would be asserting against a thing that cannot happen.
 */

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:sqlite') {
    throw Object.assign(new Error('No such built-in module: node:sqlite'), {
      code: 'ERR_UNKNOWN_BUILTIN_MODULE',
    });
  }
  return nextResolve(specifier, context);
}
