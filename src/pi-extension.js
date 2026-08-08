/**
 * Installing the pi extension.
 *
 * The same job as `hooks.js` against a different file and a much simpler shape:
 * pi's `settings.json` carries a flat `extensions` array of paths, so there is
 * no per-event structure to merge, only a path to be present exactly once.
 *
 * **A path into the checkout, never a copy into `~/.pi/agent/extensions/`.**
 * Auto-discovery would work and is one line shorter, but a copied file is a
 * fork: it goes stale the first time the repo is pulled, and the stale half is
 * the one running inside the agent. `raise-hook.js` is registered the same way
 * for the same reason.
 *
 * The merge is a pure function so the CLI can show a truthful preview before
 * writing anything, and so it is tested without a real pi installation. The
 * JSON read and write are shared with `hooks.js` - they are about settings
 * files rather than about Claude Code, and one backup rule is better than two.
 */

/**
 * pi's settings file, as much of it as we touch.
 *
 * Everything else in there is somebody else's and is carried through
 * untouched, which is why this is deliberately not a full description of the
 * file - claiming to know its shape is how a merge starts dropping keys.
 *
 * @typedef {{extensions?: unknown[]}} PiSettings
 */

/** Anything containing this is ours and may be replaced on reinstall. */
export const EXTENSION_MARKER = 'raise-pi-extension.js';

/** @param {unknown} entry */
function isOurs(entry) {
  return typeof entry === 'string' && entry.includes(EXTENSION_MARKER);
}

/**
 * Put our extension path into a pi settings object.
 *
 * Replaces our own previous entry rather than stacking duplicates, so moving
 * the checkout and reinstalling leaves one path and not two - two would load
 * the extension twice and post every event twice. Everybody else's extensions
 * keep their place in the array, because load order is meaningful in pi: later
 * handlers see earlier ones' mutations.
 *
 * @param {PiSettings} existingSettings
 * @param {string} extensionPath absolute path to `hooks/raise-pi-extension.js`
 * @returns {{settings: PiSettings, changes: string[]}}
 */
export function mergeExtension(existingSettings, extensionPath) {
  const settings = structuredClone(existingSettings || {});
  const existing = Array.isArray(settings.extensions) ? [...settings.extensions] : [];
  const changes = [];

  const ourIndex = existing.findIndex(isOurs);
  if (ourIndex === -1) {
    existing.push(extensionPath);
    changes.push(`add ${extensionPath}`);
  } else if (existing[ourIndex] !== extensionPath) {
    changes.push(`update ${existing[ourIndex]} -> ${extensionPath}`);
    existing[ourIndex] = extensionPath;
  }

  // A second copy of ours can only come from an edit by hand, but loading it
  // twice would double every event, so it is dropped rather than tolerated.
  const deduped = existing.filter((entry, index) => !isOurs(entry) || index === existing.findIndex(isOurs));
  if (deduped.length !== existing.length) changes.push('remove a duplicate entry');

  settings.extensions = deduped;
  return { settings, changes };
}

/**
 * Take our extension path back out, leaving every other entry untouched.
 *
 * @param {PiSettings} existingSettings
 * @returns {{settings: PiSettings, changes: string[]}}
 */
export function removeExtension(existingSettings) {
  const settings = structuredClone(existingSettings || {});
  const changes = [];
  if (!Array.isArray(settings.extensions)) return { settings, changes };

  const kept = settings.extensions.filter((entry) => !isOurs(entry));
  if (kept.length !== settings.extensions.length) changes.push('remove the Raise extension');
  if (kept.length === 0) {
    // An empty array is noise in somebody else's config file; if we added the
    // key we take it away again.
    delete settings.extensions;
  } else {
    settings.extensions = kept;
  }
  return { settings, changes };
}
