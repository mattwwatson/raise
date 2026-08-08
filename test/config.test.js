import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePort, portFromFlag, defaultPort, DEFAULT_PORT } from '../src/config.js';

function withEnv(value, fn) {
  const previous = process.env.RAISE_PORT;
  if (value === undefined) delete process.env.RAISE_PORT;
  else process.env.RAISE_PORT = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.RAISE_PORT;
    else process.env.RAISE_PORT = previous;
  }
}

test('a valid port is accepted from either source', () => {
  assert.equal(parsePort('8080'), 8080);
  assert.equal(portFromFlag('8080'), 8080);
  assert.equal(withEnv('8080', defaultPort), 8080);
  assert.equal(withEnv(undefined, defaultPort), DEFAULT_PORT);
});

test('--port gets the same validation as RAISE_PORT', () => {
  // Unvalidated, `--port abc` became NaN: listen bound a random port, the URL
  // printed as :NaN, and server.json recorded null - so every hook decided the
  // server was not running and session tracking died with no error anywhere.
  for (const bad of ['abc', '0', '65536', '80.5', '-1', '']) {
    assert.throws(() => portFromFlag(bad), /must be a whole number between 1 and 65535/, `--port ${bad}`);
    assert.throws(() => withEnv(bad === '' ? ' ' : bad, defaultPort), /between 1 and 65535/, `env ${bad}`);
  }
});

test('--port with no value is a typo, not port 1', () => {
  // parseFlags turns a valueless flag into `true`; Number(true) is 1, which
  // used to surface as a raw EACCES stack trace.
  assert.throws(() => portFromFlag(true), /--port needs a port number/);
});

test('the offending value is quoted back in the message', () => {
  assert.throws(() => parsePort('abc', 'RAISE_PORT'), /RAISE_PORT .* got "abc"/);
});
