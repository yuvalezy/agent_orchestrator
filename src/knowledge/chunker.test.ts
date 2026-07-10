import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown } from './chunker';

// Pure unit tests for the markdown chunker — no fs, no network, no DB.
// Covers: heading-path (section) derivation, boundary splitting + overlap carry,
// and ⚠︎ table atomicity (a table fits whole; an oversized table splits ONLY at row
// boundaries, repeating the header + separator on every fragment).

test('heading-path: each chunk carries its cumulative heading path as `section`', () => {
  const md = ['# Overview', 'intro text', '## Setup', 'step one', '### Details', 'fine print'].join('\n');
  const chunks = chunkMarkdown({ title: 'Doc', content: md });

  const bySection = chunks.map((c) => c.section);
  assert.deepEqual(bySection, ['Overview', 'Overview > Setup', 'Overview > Setup > Details']);
  // chunkIndex is 0-based and strictly increasing in emit order.
  assert.deepEqual(
    chunks.map((c) => c.chunkIndex),
    [0, 1, 2],
  );
  assert.equal(chunks[0].content, 'intro text');
  assert.equal(chunks[1].content, 'step one');
});

test('sibling heading pops the deeper path (Setup then Usage are siblings under Overview)', () => {
  const md = ['# Overview', 'a', '## Setup', 'b', '## Usage', 'c'].join('\n');
  const chunks = chunkMarkdown({ title: 'Doc', content: md });
  assert.deepEqual(
    chunks.map((c) => c.section),
    ['Overview', 'Overview > Setup', 'Overview > Usage'],
  );
});

test('pre-heading preamble uses empty-string section', () => {
  const chunks = chunkMarkdown({ title: 'Doc', content: 'just a preamble line\nsecond line' });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].section, '');
  assert.match(chunks[0].content, /preamble/);
});

test('boundary split + overlap: an oversized section splits and the next chunk carries the tail', () => {
  // maxTokens 3 → maxChars 12; overlapTokens 1 → overlapChars 4.
  const md = ['one', 'two', 'three'].join('\n');
  const chunks = chunkMarkdown({ title: 'Doc', content: md }, { maxTokens: 3, overlapTokens: 1 });

  assert.equal(chunks.length, 2, 'section split into two chunks');
  assert.equal(chunks[0].content, 'one\ntwo');
  // overlap: chunk 2 begins with the last line of chunk 1.
  assert.equal(chunks[1].content, 'two\nthree');
  assert.ok(chunks[1].content.startsWith('two'), 'overlap tail carried forward');
});

test('table stays whole: a table that fits is a single atomic chunk', () => {
  const md = ['## Data', '| A | B |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n');
  const chunks = chunkMarkdown({ title: 'Doc', content: md });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].section, 'Data');
  // all rows present, table not fragmented.
  assert.match(chunks[0].content, /\| 1 \| 2 \|/);
  assert.match(chunks[0].content, /\| 3 \| 4 \|/);
  assert.equal(chunks[0].content.match(/\| A \| B \|/g)?.length, 1, 'header appears exactly once');
});

test('oversized table splits at row boundaries, repeating header + separator on each fragment', () => {
  // header(9)+sep(13) plus rows; maxTokens 11 → maxChars 44 forces two fragments.
  const md = [
    '## Data',
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '| 3 | 4 |',
    '| 5 | 6 |',
  ].join('\n');
  const chunks = chunkMarkdown({ title: 'Doc', content: md }, { maxTokens: 11, overlapTokens: 0 });

  assert.ok(chunks.length >= 2, 'oversized table produced continuation chunk(s)');
  for (const c of chunks) {
    assert.match(c.content, /\| A \| B \|/, 'every fragment repeats the header row');
    assert.match(c.content, /\| --- \| --- \|/, 'every fragment repeats the separator row');
    assert.equal(c.section, 'Data', 'heading path carried on every fragment');
  }
  // No data row is dropped and none is split mid-row.
  const all = chunks.map((c) => c.content).join('\n');
  for (const row of ['| 1 | 2 |', '| 3 | 4 |', '| 5 | 6 |']) assert.match(all, new RegExp(row.replace(/\|/g, '\\|')));
});

test('a `#` inside a fenced code block is not treated as a heading', () => {
  const md = ['# Real Heading', 'body', '```bash', '# not a heading', 'echo hi', '```'].join('\n');
  const chunks = chunkMarkdown({ title: 'Doc', content: md });
  assert.deepEqual(
    [...new Set(chunks.map((c) => c.section))],
    ['Real Heading'],
    'only the real ATX heading forms a section',
  );
});

test('empty content yields no chunks', () => {
  assert.deepEqual(chunkMarkdown({ title: 'Doc', content: '' }), []);
  assert.deepEqual(chunkMarkdown({ title: 'Doc', content: '\n\n   \n' }), []);
});
