import { env } from '../../config/env';
import { resolveCredential, tryResolveCredential } from '../../config/credentials';
import { query } from '../../db';
import { TelegramClient } from './telegram-client';
import { TelegramNotifier } from './telegram-notifier';
import { recordTelegramNotificationRef } from '../../scheduling/scheduling-repo';
import { buildOpenAiTranscriptionClient } from '../llm/openai-transcription.client';
import { threadMarkers } from '../triage/thread-markers.instance';
import { serializePendingAsk } from '../../query/pending-ask';

/**
 * Build the TelegramNotifier from non-secret env + the lazily-resolved bot token
 * (`TELEGRAM_BOT_TOKEN`). Fails fast with a clear message when the supergroup id
 * is missing — it is optional in the env schema (so the service boots without
 * Telegram) but required the moment the notifier is actually used.
 *
 * `resolveCustomerTopicId` is wired here to a DB lookup so the adapter itself
 * owns no SQL. Adapters may use the orchestrator's OWN database (invariant #5
 * forbids only the whatsapp_manager DB).
 */
export function buildTelegramNotifier(): TelegramNotifier {
  const supergroupChatId = env.TELEGRAM_SUPERGROUP_CHAT_ID;
  if (!supergroupChatId?.trim()) {
    throw new Error(
      'TELEGRAM_SUPERGROUP_CHAT_ID is not set — required to create/post forum topics',
    );
  }

  const client = new TelegramClient({
    resolveToken: () => resolveCredential('TELEGRAM_BOT_TOKEN'),
  });
  const transcription = buildOpenAiTranscriptionClient({
    resolveKey: () => tryResolveCredential('OPENAI_API_KEY'),
    baseUrl: env.OPENAI_BASE_URL,
    // Read through `env` per call — the settings store overlays this same object.
    resolveModel: () => env.OPENAI_TRANSCRIBE_MODEL,
  });

  return new TelegramNotifier(client, {
    supergroupChatId,
    adminTopicId: env.TELEGRAM_ADMIN_TOPIC_ID,
    // Read through `env` on every update rather than closed over at boot: the settings
    // store overlays this same object, so a console edit applies without a restart.
    resolveFounderUserIds: () =>
      String(env.TELEGRAM_FOUNDER_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    recordNotificationRef: recordTelegramNotificationRef,
    // M5 task 5.3: an askFounder question ARMS its thread, so the founder's next message
    // there is read as the ANSWER rather than handed to the query engine. Uses THE shared
    // marker set, so arming this clears any ✏️ Edit / 🔁 Revise / schedule capture on the
    // thread (and vice versa) — exactly one thing can own the next message.
    armPendingAsk: async ({ threadId, customerId, options }) => {
      await threadMarkers.arm('ask_founder', threadId, serializePendingAsk({ v: 1, customerId, options }));
    },
    transcribeAudio: (input) => transcription.transcribe(input),
    resolveCustomerTopicId: async (customerId: string) => {
      const { rows } = await query<{ telegram_topic_id: string | null }>(
        'SELECT telegram_topic_id FROM agent_customers WHERE id = $1',
        [customerId],
      );
      return rows[0]?.telegram_topic_id ?? null;
    },
  });
}
