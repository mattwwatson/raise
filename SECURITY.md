# Security

## Reporting

**Please do not open a public issue for a security problem.**

Report it privately through GitHub:
**https://github.com/mattwwatson/raise/security/advisories/new**

Include what an attacker would have to control, and what they would get. A proof of concept is
welcome and not required. You will get an acknowledgement; no response time is promised here,
because a promise nobody can keep is worse than none.

This is a single-maintainer project with no bounty. Credit in the advisory and in the fix's
commit message, if you want it.

**What is supported is the latest commit on `main`.** There are no maintained release branches
and no backports.

## What the trust boundary actually is

Worth stating plainly, because it is unusual for a local tool and it is what most reports will
be about.

Raise runs a local HTTP server that ends up executing `osascript` and `tmux`. **Binding to
`127.0.0.1` is not treated as a boundary** - any page in your browser can make requests to
localhost, and DNS rebinding can point a hostile domain there. So the server also requires all
three of:

- a shared token, generated per install, `0600` in `~/.raise/token`
- a `Host` header allowlist, which is what actually defeats DNS rebinding
- an `Origin` allowlist

`/health` is the only unauthenticated route and returns liveness only. `src/security.js` is
where this lives, and weakening any of the three is treated as a security regression rather
than a simplification.

It has **no runtime dependencies** - Node builtins only - so there is no third-party package in
the execution path to compromise.

## Things that are deliberate, and are not findings

- **The dashboard renders transcript content.** Expanding a row shows conversation text. It is
  read from a local file by a local server and rendered in your own browser; it is not in the
  event stream, not in the hook payload, and not sent anywhere. The token guards that route
  like every other one.
- **Hooks are merged into your agent's settings files.** Always after showing a diff and
  asking, always with a `.raise-backup`, always reversible, and never touching a foreign entry.
  `raise install-hooks`, `install-codex` and `install-pi`, each with an `uninstall-`.
- **Raise never writes Codex's `config.toml`.** That file records what *you* have agreed to let
  Codex run, and forging a consent hash would be installing a silent executable on your behalf.
  It is why Codex asks you to approve the hook yourself.
- **Two outbound requests exist, they are separately opted into, and both are off by default.**
  With the forge lookup enabled, a pull request URL already on your dashboard is sent to the
  forge hosting it, and nothing else. With the update check enabled, one request a day goes to
  `registry.npmjs.org` for this package's own name, carrying no version, no identifier and no
  query string. With both off - the default - Raise makes no network request of any kind.
- **The Bitbucket token is read from a `0600` file, never from the environment.** Deliberate:
  child processes inherit the environment, and several of them run on a one-second loop. An
  unsafe file mode makes Raise refuse the whole file rather than honour the half without a
  secret in it.

If you have found a way around any of the above, that *is* a finding, and the paragraph
describing it is what it contradicts.

## What is in scope

Anything that lets a local process, a web page, or another user on the machine read data or
run commands through Raise that they could not otherwise. The hook payload allowlist
(`REPORTABLE_FIELDS` in `src/hook-payload.js`) is a privacy boundary and in scope: a field
crossing it that should not is worth reporting even if nothing is exploitable.

Out of scope: anything requiring an attacker who already has your user account, and the
behaviour of the agents, terminals and tools Raise reads - report those to their own projects.
