import type { FounderNotifierPort, Notification } from '../ports/founder-notifier.port';
import type { SyncLogger } from '../knowledge/sync';

// Daily founder briefing (M5(b), CORE — ports + injected data-fetch fns only; the
// concrete repo queries + notifier are wired at the composition root, so this never
// imports src/adapters — D1 boundary). Composes a once-a-day, scannable digest of what
// is WAITING on the founder — pending draft replies + pending backfill task proposals —
// with counts, the oldest item's age, and a ranked "who needs attention" list so the
// founder can triage decision throughput at a glance.
//
// The aggregation + render are PURE (unit-testable without a DB). Idempotent per calendar
// day via an app_state last-run-day key so a sub-daily interval (and restarts) post EXACTLY
// ONCE per day. PII posture: the digest carries customer NAMES + counts + ages only — never
// a message body or a draft/proposal body (the composition root maps repo rows down to this
// PII-light shape before it reaches core).

/** One pending item awaiting founder action, reduced to what the digest needs. */
export interface PendingItem {
  customerId: string | null;
  customerName: string | null;
  /** When the item entered the queue — drives the oldest-age figures. */
  createdAt: Date;
}

/** Per-queue roll-up: how many are waiting and how long the oldest has waited. */
export interface QueueSummary {
  count: number;
  /** Age of the oldest item in whole hours; null when the queue is empty. */
  oldestAgeHours: number | null;
}

/** A customer with items waiting, for the "who needs attention" ranking. */
export interface CustomerAttention {
  customerId: string;
  customerName: string | null;
  draftCount: number;
  proposalCount: number;
  totalCount: number;
  /** Age of this customer's oldest waiting item (either queue), whole hours. */
  oldestAgeHours: number;
}

export interface BriefingData {
  drafts: QueueSummary;
  proposals: QueueSummary;
  /** Customers ranked by total waiting items desc, then oldest-age desc. */
  topCustomers: CustomerAttention[];
}

const HOUR_MS = 60 * 60 * 1000;

/** Whole hours between an item's createdAt and now (clamped at 0 for clock skew). */
function ageHours(createdAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / HOUR_MS));
}

function summarize(items: readonly PendingItem[], now: Date): QueueSummary {
  if (items.length === 0) return { count: 0, oldestAgeHours: null };
  let oldest = items[0].createdAt;
  for (const it of items) if (it.createdAt.getTime() < oldest.getTime()) oldest = it.createdAt;
  return { count: items.length, oldestAgeHours: ageHours(oldest, now) };
}

/** Render a whole-hour age as a compact "3d 4h" / "5h" / "just now". */
export function humanizeAgeHours(hours: number): string {
  if (hours <= 0) return 'just now';
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  if (days === 0) return `${rem}h`;
  if (rem === 0) return `${days}d`;
  return `${days}d ${rem}h`;
}

interface AttentionAccum {
  customerId: string;
  customerName: string | null;
  draftCount: number;
  proposalCount: number;
  oldestCreatedAt: Date;
}

/**
 * Aggregate the two pending queues into the digest shape (PURE). Per-queue counts +
 * oldest age, plus a per-customer roll-up ranked by total waiting items (tie-broken by
 * the oldest age). Items with a null customerId still count toward the queue totals but
 * are NOT surfaced as a named attention row (there is no customer to act on). `topN`
 * caps the attention list so the digest stays scannable.
 */
export function composeBriefing(
  drafts: readonly PendingItem[],
  proposals: readonly PendingItem[],
  now: Date,
  opts: { topN?: number } = {},
): BriefingData {
  const topN = opts.topN ?? 5;
  const byCustomer = new Map<string, AttentionAccum>();

  const fold = (items: readonly PendingItem[], kind: 'draft' | 'proposal'): void => {
    for (const it of items) {
      if (it.customerId === null) continue;
      const prev = byCustomer.get(it.customerId);
      if (!prev) {
        byCustomer.set(it.customerId, {
          customerId: it.customerId,
          customerName: it.customerName,
          draftCount: kind === 'draft' ? 1 : 0,
          proposalCount: kind === 'proposal' ? 1 : 0,
          oldestCreatedAt: it.createdAt,
        });
        continue;
      }
      if (kind === 'draft') prev.draftCount += 1;
      else prev.proposalCount += 1;
      if (it.createdAt.getTime() < prev.oldestCreatedAt.getTime()) prev.oldestCreatedAt = it.createdAt;
      // Backfill a name if the first-seen row lacked one.
      if (prev.customerName === null && it.customerName !== null) prev.customerName = it.customerName;
    }
  };
  fold(drafts, 'draft');
  fold(proposals, 'proposal');

  const topCustomers: CustomerAttention[] = [...byCustomer.values()]
    .map((a) => ({
      customerId: a.customerId,
      customerName: a.customerName,
      draftCount: a.draftCount,
      proposalCount: a.proposalCount,
      totalCount: a.draftCount + a.proposalCount,
      oldestAgeHours: ageHours(a.oldestCreatedAt, now),
    }))
    .sort((a, b) => b.totalCount - a.totalCount || b.oldestAgeHours - a.oldestAgeHours)
    .slice(0, topN);

  return {
    drafts: summarize(drafts, now),
    proposals: summarize(proposals, now),
    topCustomers,
  };
}

