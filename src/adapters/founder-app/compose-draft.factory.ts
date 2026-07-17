import { buildDraftEmailPresenter, type DraftEmailPresenterDeps } from '../../query/draft-email';
import type { ResolvedCustomerRef } from '../../query/commands';
import { env } from '../../config/env';
import { logger } from '../../logger';
import { query } from '../../db';
import { tryResolveCredential } from '../../config/credentials';
import type { FounderNotifierPort } from '../../ports/founder-notifier.port';
import type { KnowledgeRetriever } from '../../knowledge/retrieval';
import { buildKnowledgeRetriever } from '../../knowledge/retrieval';
import { memoryRepo } from '../../knowledge/memory-repo';
import { buildEmbeddingAdapter } from '../knowledge/openai-embeddings.client';
import { buildLlmRouter } from '../llm/factory';
import { renderCitations } from '../../triage/response-drafter';
import { loadCustomerConfig } from '../../triage/context-loader';
import { resolveScheduleRoute } from '../../scheduling/scheduling-repo';
import { enqueueDraft } from '../../outbound/outbound-repo';
import { recordFounderDraftDecision } from '../../decisions/decisions';

// COMPOSE-a-new-draft for the Founder PWA (Track C) — the app equal of Telegram's
// `/draft email <prompt>`. The Telegram surface COMPOSES a customer email, enqueues it
// is_draft=true, opens the audit decision, and presents an Approve/Edit/Reject card in the
// customer's topic; the PWA could review existing drafts but not COMPOSE a new one. This wires
// the EXACT same core presenter (src/query/draft-email.ts) — resolve route → compose → open
// decision → enqueue → present — but with the APP notifier as `deps.notifier`, so the resulting
// draft card lands in the app feed (SSE + FCM), mirroring how the console/PWA 🔁 Revise path
// re-presents a regenerated draft through the app notifier.
//
// The presenter's DraftEmailResult does not surface the enqueued queueId (the Telegram command
// only echoes a preview), so we wrap enqueueDraft in a per-call closure to capture it — a fresh
// wrap per call keeps concurrent composes from clobbering each other's id. Reuses the presenter
// and every core fn verbatim; adds NO new domain logic.

/** What the app compose endpoint hands in. `by` mirrors the edit/revise contract ('founder-app');
 *  the compose presenter records no actor today, so it is carried for symmetry, not consumed. */
export interface AppComposeDraftInput {
  customerId: string;
  prompt: string;
  by: string;
}

/** On success the draft was enqueued (is_draft=true), an audit decision opened, and the
 *  Approve/Edit/Reject card presented in the app feed — `queueId` is the agent_outbound_queue id
 *  the card's buttons key off. `ok:false` carries the presenter's refusal reason (e.g.
 *  `no_email_route` — the customer has no email contact/sending account, nothing composed/queued)
 *  or `unknown_customer` (a race after the router's existence check). */
export type AppComposeDraftResult = { ok: true; queueId: string } | { ok: false; reason: string };

export interface AppComposeDraftDeps extends DraftEmailPresenterDeps {
  /** Resolve the customer's ref (id + display name) — the presenter's compose + decision need the
   *  NAME (their language, the audit agent_output), and the app compose input carries only the id.
   *  null → unknown customer (the router already 404s this; this is the defensive race guard). */
  resolveCustomer: (customerId: string) => Promise<ResolvedCustomerRef | null>;
}

/**
 * Build the app compose-draft capability: `(input) => { ok:true, queueId } | { ok:false, reason }`.
 * Reuses buildDraftEmailPresenter (the SAME presenter `/draft email` uses) with the APP notifier
 * injected as `deps.notifier`, so a composed draft appears as a card in the app feed. Returns the
 * enqueued queueId, captured through a per-call enqueueDraft wrap the presenter does not surface.
 */
export function buildAppComposeDraft(
  deps: AppComposeDraftDeps,
): (input: AppComposeDraftInput) => Promise<AppComposeDraftResult> {
  return async (input: AppComposeDraftInput): Promise<AppComposeDraftResult> => {
    const customer = await deps.resolveCustomer(input.customerId);
    if (!customer) return { ok: false, reason: 'unknown_customer' };

    // Capture the queueId the presenter enqueues but does not return. A fresh presenter (hence a
    // fresh closure) per call keeps concurrent composes from sharing this variable.
    let queueId: string | null = null;
    const presenter = buildDraftEmailPresenter({
      ...deps,
      enqueueDraft: async (enqueueInput) => {
        const id = await deps.enqueueDraft(enqueueInput);
        queueId = id;
        return id;
      },
    });

    const result = await presenter({ prompt: input.prompt, customer });
    if (!result.ok) return { ok: false, reason: result.reason };
    // ok:true means the presenter enqueued + presented → the wrap captured the id.
    if (queueId === null) return { ok: false, reason: 'compose_failed' };
    return { ok: true, queueId };
  };
}

