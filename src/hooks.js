/**
 * Installing the agent hooks.
 *
 * Asking every colleague to hand-edit settings.json is how this ends up broken
 * on four machines, so Raise merges the entries itself - idempotently, showing
 * what it will change, and keeping a backup.
 *
 * The merge is a pure function so it can be tested without a real settings
 * file, and so the CLI can show a truthful preview before writing anything.
 *
 * **Two agents, one merge.** Codex keeps its hooks in `~/.codex/hooks.json`
 * rather than in Claude Code's settings file, but the structure under `hooks` is
 * the same object of events to groups of entries - so this is generalised over
 * the event list and the timeouts rather than copied. A second copy would be a
 * second set of the obligations in AGENTS.md's safe-change rules (show a diff,
 * ask first, back up, leave foreign entries alone, be safe to run twice), and
 * the copy that missed the next fix would be the one writing to somebody's
 * config.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A settings file, as much of it as this module touches.
 *
 * Everything else in there is somebody else's and is carried through untouched,
 * which is why this deliberately does not claim to describe the whole file -
 * the same rule `pi-extension.js` states about pi's. Claude Code's
 * `settings.json` and Codex's `hooks.json` are both this shape at the level
 * that matters.
 *
 * @typedef {{hooks?: Record<string, any[]>, [key: string]: any}} HookSettings
 */

/**
 * Which events we listen to, and why.
 *
 * PreToolUse/PostToolUse are deliberately not included: they fire constantly
 * and would add a process spawn to every tool call. `PermissionRequest` is the
 * exception that proves the rule - it fires only when a tool actually needs a
 * human, so it is as rare as a `Notification` and says the same thing sooner.
 *
 * Nothing here reports that a permission prompt was *granted*, because Claude
 * Code has no such event to fire. That is settled by reading the transcript
 * instead - see `blockDisproved` in `dashboard.js`.
 *
 * **The tempting fix is to add `PostToolUse` to the list above, and this is
 * where that warning belongs, because it is a one-line change to this array.**
 * `EVENT_STATES` in `registry.js` already maps it (and `PreToolUse`) to
 * `working`, so nothing else would move. It is refused on two counts. It costs
 * a hook process and a localhost POST *per tool call*, inside the user's
 * editing loop. And hook *registration* is read at session start, so it fixes
 * nothing until `raise install-hooks` is re-run **and** every open session is
 * restarted - which is exactly when a stale block is most annoying. Reading the
 * transcript fixes sessions that are already running, for free.
 *
 * `PostToolBatch` was weighed when `PermissionRequest` was adopted and refused
 * on the same ground. It is cheaper - one hook per batch of parallel calls
 * rather than one per call - but it still fires on every step of every turn,
 * and it buys nothing the transcript does not already give within three
 * seconds. Adopting `PermissionRequest` did not change this: it reports the
 * *start* of a block sooner, and the end of one is still inferred, because
 * there is nothing to report it. Revisit only if the transcript stops being
 * readable.
 */
export const HOOK_EVENTS = [
  'SessionStart', // register the session and capture its window identity
  'UserPromptSubmit', // you gave it work, so it is now busy
  'PermissionRequest', // a tool needs a human, said the moment Claude decides it
  'Notification', // that same prompt six seconds later, plus the idle nudge
  'Stop', // turn finished, waiting for your next instruction
  'SessionEnd', // deregister
];

/**
 * Which Codex events we listen to.
 *
 * The same names Claude Code uses, because Codex's hook system is the same
 * shape - but a shorter list, because Codex has no `Notification` at all and
 * `Stop` is the only thing that ends a turn. `PreToolUse` / `PostToolUse` are
 * left out on the rule above.
 *
 * `SessionEnd` is what deregisters a session, and `SessionEnd` on Codex also
 * fires after thirty minutes idle. That is a session going away, not a nudge,
 * and `CODEX_EVENT_STATES` reads it as exactly that.
 */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'Stop',
  'SessionEnd',
];

/** Anything containing this is one of ours and may be replaced on reinstall. */
export const HOOK_MARKER = 'raise-hook.js';

/** How long each side gives our hook, in seconds. */
const DEFAULT_TIMEOUT = 5;

/**
 * Codex clamps a `SessionEnd` hook to three seconds and prints a warning on
 * every session start while an entry asks for more. Our reporter is bounded at
 * two seconds internally, so the extra two were never used - and causing a
 * warning in somebody's editing loop, once per session, forever, to ask for time
 * we do not want is exactly what `raise-hook.js`'s rules exist to prevent.
 */
export const CODEX_HOOK_TIMEOUTS = { SessionEnd: 3 };

