import { randomBytes } from 'node:crypto';
import { env } from '../../config/env';
import { logger } from '../../logger';
import { buildLlmRouter } from '../llm/factory';
import type { TelegramNotifier } from '../telegram/telegram-notifier';
import { buildScheduleHandlers, isScheduleOption, type ScheduleHandlers } from '../../scheduling/schedule-handler';
import { buildRecipientProfileAdapter } from '../whatsapp-manager/factory';
import type { ThreadMarkers } from '../../triage/thread-markers';
import {
  createScheduledAction,
  findCustomerByTelegramTopic,
  listCustomerEmailContacts,
  listFounderEmails,
  listScheduleRouteCandidates,
  loadMappedOutboundBody,
  resolveScheduleRoute,
  resolveTelegramReplyOrigin,
} from '../../scheduling/scheduling-repo';
import type { MeetingCommandDeps } from '../../scheduling/schedule-handler';
import { resolveMeetingHostTarget } from '../calendar/calendar-write-target';
import { buildDynamicMultiFreeBusy, buildFreeBusyAccounts } from '../calendar/google-freebusy';
import { listEnabledCalendarAccounts } from '../connectors/calendar-accounts-repo';
import { dueEventId } from '../../triage/due-event-sync';
import { mergeBusy } from '../../triage/meeting-slots';
import { safeMeetingCalendarTitle } from '../../scheduling/meeting-title';

export interface GatedScheduling extends ScheduleHandlers {
  isScheduleOption: (optionId: string) => boolean;
}

/**
 * The founder-initiated meeting lane's I/O ("set up a meeting with X thursday 3pm"). Shares the
 * MEETING_SCHEDULING_ENABLED flag and the same host calendar as the customer-initiated lane —
 * one place to turn meetings on, one identity customers see an invitation from.
 *
 * Null when meetings are off, which the handler reports rather than ignoring: a founder who
 * typed a command deserves an answer.
 */
export function buildMeetingCommandDeps(): MeetingCommandDeps | null {
  if (!env.MEETING_SCHEDULING_ENABLED) return null;

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

  return {
    listContacts: listCustomerEmailContacts,
    founderEmails: listFounderEmails,
    // Titles are not available from freebusy (it returns opaque intervals), so a clash is
    // reported as a count-free "you are busy" rather than a fabricated event name. Best-effort
    // BY DESIGN here, unlike the customer-initiated lane's fail-closed slot search: the founder
    // NAMED this time, so an unreadable calendar costs them a warning, not the booking.
    conflictsAt: async (startsAt, endsAt) => {
      const busy = mergeBusy(await freeBusy.queryFreeBusy({ timeMin: startsAt, timeMax: endsAt }));
      return busy.length ? ['an existing event'] : [];
    },
    book: async (input) => {
      const host = await resolveMeetingHostTarget();
      if (!host) throw Object.assign(new Error('no meeting-host calendar'), { status: 404 });
      const created = await host.writer.createEvent({
        calendarId: host.calendarId,
        title: safeMeetingCalendarTitle(input.title),
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        timeZone: env.CALENDAR_TZ,
        description: 'Scheduled by agent-orchestrator from a founder command.',
        attendeeEmails: input.attendeeEmails.length ? input.attendeeEmails : undefined,
        // Same derivation as the customer-initiated lane (sha256 → a base32hex-legal id Google
        // will accept), keyed on the ORIGINAL command's ids: a redelivered tap collides at the
        // API with a 409 instead of booking a second event.
        eventId: dueEventId(`cmd:${input.idempotencyKey}`),
        conference: true,
        sendUpdates: input.attendeeEmails.length ? 'all' : 'none',
      });
      return { meetLink: created.meetLink, htmlLink: created.htmlLink, alreadyExisted: created.alreadyExisted };
    },
    defaultDurationMinutes: env.CALENDAR_DUE_EVENT_DURATION_MINUTES,
  };
}

/**
 * Wire the scheduling message + button handlers (null when the feature is off).
 *
 * `markers` is passed in rather than built here: the schedule marker must share ONE
 * mutual-exclusion set with the ✏️ Edit / 🔁 Revise captures, so a thread can never be
 * armed for two of them at once.
 */
export function buildSchedulingGated(notifier: TelegramNotifier, markers: ThreadMarkers): GatedScheduling | null {
  if (!env.TELEGRAM_SCHEDULING_ENABLED) {
    logger.info('Telegram scheduling NOT wired (TELEGRAM_SCHEDULING_ENABLED=false)');
    return null;
  }
  const llm = buildLlmRouter({
    notifyAdmin: (body) => notifier.notifyAdmin({ title: 'LLM gateway', body, severity: 'warning' }),
  });
  const allowedChannelTypes = env.OUTBOUND_ENABLED
    ? ['whatsapp', ...(env.OUTBOUND_EMAIL_ENABLED ? ['email'] : [])]
    : [];
  logger.info({ timezone: env.TELEGRAM_SCHEDULING_TZ }, 'Telegram scheduling wired');
  const handlers = buildScheduleHandlers({
    interpreter: llm,
    timezone: env.TELEGRAM_SCHEDULING_TZ,
    graceMinutes: env.TELEGRAM_SCHEDULING_GRACE_MINUTES,
    outboundEnabled: env.OUTBOUND_ENABLED,
    allowedChannelTypes,
    now: () => new Date(),
    newNonce: () => randomBytes(4).toString('hex'),
    findCustomer: findCustomerByTelegramTopic,
    resolveReplyOrigin: resolveTelegramReplyOrigin,
    loadMappedOutboundBody,
    resolveRoute: resolveScheduleRoute,
    listRouteCandidates: listScheduleRouteCandidates,
    recipientProfile: buildRecipientProfileAdapter(),
    createAction: createScheduledAction,
    readPending: (threadId) => markers.read('schedule', threadId),
    armPending: (threadId, value) => markers.arm('schedule', threadId, value),
    clearPending: (threadId) => markers.clear('schedule', threadId),
    postAnswer: (threadId, text) => notifier.replyInThread(threadId, text),
    notifyCustomer: (customerId, n, buttons) => notifier.notifyCustomerEvent(customerId, n, buttons),
    log: logger,
    meetings: buildMeetingCommandDeps() ?? undefined,
  });
  return { ...handlers, isScheduleOption };
}
