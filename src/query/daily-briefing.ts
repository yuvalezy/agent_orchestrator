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
//
// ── Task 3.1's four sections (added ADDITIVELY) ────────────────────────────────────────────
// The spec asks the briefing to carry: overnight unprocessed, urgent items, tasks awaiting a
// customer reply > 3 days, and today's holidays/meetings. Each arrives as its OWN optional
// injected fetch on DailyBriefingDeps and lands in its OWN optional field on BriefingData:
//   • `undefined` → the source is NOT wired (feature off) → the section is OMITTED entirely.
//   • `null`      → the source IS wired but FAILED this tick → rendered "unavailable".
// The null state is load-bearing: a calendar outage must never make the digest silently claim
// "no meetings today". Every new section is best-effort — one failing source must not stop the
// briefing (the two original queues are NOT caught: they ARE the briefing, so a failure there
// still defers the whole post to the next tick, unchanged from M5(b)).
//
// This additive shape is deliberate: src/query/commands.ts consumes composeBriefing /
// renderBriefing / queueLine / BriefingData for `/pending`, `/briefing` and `/summary`. Those
// callers pass no sections, so every new field stays undefined and their rendered output is
// byte-for-byte what it was — no change needed there.
//
// PII posture for the new sections (the briefing posts UNPROMPTED to the admin topic, so the
// strict "names + counts + ages, never a body" rule holds): the urgent feed carries the
// customer name + change 06's score + an age — the adapter DROPS the subject/sender the
// ranked read returns. Awaiting-reply carries a name + task CODE + an age, never the reply
// text. Today's calendar carries event TITLES + times: an event title is the founder's own
// calendar entry (not customer message content), it is the only thing that makes the line
// useful, and src/triage/meeting-context.ts already surfaces titles the same way. Titles are
// rendered but NEVER logged — the log stays counts-only throughout.

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

// ── Task 3.1 section inputs (PII-light; the composition root maps rows down to these) ───────

/**
 * One inbox row ranked by change 06's urgency score. The score is NOT computed here and must
 * never be recomputed here — it is produced by the ONE documented, deterministic definition in
 * the console urgency read (src/adapters/console/console-urgency-repo.ts: failed=1000,
 * pending=500, processing=200, + 1/hour of age capped at 72, + 5/retry capped at 20) and
 * injected. A second scoring rule living in core is exactly the divergence to avoid.
 */
export interface UrgentItem {
  customerId: string | null;
  customerName: string | null;
  /** Change 06's score, passed through verbatim. */
  urgencyScore: number;
  /** The instant the score's age component measures from (received_at, else created_at). */
  createdAt: Date;
}

/** The ranked urgent read. `capped` marks a page-limited read (more rows may exist BELOW the
 *  last one) — it is what lets composeBriefing say whether its count is exact. */
export interface UrgentFeed {
  items: readonly UrgentItem[];
  capped: boolean;
}

/** A task we replied on, still waiting for the customer to come back. */
export interface AwaitingReplyItem {
  customerId: string;
  customerName: string | null;
  /** Human task code (e.g. 'TSK-00214'); null when the bridge has no code. */
  taskCode: string | null;
  /** When we last sent the customer something on this task. */
  lastOutboundAt: Date;
}

/** One of today's calendar events. Title + time only — never the event description. */
export interface TodayMeeting {
  title: string;
  startsAt: Date;
  allDay: boolean;
}

/** One of today's holidays (agent_holidays). `faith` is the 'global' sentinel or a faith key. */
export interface TodayHoliday {
  name: string | null;
  faith: string;
}

// ── Task 3.1 section roll-ups (what renders) ─────────────────────────────────────────────────

/** One urgent line: who + change 06's score + how long it has waited. No subject, no body. */
export interface UrgentLine {
  customerId: string | null;
  customerName: string | null;
  urgencyScore: number;
  ageHours: number;
}

