import { logger } from '../../logger';
import type { WorkerDefinition } from '../../workers/worker-runner';
import type { FounderReplyReconciliation } from '../../inbox/founder-whatsapp-reply';

export interface FounderReplyWorkerDeps {
  list: (limit: number) => Promise<string[]>;
  reconcile: (outboundInboxId: string) => Promise<FounderReplyReconciliation>;
  onChanged: (result: FounderReplyReconciliation) => Promise<void>;
  intervalMs?: number;
  batch?: number;
}

/** Durable catch-up for outbound rows missed during downtime or encountered before
 * their inbound partner in a timestamp-desc WhatsApp pull page. Per-row isolation
 * prevents one malformed historic message from blocking every later founder reply. */
export function buildFounderReplyWorker(deps: FounderReplyWorkerDeps): WorkerDefinition {
  return {
    name: 'whatsapp:founder-replies',
    intervalMs: deps.intervalMs ?? 60_000,
    runImmediately: true,
    run: async () => {
      const ids = await deps.list(deps.batch ?? 100);
      let reconciled = 0;
      let failed = 0;
      for (const id of ids) {
        try {
          const result = await deps.reconcile(id);
          if (!result.retryLater) reconciled += 1;
          await deps.onChanged(result);
        } catch (err) {
          failed += 1;
          logger.warn(
            { outboundInboxId: id, reason: (err as Error)?.message },
            'founder WhatsApp reply reconciliation failed — catch-up will retry',
          );
        }
      }
      if (ids.length > 0) {
        logger.info({ scanned: ids.length, reconciled, failed }, 'founder WhatsApp reply reconciliation complete');
      }
    },
  };
}
