import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileInternalKnowledge, reconcileInternalDoc, type InternalReconcileDeps } from './internal-sync';
import type { InternalDocSourcePort, InternalScannedDoc, InternalPathScan } from '../ports/internal-doc-source.port';
import type { EmbeddingPort } from '../ports/embedding.port';
import type { InternalChunkRow, InternalKnowledgeRepo, InternalManifestRow } from './internal-repo';
import type { Chunk } from './chunker';
import type { SyncLogger } from './sync';

// Unit tests for the CORE internal reconciler (ports-only, fully injected). No DB, no
// fs, no network — docSource / embedding / repo are mocks. Covers every diff branch +
// the ⚠︎ guards: zero-doc scan never tombstones, one poison doc doesn't starve the
// tail, hash-same → ZERO embed calls, ratio ceiling refuses, resurrect re-embeds.

const doc = (over: Partial<InternalScannedDoc> & Pick<InternalScannedDoc, 'docKey'>): InternalScannedDoc => ({
  sourceId: 's',
  repo: 'yuval_dev_manager',
  path: 'plan/x.md',
  title: 't',
  content: 'body',
  contentHash: 'h1',
  ...over,
});

const man = (over: Partial<InternalManifestRow> & Pick<InternalManifestRow, 'docKey'>): InternalManifestRow => ({
  contentHash: 'h1',
  status: 'active',
  ...over,
});

interface RepoSpy {
  repo: InternalKnowledgeRepo;
  replaced: Array<{ docKey: string; rows: InternalChunkRow[] }>;
  tombstoned: string[];
}

function makeRepo(manifest: InternalManifestRow[], opts: { failReplaceFor?: Set<string> } = {}): RepoSpy {
  const spy: RepoSpy = { repo: null as unknown as InternalKnowledgeRepo, replaced: [], tombstoned: [] };
  spy.repo = {
    listManifest: async () => manifest,
    replaceDoc: async (docKey: string, rows: InternalChunkRow[]) => {
      if (opts.failReplaceFor?.has(docKey)) throw new Error(`boom:${docKey}`);
      spy.replaced.push({ docKey, rows });
    },
    tombstoneDoc: async (docKey: string) => {
      spy.tombstoned.push(docKey);
    },
    search: async () => {
      throw new Error('search must not be called by reconcile');
    },
    getDocLocation: async () => {
      throw new Error('getDocLocation must not be called by reconcile');
    },
  };
  return spy;
}

function makeEmbedding(): { port: EmbeddingPort; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    port: {
      embed: async (texts: string[]) => {
        calls.push(texts);
        return texts.map((_, i) => [i, i + 1, i + 2]);
      },
    },
  };
}

const docSourceOf = (docs: InternalScannedDoc[]): InternalDocSourcePort => ({
  listDocs: async () => docs,
  scanPath: async () => {
    throw new Error('scanPath must not be called by the full reconcile');
  },
});

/** A doc-source whose scanPath returns a fixed result (for reconcileInternalDoc tests). */
const docSourceWithScan = (scan: InternalPathScan): InternalDocSourcePort => ({
  listDocs: async () => {
    throw new Error('listDocs must not be called by the targeted resync');
  },
  scanPath: async () => scan,
});

const oneChunk = (d: { title: string; content: string }): Chunk[] => [
  { content: d.content, section: 'Overview', chunkIndex: 0 },
];

function makeLogger(): { log: SyncLogger; warns: unknown[]; infos: unknown[] } {
  const warns: unknown[] = [];
  const infos: unknown[] = [];
  return {
    warns,
    infos,
    log: { info: (o) => infos.push(o), warn: (o) => warns.push(o), error: () => {}, debug: () => {} },
  };
}

function baseDeps(over: Partial<InternalReconcileDeps>): InternalReconcileDeps {
  return {
    docSource: docSourceOf([]),
    embedding: makeEmbedding().port,
    repo: makeRepo([]).repo,
    chunk: oneChunk,
    log: makeLogger().log,
    config: { tombstoneMaxRatio: 0.5 },
    ...over,
  };
}

test('new doc → chunk→embed→replaceDoc (created), citation fields stamped', async () => {
  const emb = makeEmbedding();
  const repo = makeRepo([]);
  const summary = await reconcileInternalKnowledge(
    baseDeps({
      docSource: docSourceOf([doc({ docKey: 's:plan/a.md', path: 'plan/a.md', title: 'A' })]),
      embedding: emb.port,
      repo: repo.repo,
    }),
  );
  assert.deepEqual(summary, { created: 1, updated: 0, skipped: 0, tombstoned: 0, failed: 0 });
  assert.equal(emb.calls.length, 1);
  assert.equal(repo.replaced.length, 1);
  const row = repo.replaced[0].rows[0];
  assert.equal(row.docKey, 's:plan/a.md');
  assert.equal(row.path, 'plan/a.md');
  assert.equal(row.repo, 'yuval_dev_manager');
  assert.equal(row.section, 'Overview');
  assert.equal(row.title, 'A');
});

