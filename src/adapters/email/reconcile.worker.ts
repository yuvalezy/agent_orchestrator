import type { InboundMessage } from '../../ports/channel.port';
import type { WorkerDefinition } from '../../workers/worker-runner';
import { buildReconcileWorker } from '../reconcile-worker';
import type { EmailChannelAdapter } from './email-channel.adapter';

// Email reconcile worker (tasks.md 3.5). One per gmail instance. Now a thin
// wrapper over the generic buildReconcileWorker (D-E) — the GmailClient still owns
// pagination + the dynamic bootstrap window (R51); the shared worker persists the
// cursor and ingests (advance-after-all-ingest / hold-on-throw / write-only-on-change).

export function buildEmailReconcileWorker(params: {
  instanceId: string;
  instanceName: string;
  adapter: EmailChannelAdapter;
  sink: (msg: InboundMessage) => Promise<unknown>;
  intervalMs: number;
}): WorkerDefinition {
  return buildReconcileWorker({
    instanceId: params.instanceId,
    instanceName: params.instanceName,
    namePrefix: 'email:reconcile',
    fetchSince: params.adapter.fetchSince.bind(params.adapter),
    sink: params.sink,
    intervalMs: params.intervalMs,
  });
}
