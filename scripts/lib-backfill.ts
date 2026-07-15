import { env } from '../src/config/env';
import { logger } from '../src/logger';
import { tryResolveCredential } from '../src/config/credentials';
import { buildLlmRouter } from '../src/adapters/llm/factory';
import { buildEmbeddingAdapter } from '../src/adapters/knowledge/openai-embeddings.client';
import { memoryRepo } from '../src/knowledge/memory-repo';
import { buildInboxHistorySource } from '../src/knowledge/inbox-history-source';
import { buildGmailHistorySource } from '../src/adapters/email/gmail-history-source';
import { GmailClient } from '../src/adapters/email/gmail-client';
import { listGmailAccounts } from '../src/adapters/channel/channel-accounts-repo';
import { getCustomerEmailIdentity } from '../src/customers/email-identity';
import { buildWhatsAppDirectoryClient, buildWaHistoryClient } from '../src/adapters/whatsapp-manager/factory';
import { buildWaHistorySource } from '../src/adapters/whatsapp-manager/wa-history-source';
import { getCustomerDirectoryInfo } from '../src/customers/customer-directory';
import { buildProposalCollapser } from '../src/adapters/knowledge/backfill-collapse.factory';
import {
  reconcileThread,
  runBackfill,
  dropCoveredThreads,
  type HistoricalThread,
  type BackfillOrchestratorDeps,
  type BackfillReport,
} from '../src/knowledge/backfill';
import { getPendingBackfillProposals } from '../src/decisions/decisions';

// Shared backfill composition root for the dry-run + live scripts (DRY). Wires the three history
// legs (agent_inbox + Gmail + WhatsApp), the reconcile-against-task-inventory closure, and the
// sweep-wide proposal collapser. The scripts add only their own sinks (dry = no-ops, live = write).
//
// The DRY sweep itself lives here too (runDrySweep + printDryReport): it has TWO callers now —
// `npm run backfill:dry` and the onboarding flow, which ends with a dry sweep the founder reviews
// before running the live one. Keeping one copy means the report onboarding prints can't drift
// from the report backfill:dry prints.

export interface BackfillCore {
  readThreads: (customerId: string) => Promise<HistoricalThread[]>;
  reconcile: BackfillOrchestratorDeps['reconcile'];
  collapseProposals: NonNullable<BackfillOrchestratorDeps['collapseProposals']>;
  embedOne: (text: string) => Promise<number[] | null>;
}

