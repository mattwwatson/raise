import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ForgeState,
  parseForgeUrl,
  normaliseForgeState,
  pullRequestKey,
  OPEN_REFRESH_MS,
  FAILURE_BACKOFF_MS,
} from '../src/forge.js';

const GH = 'https://github.com/acme/widgets/pull/41';
const BB = 'https://bitbucket.org/acme/widgets/pull-requests/41';

const enabled = (bitbucket = null) => ({ enabled: true, bitbucket, problem: null });
const CREDENTIAL = { email: 'me@example.com', token: 'shhh' };

/** An `execAsync` that records what it was asked and answers with `state`. */
const ghRunner = (state, calls = []) => {
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    return Promise.resolve(JSON.stringify({ state }));
  };
  runner.calls = calls;
  return runner;
};

/** A `fetch` that records the request and answers with a Bitbucket body. */
const bbFetch = (state, calls = []) => {
  const fake = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ state }) });
  };
  fake.calls = calls;
  return fake;
};

test('parseForgeUrl takes apart the two hosts it can answer for', () => {
  assert.deepEqual(parseForgeUrl(GH), {
    forge: 'github',
    url: GH,
    workspace: 'acme',
    repo: 'widgets',
    number: 41,
  });
  assert.deepEqual(parseForgeUrl(BB), {
    forge: 'bitbucket',
    url: BB,
    workspace: 'acme',
    repo: 'widgets',
    number: 41,
  });
});

test('anything else gets nothing, so no host we do not know is ever contacted', () => {
  // Fail closed, like every other match here. A GitHub Enterprise install is
  // not github.com, and guessing would mean an outbound request to a machine
  // the user never expected us to reach.
  for (const url of [
    'https://github.example.com/acme/widgets/pull/41',
    'https://gitlab.com/acme/widgets/-/merge_requests/41',
    'https://github.com/acme/widgets/issues/41',
    'https://github.com/acme/widgets',
    'not a url',
    null,
    undefined,
  ]) {
    assert.equal(parseForgeUrl(url), null, `${url} should not be parsed`);
  }
});

test('normaliseForgeState folds both vocabularies onto the page words', () => {
  assert.equal(normaliseForgeState('OPEN'), 'open');
  assert.equal(normaliseForgeState('MERGED'), 'merged');
  assert.equal(normaliseForgeState('CLOSED'), 'closed');
  // Bitbucket's two ways of closing without merging.
  assert.equal(normaliseForgeState('DECLINED'), 'closed');
  assert.equal(normaliseForgeState('SUPERSEDED'), 'closed');
  // A word neither forge documents is discarded rather than rendered raw.
  assert.equal(normaliseForgeState('LOCKED'), null);
  assert.equal(normaliseForgeState(null), null);
});

test('a disabled config never runs a command and never makes a request', async () => {
  // The default, and the thing the whole feature is held to: a user who has not
  // configured this cannot tell it exists.
  const forge = new ForgeState({
    execAsync: () => assert.fail('gh must not run when the lookup is off'),
    fetch: () => assert.fail('no request may go out when the lookup is off'),
  });
  assert.equal(forge.enabled, false);
  forge.observe([GH, BB]);
  await forge.load([GH, BB]);
  assert.equal(forge.readings.size, 0);
});

test('GitHub is asked through gh, by URL, with no working directory of its own', async () => {
  const runner = ghRunner('MERGED');
  const forge = new ForgeState({ execAsync: runner, config: enabled() });
  await forge.load([GH]);

  assert.deepEqual(runner.calls[0].command, 'gh');
  assert.deepEqual(runner.calls[0].args, ['pr', 'view', GH, '--json', 'state']);
  assert.equal(runner.calls[0].options.cwd, undefined);
  assert.equal(forge.readings.get(pullRequestKey(GH)).state, 'merged');
});

test('Bitbucket is asked over its API, for one field, with Basic auth', async () => {
  const fake = bbFetch('OPEN');
  const forge = new ForgeState({ fetch: fake, config: enabled(CREDENTIAL) });
  await forge.load([BB]);

  const { url, init } = fake.calls[0];
  assert.equal(
    url,
    'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/41?fields=state',
  );
  // Basic auth over the account email and the token. App passwords, which
  // needed only the token, were removed on 28/07/2026.
  const decoded = Buffer.from(init.headers.authorization.slice('Basic '.length), 'base64').toString();
  assert.equal(decoded, 'me@example.com:shhh');
  assert.equal(forge.readings.get(pullRequestKey(BB)).state, 'open');
});

