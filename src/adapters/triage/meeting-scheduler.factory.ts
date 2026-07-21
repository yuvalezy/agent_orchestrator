import { DateTime } from 'luxon';
import { env } from '../../config/env';
import { logger } from '../../logger';
import { findTriageIntent, recordTaskBridge, recordTriageDecision, resolveTriageDecision } from '../../decisions/decisions';
import { loadBusinessHours, loadHolidays } from '../../outbound/outbound-repo';
import { toSoftBlocks } from '../../outbound/send-window';
import type { FounderNotifierPort } from '../../ports/founder-notifier.port';
import type { TaskTargetPort } from '../../ports/task-target.port';
import type { Intent, ScheduleInterpreterPort } from '../../ports/llm.port';
import { loadCustomerConfig } from '../../triage/context-loader';
import { dueEventId } from '../../triage/due-event-sync';
import { buildMeetingDecisionHandler, type MeetingDecisionHandler } from '../../triage/meeting-decision-handler';
import { buildMeetingFreeTextHook } from '../../triage/meeting-free-text';
import { buildMeetingScheduler, type MeetingScheduler } from '../../triage/meeting-scheduler';
import type { MeetingRequest } from '../../triage/meeting-repo';
import { buildMeetingFallbackWorker } from '../../triage/meeting-fallback.worker';
import type { WorkerDefinition } from '../../workers/worker-runner';
import {
  claimMeetingGiveUp,
  claimMeetingRequest,
  claimForCreating,
  enqueueMeetingConfirmation,
  getMeetingRequest,
  markScheduled,
  completeMeetingGiveUp,
  listPendingMeetingFallbacks,
  reclaimStuckMeetingFallbacks,
  releaseMeetingGiveUp,
  releaseToAwaitingSlot,
  replaceSlots,
  setDurationAndSlots,
  setMeetingDecisionId,
} from '../../triage/meeting-repo';
import { resolveMeetingHostTarget } from '../calendar/calendar-write-target';
import { taskDeepLink } from '../shared/portal-url';
import { buildDynamicMultiFreeBusy, buildFreeBusyAccounts } from '../calendar/google-freebusy';
import { listEnabledCalendarAccounts } from '../connectors/calendar-accounts-repo';
import { findContactEmail } from '../../customers/contact-resolution';

// Composition root for meeting scheduling (M5 — the TSK-00249 fix). The ONLY place the core
// scheduler meets Google, Postgres, and Telegram (D1: the core imports none of them).
//
// Gated on MEETING_SCHEDULING_ENABLED. When off, buildMeetingSchedulerGated returns undefined →
// TriageService's optional dep is absent → `meeting_request` creates a task exactly as every
// other actionable category does. The kill-switch is genuinely dormant.
//
// ⚠︎ Availability works on TODAY's credentials but BOOKING does not. freebusy.query needs only
// calendar.readonly, while events.insert needs calendar.events — and every calendar account here
// was consented BEFORE that scope was added, so it reads fine and 403s on every write until
// re-connected in the console. The scheduler handles that explicitly (403 → task + a re-connect
// prompt), which is why this can ship before the re-consent happens.

/** The horizon slots are searched over — also the window free/busy is read for. */
const HORIZON_DAYS = 7;

/**
 * Rebuild the project task this meeting request would have been, from what is already persisted.
 *
 * This is the escape hatch for every failure discovered AFTER the founder was asked (triage has
 * long since returned by then, so its own fall-through cannot help). The intent is read back out
 * of the decision row rather than duplicated onto the meeting request — one source of truth, and
 * the decision row had to exist anyway for the audit.
 */
