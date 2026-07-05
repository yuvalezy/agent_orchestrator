import { query } from '../../db';
import { logger } from '../../logger';
import type { InboundMessage } from '../../ports/channel.port';
import type { WorkerDefinition } from '../../workers/worker-runner';
import type { EmailChannelAdapter } from './email-channel.adapter';

// Email reconcile worker (tasks.md 3.5). One per gmail instance. The GmailClient
// owns pagination + the dynamic bootstrap window (R51); this worker just persists
// the cursor and ingests. Cursor advances ONLY after every message ingests (a
// throw holds it → idempotent re-fetch next tick via (instance, message.id) dedup).

async function readCursor(instanceId: string): Promise<string | null> {
  const { rows } = await query<{ sync_cursor: string | null }>('SELECT sync_cursor FROM channel_instances WHERE id = $1', [instanceId]);
  return rows[0]?.sync_cursor ?? null;
}
async function writeCursor(instanceId: string, cursor: string): Promise<void> {
  await query('UPDATE channel_instances SET sync_cursor = $2 WHERE id = $1', [instanceId, cursor]);
}

export function buildEmailReconcileWorker(params: {
  instanceId: string;
  instanceName: string;
  adapter: EmailChannelAdapter;
  sink: (msg: InboundMessage) => Promise<unknown>;
  intervalMs: number;
}): WorkerDefinition {
  const { instanceId, instanceName, adapter, sink, intervalMs } = params;
  return {
    name: `email:reconcile:${instanceName}`,
    intervalMs,
    runImmediately: true, // startup catch-up (bootstrap on first run)
    run: async () => {
      const cursor = await readCursor(instanceId);
      const { messages, nextCursor } = await adapter.fetchSince(cursor);
      for (const msg of messages) {
        await sink(msg); // throw → cursor not advanced → re-fetch next tick (idempotent)
      }
      if (nextCursor !== cursor) await writeCursor(instanceId, nextCursor);
      if (messages.length) logger.info({ instance: instanceName, ingested: messages.length }, 'email reconcile tick');
    },
  };
}
