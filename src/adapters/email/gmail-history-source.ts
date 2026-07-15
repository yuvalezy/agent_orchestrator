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
//
// STARRED IS A PROPERTY, NOT A LEG. `is:starred (<identity>)` is a strict SUBSET of this leg's own
// query — running it as a second HistorySourcePort re-read the same threads under a second
// threadKey namespace, which (now that backfill seeds memory) would write a DUPLICATE conversation
// memory per starred thread, since insertBackfillLink dedups on thread_key. So we run the starred
// search once per account purely to collect an id SET, and read the UNION of that set with the
// standard search. One leg, one threadKey, no duplicate. The set is best-effort: if the starred
// search fails we degrade to "no stars" (zero proposals) rather than failing the whole leg — a
// missed proposal is recoverable, a lost history read is not.
//
// ⚠︎ The starred set is UNIONED into the read, never merely intersected with it. `maxThreadsPerAccount`
// keeps the most RECENT threads, and the star is the ONLY gate that yields a task card — so treating
// the set as a marker-only lookup would silently drop exactly the thread a star exists to rescue: the
// aged one, ranked below the recency cap, which then can neither be marked nor proposed nor even
// read. The set carries its own cap (maxStarredPerAccount), so the union stays bounded.

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
  /** Cap the starred-id set pulled per account (BACKFILL_STARRED_MAX_THREADS). */
  maxStarredPerAccount?: number;
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

/** Build the starred `q`: `is:starred` ANDed with the SAME identity clause, so only the customer's
 *  own starred correspondence is marked. Empty identity → null (nothing to search). */
export function buildStarredQuery(identity: { domain: string | null; addresses: string[] }): string | null {
  const base = buildGmailQuery(identity);
  return base ? `is:starred (${base})` : null;
}

/** Normalize a fetched Gmail thread into a HistoricalThread. Empty-body messages contribute
 *  nothing; an all-empty thread → null (dropped). */
export function toHistoricalThread(
  customerId: string,
  account: string,
  threadId: string,
  msgs: ProviderEmail[],
  opts: { language?: string; starred?: boolean } = {},
): HistoricalThread | null {
  const messages: HistoricalMessage[] = msgs
    .filter((m) => (m.bodyText ?? '').trim())
    .map((m) => ({ from: m.from || 'sender', body: m.bodyText ?? '', at: m.sentAt }));
  if (!messages.length) return null;
  return {
    customerId,
    channel: 'email',
    threadKey: `gmail:${account}:${threadId}`,
    // agent_inbox stores this same id in channel_thread_id (email-channel.adapter's toInbound sets
    // threadKey: e.threadId), so it is what lets the inbox leg's thinner copy of this thread be
    // dropped rather than embedded a second time. See dropCoveredThreads.
    sourceThreadId: threadId,
    language: opts.language,
    starred: opts.starred,
    messages,
  };
}

export function buildGmailHistorySource(deps: GmailHistorySourceDeps): HistorySourcePort {
  const cap = deps.maxThreadsPerAccount ?? 100;
  const starredCap = deps.maxStarredPerAccount ?? 50;
  return {
    async readThreads(customerId: string): Promise<HistoricalThread[]> {
      const identity = await deps.getIdentity(customerId);
      const q = buildGmailQuery(identity);
      if (!q) {
        logger.warn({ customerId }, 'gmail history: customer has no email domain/addresses — nothing to search');
        return [];
      }
      const starredQ = buildStarredQuery(identity);
      const language = deps.language ? await deps.language(customerId) : undefined;

      const threads: HistoricalThread[] = [];
      let starredMarked = 0;
      for (const account of deps.accounts) {
        // One extra search per account for the star SET (ids only). Best-effort: a failure here
        // means "no stars known" for this account — the history read below still proceeds.
        let starredIds = new Set<string>();
        if (starredQ) {
          try {
            starredIds = new Set(await account.client.searchThreadIds(starredQ, starredCap));
          } catch (err) {
            logger.warn({ customerId, account: account.name, reason: (err as Error)?.message }, 'gmail history: starred search failed — no threads marked starred for this account');
          }
        }

        let threadIds: string[] = [];
        try {
          threadIds = await account.client.searchThreadIds(q, cap);
        } catch (err) {
          logger.warn({ customerId, account: account.name, reason: (err as Error)?.message }, 'gmail history: search failed — skipping account');
          continue;
        }
        // UNION, not intersection: a starred thread that falls outside the recency cap must still
        // be read, or the star can never do the one job it has here (see the header note).
        const readIds = starredIds.size > 0 ? [...new Set([...threadIds, ...starredIds])] : threadIds;
        if (readIds.length > threadIds.length) {
          logger.info(
            { customerId, account: account.name, beyondCap: readIds.length - threadIds.length },
            'gmail history: starred threads outside the recency cap pulled in as well',
          );
        }
        for (const tid of readIds) {
          try {
            const msgs = await account.client.getThread(tid);
            const starred = starredIds.has(tid);
            const t = toHistoricalThread(customerId, account.name, tid, msgs, { language, starred });
            if (t) {
              threads.push(t);
              if (starred) starredMarked += 1;
            }
          } catch (err) {
            logger.warn({ customerId, account: account.name, threadId: tid, reason: (err as Error)?.message }, 'gmail history: thread fetch failed — skipped');
          }
        }
      }
      logger.info({ customerId, accounts: deps.accounts.length, threads: threads.length, starred: starredMarked }, 'gmail history: read complete');
      return threads;
    },
  };
}
