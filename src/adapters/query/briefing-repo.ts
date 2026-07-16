import { query } from '../../db';
import type { CalendarPort } from '../../ports/calendar.port';
import {
  dayInTz,
  type AwaitingReplyItem,
  type CommitmentDueItem,
  type PendingItem,
  type TodayHoliday,
  type TodayMeeting,
  type UrgentFeed,
} from '../../query/daily-briefing';
import { listUrgencyInbox } from '../console/console-urgency-repo';
import { listOpenCommitmentsDueBy } from '../../commitments/commitment-repo';

// Read queries backing task 3.1's four briefing sections (ADAPTER — the core briefing takes
// these as injected fns and never imports this file, D1). Kept in its OWN file (not the worker)
// so the worker stays wiring, mirroring console-approvals-repo.ts's split from console-repo.ts.
//
// Every row is mapped down to the core's PII-light shape HERE: bodies, subjects and sender names
// are dropped at this boundary and never reach the digest (the briefing posts unprompted to the
// admin topic — names + counts + ages only). The one deliberate exception is the calendar event
// TITLE, which the digest does render (see the PII note in daily-briefing.ts) and never logs.

/** Row cap for the list reads. The counts these feed are the acceptance criterion (5.4), so the
 *  cap is set FAR above the real volume rather than at a display limit: the overnight window is
 *  24h and the pending queues run in the tens (see console-approvals-repo's own 200 cap), so a
 *  count is exact in practice. The core's own topN caps what actually PRINTS. */
const ROW_CAP = 500;

/** Cap on today's calendar read — a founder's day, not a display limit. */
const MAX_TODAY_MEETINGS = 20;

interface OvernightRow {
  customer_id: string | null;
  customer_name: string | null;
  received_at: Date | string;
}

/**
 * Inbox rows that landed since `since` and are STILL untriaged ("overnight unprocessed").
 *
 * Unprocessed = status 'pending' (never claimed) or 'failed' (claimed, errored, still owed).
 * 'processing' is excluded — it is mid-flight in a live worker, not stalled work; if it stalls
 * it ages into the urgent section, which has no window. 'processed'/'skipped' are done.
 *
 * Two exclusions keep the count honest rather than merely large:
 *  • is_backfill rows are pulled HISTORY, not overnight traffic.
 *  • pre-cutoff rows mirror triage's live watermark (triage.service.ts isPreCutoff): anything a
 *    customer sent before their `backfill_cutoff` go-live instant will be SKIPPED by triage, so
 *    counting it as work waiting on the founder would overstate the number. The boundary is
 *    EXCLUSIVE (`>= cutoff` is live) and a NULL cutoff means "triage everything" — both match
 *    isPreCutoff exactly, so this count cannot disagree with what triage will actually do.
 */
export async function fetchOvernightUnprocessed(since: Date): Promise<PendingItem[]> {
  const { rows } = await query<OvernightRow>(
    `SELECT i.customer_id::text   AS customer_id,
            c.display_name        AS customer_name,
            i.received_at         AS received_at
       FROM agent_inbox i
       LEFT JOIN agent_customers c ON c.id = i.customer_id
      WHERE i.status IN ('pending', 'failed')
        AND i.received_at >= $1
        AND COALESCE(i.is_backfill, false) = false
        AND (c.backfill_cutoff IS NULL OR i.received_at >= c.backfill_cutoff)
      ORDER BY i.received_at ASC
      LIMIT ${ROW_CAP}`,
    [since.toISOString()],
  );
  return rows.map((r) => ({
    customerId: r.customer_id,
    customerName: r.customer_name,
    createdAt: new Date(r.received_at),
  }));
}

/**
 * The change-06 ranked urgent inbox, reused VERBATIM: this calls the console's own
 * `listUrgencyInbox`, so the briefing and the console rank by the ONE documented deterministic
 * score. Nothing here computes or adjusts a score — the rows are only stripped of subject/
 * sender_name (PII) and handed to core, which applies the configured cut.
 *
 * `capped` reports whether the ranked page hit its limit (nextCursor present). Core needs it to
 * decide whether its count is exact: the page is score-ordered, so a page that still contains
 * a below-cut row provably holds every urgent row (see UrgentSummary.exact).
 */
export async function fetchUrgentItems(): Promise<UrgentFeed> {
  // 100 is listUrgencyInbox's own max page. Well above a real urgent backlog, and `capped`
  // keeps the digest honest ("12+") on the day it is not.
  const page = await listUrgencyInbox({ limit: '100' });
  if (!page) return { items: [], capped: false };
  return {
    items: page.data.map((r) => ({
      customerId: (r.customer_id as string | null) ?? null,
      customerName: (r.customer_name as string | null) ?? null,
      urgencyScore: Number(r.urgency_score),
      // Match the score's own age basis: COALESCE(received_at, created_at).
      createdAt: new Date((r.received_at as string | Date | null) ?? (r.created_at as string)),
    })),
    capped: page.nextCursor !== null,
  };
}

