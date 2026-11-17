---
issue: 36
status: backlog
size: L
depends: -
---
# 36 - Focusing a session does not work on Linux

**Self-contained brief.** No prior conversation needed. Written 17/11/2026.

> **This is a record that the question was looked at, not a plan.** Nobody is running Raise on
> Linux today, and CONTRIBUTING requires that whoever builds an adapter is running the
> terminal and the desktop it is for. **Before starting any work here, re-research it for the
> specific terminal, display server and compositor actually in use.** Everything below is from
> a desk survey on 17/11/2026, not from running anything, and Linux desktop tooling changes
> quickly.

---

## What and why

Monitoring is portable: the hooks, the transcript, the process table and the page all work on
Linux. Focusing does not. Every terminal adapter checks for macOS, and a click on Linux ends in
*"Focusing is only implemented for macOS terminals so far"*. The one part that already works is
the tmux half: selecting the right window and pane is plain tmux, so the pane is correct and
then nothing comes to the front.

On macOS one AppleScript call does two jobs: it finds the tab and brings its window to the
front. **On Linux those are two separate problems, and they vary independently.** That is why
this is not one more entry in `src/focus/terminals.js`.

---

## Problem 1 - choosing the tab, which depends on the terminal

| Terminal | How | Exact? |
| --- | --- | --- |
| kitty | remote control, `kitten @ focus-window`; same mechanism as #33 on macOS | yes, needs `allow_remote_control` |
| WezTerm | `wezterm cli activate-pane --pane-id N`, `WEZTERM_PANE` is in the session's environment | yes |
| Konsole | D-Bus, `KONSOLE_DBUS_SERVICE` / `KONSOLE_DBUS_SESSION` in the environment | yes |
| GNOME Terminal | essentially no tab-selection API | no |
| Alacritty | no tabs at all; each window is an OS window, so this problem disappears | n/a |

kitty and WezTerm are worth noting because their own command-line tools work the same on
macOS and Linux, so an adapter for either may cover both platforms.

## Problem 2 - bringing the window to the front, which depends on the display server

- **X11: solved.** `wmctrl -i -a <window id>` or `xdotool windowactivate`. The window can be found
  through the `_NET_WM_PID` property by walking up from the session's process to the
  terminal's. It is ambiguous where one terminal process owns every window, as
  `gnome-terminal-server` does.
- **Wayland: no general way, deliberately.** One program raising another's window is
  something Wayland withholds on purpose, so each compositor has its own route:
  - **Sway / i3:** `swaymsg '[pid=N] focus'`
  - **Hyprland:** `hyprctl dispatch focuswindow pid:N`, which can also match by window address
    or title
  - **KDE:** KWin scripting over D-Bus
  - **GNOME:** nothing built in. It needs a Shell extension that exposes window calls over
    D-Bus, since `Shell.Eval` has been locked down for years.

  **Focus-stealing prevention may beat all of these.** A terminal's own "activate" command, and
  some compositor commands, may only mark the window as needing attention rather than raise it.
  Test on the actual compositor before believing any of the above.

---

## One data point: Omarchy

Omarchy, the Arch-based setup, runs Hyprland, so Problem 2 would be `hyprctl`. **Unverified:**
which terminal it ships by default (Alacritty, as far as the survey went). If that is right,
Problem 1 disappears, because Alacritty has no tabs. But Alacritty can run several windows from
one process, which makes a match by pid ambiguous, and that has to be handled by refusing rather
than guessing. Check all of this on a real install.

---

## Design questions, for whoever picks this up

1. **A second axis in the abstraction.** The likely shape is terminal adapters for Problem 1
   plus a separate window-raising layer, one per display server or compositor, for Problem 2.
   That changes the focus design beyond `terminals.js`. CONTRIBUTING says that kind of change
   must be stated and agreed, not worked around.
2. **Positive evidence.** Raising "the window owned by this pid" is exact only when the pid owns
   one window. Where it owns several, raise nothing and say so, as control-mode iTerm2 already
   does for an ambiguous title.
3. **Partial results.** Choosing the tab without being able to raise the window, or the reverse,
   is a partial focus. It needs the same "raised less than you clicked" result that #35 (Warp)
   needs, so settle that shape once for both.
4. **Optional tools.** `wmctrl`, `xdotool`, `hyprctl` and the rest are somebody else's tools.
   Their absence is not a degraded state: say nothing, run nothing looking for them, as with
   every other optional integration.

---

## Deliberately not in scope

- **Building speculatively.** No adapter for a terminal or compositor nobody here is running.
- **Windows.**

---

## Acceptance

Defined when the work is picked up, after the re-research above. At minimum: verified by hand
on a real session on the target system, tests through the injected command runner only, and
`npm test`, `npm run lint` and `npm run typecheck` pass.
