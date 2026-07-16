import { logger } from '../logger';
import type { AgentLlmPort, Intent, KnowledgeChunk } from '../ports/llm.port';
import type { TargetTask, TaskTargetPort } from '../ports/task-target.port';
import type { FounderNotifierPort } from '../ports/founder-notifier.port';
import type { GroupSummaryPort, GroupSummary, GroupImageRef } from '../ports/group-summary.port';
import type { KnowledgeRetriever } from '../knowledge/retrieval';
import type { ResponseDrafter } from './response-drafter';
import type { NeedsInfoDrafter } from './needs-info-draft';
import type { CrossChannelDedup } from './cross-channel-dedup';
import type { MeetingScheduler } from './meeting-scheduler';
import type { CustomerBriefLoader } from '../knowledge/customer-brief';
import { resolveContact, proposeAddContact, type ContactResolutionQueries } from '../customers/contact-resolution';
import { loadCustomerConfig, buildTriageContext, type CustomerConfig } from './context-loader';
import { decideDedup } from './dedup';
import { recordTaskBridge, findTaskByInbox, recordTriageDecision, findCustomerByTaskRef } from '../decisions/decisions';
import { loadPriorThreadConversation, markProcessed, markSkipped, setInboxCustomer, type ClaimedInbox } from '../inbox/inbox-repo';

// Triage pipeline (tasks 6.2-6.5, CORE — injected ports + db only, imports NO
// adapter, D1). process() is the per-inbox-row money-loop: resolve → load context
// → extract intents → route → dedup → create/comment → bridge/audit → notify.
// Never logs the message body — only ids/category/counts.

/** callback_data prefix for the ❌ cancel button (compact: 'x:'+task uuid ≤ 64B). */
export const CANCEL_PREFIX = 'x:';
const cancelButton = (taskRef: string) => [{ id: `${CANCEL_PREFIX}${taskRef}`, label: '❌ Cancel task' }];

/** Categories that represent an explicit ask (→ a task). The rest are context.
 *
 * 'meeting_request' is a member even though it aims to produce a MEETING, not a task. That is
 * deliberate and load-bearing: a non-member terminates at the `'context'` gate below, so if
 * scheduling could not start (no calendar, no free slots, a write-scope 403) the ask would
 * evaporate — neither meeting nor task. Membership is exactly what keeps the task FALLBACK
 * reachable. */
export const ACTIONABLE = new Set([
  'bug_report',
  'new_feature_request',
  'custom_development',
  'question_existing',
  'follow_up',
  'meeting_request',
]);
export function taskMutationGate(
  intent: Pick<Intent, 'category' | 'explicit_action_request'>,
): 'context' | 'confirm' | 'act' {
  if (!ACTIONABLE.has(intent.category)) return 'context';
  if (intent.explicit_action_request === false) return 'confirm';
  return 'act';
}
/** Below this the intent is too uncertain to act on unprompted (→ askFounder,
 *  or context-only when CC'd). */
const CONFIDENCE_MIN = 0.5;

/** CC-only (DM6-5): an email where the founder's own address is in CC but not TO —
 *  a message they were merely copied on, not directly asked. */
export function isCcOnly(row: Pick<ClaimedInbox, 'channel_type' | 'account_email' | 'recipients'>): boolean {
  if (row.channel_type !== 'email' || !row.account_email || !row.recipients) return false;
  const me = row.account_email.toLowerCase();
  const to = row.recipients.to.map((a) => a.toLowerCase());
  const cc = row.recipients.cc.map((a) => a.toLowerCase());
  return cc.includes(me) && !to.includes(me);
}

