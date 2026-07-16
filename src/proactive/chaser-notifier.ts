import { logger } from '../logger';
import type { FounderNotifierPort, Notification } from '../ports/founder-notifier.port';
import type { CustomerConfig } from '../triage/context-loader';
import { draftButtons } from '../triage/draft-review';
import type { enqueueDraft } from '../outbound/outbound-repo';
import type { recordReleaseNoteDraftDecision } from '../decisions/decisions';
import type { TaskOrigin } from './resolution-origin-repo';
import type { ComposeChaseDraft } from './chaser-draft';

// WP2 proactive-chaser notifier (CORE — injected ports + core repo fns only, imports NO adapter,
// D1). The shared heart of the two chaser behaviors (stale in-progress task status updates +
// awaiting-reply nudges): for a chaseable item that resolves to a customer-conversation ORIGIN
// (the agent_tasks bridge, SAME resolver M4's resolution-notifier uses), compose ONE short draft
// on the ORIGIN channel — threaded and quoting the inbound message — enqueue it is_draft=true
// (NEVER auto-sent), and present it via the SAME Telegram approve/edit/reject flow (draftButtons +
// the existing draft-review handlers, keyed by queueId). NOTHING auto-sends. Not customer-
// originated → SKIP. Per-item isolation: any failure after the origin resolves is caught and
// returned as a failure (this method NEVER throws). Never logs the body.
//
// It is deliberately a PARALLEL of resolution-notifier.ts (a done task → "resolved" draft) rather
// than a refactor of it: same shape, but a chase is grounded on an OPEN task's title (not a done
// one), carries its own decision `kind`, and is driven off a different detector. Keeping M4's
// notifier untouched avoids destabilizing a shipped path.

/** The chaseable item the notifier acts on — the portal task/thread ref + its human title. */
export interface ChaseItem {
  /** The portal task ref whose agent_tasks bridge resolves the customer-conversation origin. */
  taskRef: string;
  /** The task/thread title — the ONE product fact handed to the composer (never invented past it). */
  title: string;
}

export interface ChaserNotifierDeps {
  /** Resolve the customer-conversation origin of the task (null = not customer-originated). */
  resolveTaskOrigin: (taskRef: string) => Promise<TaskOrigin | null>;
  loadCustomerConfig: (
    customerId: string,
  ) => Promise<Pick<CustomerConfig, 'displayName' | 'preferredLanguage'> | null>;
  /** Compose the chase body (LLM 'draft' role); throws on LLM failure (caught here). */
  composeChase: ComposeChaseDraft;
  /** Open the draft_reply audit decision (founder-initiated → inbox_message_id NULL). */
  recordDraftDecision: typeof recordReleaseNoteDraftDecision;
  enqueueDraft: typeof enqueueDraft;
  notifier: Pick<FounderNotifierPort, 'notifyCustomerEvent'>;
  /** The decision `kind` stamped on agent_output (e.g. 'task_stale_update' / 'awaiting_reply_nudge')
   *  so this draft is distinguishable in the audit trail. */
  decisionKind: string;
  /** The founder-facing presentation title (e.g. '⏳ Status-update draft — needs approval'). */
  presentTitle: string;
}

/**
 * Per-item outcome (no body — ids/flags only). Three mutually-exclusive states, IDENTICAL in
 * meaning to the resolution notifier's so the worker's claim/release logic is shared verbatim:
 *  - drafted: the chase draft was enqueued + presented (success).
 *  - skipped: a BY-DESIGN no-op (no customer origin / no customer config) — a permanent decision,
 *    so the caller keeps the ledger claim.
 *  - failed: a TRANSIENT error in compose/decision/enqueue/present — the caller must RELEASE the
 *    claim so the next scan retries. Never thrown out.
 */
export interface ChaserNotifyResult {
  drafted: boolean;
  skipped: boolean;
  failed: boolean;
  reason?: string;
}

