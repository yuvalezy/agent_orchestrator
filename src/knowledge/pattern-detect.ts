import type { FounderNotifierPort, Notification } from '../ports/founder-notifier.port';
import type { SyncLogger } from './sync';
import { clusterByEmbedding, type EmbeddedItem } from './proposal-collapse';

// M3(e) Weekly Pattern Detection (CORE, pure aggregation + injected fetch/notifier —
// mirrors the M3(d) acceptance-report shape). Clusters the week's Layer-A signal
// memories (founder corrections + customer conversation/task themes) by their ALREADY-
// STORED embeddings (no new embed calls — reuses the vectors written at ingest) via the
// existing greedy near-dupe primitive (proposal-collapse.clusterByEmbedding), keeps only
// clusters that recur (>= minCount), and renders the top recurring patterns as a founder
// digest posted to the Telegram Admin topic. Purpose: surface SYSTEMIC issues ("3
// customers asked about X", "you corrected Y five times"), not one-off decisions.
//
// PURE + unit-testable without a DB (the fetch + notifier + clock are injected).
// Idempotent per ISO week (an app_state last-run-week key) so a sub-weekly interval that
// fires several times a week (and restarts) posts EXACTLY ONCE per ISO week. Counts +
// cluster labels only cross the logging boundary — NEVER message bodies (the founder-
// facing digest carries a short representative label, which is not logged).

/** One signal row (an agent_memory Layer-A memory) with its stored embedding. Structurally
 *  matches memory-repo's RecentSignalRow so the composition root can inject it directly. */
export interface PatternSignalInput {
  id: string;
  memoryType: string;
  customerId: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  /** The embedding stored at ingest — reused for clustering (no new embed call). */
  embedding: number[];
  createdAt: Date;
}

/** A founder-behavior pattern (corrections/feedback) vs a customer-theme pattern
 *  (conversation/task). Splits the digest into "you corrected X" vs "N customers asked X". */
export type PatternKind = 'correction' | 'theme';

/** memory_types that represent a FOUNDER correction (vs a customer-originated theme). */
const CORRECTION_TYPES = new Set(['correction', 'feedback']);

export interface Pattern {
  kind: PatternKind;
  /** Short representative label (from the cluster's rep row); shown to the founder, never logged. */
  label: string;
  /** Total signals in the cluster. */
  count: number;
  /** Distinct non-null customers touched by the cluster. */
  distinctCustomers: number;
  /** Most common memory_type in the cluster. */
  dominantType: string;
}

export interface PatternDigest {
  totalSignals: number;
  /** Founder-correction patterns, recurring-first. */
  corrections: Pattern[];
  /** Customer-theme patterns, recurring-first. */
  themes: Pattern[];
}

