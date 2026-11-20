/**
 * AppleScript helpers for the macOS terminal adapters.
 *
 * The scripts are built as strings and returned by pure functions so the test
 * suite can assert on exactly what would be sent to osascript without running
 * it and yanking the user's focus mid-test.
 */

import { shellQuote } from './tmux.js';

/**
 * Escape a value for interpolation into an AppleScript string literal.
 *
 * Session ids and ttys are effectively trusted, but they arrive over a socket
 * from a hook, so they get escaped like anything else.
 */
export function escapeAppleScript(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * iTerm2: find a session by its own UUID or by its tty, then select the
 * session, its tab and its window, and bring the app forward.
 *
 * `tty of s` is `missing value` for restored-but-dead sessions, so the
 * comparison must tolerate that rather than erroring out of the loop.
 *
 * One identifier is enough, and callers pass one or the other: the UUID is
 * preferred where it exists, because a tty can be recycled by a later process.
 *
 * @param {{sessionUuid?: string|null, tty?: string|null}} target
 */
export function itermFocusScript({ sessionUuid, tty }) {
  const matcher = sessionUuid
    ? `(id of s) is "${escapeAppleScript(sessionUuid)}"`
    : `((tty of s) is not missing value and (tty of s) is "${escapeAppleScript(tty)}")`;
  return `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        try
          if ${matcher} then
            select s
            select t
            select w
            activate
            return "ok"
          end if
        end try
      end repeat
    end repeat
  end repeat
  return "notfound"
end tell`;
}

/**
 * iTerm2: find a tmux control mode pane by the title iTerm2 named it after.
 *
 * The last resort, and only for control mode, where iTerm2 reports `tty` as
 * `missing value` for every tmux pane and the tmux client's own tty points at
 * the idle tab that ran `tmux -CC`. The pane title is the one thing both sides
 * agree on.
 *
 * Matched with `ends with` rather than equality because the caller has already
 * stripped the leading status glyph - Claude Code animates a braille spinner
 * there, so the title read from tmux and the name read from iTerm2 a moment
 * later routinely differ in their first character.
 *
 * Refuses to act on more than one match. Two panes can genuinely share a title,
 * and raising an arbitrary one of them is worse than saying so: the whole point
 * of this feature is landing on the right window.
 */
export function itermFocusByTitleScript({ title }) {
  return `tell application "iTerm2"
  set matched to {}
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        try
          if (name of s) ends with "${escapeAppleScript(title)}" then
            copy {s, t, w} to end of matched
          end if
        end try
      end repeat
    end repeat
  end repeat
  if (count of matched) is 0 then return "notfound"
  if (count of matched) > 1 then return "ambiguous"
  set hit to item 1 of matched
  select (item 1 of hit)
  select (item 2 of hit)
  select (item 3 of hit)
  activate
  return "ok"
end tell`;
}

/**
 * Terminal.app has no stable per-session identifier we can rely on, so it is
 * matched by tty, which its tabs expose directly.
 */
export function terminalAppFocusScript({ tty }) {
  return `tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      try
        if (tty of t) is "${escapeAppleScript(tty)}" then
          set selected tab of w to t
          set frontmost of w to true
          activate
          return "ok"
        end if
      end try
    end repeat
  end repeat
  return "notfound"
end tell`;
}

/**
 * Ghostty's bundle id, used in place of a process name.
 *
 * Its process is `ghostty` and its app name `Ghostty`, and which of the two
 * System Events reports is not worth depending on. A bundle id names one app.
 */
export const GHOSTTY_BUNDLE_ID = 'com.mitchellh.ghostty';

/**
 * Ghostty is matched by tty, which every `terminal` in its dictionary exposes
 * from 1.4.0. The dictionary's `focus` brings the terminal's window to the
 * front, and `activate` makes Ghostty the frontmost app.
 *
 * A Ghostty older than 1.4 has no `tty` property (or, before 1.3, no dictionary
 * at all). osascript may then fail to compile the script, before the `try`
 * below can run, so the adapter reads any failure of the script as no match.
 * Where the lookup does run and errors, the `try` answers `notfound`. Either
 * way it is the same answer as a tty Ghostty does not hold, and never a reason
 * to match on the title or directory instead.
 */
export function ghosttyFocusScript({ tty }) {
  return `tell application id "${GHOSTTY_BUNDLE_ID}"
  try
    set hits to (terminals whose tty is "${escapeAppleScript(tty)}")
  on error
    return "notfound"
  end try
  if (count of hits) is 0 then return "notfound"
  focus (item 1 of hits)
  activate
  return "ok"
end tell`;
}

/**
 * Is the app with this bundle id running? `is running` never launches it, and
 * it needs no System Events permission. An app that is not installed makes
 * the script error, which the caller reads as not running.
 */
export function appRunningByIdScript(bundleId) {
  return `return (application id "${escapeAppleScript(bundleId)}" is running) as string`;
}

/**
 * Bring an app to the front by bundle id. Only ever sent after
 * `appRunningByIdScript` said it is running, because `activate` on an app that
 * is not would launch it.
 */
export function activateAppByIdScript(bundleId) {
  return `tell application id "${escapeAppleScript(bundleId)}" to activate`;
}

/** Is this app currently running? Avoids launching it just to search it. */
export function appRunningScript(appName) {
  return `tell application "System Events" to return (exists (processes where name is "${escapeAppleScript(
    appName,
  )}")) as string`;
}

// ------------------------------------------------------------- opening a tab

/**
 * An argv array as one POSIX shell command line, every word quoted.
 *
 * The values come from a hook - a tmux socket path, a Herdr socket path - so a
 * space or a quote in one is the ordinary case for this function, not an attack
 * it has to anticipate. `shellQuote` leaves a plain word alone and single-quotes
 * anything else.
 *
 * @param {string[]} argv
 * @returns {string}
 */
export function shellCommand(argv) {
  return argv.map(shellQuote).join(' ');
}

/**
 * A command line as one double-quoted word, for a parser that understands
 * double quotes and backslash and nothing else.
 *
 * @param {string} text
 * @returns {string}
 */
function doubleQuoted(text) {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * iTerm2: open the command in a new tab of the frontmost window, or in a new
 * window when there is none, and bring iTerm2 forward.
 *
 * **The `command` is not given to a shell.** iTerm2 splits it into arguments
 * with a parser of its own, and its dictionary says nothing about how. So the
 * command line is handed to `/bin/sh -c` as one double-quoted word, and the
 * shell then reads the single quotes `shellQuote` wrote. Inside that word only
 * `"` and `\` are escaped, and the form reads the same whether or not iTerm2's
 * parser also honours single quotes, because inside double quotes a single
 * quote is an ordinary character.
 *
 * `current window` fails when iTerm2 has no window, and the `try` turns that
 * into a new one. If iTerm2 is not running, `tell` starts it: the user named
 * this terminal, so starting it is what they asked for.
 *
 * @param {{argv: string[]}} target
 */
export function itermOpenTabScript({ argv }) {
  const command = escapeAppleScript(`/bin/sh -c ${doubleQuoted(shellCommand(argv))}`);
  return `tell application "iTerm2"
  try
    tell current window to create tab with default profile command "${command}"
  on error
    create window with default profile command "${command}"
  end try
  activate
  return "ok"
end tell`;
}

/**
 * Terminal.app: run the command in a new window, and bring Terminal forward.
 *
 * **A window, not a tab, because Terminal.app's dictionary cannot make a tab.**
 * `do script` with no `in` opens a new window; with `in` it types into a tab
 * that already exists, which would be somebody's shell. The only other way to a
 * tab is to send it Cmd-T through System Events, which needs the Accessibility
 * permission and lands in whichever window happens to be in front.
 *
 * `do script` types the text into a new login shell, so the command line is
 * POSIX-quoted and nothing more, and `exec` replaces the shell so that the
 * window ends when the attach does.
 *
 * @param {{argv: string[]}} target
 */
export function terminalAppOpenTabScript({ argv }) {
  return `tell application "Terminal"
  do script "${escapeAppleScript(`exec ${shellCommand(argv)}`)}"
  activate
  return "ok"
end tell`;
}

/**
 * Ghostty 1.4: open the command in a new tab of the front window, or a new
 * window when there is none, and bring Ghostty forward.
 *
 * **Ghostty runs a `command` that has arguments through `/bin/sh -c`**, by its
 * own documentation for the `command` option, which is what a surface
 * configuration's `command` sets. So the command line is POSIX-quoted. No
 * `shell:` prefix: Ghostty's own docs say a command with arguments already goes
 * to the shell, and a prefix it did not recognise here would be run as part of
 * the command.
 *
 * An older Ghostty has no `new tab` or `surface configuration`, so the script
 * fails to compile and the adapter reads that as not opened.
 *
 * @param {{argv: string[]}} target
 */
export function ghosttyOpenTabScript({ argv }) {
  return `tell application id "${GHOSTTY_BUNDLE_ID}"
  set cfg to new surface configuration
  set command of cfg to "${escapeAppleScript(shellCommand(argv))}"
  if (count of windows) is 0 then
    new window with configuration cfg
  else
    new tab in (window 1) with configuration cfg
  end if
  activate
  return "ok"
end tell`;
}
