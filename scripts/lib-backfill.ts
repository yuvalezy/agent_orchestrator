import { env } from '../src/config/env';
import { logger } from '../src/logger';
import { tryResolveCredential } from '../src/config/credentials';
import { buildLlmRouter } from '../src/adapters/llm/factory';
import { buildEmbeddingAdapter } from '../src/adapters/knowledge/openai-embeddings.client';
import { memoryRepo } from '../src/knowledge/memory-repo';
import { buildInboxHistorySource } from '../src/knowledge/inbox-history-source';
import { buildGmailHistorySource } from '../src/adapters/email/gmail-history-source';
import { buildGmailStarredSource } from '../src/adapters/email/gmail-starred-source';
import { GmailClient } from '../src/adapters/email/gmail-client';
import { getCustomerEmailIdentity } from '../src/customers/email-identity';
import { buildWhatsAppDirectoryClient, buildWaHistoryClient } from '../src/adapters/whatsapp-manager/factory';
import { buildWaHistorySource } from '../src/adapters/whatsapp-manager/wa-history-source';
import { getCustomerDirectoryInfo } from '../src/customers/customer-directory';
import { buildProposalCollapser } from '../src/adapters/knowledge/backfill-collapse.factory';
import { reconcileThread, type HistoricalThread, type BackfillOrchestratorDeps } from '../src/knowledge/backfill';
import { getPendingBackfillProposals } from '../src/decisions/decisions';

// Shared backfill composition root for the dry-run + live scripts (DRY). Wires the three history
// legs (agent_inbox + Gmail + WhatsApp), the reconcile-against-task-inventory closure, and the
// sweep-wide proposal collapser. The scripts add only their own sinks (dry = no-ops, live = write).

export interface BackfillCore {
  readThreads: (customerId: string) => Promise<HistoricalThread[]>;
  reconcile: BackfillOrchestratorDeps['reconcile'];
  collapseProposals: NonNullable<BackfillOrchestratorDeps['collapseProposals']>;
  embedOne: (text: string) => Promise<number[] | null>;
}

export function createBackfillCore(): BackfillCore {
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
  // Shared Gmail accounts — reused by BOTH the standard Gmail leg and the starred leg (one integration).
  const gmailAccounts = [
    { name: 'email:gmail:work', client: new GmailClient(() => tryResolveCredential('GMAIL_WORK_OAUTH') ?? '') },
    { name: 'email:gmail:personal', client: new GmailClient(() => tryResolveCredential('GMAIL_PERSONAL_OAUTH') ?? '') },
  ];
  const gmailReader = buildGmailHistorySource({
    accounts: gmailAccounts,
    getIdentity: getCustomerEmailIdentity,
    maxThreadsPerAccount: 50,
  });
  // M3(b): starred-email leg (gated, default off) — the founder's starred threads as review candidates.
  const starredReader = env.BACKFILL_STARRED_ENABLED
    ? buildGmailStarredSource({
        accounts: gmailAccounts,
        getIdentity: getCustomerEmailIdentity,
        maxThreadsPerAccount: env.BACKFILL_STARRED_MAX_THREADS,
      })
    : null;
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
    const [inbox, gmail, starred, wa] = await Promise.all([
      safeRead('inbox', inboxReader.readThreads(customerId)),
      safeRead('gmail', gmailReader.readThreads(customerId)),
      starredReader ? safeRead('gmail-starred', starredReader.readThreads(customerId)) : Promise.resolve([] as HistoricalThread[]),
      waReader ? safeRead('whatsapp', waReader.readThreads(customerId)) : Promise.resolve([] as HistoricalThread[]),
    ]);
    return [...inbox, ...gmail, ...starred, ...wa];
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
