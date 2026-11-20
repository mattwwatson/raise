---
issue: 65
status: shipped
size: S
depends: -
branch: fm/65-herdr-letter-addresses
shipped: 2026-11-20
---
# 65 - A Herdr session whose address has a letter in it cannot be focused

**Self-contained brief.** No prior conversation needed. Written 20/11/2026.

## Problem

Raise accepts a Herdr terminal address only when it is `t` followed by digits
(`ADDRESS = /^t\d+$/` in `src/focus/herdr.js`, used by `isHerdrAddress`). Herdr does not keep to
that. Measured on 20/11/2026 with hc 0.1.21, `hc ls --all` on the local default server listed:

```
t17, t18, t19, t1b, t1c, t1d
```

So after `t19` the local addresses carry letters. Whether that is hexadecimal or base 36 is not
established: every letter seen so far is `a` to `f`. Terminals on another machine, listed by the
same command, still read `<machine>/t9`, `<machine>/t10`, `<machine>/t11`.

What the user sees: a Claude Code session started in Herdr terminal `t1b` (through `hc run --bg
claude`, or a shell in an `hc` terminal) gets a row that says **no window**, with no `Focus`
button. The hook recorded it correctly - `multiplexer: "herdr"`, `hc_terminal_id: "t1b"`, the
default server's socket - and `planFocus` in `src/focus/index.js` then refuses it as *"reported a
terminal address Raise does not recognise"*, which the dashboard renders as unfocusable.

The same check decides whether a process is a typed `hc attach <address>` (`typedAttachAddress`
in `src/focus/herdr.js`), so a tab running `hc attach t1b` is not found either, and with the
`new-tab` setting on (issue 56) no tab can be opened for such a session.

This is on `main` and affects every Herdr user once their server has handed out enough
terminals, with or without `new-tab`.

## Decisions

- **Accept `t`, a digit, then any lowercase letters or digits: `/^t[0-9][0-9a-z]*$/`.** Every
  address seen starts with a digit after the `t`, so requiring one keeps an ordinary word that
  happens to start with `t` (`tab`, `tmux`) from reading as an address in an `hc attach` argv.
  Lowercase only, because nothing uppercase has been seen; widen it only on a measurement.
- **A machine-qualified address (`<machine>/t9`) stays refused.** It names a terminal on another
  machine, which nothing on this one can show; that is unchanged.
- **Do not decode the address.** Raise only passes it back to `hc` and the desktop app, so
  whether the suffix is hexadecimal or base 36 does not matter, and guessing would be a claim
  nothing here has measured.
- Update the comment beside `ADDRESS` (it says addresses are `t<number>`, per herdr-core's error
  text) to record this measurement and the date.

## Acceptance

- [x] `isHerdrAddress('t1b')` and `isHerdrAddress('t1d')` are true; `t5` still is.
- [x] `''`, `t`, `5`, `fix`, `tab`, `tmux`, `mac/t5`, `mac/t1b`, `--terminal`, `t5 `, `T1B`,
      `null` and `5` are all refused.
- [x] `planFocus` gives `kind: 'herdr'` for a session recorded with `hc_terminal_id: 't1b'`,
      so its row is focusable and no longer says *no window*.
- [x] `typedAttachAddress('hc attach t1b')` returns `t1b`, so a tab holding it is found and
      raised.
- [x] `npm test`, `npm run lint` and `npm run typecheck` pass.
- [ ] Checked by hand: a Claude Code session in a Herdr terminal with a letter in its address
      shows `Focus` and focusing it works.

## Implementation notes

- `src/focus/herdr.js`: `ADDRESS` is now `/^t[0-9][0-9a-z]*$/`, and its comment records the
  20/11/2026 measurement, why the digit after the `t` is required, and that the address is
  never decoded. That regular expression is the only place a Herdr address is parsed:
  `planFocus` (and through it the row's `focusable` and `raise doctor`'s count),
  `typedAttachAddress` and `findTypedAttach` all go through `isHerdrAddress`, so nothing else
  changed.
- Tests pin both sides at each consumer: `isHerdrAddress` (`t1b`, `t1d` accepted; `tab`,
  `tmux`, `T1B`, `mac/t1b` and the rest of the list refused), `typedAttachAddress`
  (`hc attach t1b` read; `hc attach tab` and `hc attach macbook/t1b` not), `findTypedAttach`
  (a `t1b` attach is found and a `t1` beside it is not), `planFocus` and `focusSession` (a
  `t1b` session plans and raises through its attach tab), `buildRows` (the row is focusable)
  and `raise doctor` (a `t1b` session is counted focusable).
- Nothing was left open by the spec. The hand check is the last acceptance item and is
  described in the pull request's Manual testing section.
