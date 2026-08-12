/**
 * The update check, which is the second thing in Raise that reaches the network
 * and the second thing that is off until somebody says otherwise.
 *
 * Two of these tests are the ones that matter, and they are the negative kind:
 * that a machine which has not opted in makes no request and writes no file, and
 * that the request a machine which *has* opted in makes carries nothing about
 * itself. Neither can be observed from the outside - an absent request looks
 * exactly like a successful one that happened to say nothing - so it is asserted
 * here or it is lost, which is the same reason `server.test.js` carries a
 * `fetch` that fails the test if it is called.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UPDATE_CHECK_INTERVAL_MS,
  REGISTRY_URL,
  isNewerVersion,
  newerVersion,
  readUpdateCache,
  readUpdateConfig,
} from '../src/update-check.js';

/**
 * A fake `~/.raise/config.json`. `mode` is the full stat mode, so these say
 * `0o100600` the way the filesystem does rather than the permission bits alone.
 */
const files = (text, mode = 0o100600) => ({
  stat: () => ({ mode, mtimeMs: 1, size: text.length }),
  readText: () => text,
});

const noFile = {
  stat: () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  },
  readText: () => {
    throw new Error('never reached');
  },
};

const optedIn = files(JSON.stringify({ updates: { enabled: true } }));

/** A cache that starts empty and remembers what was written to it. */
function scratchCache(initial = null) {
  let text = initial;
  return {
    writes: [],
    readText() {
      if (text === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return text;
    },
    writeText(path, next) {
      this.writes.push(next);
      text = next;
    },
  };
}

/** A registry that answers once with a version, and counts how often it is asked. */
function registry(version) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ version }) };
  };
  return { fetch, calls };
}

const neverCalled = () => assert.fail('no outbound request may be made from here');

const NOW = 1_770_000_000_000;

// ------------------------------------------------------------------- opting in

test('a machine with no config file asks nothing and writes nothing', async () => {
  // The default, and the whole reason the README may still say Raise makes no
  // outbound request of any kind out of the box.
  const cache = {
    readText: () => assert.fail('the cache is not even read when the feature is off'),
    writeText: () => assert.fail('nothing is written on a machine that never opted in'),
  };
  const latest = await newerVersion({
    current: '0.1.0',
    now: NOW,
    fetch: neverCalled,
    cache,
    cachePath: '/nope/update-check.json',
    configPath: '/nope/config.json',
    files: noFile,
  });
  assert.equal(latest, null);
});

test('no config file produces no problem for doctor to print either', () => {
  // A user who has not configured this may not be able to tell it exists.
  assert.deepEqual(readUpdateConfig({ path: '/nope/config.json', files: noFile }), {
    enabled: false,
    problem: null,
  });
});

test('an unsafe file mode refuses the update opt-in as well as the credential', async () => {
  // The rule is a property of the file, not of the block: the update block holds
  // nothing secret and is refused anyway, because a safety rule with an
  // exception is the exception somebody deletes while tidying.
  const unsafe = files(JSON.stringify({ updates: { enabled: true } }), 0o100644);
  const config = readUpdateConfig({ path: '/home/x/.raise/config.json', files: unsafe });
  assert.equal(config.enabled, false);
  assert.match(config.problem, /mode 0644/);
  assert.match(config.problem, /chmod 600/);

  const latest = await newerVersion({
    current: '0.1.0',
    now: NOW,
    fetch: neverCalled,
    cache: scratchCache(),
    configPath: '/home/x/.raise/config.json',
    files: unsafe,
  });
  assert.equal(latest, null, 'a refused file must not leave the request enabled');
});

test('only the boolean true is an opt-in', () => {
  for (const raw of [{}, { updates: {} }, { updates: { enabled: 'true' } }, { updates: { enabled: 1 } }]) {
    const config = readUpdateConfig({ path: '/c.json', files: files(JSON.stringify(raw)) });
    assert.equal(config.enabled, false, `${JSON.stringify(raw)} is not an opt-in`);
    assert.equal(config.problem, null, 'and not turning it on is not a problem to report');
  }
});

test('the forge block and the update block are turned on separately', () => {
  const config = readUpdateConfig({
    path: '/c.json',
    files: files(JSON.stringify({ forge: { enabled: true } })),
  });
  assert.equal(config.enabled, false, 'opting into one outbound request is not opting into both');
});

// ------------------------------------------------------- what leaves the machine