/**
 * The live-triage watermark. A customer's `backfill_cutoff` is their go-live
 * instant: anything they sent BEFORE it was already history when we onboarded them,
 * so it is context to retrieve — never work to action.
 *
 * This guard is what makes pulling channel history safe. whatsapp_manager's backfill
 * saves historical rows with `updated_at = now()`, and reconcile.worker.ts polls
 * `GET /messages?updated_since=<cursor>` — an updated_at cursor, NOT a message-time
 * one. So a months-old backfilled message looks BRAND NEW to the reconciler, lands
 * here as 'pending', and would auto-create a task with no approval gate — hundreds of
 * junk tasks per pull. The backfill sweep's own starred gate does not help: that gate
 * is on the sweep, this is the live loop.
 *
 * Two semantics that must not be inverted:
 *   • NULL cutoff = triage EVERYTHING (the pre-watermark behavior). If NULL ever read
 *     as "skip", every customer onboarded before this column had a job would go
 *     silently mute. The `!cutoff` bail is load-bearing, not defensive noise.
 *   • The boundary is EXCLUSIVE (`< cutoff` skips; `>= cutoff` triages). Onboarding
 *     stamps the cutoff at now(), so a message landing on the same instant is live
 *     traffic and must be worked. Ties resolve toward triage — the safe direction,
 *     since the failure mode is a missed task rather than a muted customer.
 *
 * `received_at` IS the message's own send time (ingestion.ts writes `msg.sentAt` into
 * it); the row's insertion time is `created_at`. Comparing against received_at is the
 * whole point — created_at would be ~now() for every backfilled row and skip nothing.
 */
export function isPreCutoff(
  row: Pick<ClaimedInbox, 'received_at'>,
  config: Pick<CustomerConfig, 'backfillCutoff'>,
): boolean {
  const cutoff = config.backfillCutoff;
  if (!cutoff) return false; // NULL = triage everything. Never invert this.
  const sentAt = new Date(row.received_at);
  if (Number.isNaN(sentAt.getTime())) return false; // unparseable → triage (fail toward work, not silence)
  return sentAt.getTime() < cutoff.getTime();
}

/** The task-origin triple for a created/deduped task, keyed by channel type.
 *  Service-desk tickets must match the portal's OWN convention (frontend
 *  CreateProjectTaskDialog.tsx: sourceService='serviceDeskApp', entityType='Ticket')
 *  so the ticket detail page's "linked Projects tasks" card — which queries by
 *  those exact values — finds tasks this orchestrator creates too. */
export function resolveTaskSource(
  row: Pick<ClaimedInbox, 'channel_type' | 'ticket_number'>,
  threadKey: string,
  config: Pick<CustomerConfig, 'displayName'>,
): { service: string; entityType: string; entityId: string; display: string; url?: string } {
  if (row.channel_type === 'service_desk') {
    return {
      service: 'serviceDeskApp',
      entityType: 'Ticket',
      entityId: threadKey,
      display: row.ticket_number ?? threadKey,
      url: `/service-desk/tickets/${threadKey}`,
    };
  }
  return {
    service: 'agent-orchestrator',
    entityType: row.channel_type,
    entityId: threadKey,
    display: `${config.displayName} · ${threadKey}`,
  };
}