test('Bitbucket is not asked at all without a credential', async () => {
  // Enabled is enough for GitHub, because `gh` authenticates itself. It is not
  // enough for Bitbucket, and the difference must be silent rather than an error.
  const forge = new ForgeState({
    fetch: () => assert.fail('no request without a credential'),
    config: enabled(null),
  });
  await forge.load([BB]);
  assert.equal(forge.readings.size, 0);
});

test('a URL is asked about once per interval, however often it is rendered', async () => {
  // `observe` runs on every poll - once a second - and a request per second is
  // the one way this could become a problem for anybody.
  const runner = ghRunner('OPEN');
  const forge = new ForgeState({ execAsync: runner, config: enabled() });
  await forge.load([GH], 0);
  for (let tick = 1000; tick < OPEN_REFRESH_MS; tick += 1000) forge.observe([GH], tick);
  await forge.settle();
  assert.equal(runner.calls.length, 1);

  await forge.load([GH], OPEN_REFRESH_MS + 1);
  assert.equal(runner.calls.length, 2);
});

test('a merged pull request is never asked about again', async () => {
  // It cannot un-merge, so there is no answer left to get.
  const runner = ghRunner('MERGED');
  const forge = new ForgeState({ execAsync: runner, config: enabled() });
  await forge.load([GH], 0);
  await forge.load([GH], OPEN_REFRESH_MS * 1000);
  assert.equal(runner.calls.length, 1);
  assert.equal(forge.readings.get(pullRequestKey(GH)).state, 'merged');
});

test('a closed one is still watched, because it can be reopened', async () => {
  // Showing `closed` over a reopened review is the same quiet staleness the
  // feature exists to remove, and one request a minute is not worth saving.
  const runner = ghRunner('CLOSED');
  const forge = new ForgeState({ execAsync: runner, config: enabled() });
  await forge.load([GH], 0);
  await forge.load([GH], OPEN_REFRESH_MS + 1);
  assert.equal(runner.calls.length, 2);
});

test('a failure is silent, leaves no reading, and is not retried every minute', async () => {
  // No `gh`, no login, a private repo, a rate limit - all the same here.
  let calls = 0;
  const forge = new ForgeState({
    execAsync: () => {
      calls += 1;
      return Promise.reject(new Error('gh exited 4'));
    },
    config: enabled(),
  });
  await forge.load([GH], 0);
  assert.equal(forge.readings.size, 0);

  await forge.load([GH], OPEN_REFRESH_MS + 1);
  assert.equal(calls, 1, 'a durable failure must not be retried on the open interval');

  await forge.load([GH], FAILURE_BACKOFF_MS + 1);
  assert.equal(calls, 2, 'but fixing the credential takes effect without a restart');
});

test('an HTTP error is a no-answer rather than a state', async () => {
  const forge = new ForgeState({
    fetch: () => Promise.resolve({ ok: false, status: 403, json: () => assert.fail('not read') }),
    config: enabled(CREDENTIAL),
  });
  await forge.load([BB]);
  assert.equal(forge.readings.size, 0);
});

test('a lookup that stops answering drops its reading rather than keeping it', async () => {
  // A reading we can no longer confirm is exactly what this page must not
  // assert. The row falls back to the sources that never went away.
  let answer = () => Promise.resolve(JSON.stringify({ state: 'OPEN' }));
  const forge = new ForgeState({ execAsync: () => answer(), config: enabled() });
  await forge.load([GH], 0);
  assert.equal(forge.readings.size, 1);

  answer = () => Promise.reject(new Error('network is gone'));
  await forge.load([GH], OPEN_REFRESH_MS + 1);
  assert.equal(forge.readings.size, 0);
});

test('a pull request that leaves the page is forgotten', async () => {
  const forge = new ForgeState({ execAsync: ghRunner('OPEN'), config: enabled() });
  await forge.load([GH], 0);
  assert.equal(forge.readings.size, 1);

  forge.observe([], OPEN_REFRESH_MS + 1);
  assert.equal(forge.readings.size, 0);
});

test('one review under two spellings is one lookup', async () => {
  // no-mistakes stores a URL and a transcript prints one; they differ in a
  // trailing slash and the case of the host and mean the same review.
  const runner = ghRunner('OPEN');
  const forge = new ForgeState({ execAsync: runner, config: enabled() });
  await forge.load([GH, `${GH}/`, GH.replace('github.com', 'GitHub.com')], 0);
  assert.equal(runner.calls.length, 1);
});