interface AwaitingReplyRow {
  task_ref: string;
  task_title: string | null;
  customer_id: string;
  customer_name: string | null;
  last_outbound_at: Date | string;
}

/**
 * Tasks we replied on where the customer has gone silent since, last sent before `olderThan`
 * (core passes now − AWAITING_REPLY_DAYS, so task 3.1's "> 3 days" rule is applied IN SQL and
 * the count stays exact under the row cap).
 *
 * There is no "awaiting reply" flag in the schema — it is DERIVED from the links that do exist:
 *   agent_outbound_queue (status='sent' — we actually sent it, not a draft still pending)
 *     → decision_id → agent_decisions.inbox_message_id   (mig 015 draft→audit link)
 *     → agent_tasks.inbox_message_id → task_ref          (mig 005 task bridge)
 * so a row is "a task we replied about". `max(updated_at)` is the last send: the set_updated_at
 * trigger stamps it on the terminal 'sent' UPDATE (the same column lastSentAt reads, see
 * outbound-repo). Awaiting = no INBOUND inbox row from that customer since that send.
 *
 * Two honest limits, both erring toward under-reporting rather than crying wolf:
 *  • Silence is per CUSTOMER, not per thread — a customer who answered a DIFFERENT conversation
 *    clears every task of theirs. Inbound rows are not linked back to a task until triage bridges
 *    them, so a per-task answer check does not exist to query.
 *  • Terminal tasks are excluded via the M4 transition ledger (mig 033), the only local record
 *    that a task closed. It is only populated while the resolution poller runs, so a task closed
 *    while that worker was off can still appear.
 */
/** The awaiting-reply derivation (everything but the final LIMIT). Shared by the capped briefing
 *  read and the uncapped seed variant so the two can never drift in what "awaiting" means. */
const AWAITING_REPLY_SQL = `WITH last_out AS (
       SELECT t.task_ref, q.customer_id, max(q.updated_at) AS last_outbound_at
         FROM agent_outbound_queue q
         JOIN agent_decisions d ON d.id = q.decision_id
         JOIN agent_tasks t     ON t.inbox_message_id = d.inbox_message_id
        WHERE q.status = 'sent'
          AND q.customer_id IS NOT NULL
        GROUP BY t.task_ref, q.customer_id
     )
     SELECT l.task_ref,
            l.customer_id::text AS customer_id,
            c.display_name      AS customer_name,
            l.last_outbound_at,
            -- The title we generated for the task at triage (agent_output.suggested_title). Best-
            -- effort (LEFT JOIN LATERAL, earliest triage decision): null when no triage row exists.
            -- The briefing ignores it; the WP2 nudge grounds its draft on it.
            td.suggested_title  AS task_title
       FROM last_out l
       LEFT JOIN agent_customers c ON c.id = l.customer_id
       LEFT JOIN LATERAL (
              SELECT d2.agent_output->>'suggested_title' AS suggested_title
                FROM agent_decisions d2
               WHERE d2.task_ref = l.task_ref
                 AND d2.decision_type = 'triage'
               ORDER BY d2.id ASC
               LIMIT 1
            ) td ON true
      WHERE l.last_outbound_at < $1
        AND NOT EXISTS (
              SELECT 1 FROM agent_inbox i
               WHERE i.customer_id = l.customer_id
                 AND i.direction = 'inbound'
                 AND i.received_at > l.last_outbound_at
            )
        AND NOT EXISTS (
              SELECT 1 FROM agent_task_transition_ledger tl
               WHERE tl.task_ref = l.task_ref
            )
      ORDER BY l.last_outbound_at ASC`;

function mapAwaitingRows(rows: AwaitingReplyRow[]): AwaitingReplyItem[] {
  return rows.map((r) => ({
    customerId: r.customer_id,
    customerName: r.customer_name,
    // The opaque portal ref — carried through for the WP2 nudge worker (which resolves the
    // conversation origin from it); the digest itself does not render it.
    taskRef: r.task_ref,
    taskTitle: r.task_title,
    // agent_tasks stores the OPAQUE portal ref (mig 005) — the human 'TSK-…' code lives only in
    // the portal (TaskRef.code, on list reads) and is never persisted here. Rather than fan a
    // per-task portal read out of a best-effort digest section, the line names the customer and
    // the silence; core renders the code only when one is present.
    taskCode: null,
    lastOutboundAt: new Date(r.last_outbound_at),
  }));
}