export interface TriageDeps {
  taskTarget: TaskTargetPort;
  llm: AgentLlmPort;
  notifier: FounderNotifierPort;
  contactQueries: ContactResolutionQueries;
  /** Best-effort portal deep link for a task ref (composition supplies from env). */
  deepLink: (taskRef: string) => string | undefined;
  /** Increment the skipped-unknown-sender tally (app_state counter). */
  bumpSkipped: () => Promise<void>;
  /** M2: the muted-group @-mention path (summarize + media). Optional — when absent
   *  a group-mention row is safely skipped rather than crashing the batch. */
  groupSummary?: GroupSummaryPort;
  /** M2a(b): scoped RAG retrieval into the triage context. Optional + best-effort —
   *  when absent (or on any retrieval error) triage runs with NO injected knowledge
   *  (the pre-M2a behavior). The retriever swallows its own errors (returns []). */
  knowledgeRetriever?: KnowledgeRetriever;
  /** M2a(c): the cited-draft responder for ANSWERABLE 'question_existing' intents.
   *  Optional + gated (KNOWLEDGE_DRAFT_ENABLED) — when absent, question_existing
   *  keeps creating a task (byte-for-byte the M1.5b behavior; the kill-switch is
   *  truly dormant). Requires the knowledgeRetriever too (drafts only when
   *  knowledge.length > 0), so both flags must be on to draft. */
  responseDrafter?: ResponseDrafter;
  /** M2(f): cross-channel semantic dedup (R52). Optional + gated
   *  (CROSS_CHANNEL_DEDUP_ENABLED) — when absent, dedup runs exactly as before
   *  (same-thread + title similarity). When present, a NEW intent that semantically
   *  matches a recent task for the SAME customer folds into it (a comment) instead of a
   *  second task; below the confidence gate it stays a separate task, and different
   *  customers are never merged. Best-effort: an embed/search miss degrades to the
   *  normal path (never blocks triage). */
  crossChannelDedup?: CrossChannelDedup;
  /** A customer asking to TALK → a booked meeting instead of a task. Optional + gated
   *  (MEETING_SCHEDULING_ENABLED) — when absent, `meeting_request` creates a task exactly as
   *  every other actionable category does (the pre-feature behavior). `tryInitiate` returning
   *  false has the same effect, so no calendar problem can cost the customer their ask. */
  meetingScheduler?: MeetingScheduler;
  /** WP2(c): needs-info clarification drafter. Optional + gated (NEEDS_INFO_DRAFT_ENABLED) — when
   *  present, an unclear/low-confidence intent ADDITIONALLY drafts a clarifying question to the
   *  customer (is_draft=true, approve/edit/reject) so the founder can one-tap ask. Absent = the
   *  pre-feature behavior (askFounder only). Best-effort: a draft failure never fails the row. */
  needsInfoDrafter?: NeedsInfoDrafter;
  /** WP6: the per-customer relationship-brief loader. Optional + gated (CUSTOMER_BRIEF_ENABLED) —
   *  when present, the customer's live brief is injected as CONTEXT-ONLY into the triage context.
   *  Best-effort by contract (load returns null on a miss/error), so a brief read NEVER blocks triage;
   *  absent = no brief section (byte-for-byte the pre-feature context). */
  customerBrief?: CustomerBriefLoader;
}

/** How far back (minutes) the group-mention path pulls images for attach/reference
 *  — mirrors the summarize window (last hour). */
const GROUP_LOOKBACK_MINUTES = 60;

export class TriageService {
  constructor(private readonly deps: TriageDeps) {}

  async process(row: ClaimedInbox): Promise<void> {
    // R49 idempotency short-circuit — applies to ALL paths (author + muted-group).
    // A prior attempt created the task then failed AT/AFTER notify (e.g. Telegram
    // down — the case M1.9 hardened) → re-notify + finish, never re-run the LLM/
    // summary or re-dedup. Hoisted above the group routing (DA finding 1) so a
    // reclaimed group-mention row does NOT re-summarize + add a spurious self-comment.
    if (await this.tryR49Reconfirm(row.id)) return;

    // M2 muted-group routing. A muted group is low-attention by design — act ONLY
    // when it @-mentions the founder. Flags come from raw_metadata->'metadata'
    // (claimBatch); ABSENT (null) on non-WA channels and history-backfill rows →
    // both conditions are falsy → the author path runs unchanged.
    if (row.is_group && row.chat_muted && !row.mentions_me) {
      await markSkipped(row.id, 'muted group, no mention');
      logger.info({ inboxId: row.id }, 'triage: muted group without mention — skipped');
      return;
    }
    if (row.is_group && row.chat_muted && row.mentions_me) {
      await this.processGroupMention(row);
      return;
    }

    const inboxId = row.id;
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
    await this.runMoneyLoop(row, customerId);
  }

