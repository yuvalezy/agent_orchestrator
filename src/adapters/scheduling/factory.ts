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
  listScheduleRouteCandidates,
  loadMappedOutboundBody,
  resolveScheduleRoute,
  resolveTelegramReplyOrigin,
} from '../../scheduling/scheduling-repo';

export interface GatedScheduling extends ScheduleHandlers {
  isScheduleOption: (optionId: string) => boolean;
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
  });
  return { ...handlers, isScheduleOption };
}
