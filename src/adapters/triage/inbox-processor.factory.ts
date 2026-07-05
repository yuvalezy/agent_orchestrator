import { env } from '../../config/env';
import { logger } from '../../logger';
import { incrementCounter } from '../../db/app-state';
import type { WorkerDefinition } from '../../workers/worker-runner';
import type { FounderNotifierPort } from '../../ports/founder-notifier.port';
import { dbContactResolutionQueries } from '../../customers/contact-resolution';
import { TriageService } from '../../triage/triage.service';
import { claimBatch, failStuck } from '../../inbox/inbox-repo';
import { buildEzyPortalGateway } from '../ezy-portal';
import { buildLlmRouter } from '../llm/factory';

// Composition (imports adapters + core): build the TriageService with the real
// EZY gateway + LLM router + Telegram notifier, and the inbox-processor worker
// that drives it. The worker owns claim/failStuck; TriageService owns per-row logic.

const SKIPPED_COUNTER_KEY = 'skipped_unknown_senders';
const BATCH = 5;

export function buildInboxProcessorWorker(notifier: FounderNotifierPort): WorkerDefinition {
  const taskTarget = buildEzyPortalGateway();
  const llm = buildLlmRouter({
    notifyAdmin: (msg) => notifier.notifyAdmin({ title: 'LLM gateway', body: msg, severity: 'warning' }),
  });

  const triage = new TriageService({
    taskTarget,
    llm,
    notifier,
    contactQueries: dbContactResolutionQueries,
    deepLink: (taskRef) => `${env.EZY_PORTAL_BASE_URL}/projects/tasks/${taskRef}`, // best-effort (verify route)
    bumpSkipped: () => incrementCounter(SKIPPED_COUNTER_KEY),
  });

  return {
    name: 'inbox:processor',
    intervalMs: 10_000,
    run: async () => {
      // Poison-pill first: rows that exhausted their attempts → failed + one alert.
      const failedIds = await failStuck();
      if (failedIds.length) {
        await notifier
          .notifyAdmin({ title: 'Triage: rows failed', body: `${failedIds.length} inbox row(s) exceeded max attempts and were marked failed.`, severity: 'warning' })
          .catch((err) => logger.error({ reason: (err as Error)?.message }, 'failStuck admin alert failed'));
      }
      // Claim a batch and process SEQUENTIALLY (concurrency 1 → R43 soft-cap holds).
      const rows = await claimBatch(BATCH);
      for (const row of rows) {
        try {
          await triage.process(row);
        } catch (err) {
          // Leave the row 'processing' → reclaimed after the stuck window (retry);
          // failStuck fails it after MAX_ATTEMPTS. One bad row can't block the batch.
          logger.error({ inboxId: row.id, reason: (err as Error)?.message }, 'triage: row failed — will be reclaimed');
        }
      }
    },
  };
}
