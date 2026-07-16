import type { FounderNotifierPort, Notification } from '../ports/founder-notifier.port';
import type {
  WeeklyReviewCustomerFact,
  WeeklyReviewRequest,
  WeeklyReviewResult,
  WeeklyReviewSynthesizerPort,
} from '../ports/llm.port';
import type { ResolvedDecision } from './acceptance-report';
import type { AwaitingReplyItem } from '../query/daily-briefing';
import type { SyncLogger } from '../knowledge/sync';
import { isoWeekInTz } from '../knowledge/pattern-detect';

// Weekly business review (WP5(c), CORE — ports + injected repo fns only; the concrete queries +
// notifier + synthesizer are wired at the composition root, so this never imports src/adapters —
// D1 boundary). Every Friday it gathers per-customer 7-day FACTS from EXISTING reads (inbox in/out
// volume, draft approvals/rejections from agent_decisions, open portal tasks, awaiting-reply items,
// and the upcoming week's meetings), runs ONE LLM synthesis into a chief-of-staff read, and posts
// the whole thing to the Telegram Admin topic.
//
// Idempotent per ISO week (an app_state last-run-week key) AND gated to Friday at/after a configured
// hour, so a sub-weekly poll interval (and restarts) post EXACTLY ONCE per week. Post-late-never-skip
// through the weekend, then the ISO-week guard keeps a late post from doubling (mirrors the daily
// briefing's missed-hour policy).
//
// Tri-state facts (mirrors the daily briefing): openTasks / upcomingMeetings are best-effort — a
// failed or unwired source renders "unavailable" (a null fact), never a silent zero. The three CORE
// reads (inbox volume, draft outcomes, awaiting-reply) ARE the review, so a failure there defers the
// whole post to the next tick rather than posting a half-empty review. A SYNTHESIS failure posts the
// deterministic facts digest without narrative — never nothing. PII-light throughout: display names
// + counts only, never a message body; the log stays counts-only.

/** Per-customer inbound/outbound message volume in the window (the composition root maps rows here). */
export interface CustomerVolume {
  customerId: string;
  customerName: string | null;
  inbound: number;
  outbound: number;
}

/** Per-customer open portal-task count (best-effort source; the whole source is null when it failed). */
export interface CustomerOpenTasks {
  customerId: string;
  count: number;
}

export interface WeeklyReviewDeps {
  /** Inbound/outbound message volume per customer since an ISO instant. A CORE read (not caught). */
  fetchInboxVolume: (sinceIso: string) => Promise<CustomerVolume[]>;
  /** Resolved draft decisions since an ISO instant (decisions.fetchResolvedDraftDecisions). CORE. */
  fetchDraftOutcomes: (sinceIso: string) => Promise<ResolvedDecision[]>;
  /** Tasks awaiting a customer reply, last sent before `olderThan` (briefing-repo.fetchAwaitingReply). CORE. */
  fetchAwaitingReply: (olderThan: Date) => Promise<AwaitingReplyItem[]>;
  /** Open portal tasks per customer. OPTIONAL + best-effort (tri-state): a throw / unwired → the
   *  whole open-tasks column is "unavailable" rather than a wrong zero. */
  fetchOpenTasks?: () => Promise<CustomerOpenTasks[]>;
  /** Count of the founder's meetings in the week AHEAD (CALENDAR_ENABLED). OPTIONAL + best-effort. */
  fetchUpcomingMeetings?: () => Promise<number>;
  /** The chief-of-staff synthesizer. OPTIONAL — omitted → the digest is the deterministic facts only. */
  synthesizer?: WeeklyReviewSynthesizerPort;
  notifier: Pick<FounderNotifierPort, 'notifyAdmin'>;
  /** Last ISO week (YYYY-Www) a review posted, from app_state (or null). */
  readLastRun: () => Promise<string | null>;
  /** Persist the ISO week after a successful post (app_state). */
  writeLastRun: (week: string) => Promise<void>;
  now: () => Date;
  /** Timezone for the ISO-week boundary + the Friday/hour gate (founder's local week). */
  tz: string;
  /** Founder-local hour (0–23) the review fires at on Friday. */
  hour: number;
  /** Look-back window in days for the facts (default 7). */
  windowDays?: number;
  log: SyncLogger;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const AWAITING_REPLY_DAYS = 3;
/** Luxon-style weekday for Friday (Mon=1 … Sun=7). */
const FRIDAY = 5;

/** Why a tick did or did not post. */
export type WeeklyReviewDecision = 'post' | 'already-posted-this-week' | 'before-friday-hour';

/** Founder-local weekday (1–7, Mon=1) of a Date in an IANA timezone. */
function weekdayInTz(d: Date, tz: string): number {
  // en-US 'short' weekday → map to ISO weekday number.
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d);
  const order: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return order[wd] ?? 1;
}

/** The founder-local hour (0–23) of a Date in an IANA timezone. */
function hourInTz(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const raw = Number(parts.find((p) => p.type === 'hour')?.value);
  return Number.isFinite(raw) ? raw % 24 : 0;
}

