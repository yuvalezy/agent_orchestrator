import { logger } from '../../logger';
import type { HistorySourcePort } from '../../ports/history-source.port';
import type { HistoricalThread, HistoricalMessage } from '../../knowledge/backfill';
import type { ProviderEmail } from '../../ports/channel.port';

// Gmail-backed history source (backfill L2, ADAPTER). READ-ONLY: searches each configured Gmail
// account for threads involving the customer's email domain / addresses, fetches each matched
// thread, and normalizes it into a HistoricalThread. Never mutates a mailbox.
//
// The query is domain- + address-scoped so it only surfaces the customer's own correspondence.
// Self-sent founder replies stay in the thread (context). Best-effort per account/thread — a
// search or fetch error for one is logged and skipped, never aborting the sweep.

export interface GmailAccount {
  /** channel_instances.name, e.g. 'email:gmail:work' — namespaces the threadKey. */
  name: string;
  client: { searchThreadIds(query: string, maxThreads?: number): Promise<string[]>; getThread(threadId: string): Promise<ProviderEmail[]> };
}

export interface GmailHistorySourceDeps {
  accounts: GmailAccount[];
  /** Resolve a customer's email domain + addresses (getCustomerEmailIdentity). */
  getIdentity: (customerId: string) => Promise<{ domain: string | null; addresses: string[] }>;
  /** Cap threads pulled per account (cost/latency guard). */
  maxThreadsPerAccount?: number;
  language?: (customerId: string) => Promise<string | undefined>;
}

/** Build the Gmail search `q` from a customer's identity. Domain scopes broadly; explicit
 *  addresses catch contacts on other domains (e.g. a gmail.com contact). Empty → null (skip). */
export function buildGmailQuery(identity: { domain: string | null; addresses: string[] }): string | null {
  const terms: string[] = [];
  if (identity.domain) terms.push(`from:${identity.domain}`, `to:${identity.domain}`);
  for (const a of identity.addresses) {
    // Skip an address already covered by the domain term (avoid a redundant clause).
    if (identity.domain && a.endsWith(`@${identity.domain}`)) continue;
    terms.push(`from:${a}`, `to:${a}`);
  }
  return terms.length ? terms.join(' OR ') : null;
}

/** Normalize a fetched Gmail thread into a HistoricalThread (shared by the standard + starred legs).
 *  `threadKeyPrefix` namespaces the idempotency key so the two legs never collide (`gmail:` vs
 *  `gmail-starred:`). Empty-body messages contribute nothing; an all-empty thread → null (dropped). */
export function toHistoricalThread(
  customerId: string,
  account: string,
  threadId: string,
  msgs: ProviderEmail[],
  opts: { threadKeyPrefix?: string; language?: string } = {},
): HistoricalThread | null {
  const messages: HistoricalMessage[] = msgs
    .filter((m) => (m.bodyText ?? '').trim())
    .map((m) => ({ from: m.from || 'sender', body: m.bodyText ?? '', at: m.sentAt }));
  if (!messages.length) return null;
  return {
    customerId,
    channel: 'email',
    threadKey: `${opts.threadKeyPrefix ?? 'gmail'}:${account}:${threadId}`,
    language: opts.language,
    messages,
  };
}

export function buildGmailHistorySource(deps: GmailHistorySourceDeps): HistorySourcePort {
  const cap = deps.maxThreadsPerAccount ?? 100;
  return {
    async readThreads(customerId: string): Promise<HistoricalThread[]> {
      const identity = await deps.getIdentity(customerId);
      const q = buildGmailQuery(identity);
      if (!q) {
        logger.warn({ customerId }, 'gmail history: customer has no email domain/addresses — nothing to search');
        return [];
      }
      const language = deps.language ? await deps.language(customerId) : undefined;

      const threads: HistoricalThread[] = [];
      for (const account of deps.accounts) {
        let threadIds: string[] = [];
        try {
          threadIds = await account.client.searchThreadIds(q, cap);
        } catch (err) {
          logger.warn({ customerId, account: account.name, reason: (err as Error)?.message }, 'gmail history: search failed — skipping account');
          continue;
        }
        for (const tid of threadIds) {
          try {
            const msgs = await account.client.getThread(tid);
            const t = toHistoricalThread(customerId, account.name, tid, msgs, { language });
            if (t) threads.push(t);
          } catch (err) {
            logger.warn({ customerId, account: account.name, threadId: tid, reason: (err as Error)?.message }, 'gmail history: thread fetch failed — skipped');
          }
        }
      }
      logger.info({ customerId, accounts: deps.accounts.length, threads: threads.length }, 'gmail history: read complete');
      return threads;
    },
  };
}
