import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInternalDocSource, type InternalDocSourceDeps } from './internal-doc-source';
import type { InternalSource, InternalRepo } from './internal-sources';

// Unit tests for the internal fs walker (ADAPTER) with a VIRTUAL fs — no real disk.
// Covers: recursive *.md collection, excludeDirs pruning, single-file includes, the
// docKey/title/citation shape, non-.md skipping, missing-include tolerance, and the
// duplicate-docKey guard. Frontmatter-less docs (title ← first H1, else filename).

type Node = { type: 'dir'; entries: string[] } | { type: 'file'; content: string };

function makeFs(nodes: Record<string, Node>): Pick<InternalDocSourceDeps, 'exists' | 'isDirectory' | 'readDir' | 'readFile'> {
  return {
    exists: (p) => p in nodes,
    isDirectory: (p) => nodes[p]?.type === 'dir',
    readDir: (p) => {
      const n = nodes[p];
      if (!n || n.type !== 'dir') throw new Error(`ENOTDIR ${p}`);
      return n.entries;
    },
    readFile: (p) => {
      const n = nodes[p];
      if (!n || n.type !== 'file') throw new Error(`ENOENT ${p}`);
      return n.content;
    },
  };
}

const REPO_ROOTS: Record<InternalRepo, string> = {
  yuval_dev_manager: '/root',
  'ai-agent': '/ai',
  portal: '/p',
  wms: '/wms',
  'ezy-integration': '/ezyint',
  'ezy-report-generator': '/ezyrep',
};

const source = (over: Partial<InternalSource> & Pick<InternalSource, 'include'>): InternalSource => ({
  id: 's',
  repo: 'yuval_dev_manager',
  excludeDirs: ['archive'],
  ...over,
});

test('walks a dir recursively + a single file, skips excludeDirs and non-md, derives title', async () => {
  const fs = makeFs({
    '/root/plan/EXECUTION-PLAN.md': { type: 'file', content: '# Execution Plan\n\nbody here' },
    '/root/plan/blueprints': { type: 'dir', entries: ['M2a.md', 'archive', 'notes.txt', 'sub'] },
    '/root/plan/blueprints/M2a.md': { type: 'file', content: '# M2a Blueprint\nx' },
    '/root/plan/blueprints/archive': { type: 'dir', entries: ['old.md'] },
    '/root/plan/blueprints/archive/old.md': { type: 'file', content: '# Old\ny' },
    '/root/plan/blueprints/notes.txt': { type: 'file', content: 'not markdown' },
    '/root/plan/blueprints/sub': { type: 'dir', entries: ['deep.md'] },
    '/root/plan/blueprints/sub/deep.md': { type: 'file', content: 'no heading here, first line is prose' },
  });
  const ds = buildInternalDocSource({
    sources: [source({ include: ['plan/EXECUTION-PLAN.md', 'plan/blueprints'] })],
    repoRoots: REPO_ROOTS,
    ...fs,
  });

  const docs = await ds.listDocs();
  const byKey = new Map(docs.map((d) => [d.docKey, d]));

  assert.deepEqual(
    docs.map((d) => d.docKey).sort(),
    ['s:plan/EXECUTION-PLAN.md', 's:plan/blueprints/M2a.md', 's:plan/blueprints/sub/deep.md'],
    'recursive md only; archive pruned; notes.txt ignored',
  );

  const exec = byKey.get('s:plan/EXECUTION-PLAN.md')!;
  assert.equal(exec.title, 'Execution Plan', 'title ← first H1');
  assert.equal(exec.repo, 'yuval_dev_manager');
  assert.equal(exec.path, 'plan/EXECUTION-PLAN.md');
  assert.equal(exec.sourceId, 's');
  assert.equal(exec.content, '# Execution Plan\n\nbody here', 'content normalized (trimmed) body');
  assert.ok(exec.contentHash.length > 0);

  assert.equal(byKey.get('s:plan/blueprints/sub/deep.md')!.title, 'deep', 'title ← filename when no H1');
});