  /**
   * R49: if this inbox row already produced a task (a prior attempt that failed
   * at/after notify), re-notify the task's customer and finish — never re-run the
   * LLM/summary or dedup. Returns true iff it handled the row. Shared by the author
   * path and the muted-group path so both are idempotent under reclaim.
   * Residual (unchanged): a crash MID-multi-intent leaves un-done intents unprocessed.
   */
  private async tryR49Reconfirm(inboxId: string): Promise<boolean> {
    const existing = await findTaskByInbox(inboxId);
    if (existing) {
      logger.info({ inboxId, taskRef: existing }, 'triage: task exists (R49) — re-notifying');
      const customerId = await findCustomerByTaskRef(existing);
      if (customerId) {
        await this.deps.notifier.notifyCustomerEvent(
          customerId,
          { title: '🆕 Task (confirmed)', body: 'A task created from an earlier message is confirmed.', url: this.deps.deepLink(existing), contextRef: { kind: 'inbox', ref: inboxId } },
          cancelButton(existing),
        );
      }
      await markProcessed(inboxId);
      return true;
    }
    // M2a(c): a prior attempt may have produced an OPEN cited DRAFT (answerable
    // question → no task). Re-present it and finish rather than re-drafting — the
    // reclaim-idempotency guard (blueprint must-fix #1), applied BEFORE the LLM
    // re-extract so a reclaimed answerable question never mints a second draft.
    if (this.deps.responseDrafter && (await this.deps.responseDrafter.reconfirmOpenDraft(inboxId))) {
      logger.info({ inboxId }, 'triage: open draft exists (R49) — re-presented');
      await markProcessed(inboxId);
      return true;
    }
    return false;
  }

  /**
   * The per-row money-loop: config load → context → intents → create/comment/dedup
   * → bridge/audit → notify → markProcessed. Shared by the author path and the
   * muted-group path (which passes a row with the group summary as subject/body and
   * the group's BP customer). PURE refactor of the original process() tail — same
   * ordering and side effects.
   */
  private async runMoneyLoop(row: ClaimedInbox, customerId: string): Promise<void> {
    const inboxId = row.id;
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

    if (isPreCutoff(row, config)) {
      await markSkipped(inboxId, 'pre-backfill-cutoff (history, not work)');
      logger.info(
        { inboxId, customerId, channelType: row.channel_type, cutoff: config.backfillCutoff?.toISOString() },
        'triage: message predates the backfill cutoff — skipped (context only)',
      );
      return;
    }

    const address = row.sender_address ?? '';
    const threadKey = row.channel_thread_id ?? address;
    const openTasks = await this.deps.taskTarget.findOpenTasks({ projectRef: config.projectRef });
    // M2a(b): scope RAG retrieval to THIS customer (customerId is the resolved,
    // known customer — never null here). Additive: [] when disabled or on error.
    const knowledge = await this.retrieveKnowledge(row, customerId);
    const priorTurns = row.channel_thread_id
      ? await loadPriorThreadConversation({
          instanceId: row.channel_instance_id,
          threadId: row.channel_thread_id,
          beforeReceivedAt: row.received_at,
          beforeInboxId: row.id,
          limit: 12,
        })
      : [];
    // WP6: best-effort relationship brief (CONTEXT-ONLY). A miss/error → no brief section (never
    // blocks triage); absent loader (feature off) → no brief section.
    const customerBrief = await this.loadCustomerBrief(customerId);
    const context = buildTriageContext({ subject: row.subject, body: row.body }, config, openTasks, knowledge, priorTurns, customerBrief);
    const intents = await this.deps.llm.extractIntents(context);

    if (intents.length === 0) {
      await recordTriageDecision({ customerId, inboxMessageId: inboxId, agentOutput: { intents: [] }, outcome: 'accepted' });
      await markProcessed(inboxId);
      return;
    }

    // Task refs created across this message's intents — so a second distinct intent
    // doesn't dedup into intent #1's just-created task (code-review #2).
    const createdThisRun = new Set<string>();
    const ccOnly = isCcOnly(row);
    for (const intent of intents) {
      await this.act(intent, { row, config, customerId, threadKey, openTasks, ccOnly, knowledge }, createdThisRun);
    }
    await markProcessed(inboxId);
  }

  /**
   * M2a(b): scoped, best-effort knowledge retrieval for the triage context. The
   * query is the message subject+body; the customer scope is the EXACT resolved
   * customerId (never null for a known customer). Returns [] when no retriever is
   * wired (feature off) or the message has no text. The retriever swallows its own
   * errors (returns []), so triage is never blocked by a retrieval miss.
   */
  private async retrieveKnowledge(row: ClaimedInbox, customerId: string): Promise<KnowledgeChunk[]> {
    const retriever = this.deps.knowledgeRetriever;
    if (!retriever) return [];
    const queryText = [row.subject, row.body].filter((s): s is string => !!s && s.trim().length > 0).join('\n');
    if (!queryText) return [];
    return retriever.retrieve(queryText, customerId);
  }

