import type { AgentLlmPort, DraftRequest, DraftResult, Intent, KnowledgeChunk } from '../ports/llm.port';
import type { FounderNotifierPort, Notification } from '../ports/founder-notifier.port';
import type { ClaimedInbox } from '../inbox/inbox-repo';
import type { CustomerConfig } from './context-loader';
import type { enqueueDraft, findOpenDraftByInbox, OpenDraftForInbox } from '../outbound/outbound-repo';
import type { recordDraftDecision } from '../decisions/decisions';
import { logger } from '../logger';
import { draftButtons } from './draft-review';

// Response drafter (change 02 sub-milestone c, CORE — injected ports + core repo fns
// only, imports NO adapter, D1). For an ANSWERABLE 'question_existing' intent:
// draft a cited reply in the customer's language (LLM 'draft' role), enqueue it as a
// DRAFT (is_draft=true → NEVER auto-sent), record the audit decision, and present it
// in the customer's Telegram topic with citations + Approve/Edit/Reject controls.
// NO draft is ever delivered without founder action.
//
// Reclaim idempotency (blueprint must-fix #1): a prior attempt that failed AT/AFTER
// the notify is reclaimed by the inbox worker. draftAndPresent (and the R49-analog
// reconfirmOpenDraft) FIRST look up an existing OPEN draft for this inbox message and
// re-present it instead of minting a second customer-facing draft. Never logs the
// draft body or the customer message — ids/counts/status only.

export interface ResponseDrafterDeps {
  llm: Pick<AgentLlmPort, 'draftReply'>;
  notifier: Pick<FounderNotifierPort, 'notifyCustomerEvent'>;
  enqueueDraft: typeof enqueueDraft;
  recordDraftDecision: typeof recordDraftDecision;
  findOpenDraftByInbox: typeof findOpenDraftByInbox;
}

export interface DraftAndPresentInput {
  row: ClaimedInbox;
  customerId: string;
  config: Pick<CustomerConfig, 'displayName' | 'preferredLanguage'>;
  threadKey: string;
  /** Non-empty — the caller gates on knowledge.length > 0. */
  knowledge: KnowledgeChunk[];
  intent: Intent;
}

export interface ResponseDrafter {
  /**
   * Draft → enqueue (is_draft=true) → record decision → present with citations +
   * Approve/Edit/Reject buttons. Idempotent under reclaim: re-presents an existing
   * open draft for `input.row.id` instead of re-drafting.
   */
  draftAndPresent(input: DraftAndPresentInput): Promise<void>;
  /**
   * R49-analog reclaim guard (called from tryR49Reconfirm BEFORE the LLM re-extract):
   * if this inbox message already has an OPEN draft, re-present it and return true;
   * else false. Keeps a reclaimed answerable question from minting a second draft.
   */
  reconfirmOpenDraft(inboxMessageId: string): Promise<boolean>;
}

export function buildResponseDrafter(deps: ResponseDrafterDeps): ResponseDrafter {
  /** Present (or re-present) an open draft in the customer's topic with citations +
   *  Approve/Edit/Reject controls. Body is never logged. */
  async function present(
    customerId: string,
    queueId: string,
    body: string,
    citations: string[],
    language: string,
  ): Promise<void> {
    await deps.notifier.notifyCustomerEvent(
      customerId,
      buildPresentation(body, citations, language),
      draftButtons(queueId),
    );
  }

  /** Re-present an existing OPEN draft (reclaim idempotency, must-fix #1) — reuses the
   *  linked decision's stored citations/language so we NEVER re-invoke the LLM. */
  async function represent(existing: OpenDraftForInbox): Promise<void> {
    const { citations, language } = readDraftMeta(existing.agentOutput);
    await present(existing.customerId ?? '', existing.queueId, existing.body, citations, language);
  }

  return {
    async draftAndPresent(input: DraftAndPresentInput): Promise<void> {
      const { row, customerId, config, threadKey, knowledge, intent } = input;

      // (1) Reclaim guard: a prior attempt that failed AT/AFTER the notify left an OPEN
      // draft for this inbox message — re-present it instead of minting a second draft.
      const existing = await deps.findOpenDraftByInbox(row.id);
      if (existing) {
        logger.info({ inboxId: row.id, queueId: existing.queueId }, 'drafter: open draft exists — re-presenting');
        await represent(existing);
        return;
      }

      // Can't draft a reply to nobody — guard (failure-isolated, never throws triage).
      if (!row.sender_address) {
        logger.warn({ inboxId: row.id }, 'drafter: no sender_address — skipping draft');
        return;
      }

      // (2) Draft in the customer's preferred language, grounded ONLY in `knowledge`.
      const req: DraftRequest = {
        question: assembleQuestion(row),
        language: config.preferredLanguage,
        customerName: config.displayName,
        knowledge,
      };
      const result = await deps.llm.draftReply(req);

      // (3) Citations rendered from OUR chunks at the model's used indexes (no hallucinated cite).
      const citations = renderCitations(knowledge, result.usedSourceIndexes);

      // (4) Open the audit decision (outcome='pending') — the queue row FKs to it.
      const { decisionId } = await deps.recordDraftDecision({
        customerId,
        inboxMessageId: row.id,
        agentOutput: {
          intent,
          draft_body: result.body,
          citations,
          language: config.preferredLanguage,
        },
      });

      // (5) Enqueue as a DRAFT (status='pending', is_draft=true) — NEVER auto-drained.
      //     in_reply_to = the inbound provider id → an approved WhatsApp send quotes it (must-fix #2).
      const queueId = await deps.enqueueDraft({
        channelInstanceId: row.channel_instance_id,
        channelType: row.channel_type,
        recipientAddress: row.sender_address,
        body: result.body,
        threadKey,
        inReplyTo: row.channel_message_id,
        customerId,
        decisionId,
      });

      logger.info(
        { inboxId: row.id, queueId, decisionId, citations: citations.length },
        'drafter: cited draft enqueued (pending) — presenting for approval',
      );

      // (6) Present with Approve/Edit/Reject. A failure here throws → the row is reclaimed
      //     and step (1) re-presents this same draft (no double).
      await present(customerId, queueId, result.body, citations, config.preferredLanguage);
    },

    async reconfirmOpenDraft(inboxMessageId: string): Promise<boolean> {
      const existing = await deps.findOpenDraftByInbox(inboxMessageId);
      if (!existing) return false;
      logger.info({ inboxId: inboxMessageId, queueId: existing.queueId }, 'drafter: reconfirm — re-presenting open draft');
      await represent(existing);
      return true;
    },
  };
}