test('the request names one host, one package, and nothing about this machine', async () => {
  const npm = registry('0.2.0');
  const cache = scratchCache();
  await newerVersion({
    current: '0.1.0',
    now: NOW,
    fetch: npm.fetch,
    cache,
    cachePath: '/c/update-check.json',
    configPath: '/c.json',
    files: optedIn,
  });

  assert.equal(npm.calls.length, 1);
  const { url, init } = npm.calls[0];
  assert.equal(url, REGISTRY_URL);
  assert.equal(new URL(url).host, 'registry.npmjs.org', 'exactly one host, and it is npm');
  assert.equal(new URL(url).search, '', 'no query string, so nothing can be smuggled into one');
  // The version we are on is the one thing that would turn this from "somebody
  // asked" into "somebody on 0.1.0 asked", so it must not appear anywhere.
  assert.ok(!url.includes('0.1.0'), 'the installed version never leaves the machine');
  assert.deepEqual(Object.keys(init.headers), ['accept'], 'no header of ours identifies anybody');
});

// -------------------------------------------------------------- asking and telling

test('the first check asks once, remembers the answer, and reports it', async () => {
  const npm = registry('0.2.0');
  const cache = scratchCache();
  const latest = await newerVersion({
    current: '0.1.0',
    now: NOW,
    fetch: npm.fetch,
    cache,
    cachePath: '/c/update-check.json',
    configPath: '/c.json',
    files: optedIn,
  });
  assert.equal(latest, '0.2.0');
  assert.deepEqual(JSON.parse(cache.writes[0]), { checkedAt: NOW, latest: '0.2.0' });
});

test('a remembered answer is told again without being asked again', async () => {
  // The point of the cache, and the answer to "once per serve start is too
  // often": restarting `serve` ten times in an afternoon is ten notices and one
  // request.
  const cache = scratchCache(JSON.stringify({ checkedAt: NOW, latest: '0.2.0' }));
  for (const minutes of [1, 60, 60 * 23]) {
    const latest = await newerVersion({
      current: '0.1.0',
      now: NOW + minutes * 60_000,
      fetch: neverCalled,
      cache,
      cachePath: '/c/update-check.json',
      configPath: '/c.json',
      files: optedIn,
    });
    assert.equal(latest, '0.2.0', `still answered from the cache after ${minutes} minutes`);
  }
  assert.deepEqual(cache.writes, [], 'and nothing is rewritten while the answer stands');
});

test('an answer older than the interval is asked for again', async () => {
  const npm = registry('0.3.0');
  const cache = scratchCache(JSON.stringify({ checkedAt: NOW, latest: '0.2.0' }));
  const latest = await newerVersion({
    current: '0.1.0',
    now: NOW + UPDATE_CHECK_INTERVAL_MS,
    fetch: npm.fetch,
    cache,
    cachePath: '/c/update-check.json',
    configPath: '/c.json',
    files: optedIn,
  });
  assert.equal(npm.calls.length, 1);
  assert.equal(latest, '0.3.0');
});

test('a cache stamped in the future is not trusted', async () => {
  // The clock has moved backwards, and a record that cannot expire is one that
  // would sit on a version number forever.
  const npm = registry('0.3.0');
  const cache = scratchCache(JSON.stringify({ checkedAt: NOW + 60_000, latest: '0.2.0' }));
  const latest = await newerVersion({
    current: '0.1.0',
    now: NOW,
    fetch: npm.fetch,
    cache,
    cachePath: '/c/update-check.json',
    configPath: '/c.json',
    files: optedIn,
  });
  assert.equal(npm.calls.length, 1);
  assert.equal(latest, '0.3.0');
});

test('an answer that is not newer says nothing at all', async () => {
  const npm = registry('0.1.0');
  const latest = await newerVersion({
    current: '0.1.0',
    now: NOW,
    fetch: npm.fetch,
    cache: scratchCache(),
    cachePath: '/c/update-check.json',
    configPath: '/c.json',
    files: optedIn,
  });
  assert.equal(latest, null);
});

test('a checkout ahead of anything published is not told to downgrade', async () => {
  const npm = registry('0.1.0');
  const latest = await newerVersion({
    current: '0.2.0-dev',
    now: NOW,
    fetch: npm.fetch,
    cache: scratchCache(),
    cachePath: '/c/update-check.json',
    configPath: '/c.json',
    files: optedIn,
  });
  assert.equal(latest, null);
});

// ------------------------------------------------------------------- failing quietly

test('every way the registry can fail is the same silence', async () => {
  const failures = {
    'the network is not there': async () => {
      throw new Error('ENOTFOUND registry.npmjs.org');
    },
    'a rate limit or a 500': async () => ({ ok: false, json: async () => ({}) }),
    'a body that is not JSON': async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }),
    'a body with no version in it': async () => ({ ok: true, json: async () => ({}) }),
    'a version neither side can parse': async () => ({ ok: true, json: async () => ({ version: 'next' }) }),
  };
  for (const [what, fetch] of Object.entries(failures)) {
    const cache = scratchCache();
    const latest = await newerVersion({
      current: '0.1.0',
      now: NOW,
      fetch,
      cache,
      cachePath: '/c/update-check.json',
      configPath: '/c.json',
      files: optedIn,
    });
    assert.equal(latest, null, what);
  }
});