export interface UrgentSummary {
  /** How many items are at/above the urgency cut. */
  count: number;
  /**
   * FALSE when `count` is only a FLOOR. The ranked read is page-capped, but it is ordered by
   * score DESC — so every item at/above the cut sorts BEFORE every item below it. If even one
   * returned row fell below the cut, the page provably contains ALL urgent rows and the count
   * is EXACT despite the cap. The count is a floor only when the page was capped AND every row
   * on it was urgent (the cut may continue past the page edge). 5.4 demands accurate counts —
   * this is how the section stays honest instead of guessing.
   */
  exact: boolean;
  /** The most urgent items, score desc (capped by topN). */
  top: UrgentLine[];
}

/** One awaiting-reply line: who + which task + how long since we last sent. */
export interface AwaitingReplyLine {
  customerId: string;
  customerName: string | null;
  taskCode: string | null;
  ageHours: number;
}

export interface AwaitingReplySummary {
  count: number;
  /** Longest wait in whole hours; null when nothing is awaiting. */
  oldestAgeHours: number | null;
  /** The longest-waiting tasks (capped by topN). */
  top: AwaitingReplyLine[];
}

export interface TodaySummary {
  meetings: TodayMeeting[];
  holidays: TodayHoliday[];
}

export interface BriefingData {
  drafts: QueueSummary;
  proposals: QueueSummary;
  /** Customers ranked by total waiting items desc, then oldest-age desc. */
  topCustomers: CustomerAttention[];
  // ── Task 3.1 sections. undefined = source not wired (omit); null = wired but failed
  //    this tick (render "unavailable" — NEVER a silent zero). See the header.
  /** Inbox rows that landed in the overnight window and are still untriaged. */
  overnight?: QueueSummary | null;
  /** Items at/above the urgency cut, ranked by change 06's score. */
  urgent?: UrgentSummary | null;
  /** Tasks we replied on with no customer answer for > AWAITING_REPLY_DAYS. */
  awaitingReply?: AwaitingReplySummary | null;
  /** Today's meetings + holidays (founder-local day). */
  today?: TodaySummary | null;
}

const HOUR_MS = 60 * 60 * 1000;

/** "> 3 days" from task 3.1, in whole days. Core owns this rule; the injected fetch is handed
 *  the resulting cutoff INSTANT so the count is filtered in SQL and stays exact under any cap. */
export const AWAITING_REPLY_DAYS = 3;

/** The "overnight" look-back. The briefing fires once a day, so the window that ends at the
 *  configured hour and covers everything since the previous one is the last 24 hours — i.e. what
 *  landed while the founder was away and is STILL untriaged. Older untriaged rows are not lost:
 *  they carry the highest age points and surface in the urgent section, which has no window. */
export const OVERNIGHT_WINDOW_HOURS = 24;

/**
 * Default cut on change 06's urgency scale — NOT a new score, a threshold ON the existing one.
 * 500 is where a row is at least 'pending' (failed=1000, pending=500, processing=200), so the
 * section means "queued or broken", and a row merely mid-flight in a healthy worker (200) does
 * not cry wolf every morning. Tunable via DAILY_BRIEFING_URGENT_MIN_SCORE.
 */
export const URGENT_MIN_SCORE = 500;

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

/** Raw section inputs handed to composeBriefing. Every field is optional and tri-state:
 *  absent = not wired (omit the section), null = the source failed (render "unavailable"). */
export interface BriefingSectionInput {
  /** Untriaged inbox rows inside the overnight window (createdAt = the row's received_at). */
  overnight?: readonly PendingItem[] | null;
  urgent?: UrgentFeed | null;
  /** Already filtered to > AWAITING_REPLY_DAYS by the fetch (core hands it the cutoff). */
  awaitingReply?: readonly AwaitingReplyItem[] | null;
  today?: { meetings: readonly TodayMeeting[]; holidays: readonly TodayHoliday[] } | null;
  /** Cut on change 06's urgency scale; defaults to URGENT_MIN_SCORE. */
  urgentMinScore?: number;
}

/** Roll the ranked urgent feed up to a count + the top lines (PURE). See UrgentSummary.exact
 *  for why a page-capped read can still yield an exact count. */
function summarizeUrgent(feed: UrgentFeed, now: Date, minScore: number, topN: number): UrgentSummary {
  const urgent = feed.items.filter((i) => i.urgencyScore >= minScore);
  return {
    count: urgent.length,
    exact: !feed.capped || urgent.length < feed.items.length,
    top: [...urgent]
      .sort((a, b) => b.urgencyScore - a.urgencyScore || a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, topN)
      .map((i) => ({
        customerId: i.customerId,
        customerName: i.customerName,
        urgencyScore: i.urgencyScore,
        ageHours: ageHours(i.createdAt, now),
      })),
  };
}