  /**
   * WP6: best-effort relationship-brief load for the triage context (CONTEXT-ONLY). Returns null when
   * no loader is wired (feature off) OR on ANY error — the loader is best-effort by contract, and this
   * belt-and-braces catch guarantees a bad brief read can never block the money loop.
   */
  private async loadCustomerBrief(customerId: string): Promise<string | null> {
    if (!this.deps.customerBrief) return null;
    try {
      return await this.deps.customerBrief.load(customerId);
    } catch (err) {
      logger.warn({ reason: (err as Error)?.message }, 'triage: brief load failed — proceeding without a brief');
      return null;
    }
  }

  /**
   * Muted-group @-mention path (M2). Bypasses author resolution: resolve
   * group → BP → customer, summarize the last hour (whatsapp_manager's vision
   * model reads the images; only the summary TEXT drives triage), then run the
   * money-loop on the summary and best-effort attach the raw images (Phase 2).
   *   • no summary        → skip + admin note (nothing actionable to triage).
   *   • BP not onboarded  → founder note (summary + keyless media refs) + ONE admin
   *                         onboard note + skip (do NOT auto-onboard).
   *   • onboarded         → runMoneyLoop(summary) → attach images to the task.
   */
  private async processGroupMention(row: ClaimedInbox): Promise<void> {
    const inboxId = row.id;
    const gs = this.deps.groupSummary;
    const groupId = row.channel_thread_id;
    if (!gs || !groupId) {
      await markSkipped(inboxId, 'group summary unavailable');
      logger.warn({ inboxId, hasPort: !!gs, hasGroup: !!groupId }, 'triage: group mention not processable — skipped');
      return;
    }

    const bpRef = await gs.resolveGroupBpRef(groupId);
    const customer = bpRef ? await this.deps.contactQueries.findCustomerByBpRef(bpRef) : null;

    const summary = await gs.summarizeLastHour(groupId);
    if (!summary) {
      await markSkipped(inboxId, 'summary unavailable');
      await this.deps.notifier.notifyAdmin({
        title: '⚠️ Group summary unavailable',
        body: `A muted group (${groupId}) @-mentioned you, but the last-hour summary could not be produced. Row skipped.`,
        severity: 'warning',
      });
      logger.info({ inboxId, groupId }, 'triage: group summary unavailable — skipped');
      return;
    }

    if (!customer) {
      // Un-onboarded BP: still surface the summary + keyless media refs to the
      // founder, raise ONE admin onboard note, and skip. No auto-onboard (project +
      // work-item-type aren't derivable).
      const images = await this.gatherGroupImages(groupId, gs);
      await this.deps.notifier.notifyAdmin({
        title: '🔗 Group not onboarded',
        body: `Muted group ${groupId} @-mentioned you but is not linked to an onboarded BP (${bpRef ? `BP ${bpRef}` : 'no BP link'}). Link/onboard it so future mentions create tasks.`,
        severity: 'action',
      });
      await this.deps.notifier.notifyAdmin({
        title: '🖼️ Group summary (no task)',
        body: this.groupSummaryBody(summary, images, gs),
        severity: 'info',
      });
      await markSkipped(inboxId, 'group BP not onboarded');
      logger.info({ inboxId, groupId, hasBp: !!bpRef }, 'triage: group BP not onboarded — founder-notified + skipped');
      return;
    }

    // Feed the summary through the normal money-loop (task if actionable).
    await this.runMoneyLoop({ ...row, subject: summary.title, body: summary.body }, customer.customerId);

    // Phase 2: best-effort, non-fatal attach of the last-hour raw images.
    await this.attachGroupImages(row, customer.customerId, groupId, summary, gs);
  }

