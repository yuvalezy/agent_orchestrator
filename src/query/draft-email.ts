import type { FounderNotifierPort, Notification } from '../ports/founder-notifier.port';
import type { enqueueDraft } from '../outbound/outbound-repo';
import { draftButtons } from '../triage/draft-review';
import type { DraftEmailInput, DraftEmailResult, ResolvedCustomerRef } from './commands';

// `/draft email` fate (WP5(a), CORE — injected ports + core repo fns only, imports NO
// adapter, D1). The command used to COMPOSE a customer email and only DISPLAY it in the
// founder topic (a dead-end copy aid). It now gives the draft the STANDARD fate a real
// reply gets: enqueue is_draft=true to the customer's email account (never auto-sent —
// the drainer filters is_draft=false), open a draft_reply audit decision the queue row
// FKs to, and present it in the customer's Telegram topic with the SAME Approve/Edit/
// Reject buttons (da/de/dr) the inbox drafter uses — so the existing draft-review
// machinery (approveDraft flips+resolves 'accepted' → released to the drainer;
// cancelDraft → 'rejected'; the ✏️ Edit capture) drives it with ZERO change.
//
// This is a NEW outbound mail (no inbound message to reply to), so it routes to the
// customer's own email account/contact (resolveEmailRoute — the same reply-from account
// the scheduling email path resolves), with no in_reply_to / threadKey / subject: a fresh
// message, exactly like a scheduled customer email with no reply origin. When the customer
// has no email contact / no sending account, resolveEmailRoute returns null and the whole
// thing degrades to a clean in-topic "can't draft an email to them" (NO LLM spend, NO
// row) — the route is resolved BEFORE composing so a missing prerequisite is cheap.
//
// The audit decision has inbox_message_id NULL (founder-initiated, no inbound) — the SAME
// shape as the M2(e) release-note draft, so approve/edit/reject/feedback/acceptance all
// keep working. Never logs the prompt or the drafted body — ids/counts/flags only.

export interface DraftEmailPresenterDeps {
  /**
   * Resolve the customer's email SEND route (channel instance + recipient) — the
   * reply-from account config, the same the scheduling email path resolves. Returns null
   * when the customer has no email contact or no active sending account, which is the
   * "missing prerequisite" the command reports honestly instead of drafting into a void.
   */
  resolveEmailRoute: (customerId: string) => Promise<EmailRoute | null>;
  /**
   * Compose the reply body grounded in the customer's knowledge (the LLM 'draft' role +
   * the drafter's renderCitations — the same primitives the inbox drafter uses). Called
   * ONLY after a route resolves, so an ungated customer never costs an LLM call.
   */
  compose: (input: { prompt: string; customer: ResolvedCustomerRef }) => Promise<ComposedDraft>;
  enqueueDraft: typeof enqueueDraft;
  /** Open a founder-initiated draft_reply audit row (inbox_message_id NULL). Returns its id;
   *  the queue draft row FKs to it (resolved on approve/edit/reject). */
  recordDraftDecision: (input: { customerId: string; agentOutput: unknown }) => Promise<{ decisionId: string }>;
  notifier: Pick<FounderNotifierPort, 'notifyCustomerEvent'>;
  log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void };
}

/** The email send route for a NEW outbound mail (no reply origin → no in_reply_to/subject). */
export interface EmailRoute {
  channelInstanceId: string;
  channelType: string; // always 'email' here — carried so enqueueDraft normalizes correctly
  recipientAddress: string;
  recipientLabel: string;
}

/** A composed reply body + its rendered citations + the reply language. */
export interface ComposedDraft {
  body: string;
  citations: string[];
  /** False when retrieval found nothing (the draft is ungrounded — the reply says so). */
  grounded: boolean;
  language: string;
}

/** Title on the presented draft card — MUST match the inbox drafter so the founder reads
 *  one consistent surface (response-drafter.ts PRESENT_TITLE). */
const PRESENT_TITLE = '📝 Draft reply — needs approval';

/** Build the founder-facing draft card presented in the customer's topic (never logged). */
function buildPresentation(draft: ComposedDraft): Notification {
  const lines: string[] = ['✍️ Suggested email:', draft.body];
  if (draft.citations.length > 0) {
    lines.push('', 'Based on:', ...draft.citations.map((c) => `- ${c}`));
  }
  lines.push('', `Language: ${draft.language}`);
  if (!draft.grounded) {
    lines.push('⚠️ Ungrounded — I found no matching knowledge, so this is phrasing only. Check the facts before approving.');
  }
  return { title: PRESENT_TITLE, body: lines.join('\n'), severity: 'action' };
}

/**
 * Build the `/draft email` capability (the `draftEmail` dep in commands.ts). Resolves the
 * email route, composes, opens the audit decision, enqueues the draft, and presents it with
 * the standard Approve/Edit/Reject buttons in the customer's topic. Returns the preview the
 * command echoes back to the founder as a confirmation — or a `no_email_route` refusal when
 * the customer has no email contact/account (nothing composed, nothing queued).
 */
export function buildDraftEmailPresenter(
  deps: DraftEmailPresenterDeps,
): (input: DraftEmailInput) => Promise<DraftEmailResult> {
  return async ({ prompt, customer }: DraftEmailInput): Promise<DraftEmailResult> => {
    // Resolve the send route FIRST — a customer with no email contact/account gets a clean
    // refusal with no LLM spend and no orphan row.
    const route = await deps.resolveEmailRoute(customer.customerId);
    if (!route) {
      deps.log.info({ customerId: customer.customerId, enqueued: false }, 'draft email: no email route — refusing');
      return { ok: false, reason: 'no_email_route' };
    }

    const draft = await deps.compose({ prompt, customer });

    // Open the audit decision FIRST (the queue row FKs to it), then enqueue the draft — the
    // same order the inbox drafter uses. agent_output carries the structured draft (never the
    // raw prompt): { kind:'slash_draft', draft_body, citations, language, customer_name }.
    const { decisionId } = await deps.recordDraftDecision({
      customerId: customer.customerId,
      agentOutput: {
        kind: 'slash_draft',
        draft_body: draft.body,
        citations: draft.citations,
        language: draft.language,
        customer_name: customer.customerName,
      },
    });

    // Enqueue is_draft=true (NEVER drained) to the customer's email account. A NEW mail:
    // no in_reply_to, no threadKey, no subject (a fresh scheduled customer email is the same).
    const queueId = await deps.enqueueDraft({
      channelInstanceId: route.channelInstanceId,
      channelType: route.channelType,
      recipientAddress: route.recipientAddress,
      body: draft.body,
      customerId: customer.customerId,
      decisionId,
    });

    deps.log.info(
      { customerId: customer.customerId, queueId, decisionId, grounded: draft.grounded, cited: draft.citations.length },
      'draft email: enqueued (pending) — presenting for approval',
    );

    // Present with the STANDARD three buttons — routed by the existing buildDraftDecisionHandler.
    await deps.notifier.notifyCustomerEvent(customer.customerId, buildPresentation(draft), draftButtons(queueId));

    return { ok: true, recipient: route.recipientLabel, grounded: draft.grounded, citations: draft.citations };
  };
}
