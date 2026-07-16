import { DateTime } from 'luxon';
import { env } from '../../config/env';
import { logger } from '../../logger';
import { findTriageIntent, recordTaskBridge, recordTriageDecision, resolveTriageDecision } from '../../decisions/decisions';
import { loadBusinessHours, loadHolidays } from '../../outbound/outbound-repo';
import type { FounderNotifierPort } from '../../ports/founder-notifier.port';
import type { TaskTargetPort } from '../../ports/task-target.port';
import type { Intent } from '../../ports/llm.port';
import { loadCustomerConfig } from '../../triage/context-loader';
import { dueEventId } from '../../triage/due-event-sync';
import { buildMeetingDecisionHandler, type MeetingDecisionHandler } from '../../triage/meeting-decision-handler';
import { buildMeetingScheduler, type MeetingScheduler } from '../../triage/meeting-scheduler';
import type { MeetingRequest } from '../../triage/meeting-repo';
import {
  claimMeetingRequest,
  claimForCreating,
  enqueueMeetingConfirmation,
  getMeetingRequest,
  markMeetingFailed,
  markScheduled,
  releaseToAwaitingSlot,
  replaceSlots,
  setDurationAndSlots,
  setMeetingDecisionId,
} from '../../triage/meeting-repo';
import { resolveMeetingHostTarget } from '../calendar/calendar-write-target';
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
function buildTaskFallback(taskTarget: TaskTargetPort, deepLink: (ref: string) => string) {
  return async (m: MeetingRequest): Promise<{ url?: string } | null> => {
    if (!m.decision_id) return null;
    const intent = (await findTriageIntent(m.decision_id)) as Intent | null;
    if (!intent) return null;

    const config = await loadCustomerConfig(m.customer_id);
    if (!config?.projectRef || !config.workItemTypeRef) return null;

    const task = await taskTarget.createTask({
      customerRef: config.bpRef,
      projectRef: config.projectRef,
      workItemTypeRef: config.workItemTypeRef,
      title: intent.suggested_title,
      description: `${intent.summary}\n\n---\n(created by agent-orchestrator — a meeting could not be scheduled)`,
      priority: intent.priority,
      source: {
        service: 'agent-orchestrator',
        entityType: m.channel_type ?? 'whatsapp',
        entityId: m.thread_key ?? m.recipient_address ?? m.customer_id,
        display: `${config.displayName} · ${m.thread_key ?? ''}`,
      },
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

export interface MeetingWiring {
  scheduler: MeetingScheduler;
  decisions: MeetingDecisionHandler;
}

/**
 * Build the scheduler + its decision handler, or undefined when the feature is off.
 * `notifier` is the same Telegram notifier triage uses, so the buttons land in the customer's
 * own topic and a tap routes back through the shared decision router.
 */
export function buildMeetingSchedulerGated(
  taskTarget: TaskTargetPort,
  notifier: FounderNotifierPort,
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

  const deepLink = (taskRef: string): string => `${env.EZY_PORTAL_BASE_URL}/projects/tasks/${taskRef}`;

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
      markFailed: markMeetingFailed,
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

  return { scheduler, decisions: buildMeetingDecisionHandler(scheduler) };
}
