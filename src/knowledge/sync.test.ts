import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileKnowledge, type ReconcileKnowledgeDeps, type SyncLogger } from './sync';
import type { ScannedDoc, DocSourcePort } from '../ports/doc-source.port';
import type { EmbeddingPort } from '../ports/embedding.port';
import type {
  ChunkRow,
  KnowledgeDocumentRow,
  KnowledgeRepo,
  UpsertDocumentInput,
} from './memory-repo';
import type { Chunk } from './chunker';

// Unit tests for the CORE reconciler (ports-only, fully injected). No DB, no fs, no
// network — docSource / embedding / repo / resolver are all mocks. Covers every diff
// branch + the ⚠︎ panel guards: zero-doc source never tombstones, one poison doc
// doesn't starve the tail, unresolved customer bpRef skips the source, hash-same
// triggers ZERO embed calls, re-scope re-stamps customer_id, ratio ceiling refuses,
// Layer-A rows (document_id NULL) are never touched.

// ── mock factories ────────────────────────────────────────────────────────────
const doc = (over: Partial<ScannedDoc> & Pick<ScannedDoc, 'sourceId' | 'docKey'>): ScannedDoc => ({
  module: 'm',
  locale: 'es',
  title: 't',
  route: '/r',
  order: 0,
  tags: [],
  scope: 'shared',
  bpRef: null,
  content: 'body',
  contentHash: 'h1',
  ...over,
});

const row = (
  over: Partial<KnowledgeDocumentRow> & Pick<KnowledgeDocumentRow, 'id' | 'sourceId' | 'docKey'>,
): KnowledgeDocumentRow => ({
  module: 'm',
  locale: 'es',
  title: 't',
  route: '/r',
  scope: 'shared',
  customerId: null,
  contentHash: 'h1',
  status: 'active',
  ...over,
});

interface RepoSpy {
  repo: KnowledgeRepo;
  upserts: UpsertDocumentInput[];
  replaced: Array<{ documentId: number; rows: ChunkRow[] }>;
  tombstoned: string[];
  deletedChunks: number[];
}