  /**
   * Phase 2 attach: after the money-loop, attach the group's last-hour images to
   * the created task. NEVER fails the row (it is already processed/skipped) —
   * per-file try/catch with an admin note on upload failure. When NO task exists
   * (non-actionable summary), the founder notification carries the keyless refs.
   */
  private async attachGroupImages(
    row: ClaimedInbox,
    customerId: string,
    groupId: string,
    summary: GroupSummary,
    gs: GroupSummaryPort,
  ): Promise<void> {
    const inboxId = row.id;
    try {
      const taskRef = await findTaskByInbox(inboxId);
      const images = await this.gatherGroupImages(groupId, gs);

      if (!taskRef) {
        // No task created → reference the media in a founder notification instead.
        if (images.length) {
          await this.deps.notifier
            .notifyCustomerEvent(customerId, {
              title: '🖼️ Group images (no task)',
              body: this.groupSummaryBody(summary, images, gs),
            })
            .catch((err) => logger.warn({ inboxId, reason: (err as Error)?.message }, 'group: media-ref notify failed'));
        }
        return;
      }

      for (const img of images) {
        try {
          const media = await gs.fetchMedia(img.ref);
          await this.deps.taskTarget.attachFileToTask({ ref: taskRef }, media.bytes, media.filename, media.contentType);
        } catch (err) {
          // One bad file never strands the row (already processed). Reference the
          // keyless media url in an admin note so the founder can retrieve it.
          logger.warn({ inboxId, taskRef, ref: img.ref, reason: (err as Error)?.message }, 'group: attach image failed (non-fatal)');
          await this.deps.notifier
            .notifyAdmin({
              title: '📎 Task image attach failed',
              body: `Could not attach a group image (ref ${img.ref}) to task ${taskRef}. Reference: ${gs.mediaUrl(img.ref)}`,
              severity: 'warning',
            })
            .catch(() => {});
        }
      }
    } catch (err) {
      // The whole attach path is best-effort — swallow anything so the row (already
      // processed by runMoneyLoop) is never re-failed by an attach hiccup.
      logger.warn({ inboxId, reason: (err as Error)?.message }, 'group: attach path failed (non-fatal)');
    }
  }

  /** List the group's last-hour images defensively (never throws — a listing miss
   *  must not fail the row). */
  private async gatherGroupImages(groupId: string, gs: GroupSummaryPort): Promise<GroupImageRef[]> {
    try {
      return await gs.listRecentImages(groupId, GROUP_LOOKBACK_MINUTES);
    } catch (err) {
      logger.warn({ groupId, reason: (err as Error)?.message }, 'group: listRecentImages failed (non-fatal)');
      return [];
    }
  }

  /** Founder-facing body: summary + keyless media reference urls (NEVER api-keyed). */
  private groupSummaryBody(summary: GroupSummary, images: GroupImageRef[], gs: GroupSummaryPort): string {
    const parts = [summary.title, '', summary.body];
    if (images.length) {
      parts.push('', `Images (${images.length}):`, ...images.map((i) => gs.mediaUrl(i.ref)));
    }
    return parts.join('\n');
  }

