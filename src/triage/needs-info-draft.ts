import type { AgentLlmPort, Intent, KnowledgeChunk } from '../ports/llm.port';
import type { FounderNotifierPort, Notification } from '../ports/founder-notifier.port';
import type { ClaimedInbox } from '../inbox/inbox-repo';
import type { CustomerConfig } from './context-loader';
import type { enqueueDraft, findOpenDraftByInbox } from '../outbound/outbound-repo';
import type { recordDraftDecision } from '../decisions/decisions';
import { logger } from '../logger';
import { draftButtons } from './draft-review';
import { emailReplySubject } from './response-drafter';

// WP2(c) needs-info clarification drafter (CORE — injected ports + core repo fns only, imports NO
// adapter, D1). For an UNCLEAR / low-confidence intent, ADDITIVELY compose a short clarifying
// QUESTION to the customer (so the founder can one-tap ask instead of writing it), enqueue it
// is_draft=true (NEVER auto-sent), and present it with the standard Approve/Edit/Reject controls.
// This is ADDITIVE to triage's existing askFounder notice — that still fires; this just hands the
// founder a ready-made clarification to send.
//
// Reuses AgentLlmPort.draftReply (NO new port method — the directive is passed as the `question`,
// the unclear message SUMMARY as the lone grounding chunk), mirroring resolution-draft.ts's
// grounding discipline: the model asks WHAT they meant, it must NOT assume the answer or invent an
// interpretation. Best-effort at the call site — a compose/enqueue failure is swallowed (the
// founder still got the askFounder notice), so a clarification miss never fails the triage row.
// Reclaim-idempotent: an existing open draft for the inbox row is re-presented, never re-drafted.
// Never logs the customer message or the draft body — ids/counts only.

export interface NeedsInfoDrafterDeps {
  llm: Pick<AgentLlmPort, 'draftReply'>;
  notifier: Pick<FounderNotifierPort, 'notifyCustomerEvent'>;
  enqueueDraft: typeof enqueueDraft;
  recordDraftDecision: typeof recordDraftDecision;
  findOpenDraftByInbox: typeof findOpenDraftByInbox;
}

export interface DraftClarificationInput {
  row: ClaimedInbox;
  customerId: string;
  config: Pick<CustomerConfig, 'displayName' | 'preferredLanguage'>;
  threadKey: string;
  /** The unclear/low-confidence intent — its `summary` is the sole grounding for the question. */
  intent: Intent;
}

export interface NeedsInfoDrafter {
  /** Compose → enqueue (is_draft=true) → present a clarification question. Reclaim-idempotent. */
  draftClarification(input: DraftClarificationInput): Promise<void>;
}

/** Title on every clarification-draft presentation. */
const PRESENT_TITLE = '❓ Clarification draft — needs approval';

/**
 * The `question` handed to the draft role: ask the customer to clarify what they need, grounded
 * ONLY in the numbered source (a neutral paraphrase of THEIR unclear message). The model must ask
 * WHAT they meant — never assume an interpretation, never answer a question that was not clearly
 * asked, never invent a request they did not make.
 */
export function clarificationDirective(summary: string): string {
  return [
    'A customer sent a message we could NOT confidently understand. Here is our neutral read of it:',
    `"${summary}"`,
    '',
    'Write a SHORT, warm message asking them to clarify what they need or want, so we can help.',
    'Do NOT assume what they meant, do NOT answer a question they did not clearly ask, and do NOT',
    'invent a request on their behalf — only ask them to say more about what they are after.',
  ].join('\n');
}

export function buildNeedsInfoDrafter(deps: NeedsInfoDrafterDeps): NeedsInfoDrafter {
  return {
    async draftClarification(input: DraftClarificationInput): Promise<void> {
      const { row, customerId, config, threadKey, intent } = input;

      if (row.answered_by_inbox_id) {
        logger.info(
          { inboxId: row.id, outboundInboxId: row.answered_by_inbox_id },
          'needs-info: founder already replied directly on WhatsApp — suppressing clarification draft',
        );
        return;
      }

      // Reclaim guard: a prior attempt that failed AT/AFTER the notify left an OPEN draft for this
      // inbox message — re-present it rather than minting a second clarification.
      const existing = await deps.findOpenDraftByInbox(row.id);
      if (existing) {
        logger.info({ inboxId: row.id, queueId: existing.queueId }, 'needs-info: open draft exists — re-presenting');
        await present(deps, existing.customerId ?? customerId, existing.queueId, existing.body, config.preferredLanguage, row.id);
        return;
      }

      // Can't ask a clarification of nobody — guard (the unclear notice already reached the founder).
      if (!row.sender_address) {
        logger.warn({ inboxId: row.id }, 'needs-info: no sender_address — skipping clarification draft');
        return;
      }

      // (1) Compose the clarifying question in the customer's language, grounded ONLY on the
      //     unclear message summary (a single chunk, so nothing else to draw on).
      const knowledge: KnowledgeChunk[] = [
        { content: `The customer's message, as best we understood it: "${intent.summary}"`, title: null, route: null, section: null, distance: 0 },
      ];
      const result = await deps.llm.draftReply({
        question: clarificationDirective(intent.summary),
        language: config.preferredLanguage,
        customerName: config.displayName,
        knowledge,
      });

      // (2) Open the audit decision (draft_reply, linked to the inbox message) — kind marks it a
      //     clarification so it is distinguishable from an answerable question's cited draft.
      const { decisionId } = await deps.recordDraftDecision({
        customerId,
        inboxMessageId: row.id,
        agentOutput: {
          kind: 'needs_info_clarification',
          intent_category: intent.category,
          draft_body: result.body,
          language: config.preferredLanguage,
          customer_name: config.displayName,
        },
      });

      // (3) Enqueue as a DRAFT (is_draft=true → NEVER auto-drained), threaded on the origin channel.
      const isEmail = row.channel_type === 'email';
      const queueId = await deps.enqueueDraft({
        channelInstanceId: row.channel_instance_id,
        channelType: row.channel_type,
        recipientAddress: row.sender_address,
        body: result.body,
        threadKey,
        inReplyTo: isEmail ? row.message_id_header ?? row.channel_message_id : row.channel_message_id,
        subject: isEmail ? emailReplySubject(row.subject) : undefined,
        customerId,
        decisionId,
      });

      logger.info({ inboxId: row.id, queueId, decisionId }, 'needs-info: clarification draft enqueued (pending) — presenting for approval');

      // (4) Present with Approve/Edit/Reject. A failure here throws to the caller (swallowed there);
      //     the reclaim guard above re-presents this same draft on the next attempt (no double).
      await present(deps, customerId, queueId, result.body, config.preferredLanguage, row.id);
    },
  };
}

/** Present (or re-present) a clarification draft in the customer's topic with the standard
 *  Approve/Edit/Reject controls. Body is never logged. */
async function present(
  deps: NeedsInfoDrafterDeps,
  customerId: string,
  queueId: string,
  body: string,
  language: string,
  inboxMessageId: string,
): Promise<void> {
  const presentation: Notification = {
    title: PRESENT_TITLE,
    body: `${body}\n\nLanguage: ${language}`,
    severity: 'action',
    contextRef: { kind: 'inbox', ref: inboxMessageId },
  };
  await deps.notifier.notifyCustomerEvent(customerId, presentation, draftButtons(queueId));
}