test('hash same + active → SKIP with ZERO embed calls', async () => {
  const emb = makeEmbedding();
  const repo = makeRepo([man({ docKey: 's:plan/a.md', contentHash: 'h1' })]);
  const summary = await reconcileInternalKnowledge(
    baseDeps({
      docSource: docSourceOf([doc({ docKey: 's:plan/a.md', contentHash: 'h1' })]),
      embedding: emb.port,
      repo: repo.repo,
    }),
  );
  assert.deepEqual(summary, { created: 0, updated: 0, skipped: 1, tombstoned: 0, failed: 0 });
  assert.equal(emb.calls.length, 0, 'no embedding call on skip');
  assert.equal(repo.replaced.length, 0);
});

test('hash changed → re-embed (updated)', async () => {
  const emb = makeEmbedding();
  const repo = makeRepo([man({ docKey: 's:plan/a.md', contentHash: 'OLD' })]);
  const summary = await reconcileInternalKnowledge(
    baseDeps({
      docSource: docSourceOf([doc({ docKey: 's:plan/a.md', contentHash: 'NEW' })]),
      embedding: emb.port,
      repo: repo.repo,
    }),
  );
  assert.deepEqual(summary, { created: 0, updated: 1, skipped: 0, tombstoned: 0, failed: 0 });
  assert.equal(emb.calls.length, 1);
});

test('tombstoned + back on disk → resurrect (re-embed, counted as updated)', async () => {
  const emb = makeEmbedding();
  const repo = makeRepo([man({ docKey: 's:plan/a.md', contentHash: 'h1', status: 'tombstoned' })]);
  const summary = await reconcileInternalKnowledge(
    baseDeps({
      docSource: docSourceOf([doc({ docKey: 's:plan/a.md', contentHash: 'h1' })]),
      embedding: emb.port,
      repo: repo.repo,
    }),
  );
  assert.deepEqual(summary, { created: 0, updated: 1, skipped: 0, tombstoned: 0, failed: 0 });
  assert.equal(emb.calls.length, 1, 'resurrect re-embeds even with unchanged hash');
});

test('active but gone from disk → tombstone (scan returned ≥1)', async () => {
  const repo = makeRepo([
    man({ docKey: 's:plan/keep.md' }),
    man({ docKey: 's:plan/gone.md' }),
  ]);
  const summary = await reconcileInternalKnowledge(
    baseDeps({ docSource: docSourceOf([doc({ docKey: 's:plan/keep.md' })]), repo: repo.repo }),
  );
  assert.deepEqual(summary, { created: 0, updated: 0, skipped: 1, tombstoned: 1, failed: 0 });
  assert.deepEqual(repo.tombstoned, ['s:plan/gone.md']);
});

test('⚠︎ zero-doc scan NEVER tombstones (transient empty scan is "unknown")', async () => {
  const repo = makeRepo([man({ docKey: 's:plan/a.md' }), man({ docKey: 's:plan/b.md' })]);
  const summary = await reconcileInternalKnowledge(baseDeps({ docSource: docSourceOf([]), repo: repo.repo }));
  assert.deepEqual(summary, { created: 0, updated: 0, skipped: 0, tombstoned: 0, failed: 0 });
  assert.equal(repo.tombstoned.length, 0);
});

test('⚠︎ one poison doc does NOT starve the tail', async () => {
  const repo = makeRepo([], { failReplaceFor: new Set(['s:plan/bad.md']) });
  const log = makeLogger();
  const summary = await reconcileInternalKnowledge(
    baseDeps({
      docSource: docSourceOf([doc({ docKey: 's:plan/bad.md' }), doc({ docKey: 's:plan/good.md' })]),
      repo: repo.repo,
      log: log.log,
    }),
  );
  assert.deepEqual(summary, { created: 1, updated: 0, skipped: 0, tombstoned: 0, failed: 1 });
  assert.deepEqual(repo.replaced.map((r) => r.docKey), ['s:plan/good.md']);
  const warned = log.warns.find((w) => (w as { docKey?: string }).docKey === 's:plan/bad.md') as Record<string, unknown>;
  assert.ok(warned);
  assert.equal(warned.reason, 'boom:s:plan/bad.md');
  assert.ok(!('content' in warned), 'failure log carries no content');
});

test('⚠︎ tombstone ratio over ceiling → refuse + WARN, no tombstone', async () => {
  const repo = makeRepo([
    man({ docKey: 's:plan/a.md' }),
    man({ docKey: 's:plan/b.md' }),
    man({ docKey: 's:plan/c.md' }),
    man({ docKey: 's:plan/d.md' }),
  ]);
  const log = makeLogger();
  // scan returns only 1 of 4 → 3 removed → ratio 0.75 > 0.5 ceiling
  const summary = await reconcileInternalKnowledge(
    baseDeps({ docSource: docSourceOf([doc({ docKey: 's:plan/a.md' })]), repo: repo.repo, log: log.log }),
  );
  assert.equal(summary.tombstoned, 0);
  assert.equal(repo.tombstoned.length, 0);
  const warned = log.warns.find((w) => (w as { ratio?: number }).ratio !== undefined) as Record<string, unknown>;
  assert.ok(warned, 'a ratio-exceeded warning is emitted');
  assert.equal(warned.removed, 3);
});

