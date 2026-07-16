import { env } from '../../config/env';
import { logger } from '../../logger';
import { query } from '../../db';
import { tryResolveCredential } from '../../config/credentials';
import type { MessageEvent } from '../../ports/founder-notifier.port';
import type { TelegramNotifier } from '../telegram/telegram-notifier';
import {
  buildSlashCommandRouter,
  type BackfillStart,
  type CommitmentLine,
  type HistoryLegResult,
  type OpenTaskLine,
  type ResolvedCustomerRef,
} from '../../query/commands';
import { listAllOpenCommitments, listOpenCommitmentsForCustomer } from '../../commitments/commitment-repo';
import { fetchPendingDrafts, fetchPendingProposals } from './daily-briefing.worker';
import { loadCustomerConfig } from '../../triage/context-loader';
import { buildEzyPortalGateway } from '../ezy-portal';
import { memoryRepo } from '../../knowledge/memory-repo';
import { buildKnowledgeRetriever } from '../../knowledge/retrieval';
import { buildEmbeddingAdapter } from '../knowledge/openai-embeddings.client';
import { buildLlmRouter } from '../llm/factory';
import { renderCitations } from '../../triage/response-drafter';
import { buildDraftEmailPresenter } from '../../query/draft-email';
import { enqueueDraft } from '../../outbound/outbound-repo';
import { recordFounderDraftDecision } from '../../decisions/decisions';
import { resolveScheduleRoute } from '../../scheduling/scheduling-repo';
import { buildWaHistoryClient } from '../whatsapp-manager/factory';
import { runLiveSweep } from '../knowledge/backfill-run.factory';

// Composition for the Telegram founder slash-command surface (M5(c)). Wires the CORE router
// (src/query/commands.ts) to its concrete capabilities and the Telegram notifier's replyInThread.
// Gated by SLASH_COMMANDS_ENABLED → null when off, so a boot never surfaces the command surface by
// surprise. Importing core + sibling adapters here is boundary-legal (this factory is a composition
// root; the boundary rule only forbids core → adapters). Reuses DAILY_BRIEFING_TZ / _TOP_N so
// `/briefing` renders exactly like the daily digest.
//
// Per-command dependency gating (task 2.1): a capability that is OFF is passed as `undefined`, and
// the core command answers "unavailable" instead of throwing — an honest degrade, never a crash:
//   • /draft email → KNOWLEDGE_DRAFT_ENABLED (change 02's drafter)
//   • /backfill    → BACKFILL_ENABLED        (change 03's sweep)
//   • /history WhatsApp leg → WHATSAPP_MANAGER_BASE_URL configured
// SLASH_COMMANDS_ENABLED remains the master gate for the whole surface.

/** `/history` per-leg read caps — this is an INTERACTIVE command, not a sweep. */
const HISTORY_LIMIT = 10;
/** The WhatsApp archive has no server-side search, so a leg read drains pages and filters locally.
 *  Bound it hard: a founder typing /history must not trigger a 40k-message archive walk. */
const WA_PAGE_LIMIT = 200;
const WA_MAX_PAGES = 5;

/** Reverse of the notifier's customer→topic routing: the customer BOUND to this Telegram topic.
 *  `agent_customers.telegram_topic_id` is claimed per customer at onboarding (onboarding.ts
 *  claimTopic) and is what notifyCustomerEvent already routes by — so it is the authoritative
 *  topic→customer binding, read here in the direction the commands need. Null for a topic with no
 *  customer (the Admin topic). DB-only, no secret. */
async function resolveThreadCustomer(threadId: string): Promise<ResolvedCustomerRef | null> {
  const { rows } = await query<{ id: string; display_name: string }>(
    'SELECT id, display_name FROM agent_customers WHERE telegram_topic_id = $1',
    [threadId],
  );
  const r = rows[0];
  return r ? { customerId: r.id, customerName: r.display_name } : null;
}

/** Find a customer by display name (the explicit `/status acme` argument). Case-insensitive exact
 *  match first, then a unique prefix — a name that matches several customers resolves to none
 *  rather than guessing which one the founder meant. NEVER logs the argument. */
async function findCustomerByName(name: string): Promise<ResolvedCustomerRef | null> {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  const { rows } = await query<{ id: string; display_name: string }>(
    'SELECT id, display_name FROM agent_customers',
  );
  const exact = rows.filter((r) => r.display_name?.trim().toLowerCase() === needle);
  const hits = exact.length > 0 ? exact : rows.filter((r) => r.display_name?.trim().toLowerCase().startsWith(needle));
  if (hits.length !== 1) return null; // 0 = unknown, >1 = ambiguous — both are "I don't know"
  return { customerId: hits[0].id, customerName: hits[0].display_name };
}