function buildTaskFallback(taskTarget: TaskTargetPort, deepLink: (ref: string) => string | undefined) {
  return async (m: MeetingRequest): Promise<{ url?: string } | null> => {
    if (!m.decision_id) return null;
    const intent = (await findTriageIntent(m.decision_id)) as Intent | null;
    if (!intent) return null;

    const config = await loadCustomerConfig(m.customer_id);
    if (!config?.projectRef || !config.workItemTypeRef) return null;

    // A fallback retry can follow an ambiguous timeout-after-commit. Reconcile
    // before every create using a meeting-request-specific source key so a retry
    // finds exactly this fallback, never another task from the same long-lived
    // channel thread.
    const source = {
      service: 'agent-orchestrator',
      entityType: 'meeting_request',
      entityId: m.id,
      display: `${config.displayName} · meeting fallback`,
    };
    const existing = await taskTarget.findTasksBySource({
      projectRef: config.projectRef,
      sourceEntity: { service: source.service, type: source.entityType, id: source.entityId },
    });
    const task = existing[0] ?? await taskTarget.createTask({
      customerRef: config.bpRef,
      projectRef: config.projectRef,
      workItemTypeRef: config.workItemTypeRef,
      title: intent.suggested_title,
      description: `${intent.summary}\n\n---\n(created by agent-orchestrator — a meeting could not be scheduled)`,
      priority: intent.priority,
      source,
      tags: [intent.category],
    });
    // Same bridge + audit bookkeeping the normal task path does, so the console's customer
    // timeline shows this task against the message that caused it.
    await recordTaskBridge({
      taskRef: task.ref,
      customerId: m.customer_id,
      inboxMessageId: m.inbox_message_id,
      relationship: 'created_from',
    });
    await resolveTriageDecision(m.decision_id, 'modified'); // the agent's plan changed en route
    return { url: deepLink(task.ref) };
  };
}

/**
 * The outcome of booking a founder-picked wall-clock time from a rich client (the PWA's
 * "another time" datetime picker). `unavailable` means onTypedTime refused it (busy/past) and
 * ALREADY told the founder through the notifier — which now fans out to the app feed too — so the
 * caller adds no message of its own; it just reports the status back for inline UI.
 */
export type AppMeetingTimeOutcome =
  | { status: 'booked' }
  | { status: 'unavailable' }
  | { status: 'not_pending' }
  | { status: 'invalid' };

export interface MeetingWiring {
  scheduler: MeetingScheduler;
  decisions: MeetingDecisionHandler;
  /** The pending-ask `onUnmatched` hook, so a founder can answer "📅 Pick a time" by TYPING one.
   *  Only present when an LLM is supplied to parse the time (the callback poller has one; the
   *  inbox processor does not need this hook at all — it never reads founder messages). */
  freeText?: ReturnType<typeof buildMeetingFreeTextHook>;
  /**
   * Book a wall-clock time the founder chose in a rich client (the PWA datetime picker),
   * interpreted in the meeting's OWN founder tz — the same zone the offered slots were rendered
   * in, never the server's or the phone's. This is the PWA's equal to Telegram's "reply with a
   * time": it reuses `onTypedTime` verbatim, so a busy or past time is refused and re-notified
   * identically, and a booking books through the SAME fanout notifier (Telegram + app). No LLM —
   * a native picker yields an unambiguous instant, so there is nothing to parse.
   */
  bookLocalTime: (input: { meetingId: string; localTime: string; by: string }) => Promise<AppMeetingTimeOutcome>;
}

/**
 * Build the scheduler + its decision handler, or undefined when the feature is off.
 * `notifier` is the same Telegram notifier triage uses, so the buttons land in the customer's
 * own topic and a tap routes back through the shared decision router.
 */