test('a missing include is skipped (not fatal) — supports the tombstone-on-removal flow', async () => {
  const fs = makeFs({
    '/root/plan/present.md': { type: 'file', content: '# Present' },
  });
  const ds = buildInternalDocSource({
    sources: [source({ include: ['plan/present.md', 'plan/GONE.md', 'plan/missing-dir'] })],
    repoRoots: REPO_ROOTS,
    ...fs,
  });
  const docs = await ds.listDocs();
  assert.deepEqual(docs.map((d) => d.docKey), ['s:plan/present.md']);
});

test('duplicate docKey (overlapping includes) throws', async () => {
  const fs = makeFs({
    '/root/plan/blueprints': { type: 'dir', entries: ['M2a.md'] },
    '/root/plan/blueprints/M2a.md': { type: 'file', content: '# M2a' },
  });
  const ds = buildInternalDocSource({
    sources: [source({ include: ['plan/blueprints', 'plan/blueprints/M2a.md'] })],
    repoRoots: REPO_ROOTS,
    ...fs,
  });
  await assert.rejects(ds.listDocs(), /duplicate docKey/);
});

test('content hash is stable across runs for unchanged content', async () => {
  const fs = makeFs({ '/root/plan/a.md': { type: 'file', content: '# A\nbody' } });
  const mk = () =>
    buildInternalDocSource({ sources: [source({ include: ['plan/a.md'] })], repoRoots: REPO_ROOTS, ...fs });
  const h1 = (await mk().listDocs())[0].contentHash;
  const h2 = (await mk().listDocs())[0].contentHash;
  assert.equal(h1, h2);
});

// ── scanPath: single-path resolution for the targeted resync ──────────────────

function scanFixture() {
  const fs = makeFs({
    '/root/plan/EXECUTION-PLAN.md': { type: 'file', content: '# Execution Plan\nbody' },
    '/root/plan/blueprints/M2a.md': { type: 'file', content: '# M2a\nx' },
  });
  return buildInternalDocSource({
    sources: [source({ include: ['plan/EXECUTION-PLAN.md', 'plan/blueprints'], excludeDirs: ['archive'] })],
    repoRoots: REPO_ROOTS,
    ...fs,
  });
}

test('scanPath: absolute in-scope + on disk → found with correct docKey', async () => {
  const res = await scanFixture().scanPath('/root/plan/blueprints/M2a.md');
  assert.equal(res.status, 'found');
  if (res.status === 'found') {
    assert.equal(res.doc.docKey, 's:plan/blueprints/M2a.md');
    assert.equal(res.doc.title, 'M2a');
    assert.equal(res.doc.path, 'plan/blueprints/M2a.md');
  }
});

test('scanPath: docKey form → found', async () => {
  const res = await scanFixture().scanPath('s:plan/EXECUTION-PLAN.md');
  assert.equal(res.status, 'found');
  if (res.status === 'found') assert.equal(res.doc.docKey, 's:plan/EXECUTION-PLAN.md');
});

test('scanPath: in-scope include dir but gone from disk → missing with docKey', async () => {
  const res = await scanFixture().scanPath('/root/plan/blueprints/deleted.md');
  assert.deepEqual(res, { status: 'missing', docKey: 's:plan/blueprints/deleted.md' });
});

test('scanPath: under an excludeDirs segment → out-of-scope', async () => {
  const res = await scanFixture().scanPath('/root/plan/blueprints/archive/old.md');
  assert.deepEqual(res, { status: 'out-of-scope' });
});

test('scanPath: outside every configured root → out-of-scope', async () => {
  const res = await scanFixture().scanPath('/etc/passwd');
  assert.deepEqual(res, { status: 'out-of-scope' });
});

test('scanPath: in-scope path but not markdown → out-of-scope', async () => {
  const res = await scanFixture().scanPath('/root/plan/blueprints/notes.txt');
  assert.deepEqual(res, { status: 'out-of-scope' });
});

test('scanPath: a real path but NOT under any include → out-of-scope', async () => {
  // /root exists as a root but plan/other.md is not under either configured include.
  const res = await scanFixture().scanPath('/root/plan/other.md');
  assert.deepEqual(res, { status: 'out-of-scope' });
});