/** `/status`: open tasks for a customer. The portal has NO customer filter on tasks (R46 —
 *  findOpenTasks THROWS on an unscoped query), so this goes through the customer's bound
 *  projectRef. null = no project bound (distinct from "no open tasks" — the core says so). */
async function listOpenTasks(customerId: string): Promise<OpenTaskLine[] | null> {
  const config = await loadCustomerConfig(customerId);
  if (!config?.projectRef) return null;
  // NOTE: findOpenTasks is page-1 (25) — plenty for a scannable /status reply.
  const tasks = await buildEzyPortalGateway().findOpenTasks({ projectRef: config.projectRef });
  return tasks.map((t) => ({ code: t.code ?? null, title: t.title, status: t.status }));
}

/** `/history` leg: agent_inbox keyword search. There is no inbox search repo fn (the inbox repo is
 *  a worker queue: claim/mark/load-by-thread), so this is the one new read the command needs —
 *  kept HERE in the adapter, next to the other composition-root reads, so core stays DB-free.
 *  Scoped to a customer when the topic is bound; unscoped in the Admin topic. */
async function searchInboxHistory(keyword: string, customerId: string | null): Promise<HistoryLegResult> {
  const { rows } = await query<{
    subject: string | null;
    body: string | null;
    sender_name: string | null;
    sender_address: string | null;
    received_at: Date;
  }>(
    `SELECT subject, body, sender_name, sender_address, received_at
       FROM agent_inbox
      WHERE ($1::uuid IS NULL OR customer_id = $1::uuid)
        AND (subject ILIKE $2 OR body ILIKE $2)
      ORDER BY received_at DESC
      LIMIT $3`,
    [customerId, `%${keyword}%`, HISTORY_LIMIT],
  );
  return {
    hits: rows.map((r) => ({
      at: r.received_at ? new Date(r.received_at) : null,
      who: r.sender_name ?? r.sender_address ?? null,
      snippet: [r.subject, r.body].filter((s): s is string => !!s).join(' — '),
    })),
    capped: rows.length === HISTORY_LIMIT,
  };
}