test('scan IO error aborts the reconcile before any write', async () => {
  const repo = makeRepo([man({ docKey: 's:plan/a.md' })]);
  const badSource: InternalDocSourcePort = {
    listDocs: async () => {
      throw new Error('scan failed');
    },
    scanPath: async () => ({ status: 'out-of-scope' }),
  };
  await assert.rejects(reconcileInternalKnowledge(baseDeps({ docSource: badSource, repo: repo.repo })), /scan failed/);
  assert.equal(repo.tombstoned.length, 0, 'no diff on a failed scan');
});

test('emits a per-run summary log (counts only)', async () => {
  const log = makeLogger();
  await reconcileInternalKnowledge(
    baseDeps({ docSource: docSourceOf([doc({ docKey: 's:plan/a.md' })]), repo: makeRepo([]).repo, log: log.log }),
  );
  const summaryLog = log.infos.find((o) => (o as { created?: number }).created !== undefined) as Record<string, unknown>;
  assert.ok(summaryLog, 'summary info log present');
  assert.deepEqual(summaryLog, { created: 1, updated: 0, skipped: 0, tombstoned: 0, failed: 0 });
});

// ── reconcileInternalDoc: the TARGETED single-doc resync (MCP resync with a path) ──

test('resync found+new → created, re-embeds, touches only that doc', async () => {
  const emb = makeEmbedding();
  const repo = makeRepo([]); // empty manifest
  const res = await reconcileInternalDoc(
    baseDeps({
      docSource: docSourceWithScan({ status: 'found', doc: doc({ docKey: 's:plan/a.md', path: 'plan/a.md' }) }),
      embedding: emb.port,
      repo: repo.repo,
    }),
    '/abs/plan/a.md',
  );
  assert.deepEqual(res, { docKey: 's:plan/a.md', action: 'created' });
  assert.equal(emb.calls.length, 1);
  assert.deepEqual(repo.replaced.map((r) => r.docKey), ['s:plan/a.md']);
});

test('resync found + hash-same → skipped with ZERO embed calls', async () => {
  const emb = makeEmbedding();
  const repo = makeRepo([man({ docKey: 's:plan/a.md', contentHash: 'h1' })]);
  const res = await reconcileInternalDoc(
    baseDeps({
      docSource: docSourceWithScan({ status: 'found', doc: doc({ docKey: 's:plan/a.md', contentHash: 'h1' }) }),
      embedding: emb.port,
      repo: repo.repo,
    }),
    's:plan/a.md',
  );
  assert.deepEqual(res, { docKey: 's:plan/a.md', action: 'skipped' });
  assert.equal(emb.calls.length, 0, 'unchanged doc → no embed');
  assert.equal(repo.replaced.length, 0);
});

test('resync found + hash-changed → updated (re-embed)', async () => {
  const emb = makeEmbedding();
  const repo = makeRepo([man({ docKey: 's:plan/a.md', contentHash: 'OLD' })]);
  const res = await reconcileInternalDoc(
    baseDeps({
      docSource: docSourceWithScan({ status: 'found', doc: doc({ docKey: 's:plan/a.md', contentHash: 'NEW' }) }),
      embedding: emb.port,
      repo: repo.repo,
    }),
    's:plan/a.md',
  );
  assert.deepEqual(res, { docKey: 's:plan/a.md', action: 'updated' });
  assert.equal(emb.calls.length, 1);
});

test('resync missing + was active → tombstone (only that doc)', async () => {
  const repo = makeRepo([man({ docKey: 's:plan/gone.md', status: 'active' })]);
  const res = await reconcileInternalDoc(
    baseDeps({ docSource: docSourceWithScan({ status: 'missing', docKey: 's:plan/gone.md' }), repo: repo.repo }),
    '/abs/plan/gone.md',
  );
  assert.deepEqual(res, { docKey: 's:plan/gone.md', action: 'tombstoned' });
  assert.deepEqual(repo.tombstoned, ['s:plan/gone.md']);
});

test('resync missing + not in manifest → noop (nothing to tombstone)', async () => {
  const repo = makeRepo([]);
  const res = await reconcileInternalDoc(
    baseDeps({ docSource: docSourceWithScan({ status: 'missing', docKey: 's:plan/never.md' }), repo: repo.repo }),
    '/abs/plan/never.md',
  );
  assert.deepEqual(res, { docKey: 's:plan/never.md', action: 'noop' });
  assert.equal(repo.tombstoned.length, 0);
});

test('resync out-of-scope path → out-of-scope, no reads/writes', async () => {
  const emb = makeEmbedding();
  const repo = makeRepo([man({ docKey: 's:plan/a.md' })]);
  const res = await reconcileInternalDoc(
    baseDeps({ docSource: docSourceWithScan({ status: 'out-of-scope' }), embedding: emb.port, repo: repo.repo }),
    '/etc/passwd',
  );
  assert.deepEqual(res, { docKey: null, action: 'out-of-scope' });
  assert.equal(emb.calls.length, 0);
  assert.equal(repo.replaced.length, 0);
  assert.equal(repo.tombstoned.length, 0);
});