/** Roll awaiting-reply tasks up to a count + oldest age + the longest-waiting lines (PURE). */
function summarizeAwaitingReply(
  items: readonly AwaitingReplyItem[],
  now: Date,
  topN: number,
): AwaitingReplySummary {
  const lines = [...items]
    .sort((a, b) => a.lastOutboundAt.getTime() - b.lastOutboundAt.getTime())
    .map((i) => ({
      customerId: i.customerId,
      customerName: i.customerName,
      taskCode: i.taskCode,
      ageHours: ageHours(i.lastOutboundAt, now),
    }));
  return {
    count: lines.length,
    oldestAgeHours: lines.length === 0 ? null : lines[0].ageHours,
    top: lines.slice(0, topN),
  };
}

/**
 * Aggregate the two pending queues into the digest shape (PURE). Per-queue counts +
 * oldest age, plus a per-customer roll-up ranked by total waiting items (tie-broken by
 * the oldest age). Items with a null customerId still count toward the queue totals but
 * are NOT surfaced as a named attention row (there is no customer to act on). `topN`
 * caps the attention list so the digest stays scannable.
 *
 * Task 3.1's four sections are ADDITIVE and arrive through `opts`: a caller that passes none
 * (src/query/commands.ts's `/pending`, `/briefing`, `/summary`) gets exactly the M5(b) shape
 * back, so their output is unchanged.
 */
export function composeBriefing(
  drafts: readonly PendingItem[],
  proposals: readonly PendingItem[],
  now: Date,
  opts: { topN?: number } & BriefingSectionInput = {},
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

  const data: BriefingData = {
    drafts: summarize(drafts, now),
    proposals: summarize(proposals, now),
    topCustomers,
  };

  // Additive sections: only ever SET a key the caller supplied, so an M5(b) caller's data
  // object keeps its exact original shape (no undefined keys appearing in deepEqual).
  if (opts.overnight !== undefined) {
    data.overnight = opts.overnight === null ? null : summarize(opts.overnight, now);
  }
  if (opts.urgent !== undefined) {
    data.urgent =
      opts.urgent === null
        ? null
        : summarizeUrgent(opts.urgent, now, opts.urgentMinScore ?? URGENT_MIN_SCORE, topN);
  }
  if (opts.awaitingReply !== undefined) {
    data.awaitingReply =
      opts.awaitingReply === null ? null : summarizeAwaitingReply(opts.awaitingReply, now, topN);
  }
  if (opts.today !== undefined) {
    data.today =
      opts.today === null
        ? null
        : { meetings: [...opts.today.meetings], holidays: [...opts.today.holidays] };
  }
  return data;
}

/** One queue roll-up line: "📝 Draft replies: 3 pending · oldest 5h" / "… none pending".
 *  Exported so the on-demand `/pending` slash command renders queues identically (DRY). */
export function queueLine(label: string, s: QueueSummary): string {
  if (s.count === 0) return `${label}: none pending`;
  return `${label}: ${s.count} pending · oldest ${humanizeAgeHours(s.oldestAgeHours ?? 0)}`;
}

/** Name a customer for a digest line, falling back to the id (never blank). */
function who(customerName: string | null, customerId: string | null): string {
  return customerName ?? customerId ?? 'unknown';
}

/** "09:30" / "all day" for a meeting line, in the founder's tz. */
function meetingTime(m: TodayMeeting, tz: string): string {
  if (m.allDay) return 'all day';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(m.startsAt);
}

/** Render task 3.1's four sections. Each returns [] when its source is not wired, and an
 *  explicit "unavailable" line when the source failed (null) — never a silent zero. */
