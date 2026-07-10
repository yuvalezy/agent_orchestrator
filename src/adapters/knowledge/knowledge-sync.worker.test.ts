import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKnowledgeSyncWorker } from './knowledge-sync.worker';
import type { KnowledgeRepo } from '../../knowledge/memory-repo';
import type { EmbeddingPort } from '../../ports/embedding.port';
import type { DocSourcePort } from '../../ports/doc-source.port';
import type { SyncLogger } from '../../knowledge/sync';
import type { Chunk } from '../../knowledge/chunker';

// The worker builder is a thin adapter: it maps its flat deps into
// reconcileKnowledge and returns a WorkerDefinition. These tests pin the
// WorkerDefinition shape (name, intervalMs, runImmediately) and that run() drives
// a real reconcile end-to-end through injected mocks (no DB / fs / network).

const noopLog: SyncLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const emptyRepo: KnowledgeRepo = {
  listDocuments: async () => [],
  upsertDocument: async () => ({ id: 1 }),
  tombstoneDocument: async () => {},
  replaceChunks: async () => {},
  deleteChunksForDocument: async () => {},
  search: async () => [],
};

const embedding: EmbeddingPort = { embed: async (t) => t.map(() => [0, 0, 0]) };
const oneChunk = (d: { title: string; content: string }): Chunk[] => [
  { content: d.content, section: '', chunkIndex: 0 },
];

test('builds a WorkerDefinition with runImmediately + the given interval', () => {
  const def = buildKnowledgeSyncWorker({
    docSource: { listDocs: async () => [] },
    embedding,
    repo: emptyRepo,
    resolveCustomerId: async () => null,
    log: noopLog,
    intervalMs: 42000,
    tombstoneMaxRatio: 0.3,
    chunk: oneChunk,
  });
  assert.equal(def.name, 'knowledge:sync');
  assert.equal(def.intervalMs, 42000);
  assert.equal(def.runImmediately, true);
  assert.equal(typeof def.run, 'function');
});

test('run() drives a reconcile over the injected doc source', async () => {
  let scanned = false;
  const docSource: DocSourcePort = {
    listDocs: async () => {
      scanned = true;
      return [];
    },
  };
  const def = buildKnowledgeSyncWorker({
    docSource,
    embedding,
    repo: emptyRepo,
    resolveCustomerId: async () => null,
    log: noopLog,
    intervalMs: 1000,
    tombstoneMaxRatio: 0.5,
    chunk: oneChunk,
  });
  await def.run();
  assert.equal(scanned, true, 'reconcile scanned the injected source');
});