function makeRepo(
  manifest: KnowledgeDocumentRow[],
  opts: { failUpsertFor?: Set<string>; idFor?: (docKey: string) => number } = {},
): RepoSpy {
  const spy: RepoSpy = { repo: null as unknown as KnowledgeRepo, upserts: [], replaced: [], tombstoned: [], deletedChunks: [] };
  const byKey = new Map(manifest.map((r) => [r.docKey, r]));
  let nextId = 1000;
  spy.repo = {
    listDocuments: async () => manifest,
    upsertDocument: async (d: UpsertDocumentInput) => {
      if (opts.failUpsertFor?.has(d.docKey)) throw new Error(`boom:${d.docKey}`);
      spy.upserts.push(d);
      const id = opts.idFor ? opts.idFor(d.docKey) : (byKey.get(d.docKey)?.id ?? (nextId += 1));
      return { id };
    },
    tombstoneDocument: async (docKey: string) => {
      spy.tombstoned.push(docKey);
    },
    replaceChunks: async (documentId: number, rows: ChunkRow[]) => {
      spy.replaced.push({ documentId, rows });
    },
    deleteChunksForDocument: async (documentId: number) => {
      spy.deletedChunks.push(documentId);
    },
    search: async () => {
      throw new Error('search must not be called by reconcile');
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

const docSourceOf = (docs: ScannedDoc[]): DocSourcePort => ({ listDocs: async () => docs });

// one chunk per doc (deterministic seam)
const oneChunk = (d: { title: string; content: string }): Chunk[] => [
  { content: d.content, section: 'Overview', chunkIndex: 0 },
];

function makeLogger(): { log: SyncLogger; warns: unknown[]; infos: unknown[] } {
  const warns: unknown[] = [];
  const infos: unknown[] = [];
  return {
    warns,
    infos,
    log: {
      info: (o) => infos.push(o),
      warn: (o) => warns.push(o),
      error: () => {},
      debug: () => {},
    },
  };
}

function baseDeps(over: Partial<ReconcileKnowledgeDeps>): ReconcileKnowledgeDeps {
  return {
    docSource: docSourceOf([]),
    embedding: makeEmbedding().port,
    repo: makeRepo([]).repo,
    chunk: oneChunk,
    resolveCustomerId: async () => null,
    log: makeLogger().log,
    config: { tombstoneMaxRatio: 0.5 },
    ...over,
  };
}

// ── branch coverage ─────────────────────────────────────────────────────────
test('new doc → insert manifest + chunk→embed→replaceChunks (created)', async () => {
  const emb = makeEmbedding();
  const repo = makeRepo([]);
  const summary = await reconcileKnowledge(
    baseDeps({ docSource: docSourceOf([doc({ sourceId: 's', docKey: 's:m:es:a' })]), embedding: emb.port, repo: repo.repo }),
  );
  assert.deepEqual(summary, { created: 1, updated: 0, skipped: 0, tombstoned: 0, failed: 0 });
  assert.equal(repo.upserts.length, 1);
  assert.equal(emb.calls.length, 1);
  assert.equal(repo.replaced.length, 1);
  assert.equal(repo.replaced[0].rows[0].metadata.locale, 'es');
  assert.equal(repo.replaced[0].rows[0].metadata.section, 'Overview');
});

test('hash changed → update + re-embed', async () => {
  const emb = makeEmbedding();
  const repo = makeRepo([row({ id: 7, sourceId: 's', docKey: 's:m:es:a', contentHash: 'OLD' })]);
  const summary = await reconcileKnowledge(
    baseDeps({
      docSource: docSourceOf([doc({ sourceId: 's', docKey: 's:m:es:a', contentHash: 'NEW' })]),
      embedding: emb.port,
      repo: repo.repo,
    }),
  );
  assert.deepEqual(summary, { created: 0, updated: 1, skipped: 0, tombstoned: 0, failed: 0 });
  assert.equal(emb.calls.length, 1);
  assert.equal(repo.replaced[0].documentId, 7);
});

test('hash same + active → SKIP with ZERO embed calls', async () => {
  const emb = makeEmbedding();
  const repo = makeRepo([row({ id: 7, sourceId: 's', docKey: 's:m:es:a', contentHash: 'h1' })]);
  const summary = await reconcileKnowledge(
    baseDeps({
      docSource: docSourceOf([doc({ sourceId: 's', docKey: 's:m:es:a', contentHash: 'h1' })]),
      embedding: emb.port,
      repo: repo.repo,
    }),
  );
  assert.deepEqual(summary, { created: 0, updated: 0, skipped: 1, tombstoned: 0, failed: 0 });
  assert.equal(emb.calls.length, 0, 'no embedding call on skip');
  assert.equal(repo.upserts.length, 0);
  assert.equal(repo.replaced.length, 0);
});

test('memoryType + extraMetadata thread into the chunk rows (task source); default stays guide', async () => {
  const emb = makeEmbedding();
  const repo = makeRepo([]);
  await reconcileKnowledge(
    baseDeps({
      docSource: docSourceOf([
        doc({ sourceId: 's', docKey: 's:m:es:doc' }), // no memoryType → default (undefined → 'guide' at repo)
        doc({
          sourceId: 't',
          docKey: 't:tasks:es:TSK-1',
          memoryType: 'task',
          extraMetadata: { task_ref: 'r1', status: 'in-progress' },
        }),
      ]),
      embedding: emb.port,
      repo: repo.repo,
    }),
  );
  const guideRow = repo.replaced.find((r) => r.rows[0]?.metadata['title'] === 't' && r.rows[0]?.memoryType === undefined);
  const taskRow = repo.replaced.find((r) => r.rows[0]?.memoryType === 'task');
  assert.ok(guideRow, 'a doc without memoryType leaves it unset (repo defaults to guide)');
  assert.ok(taskRow, 'the task doc carries memoryType=task');
  assert.equal(taskRow!.rows[0].metadata['task_ref'], 'r1', 'extraMetadata is merged into chunk metadata');
  assert.equal(taskRow!.rows[0].metadata['status'], 'in-progress');
  // The reconciler's own doc metadata still wins on collision (title/section/locale present).
  assert.equal(taskRow!.rows[0].metadata['locale'], 'es');
});

test('tombstoned + back on disk → resurrect (re-embed, counted as updated)', async () => {
  const emb = makeEmbedding();
  const repo = makeRepo([row({ id: 9, sourceId: 's', docKey: 's:m:es:a', contentHash: 'h1', status: 'tombstoned' })]);
  const summary = await reconcileKnowledge(
    baseDeps({
      docSource: docSourceOf([doc({ sourceId: 's', docKey: 's:m:es:a', contentHash: 'h1' })]),
      embedding: emb.port,
      repo: repo.repo,
    }),
  );
  assert.deepEqual(summary, { created: 0, updated: 1, skipped: 0, tombstoned: 0, failed: 0 });
  assert.equal(emb.calls.length, 1, 'resurrect re-embeds even with unchanged hash');
  assert.equal(repo.upserts.length, 1);
});

test('active but gone from disk → tombstone + delete chunks (source scanned ≥1)', async () => {
  const repo = makeRepo([
    row({ id: 1, sourceId: 's', docKey: 's:m:es:keep', contentHash: 'h1' }),
    row({ id: 2, sourceId: 's', docKey: 's:m:es:gone', contentHash: 'h1' }),
  ]);
  const summary = await reconcileKnowledge(
    baseDeps({ docSource: docSourceOf([doc({ sourceId: 's', docKey: 's:m:es:keep' })]), repo: repo.repo }),
  );
  assert.deepEqual(summary, { created: 0, updated: 0, skipped: 1, tombstoned: 1, failed: 0 });
  assert.deepEqual(repo.tombstoned, ['s:m:es:gone']);
  assert.deepEqual(repo.deletedChunks, [2]);
});

test('⚠︎ zero-doc source NEVER tombstones (transient empty scan is "unknown")', async () => {
  // Manifest has active rows for source 's' but the scan returns NOTHING for it.
  const repo = makeRepo([
    row({ id: 1, sourceId: 's', docKey: 's:m:es:a' }),
    row({ id: 2, sourceId: 's', docKey: 's:m:es:b' }),
  ]);
  const summary = await reconcileKnowledge(baseDeps({ docSource: docSourceOf([]), repo: repo.repo }));
  assert.deepEqual(summary, { created: 0, updated: 0, skipped: 0, tombstoned: 0, failed: 0 });
  assert.equal(repo.tombstoned.length, 0);
  assert.equal(repo.deletedChunks.length, 0);
});

test('⚠︎ one poison doc does NOT starve the tail', async () => {
  const emb = makeEmbedding();
  const repo = makeRepo([], { failUpsertFor: new Set(['s:m:es:bad']) });
  const log = makeLogger();
  const summary = await reconcileKnowledge(
    baseDeps({
      docSource: docSourceOf([
        doc({ sourceId: 's', docKey: 's:m:es:bad' }),
        doc({ sourceId: 's', docKey: 's:m:es:good' }),
      ]),
      embedding: emb.port,
      repo: repo.repo,
      log: log.log,
    }),
  );
  assert.deepEqual(summary, { created: 1, updated: 0, skipped: 0, tombstoned: 0, failed: 1 });
  assert.deepEqual(repo.upserts.map((u) => u.docKey), ['s:m:es:good']);
  // failure log carries doc_key + reason, NEVER content
  const warned = log.warns.find((w) => (w as { docKey?: string }).docKey === 's:m:es:bad') as Record<string, unknown>;
  assert.ok(warned);
  assert.equal(warned.reason, 'boom:s:m:es:bad');
  assert.ok(!('content' in warned));
});

test('⚠︎ customer-scoped source with UNRESOLVED bpRef is skipped (fail-closed, never NULL)', async () => {
  const emb = makeEmbedding();
  const repo = makeRepo([]);
  const log = makeLogger();
  const summary = await reconcileKnowledge(
    baseDeps({
      docSource: docSourceOf([doc({ sourceId: 'cust', docKey: 'cust:m:es:a', scope: 'customer', bpRef: 'bp-x' })]),
      embedding: emb.port,
      repo: repo.repo,
      resolveCustomerId: async () => null,
      log: log.log,
    }),
  );
  assert.deepEqual(summary, { created: 0, updated: 0, skipped: 0, tombstoned: 0, failed: 0 });
  assert.equal(repo.upserts.length, 0, 'nothing written for an unresolved customer source');
  assert.equal(emb.calls.length, 0);
});

test('⚠︎ customer-scoped source with NULL bpRef is skipped (fail-closed)', async () => {
  const repo = makeRepo([]);
  const summary = await reconcileKnowledge(
    baseDeps({
      docSource: docSourceOf([doc({ sourceId: 'cust', docKey: 'cust:m:es:a', scope: 'customer', bpRef: null })]),
      repo: repo.repo,
      resolveCustomerId: async () => 'should-not-be-called',
    }),
  );
  assert.deepEqual(summary, { created: 0, updated: 0, skipped: 0, tombstoned: 0, failed: 0 });
  assert.equal(repo.upserts.length, 0);
});

test('customer-scoped source with RESOLVED bpRef stamps customer_id on manifest + chunks', async () => {
  const repo = makeRepo([]);
  const summary = await reconcileKnowledge(
    baseDeps({
      docSource: docSourceOf([doc({ sourceId: 'cust', docKey: 'cust:m:es:a', scope: 'customer', bpRef: 'bp-x' })]),
      repo: repo.repo,
      resolveCustomerId: async (bp) => (bp === 'bp-x' ? 'CUST-UUID' : null),
    }),
  );
  assert.deepEqual(summary, { created: 1, updated: 0, skipped: 0, tombstoned: 0, failed: 0 });
  assert.equal(repo.upserts[0].customerId, 'CUST-UUID');
  assert.equal(repo.replaced[0].rows[0].customerId, 'CUST-UUID');
});

test('⚠︎ re-scope with unchanged body → re-embed + re-stamp customer_id (not skipped)', async () => {
  const emb = makeEmbedding();
  // existing row was shared (customerId null); now source resolves to a customer.
  const repo = makeRepo([row({ id: 5, sourceId: 'cust', docKey: 'cust:m:es:a', contentHash: 'h1', scope: 'customer', customerId: null })]);
  const summary = await reconcileKnowledge(
    baseDeps({
      docSource: docSourceOf([doc({ sourceId: 'cust', docKey: 'cust:m:es:a', contentHash: 'h1', scope: 'customer', bpRef: 'bp-x' })]),
      embedding: emb.port,
      repo: repo.repo,
      resolveCustomerId: async () => 'CUST-UUID',
    }),
  );
  assert.deepEqual(summary, { created: 0, updated: 1, skipped: 0, tombstoned: 0, failed: 0 });
  assert.equal(emb.calls.length, 1, 'body unchanged but scope changed → must re-embed to re-stamp');
  assert.equal(repo.replaced[0].rows[0].customerId, 'CUST-UUID');
});

test('⚠︎ tombstone ratio over ceiling → refuse + WARN, no tombstone', async () => {
  const repo = makeRepo([
    row({ id: 1, sourceId: 's', docKey: 's:m:es:a' }),
    row({ id: 2, sourceId: 's', docKey: 's:m:es:b' }),
    row({ id: 3, sourceId: 's', docKey: 's:m:es:c' }),
    row({ id: 4, sourceId: 's', docKey: 's:m:es:d' }),
  ]);
  const log = makeLogger();
  // scan returns only 1 of 4 → 3 removed → ratio 0.75 > 0.5 ceiling
  const summary = await reconcileKnowledge(
    baseDeps({ docSource: docSourceOf([doc({ sourceId: 's', docKey: 's:m:es:a' })]), repo: repo.repo, log: log.log }),
  );
  assert.equal(summary.tombstoned, 0);
  assert.equal(repo.tombstoned.length, 0);
  const warned = log.warns.find((w) => (w as { ratio?: number }).ratio !== undefined) as Record<string, unknown>;
  assert.ok(warned, 'a ratio-exceeded warning is emitted');
  assert.equal(warned.removed, 3);
});

test('⚠︎ Layer-A rows (document_id NULL) are never touched — reconcile only calls Layer-B repo methods', async () => {
  // The mock repo.search throws if called; reconcile must never invoke it, and it
  // only ever addresses manifest rows it scanned/knows. A clean run over an empty
  // corpus touches nothing.
  const repo = makeRepo([]);
  const summary = await reconcileKnowledge(baseDeps({ docSource: docSourceOf([]), repo: repo.repo }));
  assert.deepEqual(summary, { created: 0, updated: 0, skipped: 0, tombstoned: 0, failed: 0 });
  assert.equal(repo.tombstoned.length, 0);
  assert.equal(repo.upserts.length, 0);
});

test('emits a per-run summary log (counts only)', async () => {
  const log = makeLogger();
  await reconcileKnowledge(
    baseDeps({ docSource: docSourceOf([doc({ sourceId: 's', docKey: 's:m:es:a' })]), repo: makeRepo([]).repo, log: log.log }),
  );
  const summaryLog = log.infos.find((o) => (o as { created?: number }).created !== undefined) as Record<string, unknown>;
  assert.ok(summaryLog, 'summary info log present');
  assert.deepEqual(summaryLog, { created: 1, updated: 0, skipped: 0, tombstoned: 0, failed: 0 });
});

test('scan IO error aborts the reconcile before any write', async () => {
  const repo = makeRepo([row({ id: 1, sourceId: 's', docKey: 's:m:es:a' })]);
  const badSource: DocSourcePort = {
    listDocs: async () => {
      throw new Error('scan failed');
    },
  };
  await assert.rejects(reconcileKnowledge(baseDeps({ docSource: badSource, repo: repo.repo })), /scan failed/);
  assert.equal(repo.tombstoned.length, 0, 'no diff on a failed scan');
});

test('resolveCustomerId is cached per bpRef across a multi-doc source', async () => {
  let calls = 0;
  const repo = makeRepo([]);
  await reconcileKnowledge(
    baseDeps({
      docSource: docSourceOf([
        doc({ sourceId: 'cust', docKey: 'cust:m:es:a', scope: 'customer', bpRef: 'bp-x' }),
        doc({ sourceId: 'cust', docKey: 'cust:m:es:b', scope: 'customer', bpRef: 'bp-x' }),
      ]),
      repo: repo.repo,
      resolveCustomerId: async () => {
        calls += 1;
        return 'CUST-UUID';
      },
    }),
  );
  assert.equal(calls, 1, 'resolver invoked once per bpRef, not per doc');
  assert.equal(repo.upserts.length, 2);
});
