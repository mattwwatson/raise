import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TranscriptReader } from '../src/transcript-reader.js';

/**
 * A fake filesystem that counts reads, so the cache can be asserted on directly
 * rather than inferred from timing.
 */
function fakeFiles(initial = {}) {
  const files = new Map(Object.entries(initial));
  const reads = { count: 0 };
  return {
    reads,
    set(path, text, mtimeMs) {
      files.set(path, { text, mtimeMs });
    },
    remove(path) {
      files.delete(path);
    },
    access: {
      stat(path) {
        const file = files.get(path);
        if (!file) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { size: file.text.length, mtimeMs: file.mtimeMs };
      },
      readTail(path) {
        const file = files.get(path);
        if (!file) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        reads.count += 1;
        return { text: file.text, partial: false };
      },
    },
  };
}

const line = (record) => `${JSON.stringify(record)}\n`;

test('reads a transcript once and answers from cache while it is unchanged', () => {
  // The server polls every second per session. Re-parsing an unchanged 128KB
  // tail on every tick is the whole cost this cache exists to avoid.
  const files = fakeFiles();
  files.set('/t.jsonl', line({ type: 'ai-title', aiTitle: 'first' }), 100);
  const reader = new TranscriptReader({ files: files.access });

  assert.equal(reader.read('/t.jsonl').title, 'first');
  assert.equal(reader.read('/t.jsonl').title, 'first');
  assert.equal(reader.read('/t.jsonl').title, 'first');
  assert.equal(files.reads.count, 1);
});

test('re-reads once the file has moved', () => {
  const files = fakeFiles();
  files.set('/t.jsonl', line({ type: 'ai-title', aiTitle: 'first' }), 100);
  const reader = new TranscriptReader({ files: files.access });
  assert.equal(reader.read('/t.jsonl').title, 'first');

  files.set('/t.jsonl', line({ type: 'ai-title', aiTitle: 'second' }), 200);
  assert.equal(reader.read('/t.jsonl').title, 'second');
  assert.equal(files.reads.count, 2);
});

test('a same-size rewrite still counts as a change', () => {
  // Two titles of equal length would otherwise look identical to a size check,
  // and the dashboard would show the old one indefinitely.
  const files = fakeFiles();
  files.set('/t.jsonl', line({ type: 'ai-title', aiTitle: 'aaaa' }), 100);
  const reader = new TranscriptReader({ files: files.access });
  assert.equal(reader.read('/t.jsonl').title, 'aaaa');

  files.set('/t.jsonl', line({ type: 'ai-title', aiTitle: 'bbbb' }), 200);
  assert.equal(reader.read('/t.jsonl').title, 'bbbb');
});

test('a missing or unreadable transcript is not an error', () => {
  // A session with no summary is still a session, and the dashboard's job is to
  // keep showing it rather than fall over on a file that went away.
  const reader = new TranscriptReader({ files: fakeFiles().access });
  assert.equal(reader.read('/gone.jsonl').title, null);
  assert.equal(reader.read(null).title, null);
});

test('a transcript that disappears and returns is read fresh', () => {
  const files = fakeFiles();
  files.set('/t.jsonl', line({ type: 'ai-title', aiTitle: 'first' }), 100);
  const reader = new TranscriptReader({ files: files.access });
  assert.equal(reader.read('/t.jsonl').title, 'first');

  files.remove('/t.jsonl');
  assert.equal(reader.read('/t.jsonl').title, null);

  // Same size and mtime as the original: a cache that survived the deletion
  // would answer 'first' from a file that is no longer that file.
  files.set('/t.jsonl', line({ type: 'ai-title', aiTitle: 'again' }), 100);
  assert.equal(reader.read('/t.jsonl').title, 'again');
});

test('prune forgets transcripts whose sessions have ended', () => {
  const files = fakeFiles();
  files.set('/a.jsonl', line({ type: 'ai-title', aiTitle: 'a' }), 100);
  const reader = new TranscriptReader({ files: files.access });
  reader.read('/a.jsonl');
  assert.equal(files.reads.count, 1);

  reader.prune(new Set(['/b.jsonl']));
  reader.read('/a.jsonl');
  assert.equal(files.reads.count, 2, 'pruned entry should have been re-read');
});