function sectionLines(data: BriefingData, tz: string): string[] {
  const parts: string[] = [];

  if (data.overnight !== undefined) {
    if (data.overnight === null) parts.push('🌙 Overnight — unavailable');
    else if (data.overnight.count === 0) parts.push(`🌙 Overnight (last ${OVERNIGHT_WINDOW_HOURS}h): nothing unprocessed`);
    else {
      parts.push(
        `🌙 Overnight (last ${OVERNIGHT_WINDOW_HOURS}h): ${data.overnight.count} unprocessed · oldest ${humanizeAgeHours(data.overnight.oldestAgeHours ?? 0)}`,
      );
    }
  }

  if (data.urgent !== undefined) {
    if (data.urgent === null) parts.push('🔥 Urgent — unavailable');
    else if (data.urgent.count === 0) parts.push('🔥 Urgent: none');
    else {
      parts.push(`🔥 Urgent: ${data.urgent.count}${data.urgent.exact ? '' : '+'}`);
      for (const u of data.urgent.top) {
        parts.push(`  ${who(u.customerName, u.customerId)} · score ${u.urgencyScore} · waiting ${humanizeAgeHours(u.ageHours)}`);
      }
    }
  }

  if (data.awaitingReply !== undefined) {
    const label = `⏳ Awaiting customer reply > ${AWAITING_REPLY_DAYS}d`;
    if (data.awaitingReply === null) parts.push(`${label} — unavailable`);
    else if (data.awaitingReply.count === 0) parts.push(`${label}: none`);
    else {
      parts.push(`${label}: ${data.awaitingReply.count}`);
      for (const a of data.awaitingReply.top) {
        const code = a.taskCode ? `${a.taskCode} · ` : '';
        parts.push(`  ${who(a.customerName, a.customerId)} · ${code}silent ${humanizeAgeHours(a.ageHours)}`);
      }
    }
  }

  if (data.today !== undefined) {
    if (data.today === null) parts.push('📅 Today — unavailable');
    else {
      const { meetings, holidays } = data.today;
      if (meetings.length === 0 && holidays.length === 0) parts.push('📅 Today: no meetings, no holidays');
      else {
        parts.push('📅 Today');
        for (const h of holidays) {
          parts.push(`  🎉 ${h.name ?? 'Holiday'}${h.faith === 'global' ? '' : ` (${h.faith})`}`);
        }
        for (const m of meetings) parts.push(`  ${meetingTime(m, tz)} — ${m.title}`);
      }
    }
  }
  return parts;
}

/** True when a section holds something the founder must act on (drives severity + all-clear). */
function hasActionableSections(data: BriefingData): boolean {
  return (
    (data.overnight?.count ?? 0) > 0 ||
    (data.urgent?.count ?? 0) > 0 ||
    (data.awaitingReply?.count ?? 0) > 0
  );
}

/**
 * Render the digest into a founder-facing admin Notification (PURE). `day` is the report's
 * tz-local calendar day (title). Leads with task 3.1's sections (what happened / what is on
 * fire / who has gone silent / what today holds), then the two queue roll-ups (what to
 * decide) and a ranked "needs attention" list (who is waiting, how many, how long). When
 * nothing is pending it still posts a short all-clear so the founder knows the briefing ran.
 *
 * `opts.tz` renders today's meeting times in the founder's zone; it is optional so the M5(b)
 * two-arg callers in src/query/commands.ts keep compiling and rendering identically (they pass
 * no sections, so nothing tz-dependent is ever printed for them).
 */