export async function createBackfillCore(): Promise<BackfillCore> {
  const llm = buildLlmRouter({ notifyAdmin: async () => {} });
  const embedder = buildEmbeddingAdapter(
    () => tryResolveCredential('OPENAI_API_KEY'),
    env.OPENAI_BASE_URL,
    { model: env.OPENAI_EMBEDDING_MODEL, dim: env.OPENAI_EMBEDDING_DIM },
  );
  const embedOne = async (text: string): Promise<number[] | null> => {
    try {
      const [v] = await embedder.embed([text]);
      return v ?? null;
    } catch {
      return null;
    }
  };

  const inboxReader = buildInboxHistorySource();
  // Read from the DYNAMIC, console-managed Gmail list (channel_instances) so a newly connected
  // account is backfilled too; its credential resolves lazily (missing → that account's read fails
  // and is skipped by safeRead, never dropping the others).
  const gmailAccounts = (await listGmailAccounts()).map((a) => ({
    name: a.name,
    client: new GmailClient(() => tryResolveCredential(a.credentialName) ?? ''),
  }));
  // ONE email leg. It marks `starred` inline from an id-set search (there is no separate starred
  // leg — a subset re-read would double-write each starred thread's conversation memory).
  const gmailReader = buildGmailHistorySource({
    accounts: gmailAccounts,
    getIdentity: getCustomerEmailIdentity,
    maxThreadsPerAccount: 50,
    maxStarredPerAccount: env.BACKFILL_STARRED_MAX_THREADS,
  });
  const waReader = env.BACKFILL_WA_ENABLED
    ? buildWaHistorySource({
        historyClient: buildWaHistoryClient(),
        directory: buildWhatsAppDirectoryClient(),
        getInfo: getCustomerDirectoryInfo,
        window: { idleGapMs: env.BACKFILL_WA_IDLE_GAP_MS, maxPerWindow: env.BACKFILL_WA_MAX_PER_WINDOW },
        maxWindowsPerCustomer: env.BACKFILL_WA_MAX_WINDOWS,
      })
    : null;

  const safeRead = (name: string, p: Promise<HistoricalThread[]>): Promise<HistoricalThread[]> =>
    p.catch((e) => {
      logger.warn({ source: name, reason: (e as Error)?.message }, 'backfill history source unavailable — skipped');
      return [] as HistoricalThread[];
    });

  const readThreads = async (customerId: string): Promise<HistoricalThread[]> => {
    const [inbox, gmail, wa] = await Promise.all([
      safeRead('inbox', inboxReader.readThreads(customerId)),
      safeRead('gmail', gmailReader.readThreads(customerId)),
      waReader ? safeRead('whatsapp', waReader.readThreads(customerId)) : Promise.resolve([] as HistoricalThread[]),
    ]);
    // The inbox leg OVERLAPS the source legs — it holds what the live workers already ingested from
    // these same Gmail threads / WA chats, under its own 'inbox:' threadKey namespace. Left alone,
    // each overlapping conversation would be embedded and stored TWICE (dedup is per thread_key).
    // Drop the inbox copy of any conversation a source leg actually returned; when a source leg is
    // off or unreachable it returns nothing, covers nothing, and the inbox copy stands.
    const source = [...gmail, ...wa];
    const inboxOnly = dropCoveredThreads(inbox, source);
    if (inboxOnly.length < inbox.length) {
      logger.info(
        { customerId, inboxThreads: inbox.length, droppedAsCovered: inbox.length - inboxOnly.length },
        'backfill: inbox threads already covered by the gmail/whatsapp legs dropped (one memory per conversation)',
      );
    }
    return [...inboxOnly, ...source];
  };

  const reconcile = (thread: HistoricalThread) =>
    reconcileThread(thread, {
      extractIntents: (ctx) => llm.extractIntents(ctx),
      embed: embedOne,
      searchTasks: (embedding, cid, opts) => memoryRepo.searchTasksByCustomer(embedding, cid, opts),
      judge: (a, candidates) => llm.judgeSimilarity(a, candidates),
      config: {
        matchMaxDistance: env.BACKFILL_MATCH_MAX_DISTANCE,
        judgeThreshold: env.BACKFILL_JUDGE_THRESHOLD,
        judgeVotes: env.BACKFILL_JUDGE_VOTES,
        k: env.BACKFILL_MATCH_K,
      },
      log: logger,
    });

  const collapseProposals = buildProposalCollapser({
    embedOne,
    findPendingProposals: getPendingBackfillProposals,
    config: {
      minConfidence: env.BACKFILL_PROPOSE_MIN_CONFIDENCE,
      clusterMaxDistance: env.BACKFILL_COLLAPSE_MAX_DISTANCE,
    },
    log: logger,
  });

  return { readThreads, reconcile, collapseProposals, embedOne };
}

/**
 * A DRY sweep for one customer: reads every history leg, reconciles each thread against the live
 * task inventory, runs the sweep-wide collapse/strict-gate, and returns the report. Writes
 * NOTHING and posts NOTHING — every writing sink is a no-op and `isProcessed` always answers
 * false, so the report describes the FULL sweep a live run would perform, not the remainder.
 *
 * Callers must have loaded settingsStore + credentialsStore and confirmed OPENAI_API_KEY first
 * (they differ on what to do when it's missing: backfill:dry exits, onboarding degrades).
 */
export async function runDrySweep(customerId: string): Promise<BackfillReport> {
  const core = await createBackfillCore();
  return runBackfill(customerId, {
    readThreads: core.readThreads,
    reconcile: core.reconcile,
    collapseProposals: core.collapseProposals,
    // dry-run: the writing sinks + idempotency are never invoked.
    writeLink: async () => true,
    recordProposal: async () => {},
    writeMemory: async () => true,
    isProcessed: async () => false,
    markProcessed: async () => {},
    dryRun: true,
    log: logger,
  });
}

/** Print a dry-run report (stdout, not the logger — this is a document for a human to read). */
export function printDryReport(report: BackfillReport): void {
  console.log(`\n════════ BACKFILL DRY-RUN — customer ${report.customerId} ════════`);
  console.log(
    `threads=${report.threads}  link-open=${report.linkedOpen}  link-resolved=${report.linkedResolved}  ` +
      `memory=${report.memories}  propose=${report.proposed} (of ${report.proposalsConsidered} raw)  ` +
      `skip=${report.skipped}  retryable=${report.retryable}\n`,
  );
  for (const item of report.items) {
    const o = item.outcome;
    let line = '';
    if (o.kind === 'link-open' || o.kind === 'link-resolved') line = `${o.kind} → ${o.code ?? o.taskRef} (${o.status}, judge ${o.judged})`;
    else if (o.kind === 'propose') line = `PROPOSE → "${o.title}" [${o.priority}] (conf ${o.confidence})`;
    else if (o.kind === 'memory') line = `memory (${o.reason})`;
    else line = `skip (${o.reason})`;
    console.log(`  [${item.threadKey}] ${line}`);
  }
}
