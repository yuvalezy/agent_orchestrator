import type { DocSourcePort, ScannedDoc } from '../ports/doc-source.port';
import type { EmbeddingPort } from '../ports/embedding.port';
import type { ChunkRow, KnowledgeDocumentRow, KnowledgeRepo } from './memory-repo';
import type { chunkMarkdown } from './chunker';

// The RECONCILER (CORE — ports only; repo + resolver INJECTED so it's unit-testable
// with mocks). Diffs the scanned doc set against the manifest per source:
//   new → insert + chunk→embed→replaceChunks
//   hash changed → re-embed (replaceChunks)
//   hash same + active → SKIP (zero embed cost)
//   tombstoned + back on disk → RESURRECT (status=active, re-embed)
//   active + gone from disk → tombstone + delete chunks — ⚠︎ ONLY if the source scanned ≥1 doc
//
// ⚠︎ Guards the implementer must uphold:
//  • per-doc try/catch: a failed doc is counted (doc_key + message) and the loop CONTINUES.
//  • removed-set: a source that scanned 0 docs is "unknown/skip", NEVER "all-removed";
//    refuse + WARN if a source's tombstone ratio exceeds config.tombstoneMaxRatio.
//  • pg_advisory_lock around the reconcile (serialize double-boot).
//  • re-stamp each chunk's customer_id from the manifest every pass.
//  • ⚠︎ fail-closed: skip a customer-scoped source whose bpRef doesn't resolve — NEVER NULL.
//  • emit a per-run summary log (created/updated/skipped/tombstoned/failed).

/** Minimal logger shape (pino-compatible) — injected so sync stays pure/testable. */
export interface SyncLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface ReconcileConfig {
  /** Refuse to tombstone a source whose removed/known ratio exceeds this (0–1). */
  tombstoneMaxRatio: number;
}

export interface ReconcileKnowledgeDeps {
  docSource: DocSourcePort;
  embedding: EmbeddingPort;
  repo: KnowledgeRepo;
  chunk: typeof chunkMarkdown;
  /** Resolve a customer-scope bpRef → agent_customers.id (null = unresolved → skip source). */
  resolveCustomerId: (bpRef: string) => Promise<string | null>;
  log: SyncLogger;
  config: ReconcileConfig;
}

export interface KnowledgeSyncSummary {
  created: number;
  updated: number;
  skipped: number;
  tombstoned: number;
  failed: number;
}