export function renderBriefing(data: BriefingData, day: string, opts: { tz?: string } = {}): Notification {
  const totalPending = data.drafts.count + data.proposals.count;
  const parts: string[] = [];

  const sections = sectionLines(data, opts.tz ?? 'UTC');
  if (sections.length > 0) parts.push(...sections, '');

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
  } else if (totalPending === 0 && !hasActionableSections(data)) {
    // All-clear only when the NEW sections are quiet too — an empty attention list while 12
    // urgent items burn would be a lie.
    parts.push('', 'All clear — nothing waiting on you. 🎉');
  }

  return {
    title: `☀️ Daily briefing — ${day}`,
    body: parts.join('\n'),
    // Today's meetings/holidays alone are informational — they are not work waiting on anyone.
    severity: totalPending > 0 || hasActionableSections(data) ? 'action' : 'info',
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

  // ── Task 3.1: the configured hour + the four sections. Each fetch is OPTIONAL — an omitted
  //    one means "not wired" and its section is left out of the digest entirely.

  /**
   * Founder-local hour (0–23) the briefing fires at. UNDEFINED = no hour gate: post on the
   * first tick of a new day (the M5(b) behavior, kept for on-demand/forced runs). The worker
   * always supplies env.DAILY_BRIEFING_HOUR, so production is always gated.
   */
  hour?: number;
  /** Untriaged inbox rows received since `since` (core passes now − OVERNIGHT_WINDOW_HOURS). */
  fetchOvernightUnprocessed?: (since: Date) => Promise<PendingItem[]>;
  /** The change-06 ranked urgent inbox. Scores are passed through, never recomputed here. */
  fetchUrgentItems?: () => Promise<UrgentFeed>;
  /** Tasks we last replied to before `olderThan` with no customer answer since (core passes
   *  now − AWAITING_REPLY_DAYS, so the > 3d rule is applied in SQL and the count stays exact). */
  fetchAwaitingReply?: (olderThan: Date) => Promise<AwaitingReplyItem[]>;
  /** Today's meetings on the founder's calendars, for the founder-local `day`. */
  fetchTodayMeetings?: (day: string) => Promise<TodayMeeting[]>;
  /** Today's holidays (agent_holidays) for the founder-local `day`. */
  fetchTodayHolidays?: (day: string) => Promise<TodayHoliday[]>;
  /** Cut on change 06's urgency scale (DAILY_BRIEFING_URGENT_MIN_SCORE). */
  urgentMinScore?: number;
}

/** Format a Date as YYYY-MM-DD in the given IANA timezone (en-CA yields ISO order).
 *  Exported so the on-demand `/briefing` slash command titles its digest the same way. */
export function dayInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** The hour (0–23) of a Date in an IANA timezone. `hourCycle:'h23'` pins midnight to 0; the
 *  `% 24` is a guard against ICU builds that render midnight as '24'. */
export function hourInTz(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const raw = Number(parts.find((p) => p.type === 'hour')?.value);
  return Number.isFinite(raw) ? raw % 24 : 0;
}

/** Why a tick did or did not post. */
export type BriefingDecision = 'post' | 'already-posted-today' | 'before-configured-hour';

/**
 * The schedule gate (PURE). A tick posts when the founder-local day has no briefing yet AND
 * the founder-local clock has reached the configured hour.
 *
 * ── Missed-hour policy: POST LATE, never skip ────────────────────────────────────────────────
 * The gate is `hourNow >= hour`, not `hourNow === hour`. If the box was rebooting at 08:00, the
 * next tick (say 11:20) still sees an unposted day past the hour and posts then. The alternative
 * — firing only ON the hour — means a process that was down for one interval silently loses the
 * whole day's briefing, which is exactly the failure mode this must avoid: a briefing nobody
 * notices is missing is worse than one that arrives late. The digest is a "what is waiting on
 * you right now" snapshot, so a late post is still correct and still useful — it is not stale
 * news. The day guard keeps late posts from becoming double posts.
 *
 * A tick BEFORE the hour is a no-op that writes nothing, so the day stays owed and the first
 * tick at/after the hour posts it.
 */
export function decideBriefingRun(input: {
  now: Date;
  tz: string;
  hour?: number;
  lastRunDay: string | null;
}): { decision: BriefingDecision; day: string } {
  const day = dayInTz(input.now, input.tz);
  if (input.lastRunDay === day) return { decision: 'already-posted-today', day };
  if (input.hour !== undefined && hourInTz(input.now, input.tz) < input.hour) {
    return { decision: 'before-configured-hour', day };
  }
  return { decision: 'post', day };
}

/**
 * Run one optional section fetch. A section source that throws yields `null` (rendered
 * "unavailable") instead of taking the whole briefing down — the calendar is a NETWORK read and
 * Google being down must not cost the founder their digest. Returns undefined when the fetch is
 * not wired, so the section is omitted entirely. Never logs anything but the section name.
 */
async function safeSection<T>(
  fn: (() => Promise<T>) | undefined,
  name: string,
  log: SyncLogger,
): Promise<T | null | undefined> {
  if (!fn) return undefined;
  try {
    return await fn();
  } catch (err) {
    log.warn({ section: name, reason: (err as Error)?.message }, 'daily briefing: section unavailable');
    return null;
  }
}