export interface DetectOptions {
  /** Cosine-distance ceiling for two signals to join the same cluster (tight by design). */
  maxDistance: number;
  /** Minimum cluster size to count as a RECURRING pattern (a one-off is dropped). */
  minCount: number;
  /** Cap on patterns surfaced per section. */
  topK: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A compact, single-line label from a signal (prefers a correction's `fact`, else the
 *  content), whitespace-collapsed and length-capped. PURE. */
export function labelForSignal(s: PatternSignalInput): string {
  const fact = s.metadata && typeof s.metadata['fact'] === 'string' ? (s.metadata['fact'] as string) : '';
  const raw = (fact || s.content || '').replace(/\s+/g, ' ').trim();
  const max = 90;
  return raw.length > max ? `${raw.slice(0, max - 1).trimEnd()}…` : raw;
}

/**
 * Cluster the week's signals by their stored embeddings and aggregate each recurring
 * cluster (>= minCount) into a Pattern (PURE). Order-stable: the input's first-seen row
 * in each cluster is the representative (label source), so callers pass signals in a
 * sensible order (this run passes most-recent-first for a current-phrasing label).
 * Patterns are split by dominant memory_type into corrections vs themes, each ranked by
 * distinct customers desc then total count desc, and capped at topK.
 */
export function detectPatterns(signals: readonly PatternSignalInput[], opts: DetectOptions): PatternDigest {
  const items: EmbeddedItem[] = signals.map((s) => ({ key: s.id, embedding: s.embedding }));
  const clusters = clusterByEmbedding(items, opts.maxDistance);
  const byId = new Map(signals.map((s) => [s.id, s]));

  const corrections: Pattern[] = [];
  const themes: Pattern[] = [];

  for (const cluster of clusters) {
    if (cluster.memberKeys.length < opts.minCount) continue;
    const members = cluster.memberKeys.map((k) => byId.get(k)).filter((m): m is PatternSignalInput => Boolean(m));

    const typeCounts = new Map<string, number>();
    const customers = new Set<string>();
    for (const m of members) {
      typeCounts.set(m.memoryType, (typeCounts.get(m.memoryType) ?? 0) + 1);
      if (m.customerId) customers.add(m.customerId);
    }
    const dominantType = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const rep = byId.get(cluster.repKey);
    if (!rep) continue;
    const kind: PatternKind = CORRECTION_TYPES.has(dominantType) ? 'correction' : 'theme';

    (kind === 'correction' ? corrections : themes).push({
      kind,
      label: labelForSignal(rep),
      count: members.length,
      distinctCustomers: customers.size,
      dominantType,
    });
  }

  const rank = (a: Pattern, b: Pattern): number =>
    b.distinctCustomers - a.distinctCustomers || b.count - a.count;
  corrections.sort(rank);
  themes.sort(rank);

  return {
    totalSignals: signals.length,
    corrections: corrections.slice(0, opts.topK),
    themes: themes.slice(0, opts.topK),
  };
}

/**
 * Render the digest into a founder-facing admin Notification (PURE). `weekLabel` is the
 * ISO week (for the title); `windowDays` is the look-back for the empty-state line. The
 * short labels are shown to the founder only (this is the Admin topic) — they are not
 * logged. An empty digest still posts a reassuring "nothing recurring" line (weekly
 * cadence, low noise).
 */
export function renderPatternDigest(digest: PatternDigest, weekLabel: string, windowDays: number): Notification {
  const parts: string[] = [];

  if (digest.themes.length > 0) {
    parts.push('Recurring customer themes');
    for (const p of digest.themes) {
      const who = p.distinctCustomers >= 2 ? `${p.distinctCustomers} customers` : '1 customer';
      parts.push(`  • ${who} — ${p.label} (${p.count} mentions)`);
    }
  }

  if (digest.corrections.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push('Recurring corrections');
    for (const p of digest.corrections) {
      parts.push(`  • ${p.label} — corrected ×${p.count}`);
    }
  }

  if (parts.length === 0) {
    parts.push(`No recurring patterns this week (n=${digest.totalSignals} signals over ${windowDays}d).`);
  }

  return {
    title: `🔎 Weekly pattern digest — ${weekLabel}`,
    body: parts.join('\n'),
    severity: 'info',
  };
}

/**
 * ISO-8601 week label (e.g. "2026-W28") for an instant in an IANA timezone, so "weekly"
 * is the founder's LOCAL week (not UTC). PURE. Computes the ISO week over the tz-local
 * calendar date via the standard nearest-Thursday algorithm; the year is the ISO
 * week-year (which can differ from the calendar year in the first/last days of a year).
 */
export function isoWeekInTz(d: Date, tz: string): string {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  const [y, m, day] = ymd.split('-').map(Number);

  const date = new Date(Date.UTC(y, m - 1, day));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // move to the cluster's Thursday
  const isoYear = date.getUTCFullYear();

  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);

  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export interface WeeklyPatternsDeps {
  /** Recent Layer-A signal memories since an ISO instant (memoryRepo.fetchRecentSignals). */
  fetchSignals: (sinceIso: string) => Promise<PatternSignalInput[]>;
  notifier: Pick<FounderNotifierPort, 'notifyAdmin'>;
  /** Last ISO week (YYYY-Www) a digest posted, from app_state (or null). */
  readLastRun: () => Promise<string | null>;
  /** Persist the ISO week after a successful post (app_state). */
  writeLastRun: (week: string) => Promise<void>;
  /** Injected clock (test seam). */
  now: () => Date;
  /** Timezone for the ISO-week boundary (the founder's local week). */
  tz: string;
  /** Look-back window in days (the signal horizon). */
  windowDays: number;
  detect: DetectOptions;
  log: SyncLogger;
}

/**
 * One weekly tick. Idempotent per ISO week: if a digest already posted this week (the
 * app_state last-run week == this week) it is a no-op, so a sub-weekly interval posts
 * EXACTLY ONCE per week. Posts first, then marks — a transient notify failure re-attempts
 * next tick rather than silently skipping the week.
 */
export async function runWeeklyPatterns(deps: WeeklyPatternsDeps): Promise<{ posted: boolean }> {
  const now = deps.now();
  const week = isoWeekInTz(now, deps.tz);

  const last = await deps.readLastRun();
  if (last === week) {
    deps.log.debug({ week }, 'weekly patterns: already posted this week — skip (idempotent)');
    return { posted: false };
  }

  const sinceIso = new Date(now.getTime() - deps.windowDays * MS_PER_DAY).toISOString();
  const signals = await deps.fetchSignals(sinceIso);
  const digest = detectPatterns(signals, deps.detect);

  await deps.notifier.notifyAdmin(renderPatternDigest(digest, week, deps.windowDays));
  await deps.writeLastRun(week);

  deps.log.info(
    {
      week,
      totalSignals: digest.totalSignals,
      themes: digest.themes.length,
      corrections: digest.corrections.length,
    },
    'weekly pattern digest posted',
  );
  return { posted: true };
}
