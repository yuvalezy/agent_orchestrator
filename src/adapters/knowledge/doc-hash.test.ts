import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeContentHash, type DocFrontmatter } from './doc-hash';

// Characterization of the portal-style content hash (loader.go:249 shape). The hash
// folds title\nroute\norder\ntags(sorted CSV)\n---\nbody with a normalized body
// (BOM strip, CRLF→LF, trim). Two properties matter for the reconciler:
//   • a frontmatter-only edit (title/route/order/tags) MUST change the hash
//     (else a stale citation survives — sha256(body) alone would miss it),
//   • a CRLF-only / trailing-whitespace diff MUST be stable (no re-embed churn).

const fm: DocFrontmatter = { title: 'Guía', route: '/docs', order: 70, tags: ['portal', 'docs', 'ayuda'] };
const body = 'La página **Documentación** es el lector de guías.';

test('returns lowercase sha256 hex', () => {
  const h = computeContentHash(fm, body);
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('a title-only edit changes the hash', () => {
  const h1 = computeContentHash(fm, body);
  const h2 = computeContentHash({ ...fm, title: 'Guía (v2)' }, body);
  assert.notEqual(h1, h2);
});

test('a route-only edit changes the hash', () => {
  const h1 = computeContentHash(fm, body);
  const h2 = computeContentHash({ ...fm, route: '/docs/new' }, body);
  assert.notEqual(h1, h2);
});

test('an order-only edit changes the hash', () => {
  const h1 = computeContentHash(fm, body);
  const h2 = computeContentHash({ ...fm, order: 80 }, body);
  assert.notEqual(h1, h2);
});

test('a body edit changes the hash', () => {
  const h1 = computeContentHash(fm, body);
  const h2 = computeContentHash(fm, body + ' Más texto.');
  assert.notEqual(h1, h2);
});

test('a CRLF-only diff is STABLE (no re-embed churn)', () => {
  const lf = 'linea1\nlinea2\nlinea3';
  const crlf = 'linea1\r\nlinea2\r\nlinea3';
  assert.equal(computeContentHash(fm, lf), computeContentHash(fm, crlf));
});

test('a leading BOM + trailing whitespace on the body is STABLE (trimmed/stripped)', () => {
  const clean = 'contenido';
  const noisy = '﻿  contenido  \n\n';
  assert.equal(computeContentHash(fm, clean), computeContentHash(fm, noisy));
});

test('tag ORDER is irrelevant (sorted before folding)', () => {
  const h1 = computeContentHash({ ...fm, tags: ['portal', 'docs', 'ayuda'] }, body);
  const h2 = computeContentHash({ ...fm, tags: ['ayuda', 'docs', 'portal'] }, body);
  assert.equal(h1, h2);
});

test('tags are trimmed before sorting/folding', () => {
  const h1 = computeContentHash({ ...fm, tags: ['portal', 'docs'] }, body);
  const h2 = computeContentHash({ ...fm, tags: [' portal ', ' docs '] }, body);
  assert.equal(h1, h2);
});

test('a changed tag SET changes the hash', () => {
  const h1 = computeContentHash({ ...fm, tags: ['portal', 'docs'] }, body);
  const h2 = computeContentHash({ ...fm, tags: ['portal', 'docs', 'extra'] }, body);
  assert.notEqual(h1, h2);
});