export function buildSlashCommandsHandler(
  notifier: Pick<TelegramNotifier, 'replyInThread' | 'replyInThreadWithButtons' | 'notifyCustomerEvent' | 'notifyAdmin'>,
): ((m: MessageEvent) => Promise<boolean>) | null {
  if (!env.SLASH_COMMANDS_ENABLED) {
    logger.info('slash commands NOT wired (SLASH_COMMANDS_ENABLED=false)');
    return null;
  }

  // Read-only query embed: no llm_costs row (matches the /ask engine + project-brain MCP).
  const embedding = buildEmbeddingAdapter(
    () => tryResolveCredential('OPENAI_API_KEY'),
    env.OPENAI_BASE_URL,
    { model: env.OPENAI_EMBEDDING_MODEL, dim: env.OPENAI_EMBEDDING_DIM, recordCost: async () => {} },
  );
  // ONE retriever, two uses: the /history memory leg and /draft email's grounding. Same scoped
  // cosine search the drafter/reviser use — additive-only (returns [] on any error, never throws).
  const retriever = buildKnowledgeRetriever({
    embedding,
    search: memoryRepo.search.bind(memoryRepo),
    // WP4: hybrid (vector + FTS, RRF) only when flagged on — else vector-only, byte-identical.
    hybridSearch: env.HYBRID_RETRIEVAL_ENABLED ? memoryRepo.hybridSearch.bind(memoryRepo) : undefined,
    options: {
      kCustomer: env.KNOWLEDGE_RETRIEVAL_K_CUSTOMER,
      kShared: env.KNOWLEDGE_RETRIEVAL_K_SHARED,
      maxDistance: env.KNOWLEDGE_RETRIEVAL_MAX_DISTANCE,
    },
  });

  /** `/history` leg: agent_memory. Semantic, not literal — memory has no keyword index, and the
   *  embedding search is what every other memory read uses. In the Admin topic (customerId null)
   *  scope isolation means this returns SHARED rows only, never a sweep across tenants. */
  const searchMemoryHistory = async (keyword: string, customerId: string | null): Promise<HistoryLegResult> => {
    const chunks = await retriever.retrieve(keyword, customerId);
    return {
      hits: chunks.slice(0, HISTORY_LIMIT).map((c) => ({
        at: null, // a memory chunk carries no event timestamp
        who: [c.title, c.section].filter((s): s is string => !!s).join(' › ') || null,
        snippet: c.content,
      })),
    };
  };

  // `/history` WhatsApp leg — only when whatsapp_manager is configured; otherwise the leg reports
  // "unavailable" and the other two still answer.
  const waConfigured = !!env.WHATSAPP_MANAGER_BASE_URL;
  const searchWhatsAppHistory = waConfigured
    ? async (keyword: string): Promise<HistoryLegResult> => {
        // whatsapp_manager's /messages has no `q` param — drain BOUNDED pages and filter locally.
        const client = buildWaHistoryClient({ pageLimit: WA_PAGE_LIMIT, maxPages: WA_MAX_PAGES });
        const { messages, capped } = await client.listAllMessages();
        const needle = keyword.toLowerCase();
        // Search the text a human would recognize: the message, its translation, and a voice
        // note's transcript (a voice-note-only chat has a null body — matching on body alone
        // would silently claim WhatsApp has no history of it).
        const textOf = (m: (typeof messages)[number]): string =>
          [m.body, m.translated_body, m.transcript].filter((s): s is string => !!s).join(' — ');
        const hits = messages
          .filter((m) => textOf(m).toLowerCase().includes(needle))
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .slice(0, HISTORY_LIMIT)
          .map((m) => ({
            at: m.timestamp ? new Date(m.timestamp) : null,
            who: m.sender_name ?? m.sender_number ?? m.chat_id ?? null,
            snippet: textOf(m),
          }));
        return { hits, capped };
      }
    : undefined;
  if (!waConfigured) {
    logger.info('slash /history: WhatsApp leg NOT wired (WHATSAPP_MANAGER_BASE_URL unset) — inbox + memory only');
  }

  // `/draft email` — REUSES change 02's drafter primitives: the LLM router's 'draft' role
  // (llm.draftReply, the same call the inbox drafter makes) + the drafter's own renderCitations
  // (indexes validated/clamped against OUR chunks → a hallucinated citation is impossible).
  // WP5(a): the composed reply now gets the STANDARD draft fate — enqueued is_draft=true to the
  // customer's email account (resolveScheduleRoute, the reply-from account the scheduling email
  // path uses), an audit decision opened, and an Approve/Edit/Reject card presented in the
  // customer's topic (routed by the same buildDraftDecisionHandler wired below under the same
  // KNOWLEDGE_DRAFT_ENABLED gate). NEVER auto-sent — the drainer skips is_draft=true. The
  // enqueue/decision/present orchestration lives in the CORE presenter (src/query/draft-email.ts);
  // this only wires the concrete route/compose/repo primitives.
  const draftEnabled = env.KNOWLEDGE_DRAFT_ENABLED;
  const llm = draftEnabled ? buildLlmRouter({
    notifyAdmin: (msg) => notifier.notifyAdmin({ title: 'LLM gateway', body: msg, severity: 'warning' }),
  }) : null;
  const draftEmail = llm
    ? buildDraftEmailPresenter({
        // The customer's email SEND route (reply-from account + primary email contact). A NEW mail,
        // so no reply origin → resolveScheduleRoute falls to the primary 1:1 email route.
        resolveEmailRoute: async (customerId) => {
          const route = await resolveScheduleRoute(customerId, ['email'], null);
          return route
            ? {
                channelInstanceId: route.channelInstanceId,
                channelType: route.channelType,
                recipientAddress: route.recipientAddress,
                recipientLabel: route.recipientLabel,
              }
            : null;
        },
        compose: async ({ prompt, customer }) => {
          const config = await loadCustomerConfig(customer.customerId);
          const language = config?.preferredLanguage ?? 'en';
          const knowledge = await retriever.retrieve(prompt, customer.customerId);
          const result = await llm.draftReply({
            question: prompt,
            language,
            customerName: customer.customerName,
            knowledge,
          });
          return {
            body: result.body,
            // No knowledge → no citations (renderCitations' fallback would otherwise cite nothing).
            citations: knowledge.length > 0 ? renderCitations(knowledge, result.usedSourceIndexes) : [],
            grounded: knowledge.length > 0,
            language,
          };
        },
        enqueueDraft,
        recordDraftDecision: recordFounderDraftDecision,
        notifier,
        log: logger,
      })
    : undefined;
  if (!draftEnabled) logger.info('slash /draft email NOT wired (KNOWLEDGE_DRAFT_ENABLED=false)');

  // `/backfill` — re-runs the change-03 sweep through the SAME live composition as
  // `npm run backfill:run` (src/adapters/knowledge/backfill-run.factory.ts).
  //
  // FIRE-AND-FORGET on purpose: a sweep takes minutes (LLM + embeddings per thread) and the
  // Telegram poll loop AWAITS this handler — blocking here would freeze the entire founder surface
  // for the duration. So we ack immediately and post the report when it lands.
  //
  // Single-flight per customer (in-process): a second /backfill while one runs answers
  // 'already-running' rather than starting a duplicate sweep over the same threads. The sweep is
  // idempotent anyway (app_state thread markers + proposal dedup by thread_key), so this is about
  // not burning tokens twice, and it mirrors how the WA history client treats a 409.
  const backfillEnabled = env.BACKFILL_ENABLED;
  const running = new Set<string>();
  const startBackfill = backfillEnabled
    ? async (customerId: string, threadId: string): Promise<BackfillStart> => {
        if (running.has(customerId)) return 'already-running';
        running.add(customerId);
        void (async () => {
          try {
            const { report, cardsPosted } = await runLiveSweep(customerId, notifier);
            logger.info(
              {
                command: 'backfill',
                customerId,
                threads: report.threads,
                memories: report.memories,
                proposed: report.proposed,
                cardsPosted,
                retryable: report.retryable,
              },
              'slash: backfill sweep complete',
            );
            const lines = [
              '✅ Backfill complete',
              `  threads: ${report.threads} · memories: ${report.memories}`,
              `  linked: ${report.linkedOpen} open, ${report.linkedResolved} resolved`,
              `  proposals: ${report.proposed} (${cardsPosted} card${cardsPosted === 1 ? '' : 's'} posted)`,
            ];
            // A non-zero retryable is the counter this sweep exists to surface — never stay silent.
            if (report.retryable > 0) {
              lines.push(`  ⚠️ ${report.retryable} thread(s) didn't land (embedder) — re-run /backfill to pick them up.`);
            }
            await notifier.replyInThread(threadId, lines.join('\n'));
          } catch (err) {
            const reason = (err as Error)?.message ?? 'unknown';
            logger.error({ command: 'backfill', customerId, reason }, 'slash: backfill sweep failed');
            await notifier
              .replyInThread(threadId, `⚠️ Backfill failed: ${reason}\nAlready-processed threads are marked, so /backfill resumes where it stopped.`)
              .catch(() => {}); // the sweep already failed; a notify failure must not go unhandled
          } finally {
            running.delete(customerId);
          }
        })();
        return 'started';
      }
    : undefined;
  if (!backfillEnabled) logger.info('slash /backfill NOT wired (BACKFILL_ENABLED=false)');

  // `/commitments` — open promises the founder made, with ✔ done / ✖ dismiss per item. Gated by
  // COMMITMENT_TRACKING_ENABLED (the extraction worker fills the ledger); off → the command reports
  // it is unavailable. A scoped customerId lists that customer; null (Admin, no arg) lists all.
  const commitmentsEnabled = env.COMMITMENT_TRACKING_ENABLED;
  const listOpenCommitments = commitmentsEnabled
    ? async (customerId: string | null): Promise<CommitmentLine[]> => {
        const rows = customerId
          ? (await listOpenCommitmentsForCustomer(customerId)).map((c) => ({ ...c, customerName: null }))
          : await listAllOpenCommitments();
        return rows.map((c) => ({
          id: c.id,
          customerName: 'customerName' in c ? c.customerName : null,
          text: c.text,
          dueAt: c.dueAt,
          duePrecision: c.duePrecision,
          createdAt: c.createdAt,
        }));
      }
    : undefined;
  const postCommitmentCard = commitmentsEnabled
    ? (threadId: string, text: string, buttons: Array<{ id: string; label: string }>) =>
        notifier.replyInThreadWithButtons(threadId, text, buttons)
    : undefined;
  if (!commitmentsEnabled) logger.info('slash /commitments NOT wired (COMMITMENT_TRACKING_ENABLED=false)');

  logger.info('slash commands wired (SLASH_COMMANDS_ENABLED=true)');
  return buildSlashCommandRouter({
    fetchPendingDrafts,
    fetchPendingProposals,
    postAnswer: (threadId, text) => notifier.replyInThread(threadId, text),
    now: () => new Date(),
    tz: env.DAILY_BRIEFING_TZ,
    topN: env.DAILY_BRIEFING_TOP_N,
    log: logger,
    resolveThreadCustomer,
    findCustomerByName,
    listOpenTasks,
    searchInboxHistory,
    searchMemoryHistory,
    searchWhatsAppHistory,
    draftEmail,
    startBackfill,
    listOpenCommitments,
    postCommitmentCard,
  });
}