function queueLine(label: string, s: QueueSummary): string {
  if (s.count === 0) return `${label}: none pending`;
  return `${label}: ${s.count} pending · oldest ${humanizeAgeHours(s.oldestAgeHours ?? 0)}`;
}

/**
 * Render the digest into a founder-facing admin Notification (PURE). `day` is the report's
 * tz-local calendar day (title). Leads with the two queue roll-ups (what to decide), then a
 * ranked "needs attention" list (who is waiting, how many, how long). When nothing is
 * pending it still posts a short all-clear so the founder knows the briefing ran.
 */
export function renderBriefing(data: BriefingData, day: string): Notification {
  const totalPending = data.drafts.count + data.proposals.count;
  const parts: string[] = [];
  parts.push(queueLine('📝 Draft replies', data.drafts));
  parts.push(queueLine('📋 Task proposals', data.proposals));

  if (data.topCustomers.length > 0) {
    parts.push('', 'Needs attention');
    for (const c of data.topCustomers) {
      const bits: string[] = [];
      if (c.draftCount > 0) bits.push(`${c.draftCount} draft${c.draftCount === 1 ? '' : 's'}`);
      if (c.proposalCount > 0) bits.push(`${c.proposalCount} proposal${c.proposalCount === 1 ? '' : 's'}`);
      parts.push(`  ${c.customerName ?? c.customerId}: ${bits.join(', ')} · oldest ${humanizeAgeHours(c.oldestAgeHours)}`);
    }
  } else if (totalPending === 0) {
    parts.push('', 'All clear — nothing waiting on you. 🎉');
  }

  return {
    title: `☀️ Daily briefing — ${day}`,
    body: parts.join('\n'),
    severity: totalPending > 0 ? 'action' : 'info',
  };
}

export interface DailyBriefingDeps {
  /** Pending draft replies (is_draft, status='pending'), PII-light. */
  fetchPendingDrafts: () => Promise<PendingItem[]>;
  /** Pending backfill task proposals (outcome='pending'), PII-light. */
  fetchPendingProposals: () => Promise<PendingItem[]>;
  notifier: Pick<FounderNotifierPort, 'notifyAdmin'>;
  /** Last calendar day (YYYY-MM-DD) a briefing posted, from app_state (or null). */
  readLastRun: () => Promise<string | null>;
  /** Persist the calendar day after a successful post (app_state). */
  writeLastRun: (day: string) => Promise<void>;
  /** Injected clock (test seam). */
  now: () => Date;
  /** Timezone for the day boundary so "daily" is the founder's local day (not UTC). */
  tz: string;
  /** Max customers in the attention list. */
  topN?: number;
  log: SyncLogger;
}

/** Format a Date as YYYY-MM-DD in the given IANA timezone (en-CA yields ISO order). */
function dayInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * One briefing tick. Idempotent per calendar day: if a briefing already posted today (the
 * app_state last-run day == today) it is a no-op, so an interval that fires several times a
 * day (and restarts) posts EXACTLY ONCE per day. Posts first, then marks — a transient notify
 * failure re-attempts next tick rather than silently skipping the day; the only double-post
 * window is a mark write failing right after a successful post (same DB the fetches just
 * used — effectively never). Mirrors runAcceptanceReport (change 03 sub-milestone d).
 */
export async function runDailyBriefing(deps: DailyBriefingDeps): Promise<{ posted: boolean }> {
  const now = deps.now();
  const today = dayInTz(now, deps.tz);

  const last = await deps.readLastRun();
  if (last === today) {
    deps.log.debug({ today }, 'daily briefing: already posted today — skip (idempotent)');
    return { posted: false };
  }

  const [drafts, proposals] = await Promise.all([deps.fetchPendingDrafts(), deps.fetchPendingProposals()]);
  const data = composeBriefing(drafts, proposals, now, { topN: deps.topN });

  await deps.notifier.notifyAdmin(renderBriefing(data, today));
  await deps.writeLastRun(today);

  deps.log.info(
    { day: today, drafts: data.drafts.count, proposals: data.proposals.count },
    'daily briefing posted',
  );
  return { posted: true };
}
