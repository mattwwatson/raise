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