test('a failed check is remembered, so it is not retried on every start', async () => {
  // Without this, a laptop that is offline makes one request per `raise serve`
  // rather than one a day - the one way a feature capped at a request a day
  // turns into a request a restart.
  const cache = scratchCache();
  const offline = async () => {
    throw new Error('ENOTFOUND');
  };
  const args = {
    current: '0.1.0',
    cache,
    cachePath: '/c/update-check.json',
    configPath: '/c.json',
    files: optedIn,
  };
  assert.equal(await newerVersion({ ...args, now: NOW, fetch: offline }), null);
  assert.deepEqual(JSON.parse(cache.writes[0]), { checkedAt: NOW, latest: null });
  assert.equal(await newerVersion({ ...args, now: NOW + 60_000, fetch: neverCalled }), null);
});

test('a cache that cannot be written costs a request next time and never a word', async () => {
  const npm = registry('0.2.0');
  const latest = await newerVersion({
    current: '0.1.0',
    now: NOW,
    fetch: npm.fetch,
    cache: {
      readText: () => {
        throw new Error('ENOENT');
      },
      writeText: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    },
    cachePath: '/c/update-check.json',
    configPath: '/c.json',
    files: optedIn,
  });
  assert.equal(latest, '0.2.0', 'the answer still arrives');
});

test('nothing here ever rejects, because nobody awaits it', async () => {
  // `raise serve` fires this and prints its banner. A rejection would be an
  // unhandled one, in a process that is meant to run for weeks.
  const latest = await newerVersion({
    current: '0.1.0',
    now: NOW,
    fetch: () => {
      throw new TypeError('not a function, or whatever else went wrong');
    },
    cache: {
      readText: () => {
        throw new Error('boom');
      },
      writeText: () => {
        throw new Error('boom');
      },
    },
    cachePath: '/c/update-check.json',
    configPath: '/c.json',
    files: {
      stat: () => {
        throw new Error('boom');
      },
      readText: () => {
        throw new Error('boom');
      },
    },
  });
  assert.equal(latest, null);
});

// --------------------------------------------------------------------- the cache

test('a cache that has been edited into nonsense is simply asked again', () => {
  for (const text of ['', 'not json', '{}', '[]', 'null', '{"checkedAt":"soon"}', '{"checkedAt":0}']) {
    assert.equal(
      readUpdateCache({ path: '/c/update-check.json', cache: { readText: () => text, writeText() {} } }),
      null,
      text,
    );
  }
});

test('a check that did not answer is a different fact from never having asked', () => {
  // `doctor` tells them apart, because "asked and got nothing" is something
  // Raise does not know and must not report as an answer.
  const cache = {
    readText: () => JSON.stringify({ checkedAt: NOW, latest: null }),
    writeText() {},
  };
  assert.deepEqual(readUpdateCache({ path: '/c/update-check.json', cache }), {
    checkedAt: NOW,
    latest: null,
  });
});

// ----------------------------------------------------------------- version order

test('isNewerVersion ranks major, minor and patch numerically', () => {
  assert.equal(isNewerVersion('0.1.0', '0.2.0'), true);
  assert.equal(isNewerVersion('0.1.0', '1.0.0'), true);
  assert.equal(isNewerVersion('0.1.0', '0.1.1'), true);
  assert.equal(isNewerVersion('0.1.0', '0.1.0'), false);
  assert.equal(isNewerVersion('0.2.0', '0.1.9'), false);
  assert.equal(isNewerVersion('1.0.0', '0.9.9'), false);
  // Not string order, which is the whole reason this is not a comparison of two
  // strings: "10" sorts before "9" and 10 does not.
  assert.equal(isNewerVersion('0.9.0', '0.10.0'), true);
  assert.equal(isNewerVersion('0.10.0', '0.9.0'), false);
});

test('a pre-release is below its own release and above the version before it', () => {
  assert.equal(isNewerVersion('0.2.0-rc.1', '0.2.0'), true);
  assert.equal(isNewerVersion('0.2.0', '0.2.0-rc.1'), false);
  assert.equal(isNewerVersion('0.1.0', '0.2.0-rc.1'), true);
});

test('anything unrankable says no, because guessing is the worse error', () => {
  // Saying nothing costs somebody an upgrade a week later; guessing puts a
  // monitor on the page asserting something untrue about itself.
  assert.equal(isNewerVersion('0.2.0-rc.1', '0.2.0-rc.2'), false, 'two pre-releases are not ranked');
  assert.equal(isNewerVersion('unknown', '0.2.0'), false, 'packageVersion() could not read the file');
  assert.equal(isNewerVersion('0.1.0', 'latest'), false);
  assert.equal(isNewerVersion('0.1.0', '0.2'), false);
  assert.equal(isNewerVersion('0.1.0', ''), false);
  assert.equal(isNewerVersion(null, undefined), false);
});

test('build metadata is ignored rather than making a version unrankable', () => {
  assert.equal(isNewerVersion('0.1.0', '0.2.0+build.7'), true);
});
