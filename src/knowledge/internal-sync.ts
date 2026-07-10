import type { InternalDocSourcePort, InternalScannedDoc } from '../ports/internal-doc-source.port';
import type { EmbeddingPort } from '../ports/embedding.port';
import type { InternalChunkRow, InternalKnowledgeRepo, InternalManifestRow } from './internal-repo';
import type { chunkMarkdown } from './chunker';
import type { SyncLogger } from './sync';

// The INTERNAL reconciler (CORE — ports only; repo + embedding INJECTED so it is
// unit-testable with mocks). Mirrors src/knowledge/sync.ts (reconcileKnowledge) but
// over the flat internal_knowledge table and WITHOUT customer scope/locale/module.
// Diffs the scanned internal doc set against the folded manifest:
//   new                       → chunk → embed → replaceDoc
//   hash changed              → re-embed (replaceDoc)
//   hash same + active        → SKIP (zero embed cost)
//   tombstoned + back on disk → RESURRECT (replaceDoc re-inserts active rows)
//   active + gone from disk   → tombstone — ⚠︎ ONLY if the scan returned ≥1 doc
//
// ⚠︎ Guards upheld (same discipline as the customer reconciler):
//  • per-doc try/catch: a failed doc is counted (doc_key + message) and the loop CONTINUES.
//  • zero-doc scan is "unknown/skip", NEVER "all-removed" (no mass tombstone on a glitch).
//  • refuse + WARN if the removed/active tombstone ratio exceeds config.tombstoneMaxRatio.
//  • the pg_advisory_lock that serializes a double-boot lives at the wiring layer (main.ts).
//  • emit a per-run summary log (created/updated/skipped/tombstoned/failed) — counts only.

export interface InternalReconcileConfig {
  /** Refuse to tombstone when the removed/active ratio exceeds this (0–1). */
  tombstoneMaxRatio: number;
}

export interface InternalReconcileDeps {
  docSource: InternalDocSourcePort;
  embedding: EmbeddingPort;
  repo: InternalKnowledgeRepo;
  chunk: typeof chunkMarkdown;
  log: SyncLogger;
  config: InternalReconcileConfig;
}

export interface InternalSyncSummary {
  created: number;
  updated: number;
  skipped: number;
  tombstoned: number;
  failed: number;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function reconcileInternalKnowledge(deps: InternalReconcileDeps): Promise<InternalSyncSummary> {
  const { docSource, embedding, repo, chunk, log, config } = deps;

  const summary: InternalSyncSummary = { created: 0, updated: 0, skipped: 0, tombstoned: 0, failed: 0 };

  // Load BOTH sides up front. Either throw (IO/scan or DB error) ABORTS before any
  // write — we never diff against a partial scan (which would false-tombstone).
  const scanned = await docSource.listDocs();
  const manifest = await repo.listManifest();
  const manifestByKey = new Map<string, InternalManifestRow>(manifest.map((r) => [r.docKey, r]));

  // ⚠︎ Zero-doc scan guard: an empty scan is "unknown" (probable IO glitch), NEVER
  // "everything was deleted". Skip the whole pass — never tombstone the corpus.
  if (scanned.length === 0) {
    log.debug({ manifest: manifest.length }, 'internal knowledge sync: zero-doc scan — skipped (no tombstone)');
    log.info({ ...summary }, 'internal knowledge sync reconcile complete');
    return summary;
  }

  // Persist one scanned doc: chunk → embed → replaceDoc (delete+insert fresh chunks).
  const writeDoc = async (doc: InternalScannedDoc): Promise<void> => {
    const chunks = chunk({ title: doc.title ?? '', content: doc.content });
    const rows: InternalChunkRow[] = [];
    if (chunks.length > 0) {
      const vectors = await embedding.embed(chunks.map((c) => c.content));
      for (let i = 0; i < chunks.length; i += 1) {
        const c = chunks[i];
        rows.push({
          sourceId: doc.sourceId,
          docKey: doc.docKey,
          chunkIndex: c.chunkIndex,
          repo: doc.repo,
          path: doc.path,
          title: doc.title,
          section: c.section || null,
          content: c.content,
          embedding: vectors[i],
          contentHash: doc.contentHash,
        });
      }
    }
    await repo.replaceDoc(doc.docKey, rows);
  };

  // ── Upserts: new / hash-change / resurrect / skip ─────────────────────────────
  for (const doc of scanned) {
    try {
      const existing = manifestByKey.get(doc.docKey);
      const isActive = existing?.status === 'active';
      const hashSame = existing?.contentHash === doc.contentHash;

      // hash-same + active → SKIP (⚠︎ ZERO embed calls).
      if (existing && isActive && hashSame) {
        summary.skipped += 1;
        continue;
      }

      await writeDoc(doc);
      if (!existing) summary.created += 1;
      else summary.updated += 1; // hash-change | resurrect
    } catch (err) {
      // ⚠︎ per-doc isolation: record doc_key + message (NO content) and continue.
      summary.failed += 1;
      log.warn({ docKey: doc.docKey, reason: errMessage(err) }, 'internal knowledge sync: doc failed');
    }
  }

  // ── Tombstones: active manifest docs no longer on disk (scan returned ≥1) ──────
  const activeRows = manifest.filter((r) => r.status === 'active');
  const scannedKeys = new Set(scanned.map((d) => d.docKey));
  const removed = activeRows.filter((r) => !scannedKeys.has(r.docKey));
  if (removed.length > 0) {
    const ratio = removed.length / activeRows.length;
    // ⚠︎ refuse + WARN if the removed ratio exceeds the configured ceiling.
    if (ratio > config.tombstoneMaxRatio) {
      log.warn(
        { removed: removed.length, active: activeRows.length, ratio, maxRatio: config.tombstoneMaxRatio },
        'internal knowledge sync: tombstone ratio exceeded — refusing to tombstone',
      );
    } else {
      for (const row of removed) {
        try {
          await repo.tombstoneDoc(row.docKey);
          summary.tombstoned += 1;
        } catch (err) {
          summary.failed += 1;
          log.warn({ docKey: row.docKey, reason: errMessage(err) }, 'internal knowledge sync: tombstone failed');
        }
      }
    }
  }

  // ⚠︎ per-run summary (counts only — never content or vectors).
  log.info({ ...summary }, 'internal knowledge sync reconcile complete');
  return summary;
}
