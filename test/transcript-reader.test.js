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

test('events are not computed until something asks for them', () => {
  // Every session is summarised on every poll; only an expanded card is ever
  // read back in full. The hot path must not pay for a list nobody asked for.
  const files = fakeFiles();
  files.set(
    '/t.jsonl',
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }),
    100,
  );
  const reader = new TranscriptReader({ files: files.access });

  reader.read('/t.jsonl');
  assert.equal(files.reads.count, 1);

  const events = reader.events('/t.jsonl');
  assert.deepEqual(
    events.map((e) => e.text),
    ['hello'],
  );
  assert.equal(files.reads.count, 2, 'the first ask for events had to parse');

  reader.events('/t.jsonl');
  reader.events('/t.jsonl');
  assert.equal(files.reads.count, 2, 'and then they are cached like the summary');
});

test('an expanded card refreshing itself fills the summary from the same parse', () => {
  const files = fakeFiles();
  files.set('/t.jsonl', line({ type: 'ai-title', aiTitle: 'first' }), 100);
  const reader = new TranscriptReader({ files: files.access });
  reader.events('/t.jsonl');
  assert.equal(files.reads.count, 1);

  assert.equal(reader.read('/t.jsonl').title, 'first');
  assert.equal(files.reads.count, 1, 'no second read for the summary');
});

test('events are re-read when the transcript moves', () => {
  const files = fakeFiles();
  files.set(
    '/t.jsonl',
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }),
    100,
  );
  const reader = new TranscriptReader({ files: files.access });
  assert.deepEqual(
    reader.events('/t.jsonl').map((e) => e.text),
    ['first'],
  );

  files.set(
    '/t.jsonl',
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } }),
    200,
  );
  assert.deepEqual(
    reader.events('/t.jsonl').map((e) => e.text),
    ['second'],
  );
});

test('a transcript that cannot be read has no events rather than a false empty history', () => {
  const files = fakeFiles();
  const reader = new TranscriptReader({ files: files.access });
  assert.deepEqual(reader.events('/gone.jsonl'), []);
  assert.deepEqual(reader.events(null), []);
});

test('a pi transcript is parsed by pi"s parser, and a Claude one is not', () => {
  // The same bytes mean different things to the two parsers, so picking by
  // agent is what stops a pi session being read as an empty Claude one.
  const files = fakeFiles();
  files.set(
    '/pi.jsonl',
    line({
      type: 'message',
      timestamp: '2026-08-04T05:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc_1', name: 'bash', arguments: { command: 'npm test' } }],
      },
    }),
    100,
  );
  const reader = new TranscriptReader({ files: files.access });

  assert.equal(reader.read('/pi.jsonl', null, 'pi').activity, 'Running npm');
  // Read as Claude Code's format the same file says nothing at all - which is
  // exactly the silent wrong answer this parameter prevents.
  assert.equal(reader.read('/pi.jsonl', null, 'claude').activity, null);
});

test('an agent that was never named is read as Claude Code', () => {
  // Records written before pi was supported carry no agent.
  const files = fakeFiles();
  files.set('/t.jsonl', line({ type: 'ai-title', aiTitle: 'a title' }), 100);
  const reader = new TranscriptReader({ files: files.access });
  assert.equal(reader.read('/t.jsonl').title, 'a title');
  assert.equal(reader.read('/t.jsonl', null, undefined).title, 'a title');
});

test('a Codex rollout is read with its own parser and no other', () => {
  const files = fakeFiles();
  files.set(
    '/codex.jsonl',
    line({
      type: 'response_item',
      timestamp: '2026-08-11T01:00:00.000Z',
      payload: {
        type: 'custom_tool_call',
        call_id: 'call_1',
        name: 'exec',
        input: 'const r = await tools.exec_command({cmd:"npm test",workdir:"/repo"});',
      },
    }),
    100,
  );
  const reader = new TranscriptReader({ files: files.access });

  assert.equal(reader.read('/codex.jsonl', null, 'codex').activity, 'Running npm');
  // Read as either of the other two formats the same file says nothing, which
  // is the silent wrong answer the agent key on the cache exists to prevent.
  assert.equal(reader.read('/codex.jsonl', null, 'claude').activity, null);
  assert.equal(reader.read('/codex.jsonl', null, 'pi').activity, null);
});
