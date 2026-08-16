/**
 * What counts as a build, and what must never count as one.
 *
 * The bug this serves is a pinned tab rendering with code the server replaced
 * days ago, so the tests that matter are the ones about *not* crying wolf: a
 * file rewritten with the same bytes is the same build, and a file we could not
 * read is no answer rather than a different one. Both directions were argued
 * over on issue 1 and both are cheap to get subtly wrong.
 *
 * File access is injected throughout, as everywhere else here, so nothing waits
 * on real mtime granularity or writes to the product's own `public/`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

import { BuildStamp, SERVED_FILES, PUBLIC_DIR, defaultBuildFiles } from '../src/build-stamp.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * A filesystem you can edit, that counts what was asked of it.
 *
 * `reads` is the interesting counter: the whole cost argument for hashing
 * rather than stat-ing rests on the read happening only when something moved.
 */
function fakeFiles(contents = { 'index.html': '<h1>page</h1>', 'connection.js': 'export {}' }) {
  const files = new Map(Object.entries(contents).map(([n, text]) => [n, { text, mtimeMs: 1000 }]));
  const counts = { stats: 0, reads: 0 };
  return {
    counts,
    /** Same bytes, later mtime - what `git checkout` and `npm install` do. */
    touch(name) {
      files.get(name).mtimeMs += 1000;
    },
    write(name, text) {
      const entry = files.get(name);
      files.set(name, { text, mtimeMs: (entry?.mtimeMs ?? 1000) + 1000 });
    },
    remove(name) {
      files.delete(name);
    },
    access: {
      stat(path) {
        counts.stats += 1;
        const entry = files.get(basename(path));
        if (!entry) throw new Error('ENOENT');
        return { size: entry.text.length, mtimeMs: entry.mtimeMs };
      },
      read(path) {
        counts.reads += 1;
        const entry = files.get(basename(path));
        if (!entry) throw new Error('ENOENT');
        return Buffer.from(entry.text);
      },
    },
  };
}

const stampWith = (files) => new BuildStamp({ dir: '/public', files: files.access });

test('a build has a stamp, and asking twice does not change it', () => {
  const files = fakeFiles();
  const build = stampWith(files);
  const first = build.current();
  assert.match(first, /^[0-9a-f]{12}$/);
  assert.equal(build.current(), first);
});

test('changing the page changes the build', () => {
  // The case the whole feature exists for: a session-name renderer lands in
  // index.html, and every tab still running the old one has to be able to tell.
  const files = fakeFiles();
  const build = stampWith(files);
  const before = build.current();
  files.write('index.html', '<h1>page</h1><span class="name"></span>');
  assert.notEqual(build.current(), before);
});

test('changing the module changes the build too, not just the page', () => {
  const files = fakeFiles();
  const build = stampWith(files);
  const before = build.current();
  files.write('connection.js', 'export const KEEPALIVE_MS = 20000;');
  assert.notEqual(build.current(), before);
});

test('a file rewritten with the same bytes is the same build', () => {
  // This is the reason the stamp is a hash and not the mtime it is keyed on.
  // `git checkout` between two branches that share a page, and `npm install`
  // reinstalling the same version, both rewrite these files and move their
  // mtimes without changing a byte. Offering a reload there is crying wolf on
  // a page that is not stale at all.
  const files = fakeFiles();
  const build = stampWith(files);
  const before = build.current();
  files.touch('index.html');
  files.touch('connection.js');
  assert.equal(build.current(), before, 'the same code is the same build');
});

test('nothing is re-read while nothing has moved', () => {
  // The server asks on every poll, once a second, forever. A stat is a syscall;
  // reading and hashing 67KB is not - the same trade `transcript-reader.js`
  // makes for exactly the same reason.
  const files = fakeFiles();
  const build = stampWith(files);
  build.current();
  assert.equal(files.counts.reads, SERVED_FILES.length, 'read once to begin with');

  for (let i = 0; i < 50; i += 1) build.current();
  assert.equal(files.counts.reads, SERVED_FILES.length, 'and never again on a quiet machine');
  assert.equal(files.counts.stats, SERVED_FILES.length * 51, 'though it does keep looking');
});