export async function fetchAwaitingReply(olderThan: Date): Promise<AwaitingReplyItem[]> {
  const { rows } = await query<AwaitingReplyRow>(`${AWAITING_REPLY_SQL}\n      LIMIT ${ROW_CAP}`, [olderThan.toISOString()]);
  return mapAwaitingRows(rows);
}

/**
 * The SEED variant of {@link fetchAwaitingReply}: enumerate EVERY awaiting thread, UNCAPPED. Used
 * ONLY by the awaiting-reply worker's first-run seed, which must pre-claim the entire go-live
 * backlog. The capped {@link fetchAwaitingReply} would pre-claim only its LIMIT-{@link ROW_CAP}
 * window, so any thread past the cap would later leak a COLD nudge as older threads clear and it
 * rises into the window. The seed is a one-shot at go-live, so a single uncapped read is fine.
 */
export async function fetchAwaitingReplyAll(olderThan: Date): Promise<AwaitingReplyItem[]> {
  const { rows } = await query<AwaitingReplyRow>(AWAITING_REPLY_SQL, [olderThan.toISOString()]);
  return mapAwaitingRows(rows);
}

/** Today's holidays (agent_holidays, mig 008) for a founder-local `YYYY-MM-DD`. The seeder
 *  writes the 'global' sentinel rather than NULL; COALESCE keeps a hand-inserted NULL row
 *  rendering as a global closure (the send-window convention). */
export async function fetchTodayHolidays(day: string): Promise<TodayHoliday[]> {
  const { rows } = await query<{ name: string | null; faith: string }>(
    `SELECT name, COALESCE(faith, 'global') AS faith
       FROM agent_holidays
      WHERE holiday_date = $1::date
      ORDER BY faith ASC, name ASC`,
    [day],
  );
  return rows.map((r) => ({ name: r.name, faith: r.faith }));
}

/**
 * Today's meetings across the founder's enabled calendars, for a founder-local `YYYY-MM-DD`.
 *
 * `listUpcomingEvents` reads FORWARD from now, so this is the founder's day AHEAD of the
 * briefing — a meeting that already finished before the digest fires is intentionally not
 * relisted. Normally `matchEmails: []` makes this a whole-day agenda rather than the drafter's
 * per-customer view (meeting-context.ts keeps only `matchedCustomer` events; the briefing wants
 * every meeting, so it reads the port directly). A 2-day lookahead over-reads and is then
 * filtered to today's local day, so an event never leaks in from tomorrow.
 *
 * WP7(a): when `loadMatchEmails` is supplied (MEETING_PREP on), the founder's known customer emails
 * are passed as `matchEmails` so a customer-matched event carries `hasPrep=true` and the digest can
 * flag "📋 Prep". Without it, matchEmails stays [] and no meeting is flagged — byte-identical to before.
 */
export function buildFetchTodayMeetings(
  calendar: Pick<CalendarPort, 'listUpcomingEvents'>,
  tz: string,
  loadMatchEmails?: () => Promise<string[]>,
): (day: string) => Promise<TodayMeeting[]> {
  return async (day) => {
    const matchEmails = loadMatchEmails ? await loadMatchEmails() : [];
    const events = await calendar.listUpcomingEvents({
      lookaheadDays: 2,
      matchEmails,
      maxEvents: MAX_TODAY_MEETINGS,
    });
    return events
      .filter((e) => dayInTz(e.startsAt, tz) === day)
      .map((e) => ({ title: e.title, startsAt: e.startsAt, allDay: e.allDay, hasPrep: e.matchedCustomer }))
      .slice(0, MAX_TODAY_MEETINGS);
  };
}

/** Every known customer email contact (lower-cased), for the WP7(a) "📋 Prep" meeting match. A whole-
 *  agenda read, so it loads all email contacts once per briefing tick. */
export async function listCustomerEmails(): Promise<string[]> {
  const { rows } = await query<{ address: string }>(
    `SELECT DISTINCT lower(address) AS address FROM agent_customer_contacts WHERE channel_type = 'email'`,
  );
  return rows.map((r) => r.address).filter(Boolean);
}

/** Open commitments due today or overdue (WP7(b)) — due_at at or before `cutoff` (the founder-local
 *  end of today). Maps the ledger read down to the briefing's PII-light-ish CommitmentDueItem (the
 *  founder's own promise text + who + the deadline; never a customer message body). */
export async function fetchCommitmentsDue(cutoff: Date): Promise<CommitmentDueItem[]> {
  const rows = await listOpenCommitmentsDueBy(cutoff);
  return rows.map((c) => ({
    customerId: c.customerId,
    customerName: c.customerName,
    text: c.text,
    // The "due" read filters due_at IS NOT NULL, so this is always set.
    dueAt: c.dueAt as Date,
  }));
}
