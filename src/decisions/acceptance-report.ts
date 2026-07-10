import type { FounderNotifierPort, Notification } from '../ports/founder-notifier.port';
import type { SyncLogger } from '../knowledge/sync';

// Daily acceptance report (change 03, sub-milestone d — CORE, ports + injected repo
// fns). Aggregates resolved draft_reply outcomes (accepted/modified/rejected) over
// 24h / 7d / 30d, per customer and overall, and posts a summary to the Telegram Admin
// topic via notifier.notifyAdmin. The aggregation is PURE (sliced in TS from the 30-day
// row set) so it's unit-testable without a DB. Idempotent per calendar day (a last-run
// day key in app_state) so restarts within a day never double-post. Counts only — the
// report carries no message bodies.

export type Outcome = 'accepted' | 'modified' | 'rejected';
export type ReportWindow = '24h' | '7d' | '30d';

/** One resolved draft decision (from decisions.fetchResolvedDraftDecisions). */
export interface ResolvedDecision {
  customerId: string | null;
  customerName: string | null;
  outcome: Outcome;
  resolvedAt: Date;
}

export interface WindowCounts {
  accepted: number;
  modified: number;
  rejected: number;
  total: number;
  /** accepted / total (0..1); null when total is 0 (no rate to report). */
  acceptanceRate: number | null;
}

export interface CustomerMetrics {
  customerId: string;
  customerName: string | null;
  windows: Record<ReportWindow, WindowCounts>;
}

export interface AcceptanceMetrics {
  overall: Record<ReportWindow, WindowCounts>;
  perCustomer: CustomerMetrics[];
}

const WINDOWS: ReportWindow[] = ['24h', '7d', '30d'];
const WINDOW_MS: Record<ReportWindow, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function emptyCounts(): WindowCounts {
  return { accepted: 0, modified: 0, rejected: 0, total: 0, acceptanceRate: null };
}

function emptyWindows(): Record<ReportWindow, WindowCounts> {
  return { '24h': emptyCounts(), '7d': emptyCounts(), '30d': emptyCounts() };
}

function tally(counts: WindowCounts, outcome: Outcome): void {
  counts[outcome] += 1;
  counts.total += 1;
  counts.acceptanceRate = counts.accepted / counts.total;
}

/**
 * Aggregate the 30-day resolved set into overall + per-customer counts for each window
 * (PURE). A decision lands in a window when resolvedAt >= now - windowSpan, so the 24h
 * bucket is a subset of 7d ⊂ 30d. Per-customer buckets are keyed by customerId (a null
 * customer is folded into overall only). Customers are sorted by 30d volume desc for a
 * stable, useful ordering.
 */
export function aggregateAcceptance(rows: readonly ResolvedDecision[], now: Date): AcceptanceMetrics {
  const overall = emptyWindows();
  const byCustomer = new Map<string, CustomerMetrics>();
  const nowMs = now.getTime();

  for (const row of rows) {
    const ageMs = nowMs - row.resolvedAt.getTime();
    if (ageMs < 0) continue; // future-dated (clock skew) — ignore
    const custMetrics =
      row.customerId !== null
        ? byCustomer.get(row.customerId) ??
          (() => {
            const m: CustomerMetrics = {
              customerId: row.customerId,
              customerName: row.customerName,
              windows: emptyWindows(),
            };
            byCustomer.set(row.customerId, m);
            return m;
          })()
        : null;

    for (const w of WINDOWS) {
      if (ageMs <= WINDOW_MS[w]) {
        tally(overall[w], row.outcome);
        if (custMetrics) tally(custMetrics.windows[w], row.outcome);
      }
    }
  }

  const perCustomer = [...byCustomer.values()].sort(
    (a, b) => b.windows['30d'].total - a.windows['30d'].total,
  );
  return { overall, perCustomer };
}

function pct(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

function line(label: string, c: WindowCounts): string {
  return `${label}: ${pct(c.acceptanceRate)} accepted (${c.accepted}✅ / ${c.modified}✏️ / ${c.rejected}🚫, n=${c.total})`;
}

/**
 * Render the metrics into a founder-facing admin Notification (PURE). `day` is the
 * report's calendar day (tz-local, for the title). Shows overall for each window, then
 * a per-customer breakdown for the 7-day window (the most actionable horizon); customers
 * with zero 7d activity are omitted to keep it readable.
 */
export function renderAcceptanceReport(metrics: AcceptanceMetrics, day: string): Notification {
  const parts: string[] = [];
  parts.push('Overall');
  for (const w of WINDOWS) parts.push(line(`  ${w}`, metrics.overall[w]));

  const active = metrics.perCustomer.filter((c) => c.windows['7d'].total > 0);
  if (active.length > 0) {
    parts.push('', 'By customer (7d)');
    for (const c of active) {
      parts.push(line(`  ${c.customerName ?? c.customerId}`, c.windows['7d']));
    }
  }

  return {
    title: `📊 Draft acceptance report — ${day}`,
    body: parts.join('\n'),
    severity: 'info',
  };
}

export interface AcceptanceReportDeps {
  /** Resolved decisions since an ISO instant (decisions.fetchResolvedDraftDecisions). */
  fetchDecisions: (sinceIso: string) => Promise<ResolvedDecision[]>;
  notifier: Pick<FounderNotifierPort, 'notifyAdmin'>;
  /** Last calendar day (YYYY-MM-DD) a report posted, from app_state (or null). */
  readLastRun: () => Promise<string | null>;
  /** Persist the calendar day after a successful post (app_state). */
  writeLastRun: (day: string) => Promise<void>;
  /** Injected clock (test seam). */
  now: () => Date;
  /** Timezone for the day boundary (so "daily" is the founder's local day). */
  tz: string;
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
 * One report tick. Idempotent per calendar day: if a report already posted today (the
 * app_state last-run day == today) it is a no-op, so an interval that fires several
 * times a day (and restarts) posts EXACTLY ONCE per day. Posts first, then marks — a
 * transient notify failure re-attempts next tick rather than silently skipping the day;
 * the only double-post window is a mark write failing right after a successful post
 * (same DB the fetch just used — effectively never).
 */
export async function runAcceptanceReport(deps: AcceptanceReportDeps): Promise<{ posted: boolean }> {
  const now = deps.now();
  const today = dayInTz(now, deps.tz);

  const last = await deps.readLastRun();
  if (last === today) {
    deps.log.debug({ today }, 'acceptance report: already posted today — skip (idempotent)');
    return { posted: false };
  }

  const sinceIso = new Date(now.getTime() - WINDOW_MS['30d']).toISOString();
  const rows = await deps.fetchDecisions(sinceIso);
  const metrics = aggregateAcceptance(rows, now);

  await deps.notifier.notifyAdmin(renderAcceptanceReport(metrics, today));
  await deps.writeLastRun(today);

  deps.log.info({ day: today, total30d: metrics.overall['30d'].total }, 'acceptance report posted');
  return { posted: true };
}