export function buildMeetingSchedulerGated(
  taskTarget: TaskTargetPort,
  notifier: FounderNotifierPort,
  /**
   * Supply to let the founder answer "📅 Pick a time" in words. Omitted → buttons only, which is
   * right for the inbox processor: it builds a scheduler to START conversations and never reads
   * a founder message, so wiring an LLM there would buy nothing and cost a router per boot.
   */
  freeTextDeps?: {
    /** A THUNK, not the router: it is called once, past the feature gate, so a boot with
     *  meeting scheduling off does not construct an LLM router (and its failover/cost-cap
     *  machinery) for a hook that will never run. */
    llm: () => Pick<ScheduleInterpreterPort, 'interpretSchedule'>;
    /** Reply in the founder's thread. Not on FounderNotifierPort — the port speaks in
     *  Notifications; this is a plain line back into the same topic. */
    postAnswer: (threadId: string, text: string) => Promise<void>;
  },
): MeetingWiring | undefined {
  if (!env.MEETING_SCHEDULING_ENABLED) {
    logger.info({}, 'meeting scheduling NOT wired (MEETING_SCHEDULING_ENABLED=false) — a meeting_request creates a task');
    return undefined;
  }
  logger.info({}, 'meeting scheduling wired (MEETING_SCHEDULING_ENABLED=true) — a meeting_request books a call');

  const freeBusy = buildDynamicMultiFreeBusy(() =>
    buildFreeBusyAccounts({
      listEnabled: async () =>
        (await listEnabledCalendarAccounts()).map((a) => ({
          label: a.label,
          credentialName: a.credentialName,
          calendarId: a.calendarId,
        })),
      legacyCalendarId: env.CALENDAR_ID,
    }),
  );

  // The ONE canonical formatter (adapters/shared/portal-url.ts) — it trims the base, encodes the
  // ref, and yields no link at all rather than a malformed one. The route is real: the portal's
  // ProjectsApp mounts `tasks/:id` → TaskDetailPage.
  const deepLink = (taskRef: string): string | undefined => taskDeepLink(env.EZY_PORTAL_BASE_URL, taskRef);

  const scheduler = buildMeetingScheduler({
    freeBusy,
    notifier,
    resolveHost: resolveMeetingHostTarget,
    resolveAttendeeEmail: (channelType, address) => findContactEmail(channelType, address),
    loadSchedule: async () => {
      const today = DateTime.now().setZone(env.CALENDAR_TZ);
      return {
        businessHours: await loadBusinessHours(),
        holidays: await loadHolidays(
          today.toISODate() ?? '',
          today.plus({ days: HORIZON_DAYS + 1 }).toISODate() ?? '',
        ),
        // Soft holds (walk / gym) come from env, not the DB — the AUTO-PROPOSAL avoids them; a
        // founder-typed / manual booking is never vetoed by them (onTypedTime uses slotConflicts).
        softBlocks: toSoftBlocks(env.CALENDAR_SOFT_BLOCKS),
      };
    },
    fallbackToTask: buildTaskFallback(taskTarget, deepLink),
    recordDecision: async (i) => {
      const { decisionId } = await recordTriageDecision({
        customerId: i.customerId,
        inboxMessageId: i.inboxMessageId,
        agentOutput: i.intent,
        outcome: 'accepted',
      });
      return decisionId;
    },
    repo: {
      claim: claimMeetingRequest,
      setDecisionId: setMeetingDecisionId,
      get: getMeetingRequest,
      setDurationAndSlots,
      replaceSlots,
      claimForCreating,
      markScheduled,
      claimGiveUp: claimMeetingGiveUp,
      releaseGiveUp: releaseMeetingGiveUp,
      completeGiveUp: completeMeetingGiveUp,
      releaseToAwaitingSlot,
      enqueueConfirmation: enqueueMeetingConfirmation,
    },
    // Reuses the due-event id derivation (sha256 → a base32hex-legal 'ao…' prefix) — Google
    // rejects an id outside that alphabet with a 400. Keyed on the REQUEST id alone, so a
    // replayed tap collides at the API (409) instead of minting a second event.
    eventId: (meetingRequestId) => dueEventId(`meeting:${meetingRequestId}`),
    founderTz: env.CALENDAR_TZ,
    slotOptions: { count: 4, leadMinutes: 60, horizonDays: HORIZON_DAYS },
  });

  // Glue, not scheduling: turn a UI wall-clock string into the absolute instant the core port
  // speaks in, anchored in the founder's zone. Kept out of core (which deals only in Dates) — the
  // wall-clock↔zone mapping is a client-shape concern that belongs at the composition edge.
  const bookLocalTime = async ({
    meetingId,
    localTime,
    by,
  }: {
    meetingId: string;
    localTime: string;
    by: string;
  }): Promise<AppMeetingTimeOutcome> => {
    const m = await getMeetingRequest(meetingId);
    // Same guard onTypedTime applies, checked here so the caller can distinguish a stale card
    // (nothing to do) from a real refusal (busy/past, which onTypedTime notifies about).
    if (!m || m.status !== 'awaiting_slot' || !m.duration_minutes) return { status: 'not_pending' };
    const dt = DateTime.fromISO(localTime, { zone: m.founder_tz ?? env.CALENDAR_TZ });
    if (!dt.isValid) return { status: 'invalid' };
    return { status: (await scheduler.onTypedTime(meetingId, dt.toJSDate(), by)) ? 'booked' : 'unavailable' };
  };

  return {
    scheduler,
    decisions: buildMeetingDecisionHandler(scheduler),
    bookLocalTime,
    freeText: freeTextDeps
      ? buildMeetingFreeTextHook(((interpreter) => ({
          onTypedTime: (meetingId, startsAt, by) => scheduler.onTypedTime(meetingId, startsAt, by),
          postAnswer: freeTextDeps.postAnswer,
          parseTime: async ({ text, meetingId }) => {
            const m = await getMeetingRequest(meetingId);
            if (!m) return null;
            const tz = m.founder_tz ?? env.CALENDAR_TZ;
            const config = await loadCustomerConfig(m.customer_id);
            // Reuses the SAME interpreter the founder's own scheduling commands go through,
            // rather than a second time parser: it already carries the timezone handling, the
            // weekday rules, and the merge semantics — including the fix for Spanish weekday
            // names, which drifted a day forward and would have booked real customers on the
            // wrong date. Two parsers would mean two sets of those rules to keep true.
            //
            // Framing it as the answer to OUR question is what lets a bare "thursday 3pm" — no
            // verb, no action — resolve to an instant rather than to a clarify. Measured, not
            // assumed: 4/5 phrasings parsed correctly this way before the weekday fix, 10/10
            // after (3 runs each).
            const r = await interpreter.interpretSchedule(
              {
                commandText: text,
                priorCommandText: `set up a ${m.duration_minutes ?? 30} minute meeting with this customer`,
                priorClarification: 'Pick a time — when should the call be?',
                repliedText: null,
                mappedOutboundBody: null,
                customerName: config?.displayName ?? 'the customer',
                nowIso: DateTime.now().setZone(tz).toISO() ?? new Date().toISOString(),
                timezone: tz,
              },
              m.customer_id,
            );
            // A clarify (or anything with no instant) means "no time in there" — the hook says
            // so and keeps the question. Never guess at a time that books a real meeting.
            return r.execute_at ? new Date(r.execute_at) : null;
          },
        }))(freeTextDeps.llm()))
      : undefined,
  };
}

/**
 * Standalone durable fallback worker. It is intentionally separate from the
 * Telegram callback poller so retries also run in app-only deployments.
 */
export function buildMeetingFallbackWorkerGated(
  taskTarget: TaskTargetPort,
  notifier: FounderNotifierPort,
  intervalMs = 30_000,
): WorkerDefinition | undefined {
  const wiring = buildMeetingSchedulerGated(taskTarget, notifier);
  if (!wiring) return undefined;
  return buildMeetingFallbackWorker({
    reclaimStuck: reclaimStuckMeetingFallbacks,
    listPending: listPendingMeetingFallbacks,
    retryFallback: (id) => wiring.scheduler.retryFallback(id),
    intervalMs,
    log: logger,
  });
}