/**
 * The schedule gate (PURE). Posts when this ISO week has no review yet AND the founder-local clock
 * has reached Friday at/after the configured hour. Post-late-never-skip: Saturday/Sunday still post
 * (weekday > Friday), and the ISO-week guard (Fri–Sun share one ISO week) keeps that late post from
 * doubling. A tick before Friday-at-hour writes nothing, so the week stays owed.
 */
export function decideWeeklyReviewRun(input: {
  now: Date;
  tz: string;
  hour: number;
  lastRunWeek: string | null;
}): { decision: WeeklyReviewDecision; week: string } {
  const week = isoWeekInTz(input.now, input.tz);
  if (input.lastRunWeek === week) return { decision: 'already-posted-this-week', week };
  const wd = weekdayInTz(input.now, input.tz);
  const eligible = wd > FRIDAY || (wd === FRIDAY && hourInTz(input.now, input.tz) >= input.hour);
  if (!eligible) return { decision: 'before-friday-hour', week };
  return { decision: 'post', week };
}

/** A customer with no display name still needs a stable label for the review. */
function who(name: string | null, id: string): string {
  return name ?? id;
}

/**
 * Merge the per-customer sources into one fact row per customer (PURE). Keyed by customerId; a
 * customer that appears in ANY source is included. `openTasks` is null for every customer when the
 * open-tasks source was unavailable (null passed in). Draft outcomes: approved = accepted + modified
 * (an edited-then-approved draft still went out), rejected = rejected. Sorted by total activity desc
 * so the most active customers lead. Exported for direct unit testing.
 */
export function buildCustomerFacts(input: {
  volume: readonly CustomerVolume[];
  outcomes: readonly ResolvedDecision[];
  awaiting: readonly AwaitingReplyItem[];
  openTasks: readonly CustomerOpenTasks[] | null;
  now: Date;
}): WeeklyReviewCustomerFact[] {
  interface Accum {
    customerId: string;
    name: string | null;
    inbound: number;
    outbound: number;
    draftsApproved: number;
    draftsRejected: number;
    awaitingReplyDays: number | null;
    openTasks: number | null;
  }
  const by = new Map<string, Accum>();
  const get = (id: string, name: string | null): Accum => {
    let a = by.get(id);
    if (!a) {
      a = { customerId: id, name, inbound: 0, outbound: 0, draftsApproved: 0, draftsRejected: 0, awaitingReplyDays: null, openTasks: null };
      by.set(id, a);
    }
    if (a.name === null && name !== null) a.name = name;
    return a;
  };

  for (const v of input.volume) {
    const a = get(v.customerId, v.customerName);
    a.inbound += v.inbound;
    a.outbound += v.outbound;
  }
  for (const d of input.outcomes) {
    if (d.customerId === null) continue; // a null-customer draft is not per-customer actionable
    const a = get(d.customerId, d.customerName);
    if (d.outcome === 'rejected') a.draftsRejected += 1;
    else a.draftsApproved += 1; // accepted or modified — it went out
  }
  for (const w of input.awaiting) {
    const a = get(w.customerId, w.customerName);
    const days = Math.floor((input.now.getTime() - w.lastOutboundAt.getTime()) / DAY_MS);
    a.awaitingReplyDays = a.awaitingReplyDays === null ? days : Math.max(a.awaitingReplyDays, days);
  }
  if (input.openTasks !== null) {
    for (const t of input.openTasks) {
      const a = by.get(t.customerId);
      if (a) a.openTasks = t.count; // only attribute to customers we already know from another source
    }
    // A customer present only in the open-tasks source still deserves a row.
    for (const t of input.openTasks) {
      if (!by.has(t.customerId)) {
        const a = get(t.customerId, null);
        a.openTasks = t.count;
      }
    }
  }

  return [...by.values()]
    .map((a) => ({
      customer: who(a.name, a.customerId),
      inbound: a.inbound,
      outbound: a.outbound,
      draftsApproved: a.draftsApproved,
      draftsRejected: a.draftsRejected,
      awaitingReplyDays: a.awaitingReplyDays,
      // When the whole source was unavailable, every customer's openTasks stays null (unavailable).
      openTasks: input.openTasks === null ? null : a.openTasks ?? 0,
    }))
    .sort(
      (x, y) =>
        y.inbound + y.outbound + y.draftsApproved + y.draftsRejected - (x.inbound + x.outbound + x.draftsApproved + x.draftsRejected),
    );
}

/** One deterministic per-customer fact line (PURE). Never a body — counts only. */
function factLine(c: WeeklyReviewCustomerFact): string {
  const awaiting = c.awaitingReplyDays === null ? '' : ` · awaiting reply ${c.awaitingReplyDays}d`;
  const open = c.openTasks === null ? 'n/a' : String(c.openTasks);
  return `  ${c.customer}: ${c.inbound} in / ${c.outbound} out · drafts ${c.draftsApproved}✅ ${c.draftsRejected}🚫 · open ${open}${awaiting}`;
}