// ── classification guards: embedded customer docs excluded; customer / new-repo /
//    scratch behave as the real INTERNAL_SOURCES intends ──────────────────────────

const CLASSIFY_SCRATCH = ['node_modules', 'archive', 'tmp', 'summary', 'e2e', '.claude'];

function classifyFixture() {
  const fs = makeFs({
    // portal service: internal plan/ INCLUDED; embedded config/registration/docs NOT
    '/p/services/pos/plan/roadmap.md': { type: 'file', content: '# POS roadmap' },
    '/p/services/pos/backend/config/registration/docs/es/articulo.md': { type: 'file', content: '# Customer article' },
    // customer code: internal plan/ INCLUDED; customer-facing docs NOT
    '/p/customers/hola-doc/plan/rollout.md': { type: 'file', content: '# Rollout' },
    '/p/customers/hola-doc/backend/config/registration/docs/es/faq.md': { type: 'file', content: '# FAQ' },
    // sibling repo
    '/wms/ezy-wms-backend/docs/picking.md': { type: 'file', content: '# Picking' },
    // scratch under an included dir
    '/ezyint/plan': { type: 'dir', entries: ['real.md', 'node_modules'] },
    '/ezyint/plan/real.md': { type: 'file', content: '# real plan' },
    '/ezyint/plan/node_modules': { type: 'dir', entries: ['dep.md'] },
    '/ezyint/plan/node_modules/dep.md': { type: 'file', content: '# vendored' },
  });
  const sources: InternalSource[] = [
    { id: 'svc-pos', repo: 'portal', include: ['services/pos/plan', 'services/pos/docs'], excludeDirs: CLASSIFY_SCRATCH },
    { id: 'cust-hola-doc', repo: 'portal', include: ['customers/hola-doc/plan', 'customers/hola-doc/docs'], excludeDirs: CLASSIFY_SCRATCH },
    { id: 'wms-backend', repo: 'wms', include: ['ezy-wms-backend/docs'], excludeDirs: CLASSIFY_SCRATCH },
    { id: 'ezy-integration', repo: 'ezy-integration', include: ['plan', 'docs'], excludeDirs: CLASSIFY_SCRATCH },
  ];
  return buildInternalDocSource({ sources, repoRoots: REPO_ROOTS, ...fs });
}

test('guard: embedded config/registration/docs is NOT indexed and NOT resolvable', async () => {
  const ds = classifyFixture();
  const keys = (await ds.listDocs()).map((d) => d.docKey);
  assert.ok(!keys.some((k) => k.includes('config/registration/docs')), 'no embedded customer doc in listDocs');
  // and scanPath refuses it (it is under no configured include)
  assert.deepEqual(await ds.scanPath('/p/services/pos/backend/config/registration/docs/es/articulo.md'), { status: 'out-of-scope' });
  assert.deepEqual(await ds.scanPath('/p/customers/hola-doc/backend/config/registration/docs/es/faq.md'), { status: 'out-of-scope' });
});

test('guard: per-customer internal doc resolves to its cust-<code> source', async () => {
  const res = await classifyFixture().scanPath('/p/customers/hola-doc/plan/rollout.md');
  assert.equal(res.status, 'found');
  if (res.status === 'found') assert.equal(res.doc.sourceId, 'cust-hola-doc');
});

test('guard: a sibling-repo path resolves to its source', async () => {
  const res = await classifyFixture().scanPath('/wms/ezy-wms-backend/docs/picking.md');
  assert.equal(res.status, 'found');
  if (res.status === 'found') assert.equal(res.doc.sourceId, 'wms-backend');
});

test('guard: a scratch dir (node_modules) under an include is pruned', async () => {
  const ds = classifyFixture();
  const keys = (await ds.listDocs()).map((d) => d.docKey);
  assert.ok(keys.includes('ezy-integration:plan/real.md'), 'real plan doc indexed');
  assert.ok(!keys.some((k) => k.includes('node_modules')), 'node_modules pruned from listDocs');
  assert.deepEqual(await ds.scanPath('/ezyint/plan/node_modules/dep.md'), { status: 'out-of-scope' });
});
