/**
 * Installing the Claude Code hooks.
 *
 * Asking every colleague to hand-edit settings.json is how this ends up broken
 * on four machines, so nmmon merges the entries itself - idempotently, showing
 * what it will change, and keeping a backup.
 *
 * The merge is a pure function so it can be tested without a real settings
 * file, and so the CLI can show a truthful preview before writing anything.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
 * instead. See the "recorded block is disbelieved" note in AGENTS.md.
 */
export const HOOK_EVENTS = [
  'SessionStart', // register the session and capture its window identity
  'UserPromptSubmit', // you gave it work, so it is now busy
  'PermissionRequest', // a tool needs a human, said the moment Claude decides it
  'Notification', // that same prompt six seconds later, plus the idle nudge
  'Stop', // turn finished, waiting for your next instruction
  'SessionEnd', // deregister
];

/** Anything containing this is one of ours and may be replaced on reinstall. */
export const HOOK_MARKER = 'nmmon-hook.js';

export function hookCommand(nodePath, scriptPath) {
  return `${quoteIfNeeded(nodePath)} ${quoteIfNeeded(scriptPath)}`;
}

function quoteIfNeeded(value) {
  return /[\s"']/.test(value) ? `"${value}"` : value;
}

function hookEntry(command) {
  return { hooks: [{ type: 'command', command, timeout: 5 }] };
}

function containsOurHook(group) {
  return (group?.hooks || []).some(
    (hook) => typeof hook?.command === 'string' && hook.command.includes(HOOK_MARKER),
  );
}

/**
 * Merge our hook entries into a settings object.
 *
 * Never touches anybody else's hooks, and replaces our own previous entry
 * rather than stacking duplicates when the install is run twice.
 *
 * @returns {{settings: object, changes: string[]}}
 */
export function mergeHooks(existingSettings, command, events = HOOK_EVENTS) {
  const settings = structuredClone(existingSettings || {});
  settings.hooks = settings.hooks || {};
  const changes = [];

  for (const event of events) {
    const groups = Array.isArray(settings.hooks[event]) ? [...settings.hooks[event]] : [];
    const ourIndex = groups.findIndex(containsOurHook);
    const entry = hookEntry(command);

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
        'nmmon will not overwrite a file it cannot parse.',
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
    backupPath = `${settingsPath}.nmmon-backup`;
    copyFileSync(settingsPath, backupPath);
  }
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return backupPath;
}