/** Group a flat list by a key selector into insertion-ordered buckets. */
function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function reconcileKnowledge(deps: ReconcileKnowledgeDeps): Promise<KnowledgeSyncSummary> {
  const { docSource, embedding, repo, chunk, resolveCustomerId, log, config } = deps;

  const summary: KnowledgeSyncSummary = { created: 0, updated: 0, skipped: 0, tombstoned: 0, failed: 0 };

  // Load BOTH sides of the diff up front. Either throw (IO/scan error or DB error)
  // ABORTS the reconcile before any write — we never diff against a partial scan.
  const scanned = await docSource.listDocs();
  const manifest = await repo.listDocuments();

  const scannedBySource = groupBy(scanned, (d) => d.sourceId);
  const manifestByKey = new Map<string, KnowledgeDocumentRow>(manifest.map((r) => [r.docKey, r]));
  const activeBySource = groupBy(
    manifest.filter((r) => r.status === 'active'),
    (r) => r.sourceId,
  );

  // resolveCustomerId is potentially a DB hit — cache per bpRef across the run.
  const customerCache = new Map<string, string | null>();
  const resolveCached = async (bpRef: string): Promise<string | null> => {
    if (customerCache.has(bpRef)) return customerCache.get(bpRef) ?? null;
    const resolved = await resolveCustomerId(bpRef);
    customerCache.set(bpRef, resolved);
    return resolved;
  };

  // Persist one scanned doc: upsert manifest row (resurrects a tombstone) then
  // chunk → embed → replaceChunks. customerId is re-stamped from the manifest
  // decision every pass so a re-scope with an unchanged body can't leak.
  const writeDoc = async (doc: ScannedDoc, customerId: string | null): Promise<void> => {
    const { id } = await repo.upsertDocument({
      sourceId: doc.sourceId,
      docKey: doc.docKey,
      module: doc.module,
      locale: doc.locale,
      title: doc.title,
      route: doc.route,
      scope: doc.scope,
      customerId,
      contentHash: doc.contentHash,
    });

    const chunks = chunk({ title: doc.title ?? '', content: doc.content });
    const rows: ChunkRow[] = [];
    if (chunks.length > 0) {
      const vectors = await embedding.embed(chunks.map((c) => c.content));
      for (let i = 0; i < chunks.length; i += 1) {
        const c = chunks[i];
        rows.push({
          chunkIndex: c.chunkIndex,
          content: c.content,
          embedding: vectors[i],
          metadata: {
            title: doc.title,
            section: c.section,
            chunkIndex: c.chunkIndex,
            module: doc.module,
            route: doc.route,
            locale: doc.locale,
          },
          customerId,
        });
      }
    }
    await repo.replaceChunks(id, rows);
  };

  const sourceIds = new Set<string>([...scannedBySource.keys(), ...activeBySource.keys()]);

  for (const sourceId of sourceIds) {
    const scannedDocs = scannedBySource.get(sourceId) ?? [];
    const activeRows = activeBySource.get(sourceId) ?? [];

    // ⚠︎ Removed-set guard: a source that scanned ZERO docs is "unknown", never
    // "all-removed". Skip it entirely — do NOT tombstone its rows (guards against a
    // transient empty scan mass-deleting a corpus).
    if (scannedDocs.length === 0) {
      log.debug({ sourceId, active: activeRows.length }, 'knowledge sync: zero-doc source — skipped (no tombstone)');
      continue;
    }

    // ⚠︎ Resolve customer scope ONCE per source (docs of a source share scope/bpRef).
    // Fail-closed: skip the whole source (no upserts, no tombstones) if a
    // customer-scoped bpRef is absent or does not resolve — never customer_id NULL.
    const sample = scannedDocs[0];
    let customerId: string | null = null;
    if (sample.scope === 'customer') {
      if (!sample.bpRef) {
        log.warn({ sourceId }, 'knowledge sync: customer source has no bpRef — skipped (fail-closed)');
        continue;
      }
      customerId = await resolveCached(sample.bpRef);
      if (customerId === null) {
        log.warn({ sourceId, bpRef: sample.bpRef }, 'knowledge sync: customer bpRef unresolved — skipped (fail-closed)');
        continue;
      }
    }

    // ── Upserts: new / hash-change / re-scope / resurrect / skip ────────────────
    for (const doc of scannedDocs) {
      try {
        const existing = manifestByKey.get(doc.docKey);
        const isActive = existing?.status === 'active';
        const hashSame = existing?.contentHash === doc.contentHash;
        const custSame = (existing?.customerId ?? null) === customerId;

        // hash-same + active + same scope → SKIP (⚠︎ ZERO embed calls).
        if (existing && isActive && hashSame && custSame) {
          summary.skipped += 1;
          continue;
        }

        await writeDoc(doc, customerId);
        if (!existing) summary.created += 1;
        else summary.updated += 1; // hash-change | re-scope | resurrect
      } catch (err) {
        // ⚠︎ per-doc isolation: record doc_key + message (NO content) and continue.
        summary.failed += 1;
        log.warn({ sourceId, docKey: doc.docKey, reason: errMessage(err) }, 'knowledge sync: doc failed');
      }
    }

    // ── Tombstones: active manifest rows no longer on disk (source scanned ≥1) ──
    const scannedKeys = new Set(scannedDocs.map((d) => d.docKey));
    const removed = activeRows.filter((r) => !scannedKeys.has(r.docKey));
    if (removed.length > 0) {
      const ratio = removed.length / activeRows.length;
      // ⚠︎ refuse + WARN if the removed ratio exceeds the configured ceiling.
      if (ratio > config.tombstoneMaxRatio) {
        log.warn(
          { sourceId, removed: removed.length, active: activeRows.length, ratio, maxRatio: config.tombstoneMaxRatio },
          'knowledge sync: tombstone ratio exceeded — refusing to tombstone source',
        );
      } else {
        for (const row of removed) {
          try {
            await repo.tombstoneDocument(row.docKey);
            await repo.deleteChunksForDocument(row.id);
            summary.tombstoned += 1;
          } catch (err) {
            summary.failed += 1;
            log.warn({ sourceId, docKey: row.docKey, reason: errMessage(err) }, 'knowledge sync: tombstone failed');
          }
        }
      }
    }
  }

  // ⚠︎ per-run summary (counts only — never content or vectors).
  log.info({ ...summary }, 'knowledge sync reconcile complete');
  return summary;
}