/** Resolve a customer's ref (id + display name) by id — the app compose input carries only the id,
 *  but the presenter's compose + audit decision need the NAME. Reverse-direction sibling of
 *  slash-commands' resolveThreadCustomer/findCustomerByName: a direct agent_customers read, no
 *  secret, never logs the argument. null → unknown customer (the router already 404s; this is the
 *  defensive race guard buildAppComposeDraft expects). */
async function resolveCustomerById(customerId: string): Promise<ResolvedCustomerRef | null> {
  const { rows } = await query<{ id: string; display_name: string }>(
    'SELECT id, display_name FROM agent_customers WHERE id = $1',
    [customerId],
  );
  const r = rows[0];
  return r ? { customerId: r.id, customerName: r.display_name } : null;
}

/**
 * Build the GATED app compose-draft capability — the `composeDraft` dep buildFounderAppRouter reads
 * (undefined when off → POST /api/drafts/compose answers 503). Self-builds its LLM router + embedding
 * + knowledge retriever exactly like buildDraftReviserService (a composition root may import
 * adapters); gated by KNOWLEDGE_DRAFT_ENABLED — the SAME flag `/draft email`'s presenter is gated by,
 * so app compose lights up with the Telegram command, not on its own.
 *
 * Wires the SAME core primitives `/draft email` inlines (resolveScheduleRoute → resolveEmailRoute,
 * loadCustomerConfig + retriever + llm.draftReply + renderCitations → compose, enqueueDraft,
 * recordFounderDraftDecision), but with the APP `notifier` — so a composed draft card lands in the
 * app feed (SSE + FCM) rather than a Telegram topic. Kept self-contained (not extracted from
 * slash-commands) to match buildDraftReviserService's established pattern and leave the tested
 * `/draft email` path untouched.
 */
export function buildAppComposeGated(
  notifier: Pick<FounderNotifierPort, 'notifyCustomerEvent' | 'notifyAdmin'>,
): ((input: AppComposeDraftInput) => Promise<AppComposeDraftResult>) | undefined {
  if (!env.KNOWLEDGE_DRAFT_ENABLED) {
    logger.info('app compose-draft NOT wired (KNOWLEDGE_DRAFT_ENABLED=false)');
    return undefined;
  }
  if (!tryResolveCredential('OPENAI_API_KEY')) {
    logger.warn('⚠️  KNOWLEDGE_DRAFT_ENABLED=true but OPENAI_API_KEY is UNSET — app compose degrades until it is set (route resolves, but composing the body fails).');
  }
  const llm = buildLlmRouter({
    notifyAdmin: (msg) => notifier.notifyAdmin({ title: 'LLM gateway', body: msg, severity: 'warning' }),
  });
  const embedding = buildEmbeddingAdapter(
    () => tryResolveCredential('OPENAI_API_KEY'),
    env.OPENAI_BASE_URL,
    { model: env.OPENAI_EMBEDDING_MODEL, dim: env.OPENAI_EMBEDDING_DIM },
  );
  // Grounded retrieval when enabled; otherwise a no-op retriever ([]) so a compose still produces a
  // (clearly ungrounded) draft — identical degrade to buildDraftReviserService.
  const retriever: KnowledgeRetriever = env.KNOWLEDGE_RETRIEVAL_ENABLED
    ? buildKnowledgeRetriever({
        embedding,
        search: memoryRepo.search.bind(memoryRepo),
        // WP4: hybrid (vector + FTS, RRF) only when flagged on — else vector-only, byte-identical.
        hybridSearch: env.HYBRID_RETRIEVAL_ENABLED ? memoryRepo.hybridSearch.bind(memoryRepo) : undefined,
        options: {
          kCustomer: env.KNOWLEDGE_RETRIEVAL_K_CUSTOMER,
          kShared: env.KNOWLEDGE_RETRIEVAL_K_SHARED,
          maxDistance: env.KNOWLEDGE_RETRIEVAL_MAX_DISTANCE,
        },
      })
    : { retrieve: async () => [] };
  if (!env.KNOWLEDGE_RETRIEVAL_ENABLED) {
    logger.warn('⚠️  KNOWLEDGE_DRAFT_ENABLED=true but KNOWLEDGE_RETRIEVAL_ENABLED=false — app compose drafts WITHOUT retrieved knowledge (ungrounded).');
  }
  logger.info('app compose-draft wired (KNOWLEDGE_DRAFT_ENABLED=true)');
  return buildAppComposeDraft({
    // The customer's email SEND route (reply-from account + primary contact). A NEW mail, so no reply
    // origin → resolveScheduleRoute falls to the primary 1:1 email route (the SAME `/draft email` uses).
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
    resolveCustomer: resolveCustomerById,
  });
}
