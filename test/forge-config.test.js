import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readForgeConfig, watchForgeConfig } from '../src/forge-config.js';

/**
 * A fake `~/.raise/config.json`.
 *
 * `mode` is the full stat mode, so the tests say `0o100600` the way the
 * filesystem does rather than the permission bits alone - the guard masks it
 * itself, and passing it pre-masked would test a different function.
 */
const files = (text, mode = 0o100600) => ({
  stat: () => ({ mode }),
  readText: () => text,
});

const missing = {
  stat: () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  },
  readText: () => {
    throw new Error('never reached');
  },
};

test('no config file at all is the default, and says nothing about itself', () => {
  // The whole feature is off by default, and a user who never configured it may
  // not be able to tell it exists - so this must not produce a `problem` for
  // doctor to print.
  const config = readForgeConfig({ path: '/nope/config.json', files: missing });
  assert.deepEqual(config, { enabled: false, bitbucket: null, problem: null });
});

test('a file anyone else on the machine can read is refused whole', () => {
  const config = readForgeConfig({
    path: '/home/x/.raise/config.json',
    files: files(JSON.stringify({ forge: { enabled: true } }), 0o100644),
  });
  assert.equal(config.enabled, false);
  assert.match(config.problem, /mode 0644/);
  assert.match(config.problem, /chmod 600/);
});

test('the mode guard is about other users, so group-readable is refused too', () => {
  const config = readForgeConfig({
    path: '/home/x/.raise/config.json',
    files: files(JSON.stringify({ forge: { enabled: true } }), 0o100640),
  });
  assert.equal(config.enabled, false);
  assert.match(config.problem, /mode 0640/);
});

test('an unsafe mode takes the opt-in with it, not just the credential', () => {
  // Honouring the half of a file with no secret in it, having just called the
  // file unsafe, teaches nobody to fix it - and the credential that is already
  // exposed is exposed either way.
  const config = readForgeConfig({
    path: '/home/x/.raise/config.json',
    files: files(
      JSON.stringify({ forge: { enabled: true, bitbucket: { email: 'a@b.c', token: 't' } } }),
      0o100644,
    ),
  });
  assert.equal(config.enabled, false);
  assert.equal(config.bitbucket, null);
});

test('enabling with no Bitbucket credential is a complete GitHub setup', () => {
  // GitHub goes through `gh`, which authenticates itself, so there is nothing
  // to configure and this is not a half-finished state.
  const config = readForgeConfig({
    path: '/c.json',
    files: files(JSON.stringify({ forge: { enabled: true } })),
  });
  assert.deepEqual(config, { enabled: true, bitbucket: null, problem: null });
});

test('a Bitbucket credential needs both halves, and says which is missing', () => {
  // Basic auth is over the account email *and* the token: app passwords, which
  // needed only the one, were removed on 28/07/2026.
  const noToken = readForgeConfig({
    path: '/c.json',
    files: files(JSON.stringify({ forge: { enabled: true, bitbucket: { email: 'a@b.c' } } })),
  });
  assert.equal(noToken.bitbucket, null);
  assert.match(noToken.problem, /no token/);

  const noEmail = readForgeConfig({
    path: '/c.json',
    files: files(JSON.stringify({ forge: { enabled: true, bitbucket: { token: 'x' } } })),
  });
  assert.equal(noEmail.bitbucket, null);
  assert.match(noEmail.problem, /no email/);
});

test('a complete Bitbucket credential is read, and trimmed', () => {
  const config = readForgeConfig({
    path: '/c.json',
    files: files(
      JSON.stringify({
        forge: { enabled: true, bitbucket: { email: ' me@example.com\n', token: ' abc123 ' } },
      }),
    ),
  });
  assert.deepEqual(config.bitbucket, { email: 'me@example.com', token: 'abc123' });
  assert.equal(config.problem, null);
});

test('opting in is a deliberate act, so a credential alone does not do it', () => {
  const config = readForgeConfig({
    path: '/c.json',
    files: files(JSON.stringify({ forge: { bitbucket: { email: 'a@b.c', token: 't' } } })),
  });
  assert.equal(config.enabled, false);
  assert.equal(config.bitbucket, null);
});

test('enabled has to be the boolean, not a string that looks like one', () => {
  for (const enabled of ['true', 1, 'yes']) {
    const config = readForgeConfig({
      path: '/c.json',
      files: files(JSON.stringify({ forge: { enabled } })),
    });
    assert.equal(config.enabled, false, `${JSON.stringify(enabled)} should not enable it`);
  }
});

test('a malformed file is named rather than silently ignored', () => {
  // Distinct from having no file: somebody wrote this and it is not working.
  const config = readForgeConfig({ path: '/c.json', files: files('{ not json') });
  assert.equal(config.enabled, false);
  assert.match(config.problem, /not valid JSON/);
});

// ------------------------------------------------- the file, while it changes
//
// The user writes this file, and the README tells them to. An answer captured
// when the server started is one `raise doctor` and the running server disagree
// about until somebody restarts it, which is the confident-wrong shape this
// codebase is built against.

/** A mutable fake file, so a test can edit, chmod or delete it. */
const editable = () => {
  const state = { text: '{}', mode: 0o100600, mtimeMs: 1, size: 2, reads: 0 };
  return {
    state,
    write(text) {
      state.text = text;
      state.mtimeMs += 1;
      state.size = text.length;
    },
    files: {
      stat: () => {
        if (state.text === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { mode: state.mode, mtimeMs: state.mtimeMs, size: state.size };
      },
      readText: () => {
        state.reads += 1;
        return state.text;
      },
    },
  };
};

test('the file is parsed once and then only when it changes', () => {
  // The budget is a stat per poll. Re-reading and re-parsing a file nobody has
  // touched, once a second, forever, is not that.
  const file = editable();
  file.write(JSON.stringify({ forge: { enabled: true } }));
  const read = watchForgeConfig({ path: '/c.json', files: file.files });

  assert.equal(read().enabled, true);
  for (let poll = 0; poll < 10; poll += 1) assert.equal(read().enabled, true);
  assert.equal(file.state.reads, 1);

  file.write(JSON.stringify({ forge: { enabled: false } }));
  assert.equal(read().enabled, false);
  assert.equal(file.state.reads, 2);
});

test('a file written under a running monitor is noticed, because absence is not cached', () => {
  // The same problem `nm-state.js` has with the database appearing: only the
  // positive case may be remembered, or the ordinary act of configuring this
  // does nothing until a restart nobody was told about.
  const file = editable();
  file.state.text = null;
  const read = watchForgeConfig({ path: '/c.json', files: file.files });
  assert.deepEqual(read(), { enabled: false, bitbucket: null, problem: null });

  file.write(JSON.stringify({ forge: { enabled: true } }));
  assert.equal(read().enabled, true);
});

test('a chmod after the fact still refuses the file', () => {
  // The whole point of checking the mode rather than trusting the documented
  // 0600 is that a file can be written correctly and chmodded later - including
  // later than the server started.
  const file = editable();
  file.write(JSON.stringify({ forge: { enabled: true } }));
  const read = watchForgeConfig({ path: '/c.json', files: file.files });
  assert.equal(read().enabled, true);

  file.state.mode = 0o100644;
  const refused = read();
  assert.equal(refused.enabled, false);
  assert.match(refused.problem, /chmod 600/);
});
