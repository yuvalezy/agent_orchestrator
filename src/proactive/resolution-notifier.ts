import type { FounderNotifierPort } from '../ports/founder-notifier.port';
import type { CustomerConfig } from '../triage/context-loader';
import type { enqueueDraft } from '../outbound/outbound-repo';
import type { recordReleaseNoteDraftDecision } from '../decisions/decisions';
import type { TaskOrigin } from './resolution-origin-repo';
import type { ComposeResolutionDraft } from './resolution-draft';
import { buildChaserNotifier } from './chaser-notifier';

// M4 resolution notifier (CORE — injected ports + core repo fns only, imports NO adapter, D1).
// A resolution notice IS a chase grounded on a DONE task, so this is now a THIN CONFIGURATION of
// the shared chaser pipeline (chaser-notifier.ts): for a portal task that moved to 'done', if it
// ORIGINATED from a customer conversation (the agent_tasks bridge resolves the origin), draft ONE
// warm "your request is resolved" reply on the ORIGIN channel — threaded and quoting the inbound
// message — enqueue it is_draft=true (NEVER auto-sent), and present it via the SAME approve/edit/
// reject flow. NOTHING auto-sends. Not customer-originated → SKIP. Per-task isolation: any failure
// after the origin resolves is a transient FAILURE, never thrown. Never logs the body.
//
// The three config points over the generic chaser: the resolution compose adapter (composeResolution
// Draft, grounded on the done task's title), decisionKind='task_resolved' + its presentation title,
// and the extra `task_code` audit field. Everything else — the 5-step pipeline, the skip/fail
// semantics, the origin bridge, the Re: subject threading — is the chaser's, verbatim.

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

/** Title on every resolution-draft presentation. */
const PRESENT_TITLE = '✅ Resolution notification — needs approval';

export function buildResolutionNotifier(deps: ResolutionNotifierDeps): ResolutionNotifier {
  return {
    async notifyForDoneTask(task: DoneTask): Promise<ResolutionNotifyResult> {
      // Configure the shared chaser pipeline for THIS done task: the compose closure + task_code
      // audit field carry the task's identity (the chaser item only carries taskRef + title), and
      // the composer receives the full DoneTask so its grounding is unchanged. Built per call so the
      // closure captures this task — the construction is just closures, no I/O.
      const chaser = buildChaserNotifier({
        resolveTaskOrigin: deps.resolveTaskOrigin,
        loadCustomerConfig: deps.loadCustomerConfig,
        composeChase: ({ customer }) => deps.composeResolutionDraft({ task, customer }),
        recordDraftDecision: deps.recordDraftDecision,
        enqueueDraft: deps.enqueueDraft,
        notifier: deps.notifier,
        decisionKind: 'task_resolved',
        presentTitle: PRESENT_TITLE,
        auditMeta: { task_code: task.code },
      });
      // notifyForItem keys the origin bridge on taskRef and the Re: subject / task_title on title —
      // task.ref / task.title map exactly onto those, so the enqueued draft is byte-identical.
      return chaser.notifyForItem({ taskRef: task.ref, title: task.title });
    },
  };
}
