import { logger } from '../logger';
import type { AgentLlmPort, Intent } from '../ports/llm.port';
import type { TargetTask, TaskTargetPort } from '../ports/task-target.port';
import type { FounderNotifierPort } from '../ports/founder-notifier.port';
import { resolveContact, proposeAddContact, type ContactResolutionQueries } from '../customers/contact-resolution';
import { loadCustomerConfig, buildTriageContext, type CustomerConfig } from './context-loader';
import { decideDedup } from './dedup';
import { recordTaskBridge, findTaskByInbox, recordTriageDecision } from '../decisions/decisions';
import { markProcessed, markSkipped, setInboxCustomer, type ClaimedInbox } from '../inbox/inbox-repo';

// Triage pipeline (tasks 6.2-6.5, CORE — injected ports + db only, imports NO
// adapter, D1). process() is the per-inbox-row money-loop: resolve → load context
// → extract intents → route → dedup → create/comment → bridge/audit → notify.
// Never logs the message body — only ids/category/counts.

/** callback_data prefix for the ❌ cancel button (compact: 'x:'+task uuid ≤ 64B). */
export const CANCEL_PREFIX = 'x:';
const cancelButton = (taskRef: string) => [{ id: `${CANCEL_PREFIX}${taskRef}`, label: '❌ Cancel task' }];

export interface TriageDeps {
  taskTarget: TaskTargetPort;
  llm: AgentLlmPort;
  notifier: FounderNotifierPort;
  contactQueries: ContactResolutionQueries;
  /** Best-effort portal deep link for a task ref (composition supplies from env). */
  deepLink: (taskRef: string) => string | undefined;
  /** Increment the skipped-unknown-sender tally (app_state counter). */
  bumpSkipped: () => Promise<void>;
}

export class TriageService {
  constructor(private readonly deps: TriageDeps) {}

  async process(row: ClaimedInbox): Promise<void> {
    const inboxId = row.id;

    // R49 short-circuit: a prior attempt already ran the LLM + created a task and
    // then failed (e.g. Telegram down) → don't re-spend / re-dedup, just finish.
    // Residual: a crash MID-multi-intent leaves the un-done intents unprocessed —
    // accepted Phase-1 tradeoff (single-intent dominant).
    const existing = await findTaskByInbox(inboxId);
    if (existing) {
      logger.info({ inboxId, taskRef: existing }, 'triage: already produced a task (R49) — marking processed');
      await markProcessed(inboxId);
      return;
    }

    const address = row.sender_address ?? '';
    const resolution = await resolveContact({ channelType: row.channel_type, address }, this.deps.contactQueries);
    if (resolution.kind === 'unknown') {
      await this.deps.bumpSkipped();
      await markSkipped(inboxId, 'unknown sender');
      logger.info({ inboxId, channelType: row.channel_type }, 'triage: unknown sender — skipped');
      return;
    }
    if (resolution.kind === 'propose') {
      await proposeAddContact(this.deps.notifier, {
        customerId: resolution.customerId,
        customerName: resolution.customerName,
        channelType: row.channel_type,
        address,
      });
      await markSkipped(inboxId, 'proposed new contact');
      return;
    }

    const customerId = resolution.customerId;
    await setInboxCustomer(inboxId, customerId);
    const config = await loadCustomerConfig(customerId);
    if (!config || !config.projectRef || !config.workItemTypeRef) {
      await markSkipped(inboxId, 'customer missing project/work-item-type config');
      await this.deps.notifier.notifyAdmin({
        title: 'Triage skipped',
        body: `Customer ${customerId} is not fully onboarded (missing project/work-item-type).`,
        severity: 'warning',
      });
      return;
    }

    const threadKey = row.channel_thread_id ?? address;
    const openTasks = await this.deps.taskTarget.findOpenTasks({ projectRef: config.projectRef });
    const context = buildTriageContext({ subject: row.subject, body: row.body }, config, openTasks);
    const intents = await this.deps.llm.extractIntents(context);

    if (intents.length === 0) {
      await recordTriageDecision({ customerId, inboxMessageId: inboxId, agentOutput: { intents: [] }, outcome: 'accepted' });
      await markProcessed(inboxId);
      return;
    }

    for (const intent of intents) {
      await this.act(intent, { row, config, customerId, threadKey, openTasks });
    }
    await markProcessed(inboxId);
  }

  private async act(
    intent: Intent,
    ctx: { row: ClaimedInbox; config: CustomerConfig; customerId: string; threadKey: string; openTasks: TargetTask[] },
  ): Promise<void> {
    const { row, config, customerId, threadKey } = ctx;
    const inboxId = row.id;
    const projectRef = config.projectRef as string; // process() guarded non-null
    const workItemTypeRef = config.workItemTypeRef as string;

    // Low confidence / unclear → human-in-the-loop, no task (design triage contract).
    if (intent.confidence < 0.5 || intent.category === 'unclear') {
      await this.deps.notifier.notifyCustomerEvent(customerId, {
        title: '❓ Needs your input',
        body: `An unclear message from ${config.displayName} (${intent.category}). Please review:\n“${intent.summary}”`,
        severity: 'action',
      });
      await recordTriageDecision({ customerId, inboxMessageId: inboxId, agentOutput: intent, outcome: 'pending' });
      return;
    }

    const dedup = await decideDedup(
      intent,
      { channelType: row.channel_type, threadKey, projectRef, openTasks: ctx.openTasks },
      { taskTarget: this.deps.taskTarget, llm: this.deps.llm },
    );

    if (dedup.action === 'comment') {
      await this.deps.taskTarget.addComment({ ref: dedup.taskRef }, `[agent-orchestrator] ${intent.summary}`);
      await recordTaskBridge({ taskRef: dedup.taskRef, customerId, inboxMessageId: inboxId, relationship: 'contributed_to' });
      await recordTriageDecision({ customerId, inboxMessageId: inboxId, agentOutput: intent, outcome: 'accepted', taskRef: dedup.taskRef });
      await this.deps.notifier.notifyCustomerEvent(customerId, {
        title: '💬 Comment added',
        body: `Added to an existing task for ${config.displayName}:\n“${intent.summary}”`,
        url: this.deps.deepLink(dedup.taskRef),
      });
      return;
    }

    const task = await this.deps.taskTarget.createTask({
      customerRef: config.bpRef,
      projectRef,
      workItemTypeRef,
      title: intent.suggested_title,
      description: this.taskDescription(intent, row.body),
      priority: intent.priority,
      source: { service: 'agent-orchestrator', entityType: row.channel_type, entityId: threadKey, display: `${config.displayName} · ${threadKey}` },
      tags: [intent.category],
    });
    await recordTaskBridge({ taskRef: task.ref, customerId, inboxMessageId: inboxId, relationship: 'created_from' });
    await recordTriageDecision({ customerId, inboxMessageId: inboxId, agentOutput: intent, outcome: 'accepted', taskRef: task.ref });
    await this.deps.notifier.notifyCustomerEvent(
      customerId,
      {
        title: `🆕 New task · ${intent.priority}`,
        body: `${config.displayName}: ${intent.suggested_title}\n“${intent.summary}”`,
        url: this.deps.deepLink(task.ref),
      },
      cancelButton(task.ref),
    );
  }

  private taskDescription(intent: Intent, body: string | null): string {
    const parts = [intent.summary];
    if (body) parts.push('', '---', 'Original message:', body);
    parts.push('', '(created by agent-orchestrator from an inbound message)');
    return parts.join('\n');
  }
}
