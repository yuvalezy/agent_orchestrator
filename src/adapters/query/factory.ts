import { env } from '../../config/env';
import { logger } from '../../logger';
import { query } from '../../db';
import { tryResolveCredential } from '../../config/credentials';
import { memoryRepo } from '../../knowledge/memory-repo';
import { internalKnowledgeRepo } from '../../knowledge/internal-repo';
import { buildInternalKnowledgeSearch } from '../../knowledge/internal-search';
import { buildScopeResolver, type QueryScope, type ResolvedCustomer } from '../../query/scope';
import { buildQueryService, type QueryCitation, type QueryService } from '../../query/query-service';
import { buildAgenticQueryService } from '../../query/agentic-query-service';
import { buildConversationalQueryService, type ConversationalQueryService } from '../../query/conversational-query-service';
import { buildAgenticToolset, type AgenticToolDeps, type AgenticToolSource } from '../../query/agentic-tools';
import { buildEmbeddingAdapter } from '../knowledge/openai-embeddings.client';
import { buildLlmRouter } from '../llm/factory';
import { buildEzyPortalGateway } from '../ezy-portal';
import { buildCalendarAdapter } from '../calendar/factory';
import { loadCustomerConfig } from '../../triage/context-loader';
import { fetchPendingDrafts, fetchPendingProposals } from './daily-briefing.worker';
import { fetchAwaitingReply } from './briefing-repo';
import { listAllOpenCommitments, listOpenCommitmentsForCustomer } from '../../commitments/commitment-repo';
import { getCustomerBrief } from '../../knowledge/customer-brief-repo';

// Composition root for the M5(a) founder query engine (imports adapters + core; the
// D1 boundary only forbids core → adapters, and this is a wiring module). Assembles:
//   • the embedding adapter (query-time; a NO-OP cost sink — read-only query embeds
//     aren't billed, matching the project-brain MCP convention for the same corpus),
//   • the MI internal search (buildInternalKnowledgeSearch → internal_knowledge),
//   • a customer retriever (embed + memoryRepo.search → agent_memory, EXACT-scoped),
//   • the scope resolver (findCustomer over agent_customers by display name),
//   • the LLM router's synthesizeAnswer (role 'answer').
//
// ⚠︎ ISOLATION: internal + customer retrieval are DISTINCT deps over structurally-
// separate tables (internal-repo.ts / memory-repo.ts). The customer retriever forwards
// the EXACT resolved customerId to memoryRepo.search (never null) — same isolation the
// triage retriever relies on. This surface is founder-only and additive; the customer-
// DRAFTING path (src/knowledge/retrieval.ts) is untouched and still can't reach internal.

/** Snippet cap for citations shown to the founder (matches the MCP search snippet). */
const SNIPPET_CHARS = 900;

/** Max customers fanned out for one cross-customer (Admin topic) query. The fan-out is N
 *  indexed vector searches sharing ONE embedding, but N grows with the book of business
 *  and the founder is waiting on a reply, so it is bounded.
 *
 *  Past this cap only the first N customers (by name) are covered. On the AGENTIC founder-chat
 *  path the truncation is now surfaced to the founder as a `Coverage` source (`fanoutCoverageNote`
 *  below), so a partial answer never reads as complete. The single-shot /ask path still only LOGS
 *  the skip (`skipped` below) — harmless while the book is well under the cap; when it approaches
 *  25 the single-shot reply also needs the note (a flag on QueryResult → formatAnswer). */
const MAX_CROSS_CUSTOMER_FANOUT = 25;

/** Founder-visible note prepended to a cross-customer TOOL result when the fan-out was bounded
 *  below the book size — turns a silently-partial aggregate into an explicitly-partial one, with
 *  the way to get the rest (name a customer). Null when the whole book fit. */
function fanoutCoverageNote(total: number): AgenticToolSource | null {
  if (total <= MAX_CROSS_CUSTOMER_FANOUT) return null;
  return {
    label: 'Coverage',
    content: `Partial: this searched ${MAX_CROSS_CUSTOMER_FANOUT} of ${total} customers (bounded fan-out). Name a specific customer to cover the rest.`,
  };
}

