import { env } from '../../config/env';
import { logger } from '../../logger';
import type { MessageEvent } from '../../ports/founder-notifier.port';
import type { TelegramNotifier } from '../telegram/telegram-notifier';
import { buildSlashCommandRouter } from '../../query/commands';
import { fetchPendingDrafts, fetchPendingProposals } from './daily-briefing.worker';

// Composition for the Telegram founder slash-command surface (M5(c)). Wires the CORE router
// (src/query/commands.ts) to the console Approvals queue readers (reused from the daily briefing
// worker — DRY) and the Telegram notifier's replyInThread. Gated by SLASH_COMMANDS_ENABLED →
// null when off, so a boot never surfaces the command surface by surprise. Importing core + the
// sibling adapter here is boundary-legal (this factory is a composition root; the boundary rule
// only forbids core → adapters). Reuses DAILY_BRIEFING_TZ / _TOP_N so `/briefing` renders exactly
// like the daily digest.

export function buildSlashCommandsHandler(
  notifier: Pick<TelegramNotifier, 'replyInThread'>,
): ((m: MessageEvent) => Promise<boolean>) | null {
  if (!env.SLASH_COMMANDS_ENABLED) {
    logger.info('slash commands NOT wired (SLASH_COMMANDS_ENABLED=false)');
    return null;
  }
  logger.info('slash commands wired (SLASH_COMMANDS_ENABLED=true)');
  return buildSlashCommandRouter({
    fetchPendingDrafts,
    fetchPendingProposals,
    postAnswer: (threadId, text) => notifier.replyInThread(threadId, text),
    now: () => new Date(),
    tz: env.DAILY_BRIEFING_TZ,
    topN: env.DAILY_BRIEFING_TOP_N,
    log: logger,
  });
}
