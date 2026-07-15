import { logger } from '../logger';
import type { FounderNotifierPort, Notification } from '../ports/founder-notifier.port';
import type { CustomerConfig } from '../triage/context-loader';
import { draftButtons } from '../triage/draft-review';
import type { enqueueDraft } from '../outbound/outbound-repo';
import type { recordReleaseNoteDraftDecision } from '../decisions/decisions';
import type { TaskOrigin } from './resolution-origin-repo';
import type { ComposeResolutionDraft } from './resolution-draft';

// M4 resolution notifier (CORE — injected ports + core repo fns only, imports NO
// adapter, D1). The heart of M4: for a portal task that moved to 'done', if it
// ORIGINATED from a customer conversation (the agent_tasks bridge resolves the origin),
// draft ONE warm "your request is resolved" reply on the ORIGIN channel — threaded and
// quoting the inbound message — enqueue it is_draft=true (NEVER auto-sent), and present
// it via the SAME Telegram/console approve/edit/reject flow (draftButtons + the existing
// draft-review handlers, keyed by queueId). NOTHING auto-sends; the founder approves each
// one. Not customer-originated → SKIP. Per-task isolation: any failure after the origin
// resolves is caught and returned as a skip (this method NEVER throws). Never logs the body.

/** The done task the notifier acts on ({ref, code, title} from the portal poll). */
export interface DoneTask {
  ref: string;
  code: string;
  title: string;
}

export interface ResolutionNotifierDeps {
  /** Resolve the customer-conversation origin of a done task (null = not customer-originated). */
  resolveTaskOrigin: (taskRef: string) => Promise<TaskOrigin | null>;
  loadCustomerConfig: (
    customerId: string,
  ) => Promise<Pick<CustomerConfig, 'displayName' | 'preferredLanguage'> | null>;
  /** Compose the warm resolution body (LLM 'draft' role); throws on LLM failure (caught here). */
  composeResolutionDraft: ComposeResolutionDraft;
  /** Open the draft_reply audit decision (founder-initiated → inbox_message_id NULL). */
  recordDraftDecision: typeof recordReleaseNoteDraftDecision;
  enqueueDraft: typeof enqueueDraft;
  notifier: Pick<FounderNotifierPort, 'notifyCustomerEvent'>;
}

/**
 * Per-task outcome (no body — ids/flags only). Three mutually-exclusive states:
 *  - drafted: the resolution draft was enqueued + presented (success).
 *  - skipped: a BY-DESIGN no-op (no customer origin / no customer config) — a permanent
 *    decision, so the caller keeps the ledger claim and advances the cursor.
 *  - failed: a TRANSIENT error in compose/decision/enqueue/present — the caller must
 *    RELEASE the claim and hold the cursor so the next tick retries. Never thrown out.
 */
export interface ResolutionNotifyResult {
  drafted: boolean;
  skipped: boolean;
  failed: boolean;
  reason?: string;
}

export interface ResolutionNotifier {
  /** Draft + present a resolution notice for one done task. Never throws. */
  notifyForDoneTask(task: DoneTask): Promise<ResolutionNotifyResult>;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Title on every resolution-draft presentation. */
const PRESENT_TITLE = '✅ Resolution notification — needs approval';

export function buildResolutionNotifier(deps: ResolutionNotifierDeps): ResolutionNotifier {
  return {
    async notifyForDoneTask(task: DoneTask): Promise<ResolutionNotifyResult> {
      // customerId is only known once the origin resolves — undefined until then so the
      // catch can log it when the origin lookup itself is what failed.
      let customerId: string | undefined;
      try {
        // (1) Origin bridge FIRST — a task with no customer-conversation origin is not
        // ours to notify about (by-design SKIP, before any LLM/decision/queue work). A
        // THROW here (transient DB blip) falls through to the catch as a FAILURE (retry),
        // never a skip — otherwise the claim would suppress the notice forever.
        const origin = await deps.resolveTaskOrigin(task.ref);
        if (!origin) {
          logger.info({ taskRef: task.ref }, 'resolution: not customer-originated — skipped');
          return { drafted: false, skipped: true, failed: false, reason: 'not customer-originated' };
        }
        customerId = origin.customerId;

        const config = await deps.loadCustomerConfig(origin.customerId);
        if (!config) {
          logger.warn({ taskRef: task.ref, customerId: origin.customerId }, 'resolution: customer config unresolved — skipped');
          return { drafted: false, skipped: true, failed: false, reason: 'customer config unresolved' };
        }

        // (2) Compose the warm, cite-or-abstain resolution body in the customer's language.
        const body = await deps.composeResolutionDraft({
          task,
          customer: { displayName: config.displayName, preferredLanguage: config.preferredLanguage },
        });

        // (3) Open the audit decision (draft_reply, inbox NULL — founder-initiated), varying
        //     kind='task_resolved' so it's distinguishable from a release-note draft.
        const { decisionId } = await deps.recordDraftDecision({
          customerId: origin.customerId,
          agentOutput: {
            kind: 'task_resolved',
            task_ref: task.ref,
            task_code: task.code,
            task_title: task.title,
            draft_body: body,
            language: config.preferredLanguage,
          },
        });

        // (4) Enqueue the DRAFT (is_draft=true → NEVER drained) on the ORIGIN channel,
        //     threaded + quoting the inbound message. Email carries a Re: subject so an
        //     approved send lands in the same thread.
        const queueId = await deps.enqueueDraft({
          channelInstanceId: origin.channelInstanceId,
          channelType: origin.channelType,
          recipientAddress: origin.recipientAddress,
          body,
          threadKey: origin.threadKey,
          inReplyTo: origin.inReplyTo,
          subject: origin.channelType === 'email' ? `Re: ${task.title}` : undefined,
          customerId: origin.customerId,
          decisionId,
        });

        // (5) Present with Approve/Edit/Reject — the existing draft-review handlers act on it
        //     by queueId (nothing task-specific downstream). Nothing sends without a tap.
        await deps.notifier.notifyCustomerEvent(
          origin.customerId,
          { ...buildPresentation(body, config.preferredLanguage), contextRef: { kind: 'outbound', ref: queueId } },
          draftButtons(queueId),
        );

        logger.info(
          { taskRef: task.ref, customerId: origin.customerId, queueId, decisionId },
          'resolution: draft enqueued (pending) — presenting for approval',
        );
        return { drafted: true, skipped: false, failed: false };
      } catch (err) {
        // Per-task isolation: NEVER throw out. A compose/decision/enqueue/present error (or an
        // origin-lookup blip) is a TRANSIENT FAILURE — the caller releases the ledger claim and
        // holds the cursor so the next tick retries (distinct from a by-design skip above).
        const reason = errMessage(err);
        logger.warn({ taskRef: task.ref, customerId, reason }, 'resolution: draft failed — will retry');
        return { drafted: false, skipped: false, failed: true, reason };
      }
    },
  };
}

/** Founder-facing presentation: the draft body + the reply language. Never logged. */
function buildPresentation(body: string, language: string): Notification {
  return { title: PRESENT_TITLE, body: `${body}\n\nLanguage: ${language}`, severity: 'action' };
}
