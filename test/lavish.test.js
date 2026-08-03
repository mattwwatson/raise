import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseLavishSessions, LavishState, REFRESH_MS } from '../src/lavish.js';

// Trimmed to the shape that matters: the sessions block, and a following
// top-level key that has to terminate it.
const OUTPUT = `bin: /opt/homebrew/bin/lavish-axi
sessions[2]{file,status,url,pending_prompts}:
  /Users/x/.treehouse/hexbattle/2/.lavish/terrain.html,open,"http://127.0.0.1:4387/session/9274f6d4",0
  /Users/x/work/hexbattle/.lavish/profile.html,open,"http://127.0.0.1:4387/session/c2ce72dc",2
playbooks[7]{id,use_when}:
  diagram,"Map relationships"
`;

test('parseLavishSessions reads the sessions block and stops at the next key', () => {
  const sessions = parseLavishSessions(OUTPUT);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[0], {
    file: '/Users/x/.treehouse/hexbattle/2/.lavish/terrain.html',
    status: 'open',
    url: 'http://127.0.0.1:4387/session/9274f6d4',
    pendingPrompts: 0,
  });
  assert.equal(sessions[1].pendingPrompts, 2);
});

test('parseLavishSessions returns nothing when lavish reports no sessions', () => {
  assert.deepEqual(parseLavishSessions('bin: /opt/homebrew/bin/lavish-axi\n'), []);
  assert.deepEqual(parseLavishSessions(''), []);
  assert.deepEqual(parseLavishSessions(null), []);
});

test('parseLavishSessions reads columns from the header rather than by position', () => {
  // The header declares its own order; assuming it would break silently the
  // day lavish adds or reorders a column.
  const out = `sessions[1]{status,file,pending_prompts,url}:
  open,/repo/.lavish/p.html,0,"http://127.0.0.1:4387/session/abc"
`;
  assert.deepEqual(parseLavishSessions(out)[0], {
    file: '/repo/.lavish/p.html',
    status: 'open',
    url: 'http://127.0.0.1:4387/session/abc',
    pendingPrompts: 0,
  });
});

test('parseLavishSessions skips a row that does not fit its header', () => {
  const out = `sessions[2]{file,status,url,pending_prompts}:
  /repo/.lavish/good.html,open,"http://127.0.0.1:4387/session/abc",0
  /repo/.lavish/truncated.html,open
`;
  const sessions = parseLavishSessions(out);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].file, '/repo/.lavish/good.html');
});

const execReturning = (out, calls = []) =>
  async function execAsync(command, args) {
    calls.push([command, ...args]);
    return out;
  };

test('urlFor returns null on the first ask and the link once the refresh lands', async () => {
  // lavish-axi takes the better part of two seconds, so it can never be on the
  // poll path. The first ask schedules; the link appears a moment later.
  const calls = [];
  const lavish = new LavishState({ execAsync: execReturning(OUTPUT, calls) });

  assert.equal(lavish.urlFor('/Users/x/work/hexbattle/.lavish/profile.html', 1000), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['lavish-axi']]);
  assert.equal(
    lavish.urlFor('/Users/x/work/hexbattle/.lavish/profile.html', 1000),
    'http://127.0.0.1:4387/session/c2ce72dc',
  );
});

test('the CLI is not run again inside the refresh window', async () => {
  const calls = [];
  const lavish = new LavishState({ execAsync: execReturning(OUTPUT, calls) });
  lavish.urlFor('/x.html', 1000);
  await new Promise((resolve) => setImmediate(resolve));

  for (let i = 0; i < 20; i += 1) lavish.urlFor('/x.html', 1000 + i * 100);
  assert.equal(calls.length, 1);

  lavish.urlFor('/x.html', 1000 + REFRESH_MS + 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
});

test('a lavish that is absent or broken yields no links and no throw', async () => {
  const lavish = new LavishState({
    async execAsync() {
      throw new Error('command not found: lavish-axi');
    },
  });
  assert.equal(lavish.urlFor('/x.html', 1000), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lavish.urlFor('/x.html', 1000), null);
  assert.deepEqual(lavish.sessions, []);
});

test('an unexpanded variable or relative path still finds its review', async () => {
  // The transcript records the command as typed, so the path is frequently not
  // the resolved one Lavish reports - `lavish-axi poll $S/plan.html` is a real
  // case, caught the first time this ran against a live session.
  const out = `sessions[1]{file,status,url,pending_prompts}:
  /Users/x/work/repo/.lavish/plan.html,open,"http://127.0.0.1:4387/session/abc",0
`;
  const lavish = new LavishState({ execAsync: execReturning(out) });
  lavish.urlFor('x', 1000);
  await new Promise((resolve) => setImmediate(resolve));

  for (const written of ['$S/plan.html', './.lavish/plan.html', '~/work/repo/.lavish/plan.html']) {
    assert.equal(lavish.urlFor(written, 1000), 'http://127.0.0.1:4387/session/abc', written);
  }
});

test('an ambiguous filename yields no link rather than the wrong one', async () => {
  // Two repos each reviewing a plan.html is entirely plausible, and sending
  // someone to the wrong review is worse than sending them to none.
  const out = `sessions[2]{file,status,url,pending_prompts}:
  /Users/x/work/a/.lavish/plan.html,open,"http://127.0.0.1:4387/session/aaa",0
  /Users/x/work/b/.lavish/plan.html,open,"http://127.0.0.1:4387/session/bbb",0
`;
  const lavish = new LavishState({ execAsync: execReturning(out) });
  lavish.urlFor('x', 1000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(lavish.urlFor('$S/plan.html', 1000), null);
  // An exact path is never ambiguous, so it still resolves.
  assert.equal(
    lavish.urlFor('/Users/x/work/b/.lavish/plan.html', 1000),
    'http://127.0.0.1:4387/session/bbb',
  );
});

test('the basename fallback ignores closed sessions', async () => {
  const out = `sessions[1]{file,status,url,pending_prompts}:
  /Users/x/work/repo/.lavish/plan.html,closed,"http://127.0.0.1:4387/session/abc",0
`;
  const lavish = new LavishState({ execAsync: execReturning(out) });
  lavish.urlFor('x', 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lavish.urlFor('$S/plan.html', 1000), null);
});

test('a closed lavish session is not offered as a link', async () => {
  const out = `sessions[1]{file,status,url,pending_prompts}:
  /repo/.lavish/done.html,closed,"http://127.0.0.1:4387/session/abc",0
`;
  const lavish = new LavishState({ execAsync: execReturning(out) });
  lavish.urlFor('/repo/.lavish/done.html', 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lavish.urlFor('/repo/.lavish/done.html', 1000), null);
});

test('no exec runner at all is a supported configuration', () => {
  // The CLI's one-shot commands construct this without an async runner.
  const lavish = new LavishState({});
  assert.equal(lavish.urlFor('/x.html', 1000), null);
});
