import { env } from '../../config/env';
import { logger } from '../../logger';
import { incrementCounter } from '../../db/app-state';
import type { WorkerDefinition } from '../../workers/worker-runner';
import type { FounderNotifierPort } from '../../ports/founder-notifier.port';
import { dbContactResolutionQueries } from '../../customers/contact-resolution';
import { TriageService } from '../../triage/triage.service';
import { FailureEpisodeTracker } from '../../triage/failure-episode';
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

  // Early-warning tracker (§9.5): raises ONE admin alert as soon as triage failures
  // cross the threshold (a dependency down), long before the ~30-min failStuck
  // terminal alert — re-armed on recovery. Persists across ticks (closure state).
  const episode = new FailureEpisodeTracker(env.TRIAGE_FAILURE_ALERT_THRESHOLD);

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
          // Success → close any open failure episode (and tell the founder it recovered).
          const { recovered, priorFailures } = episode.recordSuccess();
          if (recovered) {
            await notifier
              .notifyAdmin({ title: '✅ Triage recovered', body: `Triage is processing again (after ${priorFailures} consecutive failure(s)).`, severity: 'info' })
              .catch((err) => logger.error({ reason: (err as Error)?.message }, 'triage recovery alert failed'));
          }
        } catch (err) {
          // Leave the row 'processing' → reclaimed after the stuck window (retry);
          // failStuck fails it after MAX_ATTEMPTS. One bad row can't block the batch.
          const reason = (err as Error)?.message ?? 'unknown';
          const { alert, count } = episode.recordFailure();
          logger.error({ inboxId: row.id, consecutiveFailures: count, reason }, 'triage: row failed — will be reclaimed');
          if (alert) {
            // EARLY warning — one per episode, so the founder knows there's an issue
            // immediately (not 30 min later). Never logs/sends a message body.
            await notifier
              .notifyAdmin({ title: '⚠️ Triage failing', body: `${count} consecutive triage failures — likely a dependency issue (portal / LLM / DB). Latest error: ${reason}. Rows are retrying; a permanent-failure alert follows if unresolved.`, severity: 'warning' })
              .catch((e) => logger.error({ reason: (e as Error)?.message }, 'triage early-warning alert failed'));
          }
        }
      }
    },
  };
}
