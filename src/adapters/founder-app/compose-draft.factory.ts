import { buildDraftEmailPresenter, type DraftEmailPresenterDeps } from '../../query/draft-email';
import type { ResolvedCustomerRef } from '../../query/commands';

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
