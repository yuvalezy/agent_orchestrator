import { env } from '../../config/env';
import { logger } from '../../logger';
import { tryResolveCredential } from '../../config/credentials';
import { buildLlmRouter } from '../llm/factory';
import { buildEmbeddingAdapter } from './openai-embeddings.client';
import { memoryRepo } from '../../knowledge/memory-repo';
import { buildInboxHistorySource } from '../../knowledge/inbox-history-source';
import { buildGmailHistorySource } from '../email/gmail-history-source';
import { GmailClient } from '../email/gmail-client';
import { listGmailAccounts } from '../channel/channel-accounts-repo';
import { getCustomerEmailIdentity } from '../../customers/email-identity';
import { buildWhatsAppDirectoryClient, buildWaHistoryClient } from '../whatsapp-manager/factory';
import { buildWaHistorySource } from '../whatsapp-manager/wa-history-source';
import { getCustomerDirectoryInfo } from '../../customers/customer-directory';
import { buildProposalCollapser } from './backfill-collapse.factory';
import {
  reconcileThread,
  dropCoveredThreads,
  type HistoricalThread,
  type BackfillOrchestratorDeps,
} from '../../knowledge/backfill';
import { getPendingBackfillProposals } from '../../decisions/decisions';

// Shared backfill composition root (ADAPTER): wires the three history legs (agent_inbox + Gmail +
// WhatsApp), the reconcile-against-task-inventory closure, and the sweep-wide proposal collapser.
// Callers add only their own sinks (dry = no-ops, live = write).
//
// ⚠︎ This used to live in scripts/lib-backfill.ts. It moved here because `tsconfig` sets
// `rootDir: src` / `include: src/**/*.ts` — scripts/ is NOT part of the compiled app, so nothing
// under src/ can import it. The M5(c) `/backfill` slash command needs this EXACT composition, and
// duplicating it in src/ would have meant two copies of the leg wiring drifting apart (the dry
// sweep, the live sweep, onboarding and /backfill must all sweep identically or the report a
// founder reviews stops describing the run they get). scripts/lib-backfill.ts now re-exports this,
// so every caller still shares ONE composition.

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
