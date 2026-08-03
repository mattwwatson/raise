/**
 * AppleScript helpers for the macOS terminal adapters.
 *
 * The scripts are built as strings and returned by pure functions so the test
 * suite can assert on exactly what would be sent to osascript without running
 * it and yanking the user's focus mid-test.
 */

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

/** Is this app currently running? Avoids launching it just to search it. */
export function appRunningScript(appName) {
  return `tell application "System Events" to return (exists (processes where name is "${escapeAppleScript(
    appName,
  )}")) as string`;
}