/**
 * One briefing tick. Fires at the configured founder-local hour and is idempotent per calendar
 * day: if a briefing already posted today (the app_state last-run day == today) it is a no-op,
 * so an interval that ticks many times a day (and restarts) posts EXACTLY ONCE per day. See
 * decideBriefingRun for the gate + the missed-hour policy (post late, never skip).
 *
 * Posts first, then marks — a transient notify failure re-attempts next tick rather than
 * silently skipping the day; the only double-post window is a mark write failing right after a
 * successful post (same DB the fetches just used — effectively never). Mirrors
 * runAcceptanceReport (change 03 sub-milestone d).
 */
export async function runDailyBriefing(deps: DailyBriefingDeps): Promise<{ posted: boolean }> {
  const now = deps.now();
  const lastRunDay = await deps.readLastRun();
  const { decision, day: today } = decideBriefingRun({ now, tz: deps.tz, hour: deps.hour, lastRunDay });

  if (decision === 'already-posted-today') {
    deps.log.debug({ today }, 'daily briefing: already posted today — skip (idempotent)');
    return { posted: false };
  }
  if (decision === 'before-configured-hour') {
    deps.log.debug({ today, hour: deps.hour }, 'daily briefing: before the configured hour — skip');
    return { posted: false };
  }

  const overnightSince = new Date(now.getTime() - OVERNIGHT_WINDOW_HOURS * HOUR_MS);
  const awaitingCutoff = new Date(now.getTime() - AWAITING_REPLY_DAYS * 24 * HOUR_MS);

  const [drafts, proposals, overnight, urgent, awaitingReply, meetings, holidays] = await Promise.all([
    deps.fetchPendingDrafts(),
    deps.fetchPendingProposals(),
    safeSection(deps.fetchOvernightUnprocessed && (() => deps.fetchOvernightUnprocessed!(overnightSince)), 'overnight', deps.log),
    safeSection(deps.fetchUrgentItems, 'urgent', deps.log),
    safeSection(deps.fetchAwaitingReply && (() => deps.fetchAwaitingReply!(awaitingCutoff)), 'awaiting_reply', deps.log),
    safeSection(deps.fetchTodayMeetings && (() => deps.fetchTodayMeetings!(today)), 'meetings', deps.log),
    safeSection(deps.fetchTodayHolidays && (() => deps.fetchTodayHolidays!(today)), 'holidays', deps.log),
  ]);

  // Meetings + holidays render as ONE "Today" section but come from two independent sources
  // (Google / the DB). Either failing marks the section unavailable rather than half-reporting
  // a day as meeting-free or holiday-free when we simply could not look.
  const today_: BriefingSectionInput['today'] =
    meetings === undefined && holidays === undefined
      ? undefined
      : meetings === null || holidays === null
        ? null
        : { meetings: meetings ?? [], holidays: holidays ?? [] };

  const data = composeBriefing(drafts, proposals, now, {
    topN: deps.topN,
    urgentMinScore: deps.urgentMinScore,
    ...(overnight !== undefined && { overnight }),
    ...(urgent !== undefined && { urgent }),
    ...(awaitingReply !== undefined && { awaitingReply }),
    ...(today_ !== undefined && { today: today_ }),
  });

  await deps.notifier.notifyAdmin(renderBriefing(data, today, { tz: deps.tz }));
  await deps.writeLastRun(today);

  // Counts + flags ONLY — never a name, a title, or a body.
  deps.log.info(
    {
      day: today,
      hour: deps.hour,
      drafts: data.drafts.count,
      proposals: data.proposals.count,
      overnight: data.overnight === null ? 'unavailable' : (data.overnight?.count ?? null),
      urgent: data.urgent === null ? 'unavailable' : (data.urgent?.count ?? null),
      awaitingReply: data.awaitingReply === null ? 'unavailable' : (data.awaitingReply?.count ?? null),
      meetings: data.today === null ? 'unavailable' : (data.today?.meetings.length ?? null),
      holidays: data.today === null ? 'unavailable' : (data.today?.holidays.length ?? null),
    },
    'daily briefing posted',
  );
  return { posted: true };
}
