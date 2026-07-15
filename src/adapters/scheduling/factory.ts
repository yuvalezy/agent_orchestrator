import { env } from '../../config/env';
import { logger } from '../../logger';
import { buildLlmRouter } from '../llm/factory';
import type { TelegramNotifier } from '../telegram/telegram-notifier';
import { buildScheduleMessageHandler } from '../../scheduling/schedule-handler';
import {
  createScheduledAction,
  findCustomerByTelegramTopic,
  loadMappedOutboundBody,
  resolveScheduleRoute,
  resolveTelegramReplyOrigin,
} from '../../scheduling/scheduling-repo';

export function buildScheduleMessageHandlerGated(notifier: TelegramNotifier) {
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
  return buildScheduleMessageHandler({
    interpreter: llm,
    timezone: env.TELEGRAM_SCHEDULING_TZ,
    graceMinutes: env.TELEGRAM_SCHEDULING_GRACE_MINUTES,
    outboundEnabled: env.OUTBOUND_ENABLED,
    allowedChannelTypes,
    now: () => new Date(),
    findCustomer: findCustomerByTelegramTopic,
    resolveReplyOrigin: resolveTelegramReplyOrigin,
    loadMappedOutboundBody,
    resolveRoute: resolveScheduleRoute,
    createAction: createScheduledAction,
    postAnswer: (threadId, text) => notifier.replyInThread(threadId, text),
    notifyCustomer: (customerId, n, buttons) => notifier.notifyCustomerEvent(customerId, n, buttons),
    log: logger,
  });
}
