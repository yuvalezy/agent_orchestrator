import { logger } from '../../logger';
import type { HistorySourcePort } from '../../ports/history-source.port';
import type { HistoricalThread } from '../../knowledge/backfill';
import { windowChat, type WaWindowConfig } from '../../knowledge/wa-windowing';
import type { CustomerDirectoryInfo } from '../../customers/customer-directory';
import type { WhatsAppDirectoryClient } from './directory-client';
import type { WaHistoryClient, StoredWaMessage } from './wa-history-client';

// WhatsApp-backed history source (backfill L2, ADAPTER). READ-ONLY: drains the whatsapp_manager
// message archive, selects the target customer's chats (contact chats by `contact_number` →
// whitelist BP; group chats by `chat_id` → groups directory BP), splits each chat into discussion
// windows, and normalizes them into HistoricalThreads. This is the leg that was missing — WhatsApp
// history never entered agent_inbox (the live reconciler starts at now()), so the backfill was
// blind to it. Never mutates a mailbox; per-chat error isolation; a hard window cap bounds cost.

export interface WaHistorySourceDeps {
  historyClient: WaHistoryClient;
  directory: WhatsAppDirectoryClient;
  getInfo: (customerId: string) => Promise<CustomerDirectoryInfo | null>;
  window: WaWindowConfig;
  /** Cap windows returned per customer (most-recent kept). Guards LLM cost on huge chats. */
  maxWindowsPerCustomer?: number;
}

const isGroupChat = (chatId: string): boolean => chatId.endsWith('@g.us');

/** Best text for matching: the original body, else a voice/media transcript, else a translation. */
function pickBody(m: StoredWaMessage): string {
  return (m.body?.trim() || m.transcript?.trim() || m.translated_body?.trim() || '').trim();
}

export function buildWaHistorySource(deps: WaHistorySourceDeps): HistorySourcePort {
  const cap = deps.maxWindowsPerCustomer ?? 60;
  return {
    async readThreads(customerId: string): Promise<HistoricalThread[]> {
      const info = await deps.getInfo(customerId);
      if (!info?.bpRef) {
        logger.warn({ customerId }, 'wa history: customer has no bp_ref — cannot map chats, skipping');
        return [];
      }

      let phones: Set<string>;
      let groupChatIds: Set<string>;
      try {
        const [whitelist, groups] = await Promise.all([deps.directory.listWhitelist(), deps.directory.listGroups()]);
        phones = new Set(whitelist.filter((w) => w.ezy_bp_id === info.bpRef).map((w) => w.phone_number));
        groupChatIds = new Set(
          groups
            .filter((g) => g.ezy_bp_id === info.bpRef)
            .flatMap((g) => [g.chat_id, `${g.group_id}@g.us`].filter((x): x is string => !!x)),
        );
      } catch (err) {
        logger.warn({ customerId, reason: (err as Error)?.message }, 'wa history: directory fetch failed — skipping');
        return [];
      }
      if (phones.size === 0 && groupChatIds.size === 0) {
        logger.info({ customerId }, 'wa history: no whitelist/group entries for this customer — nothing to read');
        return [];
      }

      let archive: StoredWaMessage[];
      let capped: boolean;
      try {
        ({ messages: archive, capped } = await deps.historyClient.listAllMessages());
      } catch (err) {
        logger.warn({ customerId, reason: (err as Error)?.message }, 'wa history: message fetch failed — skipping');
        return [];
      }
      if (capped) logger.warn({ customerId }, 'wa history: message archive hit the page cap — older history not read');

      // Select the customer's chats and group by chat_id.
      const byChat = new Map<string, StoredWaMessage[]>();
      for (const m of archive) {
        const mine = isGroupChat(m.chat_id)
          ? groupChatIds.has(m.chat_id)
          : !!m.contact_number && phones.has(m.contact_number);
        if (!mine) continue;
        const bucket = byChat.get(m.chat_id);
        if (bucket) bucket.push(m);
        else byChat.set(m.chat_id, [m]);
      }

      const threads: HistoricalThread[] = [];
      for (const [chatId, rows] of byChat) {
        try {
          const windows = windowChat(
            rows.map((m) => ({
              from: m.sender_name || (m.direction === 'outbound' ? 'You' : 'contact'),
              body: pickBody(m),
              at: new Date(m.timestamp),
            })),
            deps.window,
          );
          for (const w of windows) {
            threads.push({
              customerId,
              channel: 'whatsapp',
              threadKey: `wa:${chatId}:${w.startAt.getTime()}`,
              displayName: info.displayName,
              language: info.language ?? undefined,
              messages: w.messages,
            });
          }
        } catch (err) {
          logger.warn({ customerId, chatId, reason: (err as Error)?.message }, 'wa history: chat windowing failed — skipped');
        }
      }

      // Newest-first cap: keep the most recent `cap` windows (a huge chat can't blow the budget).
      threads.sort((a, b) => Number(b.threadKey.split(':').pop()) - Number(a.threadKey.split(':').pop()));
      const kept = threads.slice(0, cap);
      if (threads.length > kept.length) {
        logger.warn(
          { customerId, total: threads.length, kept: kept.length },
          'wa history: window cap hit — oldest windows dropped (raise maxWindowsPerCustomer to include them)',
        );
      }
      logger.info({ customerId, chats: byChat.size, windows: kept.length }, 'wa history: read complete');
      return kept;
    },
  };
}