/** Citations kept from a cross-customer merge, ranked by distance. Roughly the per-scope
 *  budget — the synthesis prompt has a finite context and the founder a finite screen. */
const CROSS_CUSTOMER_K = 12;

/** Truncate a chunk to a snippet (with an ellipsis) — shorter chunks pass through. */
function snippet(content: string): string {
  return content.length > SNIPPET_CHARS ? `${content.slice(0, SNIPPET_CHARS)}…` : content;
}

/** Best-effort: find a customer whose display_name appears in the question. Picks the
 *  LONGEST matching name (most specific) to avoid a short name shadowing a longer one.
 *  DB-only, no secret. NEVER logs the question. Only exercised for the broader query
 *  path (forceInternal=false); the /ask headline forces internal and never calls this. */
async function findCustomerByName(question: string): Promise<ResolvedCustomer | null> {
  const haystack = question.toLowerCase();
  const { rows } = await query<{ id: string; display_name: string }>(
    'SELECT id, display_name FROM agent_customers',
  );
  let best: ResolvedCustomer | null = null;
  let bestLen = 0;
  for (const r of rows) {
    const name = r.display_name?.trim();
    if (name && name.length > bestLen && haystack.includes(name.toLowerCase())) {
      best = { customerId: r.id, customerName: name };
      bestLen = name.length;
    }
  }
  return best;
}

/** Every customer, for the Admin topic's cross-customer fan-out. Ordered by name so the
 *  fan-out cap (and any truncation) is STABLE across queries rather than picking a
 *  different arbitrary subset each time. */
async function listCustomers(): Promise<Array<{ customerId: string; customerName: string }>> {
  const { rows } = await query<{ id: string; display_name: string | null }>(
    'SELECT id, display_name FROM agent_customers ORDER BY display_name ASC, id ASC',
  );
  return rows.map((r) => ({ customerId: r.id, customerName: r.display_name?.trim() || r.id }));
}

/**
 * Build the founder QueryService, or return null when disabled / no embedding key.
 * Gated by QUERY_ENGINE_ENABLED (mirrors OUTBOUND_ENABLED). WARNs but still wires when
 * the key is unset (it resolves lazily; a query then surfaces the failure — founder
 * tool). `notifyAdmin` feeds the LLM router's failover/cap notices.
 */
