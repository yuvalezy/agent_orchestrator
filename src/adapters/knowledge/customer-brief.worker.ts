import type { WorkerDefinition } from '../../workers/worker-runner';
import type { CustomerBriefSynthesizerPort } from '../../ports/llm.port';
import type { SyncLogger } from '../../knowledge/sync';
import { runCustomerBriefSweep } from '../../knowledge/customer-brief';
import {
  listBriefCustomers,
  assembleBriefFacts,
  getBriefFactsHash,
  upsertCustomerBrief,
} from '../../knowledge/customer-brief-repo';

// Relationship-brief WORKER builder (ADAPTER — co-located with the knowledge adapters; it reads
// agent_memory/agent_inbox and writes the brief mirror). Wraps runCustomerBriefSweep in a
// WorkerDefinition with runImmediately:true (refresh briefs at boot) and a ~6h interval. The core's
// per-customer facts-hash skip makes a frequent interval cheap (no LLM call when nothing changed).
// This builder only assembles deps + injects the concrete DB reads.

export interface CustomerBriefWorkerDeps {
  synthesizer: CustomerBriefSynthesizerPort;
  intervalMs: number;
  windowDays: number;
  maxMemories: number;
  maxTasks: number;
  log: SyncLogger;
  /** Clock seam — defaults to the wall clock. */
  now?: () => Date;
}

export function buildCustomerBriefWorker(deps: CustomerBriefWorkerDeps): WorkerDefinition {
  const now = deps.now ?? (() => new Date());
  return {
    name: 'brief:customer',
    intervalMs: deps.intervalMs,
    runImmediately: true, // refresh briefs at boot; the facts-hash skip keeps it cheap
    run: async () => {
      await runCustomerBriefSweep({
        listCustomers: listBriefCustomers,
        assembleFacts: (customer) =>
          assembleBriefFacts(customer, {
            windowDays: deps.windowDays,
            maxMemories: deps.maxMemories,
            maxTasks: deps.maxTasks,
            now,
          }),
        readFactsHash: getBriefFactsHash,
        synthesizer: deps.synthesizer,
        upsert: upsertCustomerBrief,
        log: deps.log,
      });
    },
  };
}
