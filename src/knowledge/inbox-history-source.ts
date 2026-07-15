import { query } from '../db';
import type { HistorySourcePort } from '../ports/history-source.port';
import type { HistoricalThread } from './backfill';

// Inbox-backed history source (backfill L2, CORE db-only). The safest backfill reader: it reads
// messages ALREADY ingested into agent_inbox (real, local — no external channel call) and groups
// them by channel_thread_id into HistoricalThreads for reconciliation. Read-only. Used for the
// dry-run and for customers whose live channel (e.g. WhatsApp) retains no server-side history.
//
// A thread = one channel_thread_id; messages ordered oldest-first. Customer display name +
// language are joined from agent_customers so the classifier gets tone/language context.

interface InboxRow {
  channel_thread_id: string | null;
  channel_message_id: string;
  sender_name: string | null;
  sender_address: string | null;
  body: string;
  received_at: string;
  channel_type: string;
  display_name: string;
  preferred_language: string | null;
}

/** Cap messages folded into one thread (newest kept) so a very long chat can't blow the LLM budget. */
const MAX_MESSAGES_PER_THREAD = 80;

export function buildInboxHistorySource(): HistorySourcePort {
  return {
    async readThreads(customerId: string): Promise<HistoricalThread[]> {
      const { rows } = await query<InboxRow>(
        `SELECT i.channel_thread_id, i.channel_message_id, i.sender_name, i.sender_address,
                i.body, i.received_at, ci.channel_type, c.display_name, c.preferred_language
           FROM agent_inbox i
           JOIN channel_instances ci ON ci.id = i.channel_instance_id
           JOIN agent_customers c ON c.id = i.customer_id
          WHERE i.customer_id = $1
            AND i.body IS NOT NULL AND length(trim(i.body)) > 0
          ORDER BY i.channel_thread_id, i.received_at ASC`,
        [customerId],
      );

      // Group by channel_thread_id (a null thread id → keyed by its own message id so it stands alone).
      const byThread = new Map<string, InboxRow[]>();
      for (const r of rows) {
        const key = r.channel_thread_id ?? `msg:${r.channel_message_id}`;
        const bucket = byThread.get(key);
        if (bucket) bucket.push(r);
        else byThread.set(key, [r]);
      }

      const threads: HistoricalThread[] = [];
      for (const [key, msgs] of byThread) {
        const kept = msgs.slice(-MAX_MESSAGES_PER_THREAD);
        const head = kept[0];
        threads.push({
          customerId,
          channel: head.channel_type,
          threadKey: `inbox:${key}`,
          // The channel's own conversation id, so the Gmail/WhatsApp legs — which re-read these same
          // conversations from the source of truth, more completely — can drop this thinner copy
          // instead of embedding it a second time (dropCoveredThreads). NULL thread id → this row
          // stands alone and no leg can claim to cover it.
          sourceThreadId: head.channel_thread_id ?? undefined,
          displayName: head.display_name,
          language: head.preferred_language ?? undefined,
          messages: kept.map((m) => ({
            from: m.sender_name || m.sender_address || 'contact',
            body: m.body,
            at: new Date(m.received_at),
          })),
        });
      }
      return threads;
    },
  };
}
