import type { WorkerDefinition } from '../../workers/worker-runner';
import type { InternalDocSourcePort } from '../../ports/internal-doc-source.port';
import type { EmbeddingPort } from '../../ports/embedding.port';
import type { InternalKnowledgeRepo } from '../../knowledge/internal-repo';
import { chunkMarkdown } from '../../knowledge/chunker';
import { reconcileInternalKnowledge } from '../../knowledge/internal-sync';
import type { SyncLogger } from '../../knowledge/sync';

// Internal knowledge-sync WORKER builder (ADAPTER — concrete worker builders live
// under src/adapters/, matching the reconcile-worker convention). Wraps
// reconcileInternalKnowledge in a WorkerDefinition with runImmediately:true (startup
// catch-up) and a configured interval. Assembles deps + relies on reconcile's own
// per-run summary log.
//
// ⚠︎ Gated behind KNOWLEDGE_INTERNAL_ENABLED and wired DORMANT (main.ts registers it
// only when the flag is the literal "true"). The pg_advisory_lock that serializes a
// double-boot lives at the wiring layer (the reconciler is CORE, ports-only).

export interface InternalSyncWorkerDeps {
  docSource: InternalDocSourcePort;
  embedding: EmbeddingPort;
  repo: InternalKnowledgeRepo;
  log: SyncLogger;
  intervalMs: number;
  /** Refuse-to-tombstone threshold (KNOWLEDGE_TOMBSTONE_MAX_RATIO). */
  tombstoneMaxRatio: number;
  /** Chunker seam (default chunkMarkdown). */
  chunk?: typeof chunkMarkdown;
}

export function buildInternalSyncWorker(deps: InternalSyncWorkerDeps): WorkerDefinition {
  const chunk = deps.chunk ?? chunkMarkdown;
  return {
    name: 'knowledge:internal-sync',
    intervalMs: deps.intervalMs,
    runImmediately: true, // startup catch-up: sync the internal corpus at boot
    run: async () => {
      await reconcileInternalKnowledge({
        docSource: deps.docSource,
        embedding: deps.embedding,
        repo: deps.repo,
        chunk,
        log: deps.log,
        config: { tombstoneMaxRatio: deps.tombstoneMaxRatio },
      });
    },
  };
}
