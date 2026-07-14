import { logger } from '../../logger';
import type { HistorySourcePort } from '../../ports/history-source.port';
import type { HistoricalThread } from '../../knowledge/backfill';
import { buildGmailQuery, toHistoricalThread, type GmailAccount } from './gmail-history-source';

// Starred-email history source (backfill L2, ADAPTER — M3(b)). READ-ONLY: mirrors the Gmail history
// leg but scopes the search to the founder's STARRED messages intersected with a customer's identity.
// Rationale: the founder stars the emails they consider important, so a starred thread that involves
// a known customer is a HIGH-SIGNAL task-proposal candidate that must not be missed. Each starred
// thread → one HistoricalThread (grouped by thread, exactly like the Gmail leg; email threads are
// already bounded topical units, so no chat-style windowing is needed). Never mutates a mailbox.
//
// It REUSES the existing GmailClient + Gmail query builder (no second Gmail integration) and a
// distinct `gmail-starred:` threadKey namespace, so it never collides with the standard Gmail leg.
// When both legs surface the same underlying thread, the sweep-wide proposal collapser folds the
// near-identical proposals into one card. Best-effort per account/thread: an error is logged + skipped.

export interface GmailStarredSourceDeps {
  accounts: GmailAccount[];
  /** Resolve a customer's email domain + addresses (getCustomerEmailIdentity). */
  getIdentity: (customerId: string) => Promise<{ domain: string | null; addresses: string[] }>;
  /** Cap starred threads pulled per account (cost/latency guard). */
  maxThreadsPerAccount?: number;
  language?: (customerId: string) => Promise<string | undefined>;
}

/** Build the starred Gmail `q`: `is:starred` ANDed with the customer's identity clause, so only the
 *  customer's own starred correspondence surfaces. Empty identity → null (nothing to search). */
export function buildStarredQuery(identity: { domain: string | null; addresses: string[] }): string | null {
  const base = buildGmailQuery(identity);
  return base ? `is:starred (${base})` : null;
}

export function buildGmailStarredSource(deps: GmailStarredSourceDeps): HistorySourcePort {
  const cap = deps.maxThreadsPerAccount ?? 50;
  return {
    async readThreads(customerId: string): Promise<HistoricalThread[]> {
      const identity = await deps.getIdentity(customerId);
      const q = buildStarredQuery(identity);
      if (!q) {
        logger.warn({ customerId }, 'gmail starred: customer has no email domain/addresses — nothing to search');
        return [];
      }
      const language = deps.language ? await deps.language(customerId) : undefined;

      const threads: HistoricalThread[] = [];
      for (const account of deps.accounts) {
        let threadIds: string[] = [];
        try {
          threadIds = await account.client.searchThreadIds(q, cap);
        } catch (err) {
          logger.warn({ customerId, account: account.name, reason: (err as Error)?.message }, 'gmail starred: search failed — skipping account');
          continue;
        }
        for (const tid of threadIds) {
          try {
            const msgs = await account.client.getThread(tid);
            const t = toHistoricalThread(customerId, account.name, tid, msgs, { threadKeyPrefix: 'gmail-starred', language });
            if (t) threads.push(t);
          } catch (err) {
            logger.warn({ customerId, account: account.name, threadId: tid, reason: (err as Error)?.message }, 'gmail starred: thread fetch failed — skipped');
          }
        }
      }
      logger.info({ customerId, accounts: deps.accounts.length, threads: threads.length }, 'gmail starred: read complete');
      return threads;
    },
  };
}