test('a moved mtime is re-read, so an edit under a running server is noticed', () => {
  // `servePage` re-reads its file on every request, so editing the page while
  // the server runs changes what is served with no restart. A stamp that only
  // refreshed at startup would go on describing a file the server had stopped
  // handing out.
  const files = fakeFiles();
  const build = stampWith(files);
  build.current();
  const readsAfterFirst = files.counts.reads;
  files.write('index.html', '<h1>edited in place</h1>');
  build.current();
  assert.equal(files.counts.reads, readsAfterFirst + SERVED_FILES.length, 're-read on the change');
});

test('a build we cannot read is no answer, never a different answer', () => {
  // The rule that keeps a failed read from telling every open tab it is stale.
  // Hashing whatever survived would produce a stamp unequal to the one every
  // page holds, which is the notice appearing because of a missing file rather
  // than because of a new build.
  const files = fakeFiles();
  const build = stampWith(files);
  assert.match(build.current(), /^[0-9a-f]{12}$/);
  files.remove('connection.js');
  assert.equal(build.current(), null, 'null, not a stamp derived from the remaining file');
});

test('a file that comes back is read again rather than answered from the gap', () => {
  // The signature carries a marker for a file it could not stat, so the file
  // reappearing moves it. Without that, a null would be cached against a
  // signature that never changes and the build would stay unknown forever.
  const files = fakeFiles();
  const build = stampWith(files);
  const before = build.current();
  files.remove('connection.js');
  assert.equal(build.current(), null);
  files.write('connection.js', 'export {}');
  assert.equal(build.current(), before, 'and it is recognisably the build it was');
});

test('moving a byte across the boundary between two files is a different build', () => {
  // Concatenating the bytes alone would hash 'ab' + 'c' and 'a' + 'bc' the
  // same, so a change that moved a character from one file to the other would
  // be invisible. The name and the length go into the hash with the bytes.
  const a = fakeFiles({ 'index.html': 'ab', 'connection.js': 'c' });
  const b = fakeFiles({ 'index.html': 'a', 'connection.js': 'bc' });
  assert.notEqual(stampWith(a).current(), stampWith(b).current());
});

test('the two files are hashed as themselves, so swapping their contents shows', () => {
  const a = fakeFiles({ 'index.html': 'one', 'connection.js': 'two' });
  const b = fakeFiles({ 'index.html': 'two', 'connection.js': 'one' });
  assert.notEqual(stampWith(a).current(), stampWith(b).current());
});

test('the real public/ hashes through the default file access', () => {
  // The injected filesystem proves the logic; this proves the wiring, against
  // the product's own files rather than a fixture.
  const build = new BuildStamp();
  assert.match(build.current(), /^[0-9a-f]{12}$/);
  assert.equal(new BuildStamp({ dir: PUBLIC_DIR, files: defaultBuildFiles }).current(), build.current());
});

test('the stamp covers every file the server actually serves', () => {
  // The drift guard. `SERVED_FILES` names the build, and `src/server.js` names
  // what is sent; nothing but this makes the two stay equal. A third served
  // file left out of the list would be a change no tab could ever notice -
  // which is the exact bug this module was written for, reintroduced through
  // its own blind spot. Detectable rather than impossible, the same bargain
  // `docs-claims.test.js` strikes with CONTRIBUTING.md's inventory.
  const source = readFileSync(join(HERE, '..', 'src', 'server.js'), 'utf8');
  const served = [...source.matchAll(/join\(PUBLIC_DIR,\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(served.length > 0, 'the pattern still matches how server.js reads public/');
  for (const name of served) {
    assert.ok(SERVED_FILES.includes(name), `${name} is served but is not part of the build stamp`);
  }
});
