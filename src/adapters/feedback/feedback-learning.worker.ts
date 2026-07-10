import type { WorkerDefinition } from '../../workers/worker-runner';
import type { EmbeddingPort } from '../../ports/embedding.port';
import type { SyncLogger } from '../../knowledge/sync';
import type { FeedbackMemoryInput } from '../../knowledge/memory-repo';
import { runFeedbackLearning, type FeedbackDecisionRow } from '../../decisions/feedback-learning';

// Feedback-learning WORKER builder (ADAPTER — concrete worker builders live under
// src/adapters/, matching the reconcile-worker / knowledge-sync convention). Wraps
// runFeedbackLearning in a WorkerDefinition with runImmediately:true (catch up on any
// corrections that resolved while the worker was down) and a configured interval. The
// worker-runner isolates each tick; this builder only assembles deps.

export interface FeedbackLearningWorkerDeps {
  fetchDecisions: (limit: number) => Promise<FeedbackDecisionRow[]>;
  embedding: EmbeddingPort;
  writeFeedback: (input: FeedbackMemoryInput) => Promise<void>;
  log: SyncLogger;
  intervalMs: number;
  batch: number;
}

export function buildFeedbackLearningWorker(deps: FeedbackLearningWorkerDeps): WorkerDefinition {
  return {
    name: 'feedback:learning',
    intervalMs: deps.intervalMs,
    runImmediately: true, // startup catch-up: learn corrections that resolved while down
    run: async () => {
      await runFeedbackLearning({
        fetchDecisions: deps.fetchDecisions,
        embedding: deps.embedding,
        writeFeedback: deps.writeFeedback,
        log: deps.log,
        batch: deps.batch,
      });
    },
  };
}
