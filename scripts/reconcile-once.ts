import 'dotenv/config';
import { env } from '../src/config/env';
import { pool } from '../src/db';
import { logger } from '../src/logger';
import { ChannelRegistry } from '../src/adapters/channel-registry';
import { buildWhatsAppReconcileWorker } from '../src/adapters/whatsapp-manager/reconcile.worker';
import { ingestInbound } from '../src/inbox/ingestion';

// Run exactly ONE WhatsApp reconcile tick and exit — deterministic gate control
// for M1.3 drills #2/#3/#4 (no HTTP/auth surface). Same wiring as src/main.ts.
//
//   npm run reconcile:once
//
// Uses the same cursor in channel_instances.sync_cursor, so repeated runs are
// idempotent and advance the cursor exactly as the background worker would.

async function main(): Promise<void> {
  const registry = await ChannelRegistry.load();
  const wa = registry.whatsappPrimary();
  if (!wa) {
    logger.error('no active whatsapp_manager channel — nothing to reconcile');
    process.exitCode = 1;
    return;
  }

  const worker = buildWhatsAppReconcileWorker({
    instanceId: wa.instance.id,
    adapter: wa.adapter,
    sink: ingestInbound,
    intervalMs: env.WHATSAPP_RECONCILE_INTERVAL_MS,
    lookbackMs: env.WHATSAPP_RECONCILE_LOOKBACK_MS,
    maxPages: env.WHATSAPP_RECONCILE_MAX_PAGES,
  });

  await worker.run();
  logger.info('reconcile-once: done');
}

main()
  .catch((err) => {
    logger.error({ err: { message: (err as Error)?.message } }, 'reconcile-once failed');
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