  private async act(
    intent: Intent,
    ctx: { row: ClaimedInbox; config: CustomerConfig; customerId: string; threadKey: string; openTasks: TargetTask[]; ccOnly: boolean; knowledge: KnowledgeChunk[] },
    createdThisRun: Set<string>,
  ): Promise<void> {
    const { row, config, customerId, threadKey } = ctx;
    const inboxId = row.id;
    const projectRef = config.projectRef as string; // process() guarded non-null
    const workItemTypeRef = config.workItemTypeRef as string;

    // CC-only email → context only UNLESS it's an explicit, CONFIDENT ask
    // (actionable category AND confidence ≥ threshold). A CC'd unclear/low-confidence
    // message must NOT ping the founder (DA residual #1) — they were merely copied,
    // not asked; so this guard precedes (and suppresses) the askFounder branch.
    if (ctx.ccOnly && !(ACTIONABLE.has(intent.category) && intent.confidence >= CONFIDENCE_MIN)) {
      await recordTriageDecision({ customerId, inboxMessageId: inboxId, agentOutput: intent, outcome: 'accepted' });
      return;
    }

    // Low confidence / unclear → human-in-the-loop, no task (design triage contract).
    // Record the audit row BEFORE notifying (code-review: a failed notify must not
    // lose the decision) — matches the create/comment branches' order.
    if (intent.confidence < CONFIDENCE_MIN || intent.category === 'unclear') {
      await recordTriageDecision({ customerId, inboxMessageId: inboxId, agentOutput: intent, outcome: 'pending' });
      await this.deps.notifier.notifyCustomerEvent(customerId, {
        title: '❓ Needs your input',
        body: `An unclear message from ${config.displayName} (${intent.category}). Please review:\n“${intent.summary}”`,
        severity: 'action',
        contextRef: { kind: 'inbox', ref: inboxId },
      });
      // WP2(c): ADDITIVELY hand the founder a ready-made clarification draft to send (gated —
      // absent by default → askFounder-only, unchanged). Best-effort: a compose/enqueue failure
      // must NOT fail the row (the founder already got the notice above), so it is swallowed here.
      if (this.deps.needsInfoDrafter && !ctx.ccOnly) {
        try {
          await this.deps.needsInfoDrafter.draftClarification({ row, customerId, config, threadKey, intent });
        } catch (err) {
          logger.warn({ inboxId, reason: (err as Error)?.message }, 'triage: needs-info clarification draft failed (non-fatal)');
        }
      }
      return;
    }

    // Context categories are terminal. Previously they fell through into dedup +
    // createTask, so even a correctly classified "thanks" / compliment created a
    // project task. ACTIONABLE was documented as the allow-list but was only used
    // by the CC rule; enforce it at the mutation boundary for every channel.
    const mutationGate = taskMutationGate(intent);
    if (mutationGate === 'context') {
      await recordTriageDecision({ customerId, inboxMessageId: inboxId, agentOutput: intent, outcome: 'accepted' });
      return;
    }

    // A category alone is not authority to mutate the project. The extractor must
    // affirm that the CURRENT customer message contains the ask; conversation
    // history can explain a reply but cannot donate actionability to "thanks" or an
    // emoji. Any contradictory actionable classification is held for review.
    // Undefined is accepted only for legacy/injected AgentLlmPort implementations;
    // every built-in provider is schema-validated and always returns the boolean.
    if (mutationGate === 'confirm') {
      await recordTriageDecision({ customerId, inboxMessageId: inboxId, agentOutput: intent, outcome: 'pending' });
      await this.deps.notifier.notifyCustomerEvent(customerId, {
        title: '❓ Confirm before creating a task',
        body: `${config.displayName}: the message was classified as ${intent.category}, but it contains no explicit request. No project task was created.\n“${intent.summary}”`,
        severity: 'action',
        contextRef: { kind: 'inbox', ref: inboxId },
      });
      return;
    }

    // A customer asking to TALK wants a meeting, not a task. Before this branch existed,
    // "avisame cuando puedes hablar" was triaged follow_up and became TSK-00249 — a task whose
    // whole content was "a customer wants to talk to you", leaving the founder to open a
    // calendar, pick a time, and reply by hand. Now: real availability → duration → slot → a
    // booked Meet event with the customer invited → a confirmation on the origin channel.
    //
    // Placed AFTER the confidence/'confirm' gates so it inherits them (a vague "we should talk
    // sometime" has explicit_action_request=false → 'confirm' → no meeting, no task), and
    // guarded on !ccOnly for the same reason the drafter below is: a message the founder was
    // merely copied on must not book their calendar.
    //
    // tryInitiate returns FALSE for every "cannot start" case (no host calendar, unreadable
    // free/busy, no free slots) → fall through to the task path below, exactly as before this
    // feature existed. Absent dep = pre-feature behavior, per the TriageDeps convention.
    // The scheduler records its OWN decision row once it claims the conversation, so nothing is
    // recorded here — a fall-through must leave the task path free to record exactly one.
    if (intent.category === 'meeting_request' && this.deps.meetingScheduler && !ctx.ccOnly) {
      const started = await this.deps.meetingScheduler.tryInitiate({
        customerId,
        inboxMessageId: inboxId,
        intent,
        threadId: config.telegramTopicId ?? threadKey,
        displayName: config.displayName,
        customerTz: config.timezone,
        channelType: row.channel_type,
        channelInstanceId: row.channel_instance_id,
        senderAddress: row.sender_address ?? '',
        recipientAddress: row.sender_address ?? '',
        threadKey,
        inReplyTo: row.channel_message_id,
        summary: intent.summary,
        preferredLanguage: config.preferredLanguage,
      });
      if (started) return; // the meeting conversation owns this message — NOT a task
      // else: fall through to dedup + createTask, exactly as before this feature existed
    }

    // M2a(c): ANSWERABLE 'question_existing' → a cited DRAFT reply (no task). Gated:
    // requires the drafter wired (KNOWLEDGE_DRAFT_ENABLED) AND retrieved knowledge
    // (knowledge.length > 0, which needs KNOWLEDGE_RETRIEVAL_ENABLED) — so the
    // kill-switch is truly dormant by default. Excludes CC-only mail (must-fix #8):
    // a message the founder was merely copied on must not auto-draft a reply. When
    // any condition is false, the existing task path below runs unchanged.
    if (
      intent.category === 'question_existing' &&
      this.deps.responseDrafter &&
      ctx.knowledge.length > 0 &&
      !ctx.ccOnly
    ) {
      await this.deps.responseDrafter.draftAndPresent({
        row,
        customerId,
        config,
        threadKey,
        knowledge: ctx.knowledge,
        intent,
      });
      return; // answerable question → cited draft, NOT a task (the drafter records its own draft_reply decision)
    }

    // M2(f): embed this intent ONCE (title+summary) when cross-channel dedup is wired —
    // reused for the semantic match below AND, on create, the stored fingerprint (no
    // double embed). Best-effort: null when off or the embed failed → the pre-M2f flow.
    const ccDedup = this.deps.crossChannelDedup;
    const matchEmbedding = ccDedup ? await ccDedup.embed(`${intent.suggested_title}\n${intent.summary}`) : null;

    const source = resolveTaskSource(row, threadKey, config);
    const dedup = await decideDedup(
      intent,
      {
        source,
        projectRef,
        openTasks: ctx.openTasks,
        excludeTaskRefs: createdThisRun,
        customerId,
        matchEmbedding,
      },
      {
        taskTarget: this.deps.taskTarget,
        llm: this.deps.llm,
        crossChannel: ccDedup ? (input) => ccDedup.match(input) : undefined,
      },
    );

    if (dedup.action === 'comment') {
      await this.deps.taskTarget.addComment({ ref: dedup.taskRef }, `[agent-orchestrator] ${intent.summary}`);
      await recordTaskBridge({ taskRef: dedup.taskRef, customerId, inboxMessageId: inboxId, relationship: 'contributed_to' });
      await recordTriageDecision({ customerId, inboxMessageId: inboxId, agentOutput: intent, outcome: 'accepted', taskRef: dedup.taskRef });
      await this.deps.notifier.notifyCustomerEvent(customerId, {
        title: '💬 Comment added',
        body: `Added to an existing task for ${config.displayName}:\n“${intent.summary}”`,
        url: this.deps.deepLink(dedup.taskRef),
        contextRef: { kind: 'inbox', ref: inboxId },
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
      source,
      tags: [intent.category],
    });
    createdThisRun.add(task.ref); // exclude from sibling intents' thread dedup (code-review #2)
    // M2(f): store this task's intent fingerprint so a later same-topic message on
    // ANOTHER channel folds into it (best-effort — a miss only risks a future duplicate,
    // never the row). Reuses the embedding computed for the match above (no double embed).
    if (ccDedup && matchEmbedding) {
      await ccDedup.record({ customerId, taskRef: task.ref, channelType: row.channel_type, embedding: matchEmbedding });
    }
    await recordTaskBridge({ taskRef: task.ref, customerId, inboxMessageId: inboxId, relationship: 'created_from' });
    await recordTriageDecision({ customerId, inboxMessageId: inboxId, agentOutput: intent, outcome: 'accepted', taskRef: task.ref });
    await this.deps.notifier.notifyCustomerEvent(
      customerId,
      {
        title: `🆕 New task · ${intent.priority}`,
        body: `${config.displayName}: ${intent.suggested_title}\n“${intent.summary}”`,
        url: this.deps.deepLink(task.ref),
        contextRef: { kind: 'inbox', ref: inboxId },
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