export interface ChaserNotifier {
  /** Draft + present a chase for one item. Never throws. */
  notifyForItem(item: ChaseItem): Promise<ChaserNotifyResult>;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function buildChaserNotifier(deps: ChaserNotifierDeps): ChaserNotifier {
  return {
    async notifyForItem(item: ChaseItem): Promise<ChaserNotifyResult> {
      let customerId: string | undefined;
      try {
        // (1) Origin bridge FIRST — a task with no customer-conversation origin is not ours to
        // chase (by-design SKIP, before any LLM/decision/queue work). A THROW here (transient DB
        // blip) falls through to the catch as a FAILURE (retry), never a skip.
        const origin = await deps.resolveTaskOrigin(item.taskRef);
        if (!origin) {
          logger.info({ taskRef: item.taskRef, kind: deps.decisionKind }, 'chaser: not customer-originated — skipped');
          return { drafted: false, skipped: true, failed: false, reason: 'not customer-originated' };
        }
        customerId = origin.customerId;

        const config = await deps.loadCustomerConfig(origin.customerId);
        if (!config) {
          logger.warn({ taskRef: item.taskRef, customerId: origin.customerId, kind: deps.decisionKind }, 'chaser: customer config unresolved — skipped');
          return { drafted: false, skipped: true, failed: false, reason: 'customer config unresolved' };
        }

        // (2) Compose the grounded, cite-or-abstain body in the customer's language.
        const body = await deps.composeChase({
          title: item.title,
          customer: { displayName: config.displayName, preferredLanguage: config.preferredLanguage },
        });

        // (3) Open the audit decision (draft_reply, inbox NULL — founder-initiated), varying `kind`
        //     so a chase is distinguishable from a resolution/release-note draft.
        const { decisionId } = await deps.recordDraftDecision({
          customerId: origin.customerId,
          agentOutput: {
            kind: deps.decisionKind,
            task_ref: item.taskRef,
            task_title: item.title,
            draft_body: body,
            language: config.preferredLanguage,
          },
        });

        // (4) Enqueue the DRAFT (is_draft=true → NEVER drained) on the ORIGIN channel, threaded +
        //     quoting the inbound message. Email carries a Re: subject so an approved send threads.
        const queueId = await deps.enqueueDraft({
          channelInstanceId: origin.channelInstanceId,
          channelType: origin.channelType,
          recipientAddress: origin.recipientAddress,
          body,
          threadKey: origin.threadKey,
          inReplyTo: origin.inReplyTo,
          subject: origin.channelType === 'email' ? `Re: ${item.title}` : undefined,
          customerId: origin.customerId,
          decisionId,
        });

        // (5) Present with Approve/Edit/Reject — the existing draft-review handlers act on it by
        //     queueId. Nothing sends without a tap.
        await deps.notifier.notifyCustomerEvent(
          origin.customerId,
          { ...buildPresentation(deps.presentTitle, body, config.preferredLanguage), contextRef: { kind: 'outbound', ref: queueId } },
          draftButtons(queueId),
        );

        logger.info(
          { taskRef: item.taskRef, customerId: origin.customerId, queueId, decisionId, kind: deps.decisionKind },
          'chaser: draft enqueued (pending) — presenting for approval',
        );
        return { drafted: true, skipped: false, failed: false };
      } catch (err) {
        // Per-item isolation: NEVER throw out. A compose/decision/enqueue/present error (or an
        // origin-lookup blip) is a TRANSIENT FAILURE — the caller releases the ledger claim so the
        // next scan retries (distinct from a by-design skip above).
        const reason = errMessage(err);
        logger.warn({ taskRef: item.taskRef, customerId, kind: deps.decisionKind, reason }, 'chaser: draft failed — will retry');
        return { drafted: false, skipped: false, failed: true, reason };
      }
    },
  };
}

/** Founder-facing presentation: the draft body + the reply language. Never logged. */
function buildPresentation(title: string, body: string, language: string): Notification {
  return { title, body: `${body}\n\nLanguage: ${language}`, severity: 'action' };
}