export function buildQueryEngineService(notifyAdmin: (msg: string) => Promise<void>): ConversationalQueryService | null {
  if (!env.QUERY_ENGINE_ENABLED) {
    logger.info('founder query engine NOT wired (QUERY_ENGINE_ENABLED=false) — /ask is dormant');
    return null;
  }
  if (!tryResolveCredential('OPENAI_API_KEY')) {
    logger.warn('⚠️  QUERY_ENGINE_ENABLED=true but OPENAI_API_KEY is UNSET — /ask embeds fail until it is set (the query reports the error).');
  }

  // Read-only query embed: no llm_costs row per query (matches project-brain MCP).
  const embedding = buildEmbeddingAdapter(() => tryResolveCredential('OPENAI_API_KEY'), env.OPENAI_BASE_URL, {
    model: env.OPENAI_EMBEDDING_MODEL,
    dim: env.OPENAI_EMBEDDING_DIM,
    recordCost: async () => {},
  });

  const internalSearch = buildInternalKnowledgeSearch({
    embedding,
    search: internalKnowledgeRepo.search.bind(internalKnowledgeRepo),
    maxDistance: env.KNOWLEDGE_INTERNAL_MAX_DISTANCE,
    defaultK: env.KNOWLEDGE_INTERNAL_K,
    snippetChars: SNIPPET_CHARS,
  });

  const synth = buildLlmRouter({ notifyAdmin });

  const memoryOpts = {
    kCustomer: env.KNOWLEDGE_RETRIEVAL_K_CUSTOMER,
    kShared: env.KNOWLEDGE_RETRIEVAL_K_SHARED,
    maxDistance: env.KNOWLEDGE_RETRIEVAL_MAX_DISTANCE,
  };

  /** Embed the question once. null = nothing to search on (blank, or an embed that
   *  returned no vector) — distinct from "searched and found nothing". */
  const embedQuestion = async (question: string): Promise<number[] | null> => {
    const text = question.trim();
    if (!text) return null;
    const [vec] = await embedding.embed([text]);
    return vec && vec.length > 0 ? vec : null;
  };

  /** ONE agent_memory search. `customerId` is passed THROUGH to memoryRepo.search
   *  verbatim: an EXACT id returns that customer's rows + shared rows; null returns
   *  SHARED rows only. Both the single-customer scope and every leg of the
   *  cross-customer fan-out go through here — there is no second, looser search. */
  const searchMemory = async (
    vec: number[],
    customerId: string | null,
  ): Promise<Array<{ content: string; label: string; distance: number }>> => {
    const results = await memoryRepo.search(vec, customerId, memoryOpts);
    return results.map((r) => {
      const md = (r.metadata ?? {}) as Record<string, unknown>;
      const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
      const label = [str(md.title), str(md.section)].filter((s): s is string => !!s).join(' › ') || r.memoryType;
      return { content: r.content, label, distance: r.distance };
    });
  };

  const scopeResolver = buildScopeResolver({ findCustomer: findCustomerByName });

  // ── Cross-customer fan-out (Admin topic, task 1.2/5.2) ────────────────────────────────
  // Hoisted to a const (WP8 reuses it for the cross-customer search_memory tool). A FAN-OUT of
  // the exact-id search — one embedding, N isolated searches, merged and ranked by distance. Not
  // a widened query: every leg still names ONE customer, so this cannot return a row that
  // customer's own scope wouldn't. SHARED ROWS ARE THE SUBTLETY: memoryRepo.search returns a
  // customer's rows PLUS the shared ones (customer_id IS NULL), so a naive merge would return each
  // shared chunk once PER customer. So the shared leg is fetched ONCE (customerId null → shared
  // only) and subtracted from every customer leg by content; a customer row byte-identical to a
  // shared row is attributed to the shared corpus.
  const retrieveAllCustomers = async (question: string): Promise<{ citations: QueryCitation[]; totalCustomers: number }> => {
    const vec = await embedQuestion(question);
    if (!vec) return { citations: [], totalCustomers: 0 };

    const [shared, customers] = await Promise.all([searchMemory(vec, null), listCustomers()]);
    const sharedContent = new Set(shared.map((h) => h.content));

    const fanned = customers.slice(0, MAX_CROSS_CUSTOMER_FANOUT);
    const perCustomer = await Promise.all(
      fanned.map(async (c) => {
        const hits = await searchMemory(vec, c.customerId); // EXACT id — isolation holds
        return hits
          .filter((h) => !sharedContent.has(h.content))
          // Attribution is not decoration here: an aggregate the founder can't trace back to a
          // customer isn't actionable.
          .map((h) => ({ label: `${c.customerName} › ${h.label}`, snippet: snippet(h.content), distance: h.distance }));
      }),
    );

    const merged = [
      ...shared.map((h) => ({ label: `Shared › ${h.label}`, snippet: snippet(h.content), distance: h.distance })),
      ...perCustomer.flat(),
    ]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, CROSS_CUSTOMER_K);

    // Counts + flags ONLY — never the question, never a snippet.
    logger.info(
      { customers: fanned.length, skipped: customers.length - fanned.length, cited: merged.length },
      'query: cross-customer fan-out',
    );
    return { citations: merged, totalCustomers: customers.length };
  };

  const service = buildQueryService({
    scopeResolver,

    // Internal corpus → InternalKnowledgeCitation → QueryCitation.
    retrieveInternal: async (question: string): Promise<QueryCitation[]> => {
      const hits = await internalSearch.search(question);
      return hits.map((h) => ({
        label: [h.repo, h.path, h.section].filter((s): s is string => !!s).join(' › '),
        snippet: h.snippet,
        distance: h.distance,
      }));
    },

    // Customer corpus → embed + memoryRepo.search (EXACT customerId + shared rows).
    retrieveCustomer: async (question: string, customerId: string): Promise<QueryCitation[]> => {
      const vec = await embedQuestion(question);
      if (!vec) return [];
      const hits = await searchMemory(vec, customerId);
      return hits.map((h) => ({ label: h.label, snippet: snippet(h.content), distance: h.distance }));
    },

    retrieveAllCustomers,

    synth,
  });

  // WP8: when the agentic loop is off, the single-shot engine above IS the query engine (byte-
  // identical to before this feature). When on, DECORATE it — the loop tries first and falls back
  // to `service` on unavailable/failure — so the single-shot path stays the default and fallback.
  let baseService: QueryService = service;
  if (!env.QUERY_AGENTIC_ENABLED) {
    logger.info('founder query engine wired (QUERY_ENGINE_ENABLED=true) — single-shot /ask + free-text');
  } else {
    const toolDeps = buildAgenticToolDeps({ embedQuestion, retrieveAllCustomers, internalSearch, findCustomerByName });
    baseService = buildAgenticQueryService({
      scopeResolver,
      buildToolset: (scope: QueryScope) => buildAgenticToolset(toolDeps, scope),
      agentic: synth,
      inner: service,
      log: logger,
    });
    logger.info('founder query engine wired + AGENTIC loop (QUERY_AGENTIC_ENABLED=true) — read-only tool loop, single-shot fallback');
  }

  // answer() stays stateless for Telegram/console. Founder PWA chat opts into the
  // richer answerTurn() surface, which resolves follow-ups before either base engine.
  return buildConversationalQueryService({ inner: baseService, contextualizer: synth, log: logger });
}