/**
 * Render the review into a founder-facing admin Notification (PURE). Leads with the chief-of-staff
 * synthesis when one is present (highlights → per-customer assessments → focus next week), then the
 * deterministic facts section (ALWAYS rendered — it is the source of truth). `synthesis`:
 *   • undefined → no synthesizer wired → facts only.
 *   • null      → synthesis FAILED this tick → facts only (never a fabricated narrative).
 *   • result    → the narrative atop the facts.
 */
export function renderWeeklyReview(
  facts: WeeklyReviewCustomerFact[],
  upcomingMeetings: number | null,
  week: string,
  synthesis?: WeeklyReviewResult | null,
): Notification {
  const parts: string[] = [];

  if (synthesis) {
    if (synthesis.highlights.length > 0) {
      parts.push('✨ Highlights');
      for (const h of synthesis.highlights) parts.push(`  • ${h}`);
      parts.push('');
    }
    if (synthesis.perCustomer.length > 0) {
      parts.push('👥 By customer');
      for (const c of synthesis.perCustomer) {
        parts.push(`  ${c.customer}: ${c.state}`);
        parts.push(`    → ${c.suggestedAction}`);
      }
      parts.push('');
    }
    if (synthesis.focusNextWeek.length > 0) {
      parts.push('🎯 Focus next week');
      for (const f of synthesis.focusNextWeek) parts.push(`  • ${f}`);
      parts.push('');
    }
  }

  parts.push('── Facts (last 7 days) ──');
  parts.push(`📅 Upcoming meetings next week: ${upcomingMeetings === null ? 'unavailable' : upcomingMeetings}`);
  if (facts.length === 0) parts.push('  No customer activity this week.');
  else for (const c of facts) parts.push(factLine(c));

  return { title: `🗓️ Weekly business review — ${week}`, body: parts.join('\n'), severity: 'info' };
}

/** Run one best-effort optional source → null on throw/unwired (rendered "unavailable"). */
async function safeSource<T>(fn: (() => Promise<T>) | undefined, name: string, log: SyncLogger): Promise<T | null> {
  if (!fn) return null;
  try {
    return await fn();
  } catch (err) {
    log.warn({ source: name, reason: (err as Error)?.message }, 'weekly review: source unavailable');
    return null;
  }
}

/**
 * One weekly-review tick. Gated to Friday at/after the configured hour and idempotent per ISO week.
 * Posts first, then marks — a transient notify failure re-attempts next tick rather than silently
 * skipping the week. A SYNTHESIS failure degrades to the deterministic facts digest (never nothing).
 */
export async function runWeeklyReview(deps: WeeklyReviewDeps): Promise<{ posted: boolean }> {
  const now = deps.now();
  const lastRunWeek = await deps.readLastRun();
  const { decision, week } = decideWeeklyReviewRun({ now, tz: deps.tz, hour: deps.hour, lastRunWeek });

  if (decision === 'already-posted-this-week') {
    deps.log.debug({ week }, 'weekly review: already posted this week — skip (idempotent)');
    return { posted: false };
  }
  if (decision === 'before-friday-hour') {
    deps.log.debug({ week, hour: deps.hour }, 'weekly review: before Friday/hour — skip');
    return { posted: false };
  }

  const windowDays = deps.windowDays ?? 7;
  const sinceIso = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
  const awaitingCutoff = new Date(now.getTime() - AWAITING_REPLY_DAYS * DAY_MS);

  // CORE reads (not caught — they ARE the review). Enrichment sources are best-effort (tri-state).
  const [volume, outcomes, awaiting, openTasks, upcomingMeetings] = await Promise.all([
    deps.fetchInboxVolume(sinceIso),
    deps.fetchDraftOutcomes(sinceIso),
    deps.fetchAwaitingReply(awaitingCutoff),
    safeSource(deps.fetchOpenTasks, 'open_tasks', deps.log),
    safeSource(deps.fetchUpcomingMeetings, 'meetings', deps.log),
  ]);

  const facts = buildCustomerFacts({ volume, outcomes, awaiting, openTasks, now });

  // Best-effort synthesis over the gathered facts. A throw yields null → the facts digest posts
  // without narrative rather than nothing.
  let synthesis: WeeklyReviewResult | null | undefined;
  if (deps.synthesizer) {
    const req: WeeklyReviewRequest = { weekLabel: week, perCustomer: facts, upcomingMeetings };
    try {
      synthesis = await deps.synthesizer.synthesizeWeeklyReview(req);
    } catch (err) {
      deps.log.warn({ reason: (err as Error)?.message }, 'weekly review: synthesis unavailable — posting facts only');
      synthesis = null;
    }
  }

  await deps.notifier.notifyAdmin(renderWeeklyReview(facts, upcomingMeetings, week, synthesis));
  await deps.writeLastRun(week);

  deps.log.info(
    {
      week,
      customers: facts.length,
      openTasks: openTasks === null ? 'unavailable' : 'ok',
      meetings: upcomingMeetings === null ? 'unavailable' : upcomingMeetings,
      synthesis: synthesis === undefined ? null : synthesis === null ? 'unavailable' : synthesis.perCustomer.length,
    },
    'weekly review posted',
  );
  return { posted: true };
}