export function hookCommand(nodePath, scriptPath, agent = null) {
  const base = `${quoteIfNeeded(nodePath)} ${quoteIfNeeded(scriptPath)}`;
  // Codex has no field on the payload to say which agent sent it, and the hook
  // command is the one place it lets us put anything of our own. Claude Code
  // stays the silent default, so it gets no flag at all and every installation
  // out there keeps the command it already has.
  return agent ? `${base} --agent ${agent}` : base;
}

function quoteIfNeeded(value) {
  return /[\s"']/.test(value) ? `"${value}"` : value;
}

function hookEntry(command, timeout) {
  return { hooks: [{ type: 'command', command, timeout }] };
}

function containsOurHook(group) {
  return (group?.hooks || []).some(
    (hook) => typeof hook?.command === 'string' && hook.command.includes(HOOK_MARKER),
  );
}

/**
 * How much of our hook set a settings file already has.
 *
 * Deliberately three states rather than a boolean. `HOOK_EVENTS` grows, and
 * every time it does, every existing installation is momentarily short of one -
 * so an all-or-nothing answer reports a working setup as "not installed", and
 * the copy that goes with that tells the user Raise cannot see when Claude is
 * waiting and cannot focus windows. Neither is true while `SessionStart` and
 * `Notification` are still there; the signal just arrives a few seconds later.
 * The re-run still needs asking for, so `missing` names what it will add.
 *
 * @param {{hooks?: Record<string, unknown>}|null|undefined} settings a parsed
 *   settings file, of which only `hooks` is ever read
 * @param {string[]} [events]
 * @returns {{state: 'installed'|'partial'|'missing', missing: string[]}}
 */
export function hookInstallState(settings, events = HOOK_EVENTS) {
  const missing = events.filter((event) => {
    const groups = settings?.hooks?.[event];
    return !Array.isArray(groups) || !groups.some(containsOurHook);
  });
  if (missing.length === 0) return { state: 'installed', missing };
  if (missing.length === events.length) return { state: 'missing', missing };
  return { state: 'partial', missing };
}

/**
 * Merge our hook entries into a settings object.
 *
 * Never touches anybody else's hooks, and replaces our own previous entry
 * rather than stacking duplicates when the install is run twice.
 *
 * @param {HookSettings|null|undefined} existingSettings
 * @param {string} command
 * @param {string[]} [events]
 * @param {Record<string, number>} [timeouts] per-event overrides, for an agent
 *   that will not honour the default
 * @returns {{settings: HookSettings, changes: string[]}}
 */
export function mergeHooks(existingSettings, command, events = HOOK_EVENTS, timeouts = {}) {
  const settings = structuredClone(existingSettings || {});
  settings.hooks = settings.hooks || {};
  const changes = [];

  for (const event of events) {
    const groups = Array.isArray(settings.hooks[event]) ? [...settings.hooks[event]] : [];
    const ourIndex = groups.findIndex(containsOurHook);
    const entry = hookEntry(command, timeouts[event] ?? DEFAULT_TIMEOUT);

    if (ourIndex === -1) {
      groups.push(entry);
      changes.push(`add ${event}`);
    } else {
      const current = groups[ourIndex];
      if (JSON.stringify(current) !== JSON.stringify(entry)) {
        groups[ourIndex] = entry;
        changes.push(`update ${event}`);
      }
    }
    settings.hooks[event] = groups;
  }

  return { settings, changes };
}

/** Remove our entries and leave everything else untouched. */
export function removeHooks(existingSettings, events = HOOK_EVENTS) {
  const settings = structuredClone(existingSettings || {});
  const changes = [];
  if (!settings.hooks) return { settings, changes };

  for (const event of events) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((group) => !containsOurHook(group));
    if (kept.length !== groups.length) changes.push(`remove ${event}`);
    if (kept.length === 0) {
      delete settings.hooks[event];
    } else {
      settings.hooks[event] = kept;
    }
  }
  return { settings, changes };
}

export function readSettings(settingsPath) {
  if (!existsSync(settingsPath)) return {};
  const raw = readFileSync(settingsPath, 'utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${settingsPath} is not valid JSON (${err.message}). Fix it before installing hooks - ` +
        'Raise will not overwrite a file it cannot parse.',
    );
  }
}

/**
 * @returns {string|null} the path the previous settings were copied to, if any
 */
export function writeSettings(settingsPath, settings, { backup = true } = {}) {
  mkdirSync(dirname(settingsPath), { recursive: true });
  let backupPath = null;
  if (backup && existsSync(settingsPath)) {
    backupPath = `${settingsPath}.raise-backup`;
    copyFileSync(settingsPath, backupPath);
  }
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return backupPath;
}