// ── WP8: the concrete read-only tool deps (adapter reads) the CORE toolset is assembled from ──────
// Each is a bounded read that returns numbered sources; the CORE (agentic-tools.ts) owns the scope
// pinning that decides WHICH customer id to pass. A missing capability (calendar off) is passed as
// null → the tool reports 'unavailable'. NEVER logs content.

/** Founder-private conversation snippet cap (chars) — same private surface as a draft card. */
const CONVERSATION_SNIPPET_CHARS = 160;
const DAY_MS = 24 * 60 * 60 * 1000;

interface AgenticToolDepsInput {
  embedQuestion: (q: string) => Promise<number[] | null>;
  retrieveAllCustomers: (question: string) => Promise<{ citations: QueryCitation[]; totalCustomers: number }>;
  internalSearch: { search: (q: string, k?: number) => Promise<Array<{ repo: string; path: string; section: string | null; snippet: string }>> };
  findCustomerByName: (question: string) => Promise<ResolvedCustomer | null>;
}

function buildAgenticToolDeps(input: AgenticToolDepsInput): AgenticToolDeps {
  const taskTarget = buildEzyPortalGateway();
  const calendar = env.CALENDAR_ENABLED ? buildCalendarAdapter() : null;

  const memoryLabel = (metadata: Record<string, unknown> | null, memoryType: string): string => {
    const md = (metadata ?? {}) as Record<string, unknown>;
    const s = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
    return [s(md.title), s(md.section)].filter((x): x is string => !!x).join(' › ') || memoryType;
  };

  /** One customer's open portal tasks via its bound projectRef (R46: findOpenTasks needs a
   *  projectRef; customerRef is not a portal filter). Empty when no project is bound. */
  const openTasksForCustomer = async (customerId: string): Promise<AgenticToolSource[]> => {
    const config = await loadCustomerConfig(customerId);
    if (!config?.projectRef) return [];
    const tasks = await taskTarget.findOpenTasks({ projectRef: config.projectRef });
    return tasks.map((t) => ({
      label: `${t.code ?? t.ref}: ${t.title}`,
      content: `${t.title} — status: ${t.status}${t.priority ? `, priority: ${t.priority}` : ''}`,
    }));
  };

  /** The raw portal contact rows for a customer via its bound bpRef (empty when none). Shared by the
   *  list_contacts tool and the customer-scoped upcoming_meetings filter (contact emails → matchEmails). */
  const contactRowsForCustomer = async (customerId: string) => {
    const config = await loadCustomerConfig(customerId);
    if (!config?.bpRef) return [];
    return taskTarget.listContacts(config.bpRef);
  };

  /** Lower-cased contact emails for a customer (deduped), used to match this customer's calendar events. */
  const contactEmailsForCustomer = async (customerId: string): Promise<string[]> => {
    const rows = await contactRowsForCustomer(customerId);
    const emails = rows.map((c) => c.email).filter((e): e is string => !!e).map((e) => e.trim().toLowerCase());
    return Array.from(new Set(emails));
  };

  return {
    // customer + shared memory search, k-aware (hybrid when HYBRID_RETRIEVAL_ENABLED — WP4).
    searchCustomerMemory: async (queryText, k, customerId) => {
      const vec = await input.embedQuestion(queryText);
      if (!vec) return [];
      const opts = { kCustomer: k, kShared: Math.max(1, Math.ceil(k / 2)), maxDistance: env.KNOWLEDGE_RETRIEVAL_MAX_DISTANCE };
      const results = env.HYBRID_RETRIEVAL_ENABLED
        ? await memoryRepo.hybridSearch(vec, queryText, customerId, opts)
        : await memoryRepo.search(vec, customerId, opts);
      return results.map((r) => ({ label: memoryLabel(r.metadata, r.memoryType), content: snippet(r.content) }));
    },
    // cross-customer fan-out (reuses the single-shot Admin-topic retriever). Surfaces partial
    // coverage to the founder when the book exceeds the fan-out cap (a silently-truncated
    // aggregate is the exact lie this tool must not tell).
    searchAllMemory: async (queryText) => {
      const { citations, totalCustomers } = await input.retrieveAllCustomers(queryText);
      const sources = citations.map((h) => ({ label: h.label, content: h.snippet }));
      const note = fanoutCoverageNote(totalCustomers);
      return note ? [note, ...sources] : sources;
    },
    // internal Project-Brain corpus (structurally separate from customer data).
    searchInternalKnowledge: async (queryText, k) => {
      const hits = await input.internalSearch.search(queryText, k);
      return hits.map((h) => ({
        label: [h.repo, h.path, h.section].filter((s): s is string => !!s).join(' › '),
        content: h.snippet,
      }));
    },
    listOpenTasks: async (customerId) => {
      if (customerId) return openTasksForCustomer(customerId);
      // Cross-customer: a BOUNDED fan-out over onboarded customers (a founder tool, so bounded).
      const all = await listCustomers();
      const customers = all.slice(0, MAX_CROSS_CUSTOMER_FANOUT);
      const per = await Promise.all(
        customers.map(async (c) =>
          (await openTasksForCustomer(c.customerId)).map((s) => ({ label: `${c.customerName} › ${s.label}`, content: s.content })),
        ),
      );
      const sources = per.flat();
      const note = fanoutCoverageNote(all.length);
      return note ? [note, ...sources] : sources;
    },
    recentConversation: async (customerId, limit) => {
      const { rows } = await query<{ direction: string; subject: string | null; body: string | null; received_at: Date }>(
        `SELECT direction, subject, body, received_at
           FROM agent_inbox
          WHERE customer_id = $1
          ORDER BY received_at DESC
          LIMIT $2`,
        [customerId, limit],
      );
      return rows.map((r) => {
        const text = [r.subject, r.body].filter((s): s is string => !!s).join(' — ').replace(/\s+/g, ' ').trim();
        const capped = text.length > CONVERSATION_SNIPPET_CHARS ? `${text.slice(0, CONVERSATION_SNIPPET_CHARS - 1).trimEnd()}…` : text;
        const who = r.direction === 'outbound' ? 'You' : 'Customer';
        return { label: `${who} · ${new Date(r.received_at).toISOString().slice(0, 10)}`, content: capped || '(no text)' };
      });
    },
    pendingApprovals: async () => {
      const [drafts, proposals] = await Promise.all([fetchPendingDrafts(), fetchPendingProposals()]);
      const src: AgenticToolSource[] = [];
      for (const d of drafts) {
        src.push({
          label: `Pending draft reply${d.customerName ? ` · ${d.customerName}` : ''}`,
          content: `Draft reply awaiting approval${d.customerName ? ` for ${d.customerName}` : ''} (since ${d.createdAt.toISOString().slice(0, 10)})`,
        });
      }
      for (const p of proposals) {
        src.push({
          label: `Pending task proposal${p.customerName ? ` · ${p.customerName}` : ''}`,
          content: `Backfill task proposal awaiting approval${p.customerName ? ` for ${p.customerName}` : ''} (since ${p.createdAt.toISOString().slice(0, 10)})`,
        });
      }
      return src;
    },
    awaitingReply: async () => {
      const rows = await fetchAwaitingReply(new Date());
      const now = Date.now();
      return rows.map((r) => {
        const days = Math.max(0, Math.floor((now - r.lastOutboundAt.getTime()) / DAY_MS));
        return {
          label: `Awaiting reply${r.customerName ? ` · ${r.customerName}` : ''}`,
          content: `${r.customerName ?? 'A customer'} has not replied for ${days} day(s)${r.taskTitle ? ` on: ${r.taskTitle}` : ''}`,
        };
      });
    },
    openCommitments: async (customerId) => {
      const rows = customerId ? await listOpenCommitmentsForCustomer(customerId) : await listAllOpenCommitments();
      return rows.map((c) => {
        const customerName = 'customerName' in c ? c.customerName : null;
        return {
          label: `Commitment${customerName ? ` · ${customerName}` : ''}`,
          content: `${c.text}${c.dueAt ? ` (due ${c.dueAt.toISOString().slice(0, 10)})` : ''}`,
        };
      });
    },
    upcomingMeetings: calendar
      ? async (days, customerId) => {
          // Customer scope: match this customer's contact emails and surface ONLY matched events; a
          // customer with no email on file yields no matches (we cannot attribute a meeting to them).
          // Founder-global (null): every upcoming event.
          const matchEmails = customerId ? await contactEmailsForCustomer(customerId) : [];
          const events = await calendar.listUpcomingEvents({ lookaheadDays: days, matchEmails, maxEvents: 20 });
          const relevant = customerId ? events.filter((e) => e.matchedCustomer) : events;
          return relevant.map((e) => ({
            label: `Meeting · ${new Date(e.startsAt).toISOString().slice(0, 16).replace('T', ' ')}`,
            content: `${e.title}${e.allDay ? ' (all day)' : ''}`,
          }));
        }
      : null,
    customerBrief: async (customerId) => {
      const brief = await getCustomerBrief(customerId);
      return brief ? [{ label: 'Relationship brief', content: brief }] : [];
    },
    listContacts: async (customerId) => {
      const rows = await contactRowsForCustomer(customerId);
      return rows.map((c) => ({
        label: `${c.name}${c.isPrimary ? ' (primary contact)' : ''}`,
        content:
          [
            c.email ? `email: ${c.email}` : null,
            c.phone ? `phone: ${c.phone}` : null,
            c.whatsapp ? `whatsapp: ${c.whatsapp}` : null,
            c.telegram ? `telegram: ${c.telegram}` : null,
          ]
            .filter((x): x is string => !!x)
            .join(' · ') || '(no contact channels on file)',
      }));
    },
    listCustomers: async () => (await listCustomers()).map((c) => ({ label: c.customerName, content: c.customerName })),
    resolveCustomer: async (name) => input.findCustomerByName(name),
  };
}