/** Title on every draft-approval presentation. */
const PRESENT_TITLE = '📝 Draft reply — needs approval';

/** Assemble the customer question (subject + body) the drafter answers. Trims + drops
 *  empty parts; both may be null (e.g. a WhatsApp message has no subject). */
function assembleQuestion(row: ClaimedInbox): string {
  return [row.subject, row.body]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s)
    .join('\n\n');
}

/** Build the founder-facing presentation: draft body + a "Based on:" citation list +
 *  the reply language. Never logged. */
function buildPresentation(body: string, citations: string[], language: string): Notification {
  const lines: string[] = [body];
  if (citations.length > 0) {
    lines.push('', 'Based on:', ...citations.map((c) => `- ${c}`));
  }
  lines.push('', `Language: ${language}`);
  return { title: PRESENT_TITLE, body: lines.join('\n'), severity: 'action' };
}

/** Safely read the citations + language a prior attempt stored on the decision's
 *  agent_output ({ intent, draft_body, citations, language }) for re-presentation. */
function readDraftMeta(agentOutput: unknown): { citations: string[]; language: string } {
  if (agentOutput && typeof agentOutput === 'object') {
    const o = agentOutput as Record<string, unknown>;
    const citations = Array.isArray(o.citations)
      ? o.citations.filter((c): c is string => typeof c === 'string')
      : [];
    const language = typeof o.language === 'string' ? o.language : '';
    return { citations, language };
  }
  return { citations: [], language: '' };
}

/** A chunk's human-readable citation label: `title › section (route)`, degrading
 *  gracefully when fields are null. */
function chunkLabel(c: KnowledgeChunk): string {
  let label = c.title?.trim() || 'Untitled';
  const section = c.section?.trim();
  if (section) label += ` › ${section}`;
  const route = c.route?.trim();
  if (route) label += ` (${route})`;
  return label;
}

/**
 * Render the human-readable "Based on:" citation labels from OUR retrieved chunks at
 * the model's `usedSourceIndexes` — indexes are validated + clamped to the valid
 * range, deduped; when none are valid the fallback is ALL retrieved chunk labels
 * (never a hallucinated citation). A chunk's label is `title › section (route)`.
 * Exported for unit test (clamp / dedup / fallback cases).
 */
export function renderCitations(knowledge: KnowledgeChunk[], usedSourceIndexes: number[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of usedSourceIndexes) {
    if (!Number.isInteger(i) || i < 0 || i >= knowledge.length) continue; // validate + clamp
    const label = chunkLabel(knowledge[i]);
    if (seen.has(label)) continue; // dedupe
    seen.add(label);
    out.push(label);
  }
  if (out.length === 0) {
    // Fallback: the model reported no valid source → cite ALL retrieved chunks (never
    // a hallucinated citation, and never an empty "Based on:" list).
    for (const c of knowledge) {
      const label = chunkLabel(c);
      if (seen.has(label)) continue;
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}

// Reference: the DraftRequest DTO is re-exported for downstream convenience.
export type { DraftRequest, DraftResult };
