import type { WorkerDefinition } from '../../workers/worker-runner';
import type { DocSourcePort } from '../../ports/doc-source.port';
import type { EmbeddingPort } from '../../ports/embedding.port';
import type { KnowledgeRepo } from '../../knowledge/memory-repo';
import { chunkMarkdown } from '../../knowledge/chunker';
import { reconcileKnowledge, type SyncLogger } from '../../knowledge/sync';

// Knowledge-sync WORKER builder (ADAPTER — concrete worker builders live under
// src/adapters/, matching the reconcile-worker convention; only generic infra sits
// in src/workers). Wraps reconcileKnowledge in a WorkerDefinition with
// runImmediately:true (startup catch-up) and a configured interval. The worker-runner
// isolates each tick; this builder only assembles deps + logs the per-run summary.
//
// ⚠︎ NOT wired into main.ts until Gate 0 (pgvector swap) — the builder exists now so
// the composition root can push it later without a signature change.

export interface KnowledgeSyncWorkerDeps {
  docSource: DocSourcePort;
  embedding: EmbeddingPort;
  repo: KnowledgeRepo;
  resolveCustomerId: (bpRef: string) => Promise<string | null>;
  log: SyncLogger;
  intervalMs: number;
  /** Refuse-to-tombstone threshold (KNOWLEDGE_TOMBSTONE_MAX_RATIO). */
  tombstoneMaxRatio: number;
  /** Chunker seam (default chunkMarkdown). */
  chunk?: typeof chunkMarkdown;
  /** Worker display name (default 'knowledge:sync'). The task-inventory sync reuses this
   *  builder with a different docSource + name so both flow through one reconcile path. */
  name?: string;
}

export function buildKnowledgeSyncWorker(deps: KnowledgeSyncWorkerDeps): WorkerDefinition {
  const chunk = deps.chunk ?? chunkMarkdown;
  return {
    name: deps.name ?? 'knowledge:sync',
    intervalMs: deps.intervalMs,
    runImmediately: true, // startup catch-up: sync the corpus at boot, not one interval later
    // ⚠︎ Advisory lock: the composition root (main.ts, post-Gate-0) is expected to
    // wrap this run in a pg_advisory_lock on a knowledge-sync key so a double-boot
    // can't reconcile concurrently. The reconciler is CORE (ports-only, no DB seam),
    // so the lock lives at the wiring layer — NOT here and NOT inside reconcile.
    run: async () => {
      await reconcileKnowledge({
        docSource: deps.docSource,
        embedding: deps.embedding,
        repo: deps.repo,
        chunk,
        resolveCustomerId: deps.resolveCustomerId,
        log: deps.log,
        config: { tombstoneMaxRatio: deps.tombstoneMaxRatio },
      });
    },
  };
}
