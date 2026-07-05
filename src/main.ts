import { env } from './config/env';
import { logger } from './logger';
import { runMigrations } from './db/migrate';
import { closePool } from './db';
import { buildApp } from './app';
import { startWorker } from './workers/worker-runner';
import { heartbeatWorker } from './workers/heartbeat.worker';

/**
 * Composition root (blueprint §4). env → migrate → listen → workers → graceful
 * shutdown. This is the ONLY module that (later) imports both src/ports and
 * src/adapters; the ESLint import boundary (D1) keeps core clean of adapters.
 */
async function main(): Promise<void> {
  await runMigrations();

  const app = buildApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`agent-orchestrator listening on http://localhost:${env.PORT}`);
  });

  // M1.1 registers exactly ONE ephemeral framework self-test worker. Extension
  // point for later milestones — no code change here, only new startWorker(...)
  // calls: inbox processor (M1.5b), outbound drainer (M1.8), ingestion pollers
  // (M1.3/M1.6/M1.7). Adapter/channel-registry wiring (M1.3) also plugs in here.
  const workers = [startWorker(heartbeatWorker)];

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down…');
    for (const w of workers) w.stop();
    server.close();
    await closePool();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
