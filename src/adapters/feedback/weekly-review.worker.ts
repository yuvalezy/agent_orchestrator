import type { WorkerDefinition } from '../../workers/worker-runner';
import type { FounderNotifierPort } from '../../ports/founder-notifier.port';
import type { CalendarPort } from '../../ports/calendar.port';
import type { WeeklyReviewSynthesizerPort } from '../../ports/llm.port';
import type { SyncLogger } from '../../knowledge/sync';
import { query } from '../../db';
import { runWeeklyReview, type CustomerOpenTasks, type CustomerVolume } from '../../decisions/weekly-review';
import { fetchResolvedDraftDecisions } from '../../decisions/decisions';
import { fetchAwaitingReply } from '../query/briefing-repo';

// Weekly business-review WORKER builder (ADAPTER — co-located with the acceptance-report and
// weekly-patterns founder-report workers). Wraps runWeeklyReview in a WorkerDefinition with
// runImmediately:true (post this week's review at boot if it is still owed and it is Friday/hour)
// and a sub-weekly poll interval; the core's Friday/hour gate + last-run-week guard make the
// interval safe (exactly one post per ISO week). This builder assembles deps + maps DB rows down to
// the PII-light shapes the core consumes — the reads reuse EXISTING queries (draft outcomes,
// awaiting-reply) plus two light aggregations (inbox in/out volume, open-task counts).

/**
 * Inbound/outbound message volume per customer since `sinceIso`. Inbound = agent_inbox rows a
 * customer sent; outbound = delivered agent_outbound_queue sends. Only customers with activity are
 * returned (the review lists the active week). Counts only — no bodies.
 */
export async function fetchInboxVolume(sinceIso: string): Promise<CustomerVolume[]> {
  const { rows } = await query<{ customer_id: string; customer_name: string | null; inbound: string; outbound: string }>(
    `SELECT c.id::text AS customer_id, c.display_name AS customer_name,
            COALESCE(inb.n, 0) AS inbound, COALESCE(outb.n, 0) AS outbound
       FROM agent_customers c
       LEFT JOIN (
         SELECT customer_id, count(*) AS n FROM agent_inbox
          WHERE direction = 'inbound' AND received_at >= $1 AND customer_id IS NOT NULL
          GROUP BY customer_id
       ) inb ON inb.customer_id = c.id
       LEFT JOIN (
         SELECT customer_id, count(*) AS n FROM agent_outbound_queue
          WHERE status = 'sent' AND updated_at >= $1 AND customer_id IS NOT NULL
          GROUP BY customer_id
       ) outb ON outb.customer_id = c.id
      WHERE COALESCE(inb.n, 0) > 0 OR COALESCE(outb.n, 0) > 0`,
    [sinceIso],
  );
  return rows.map((r) => ({
    customerId: r.customer_id,
    customerName: r.customer_name,
    inbound: Number(r.inbound),
    outbound: Number(r.outbound),
  }));
}

/**
 * Open task counts per customer — the agent's known tasks (agent_tasks bridge) that have NOT
 * transitioned to a terminal status (the M4 transition ledger, mig 033). A pure DB read (no portal
 * fan-out), the same "aging portal task" signal the awaiting-reply section derives from. Distinct
 * task_ref per customer so a task bridged from several messages counts once.
 */
export async function fetchOpenTasksPerCustomer(): Promise<CustomerOpenTasks[]> {
  const { rows } = await query<{ customer_id: string; count: string }>(
    `SELECT t.customer_id::text AS customer_id, count(DISTINCT t.task_ref) AS count
       FROM agent_tasks t
      WHERE t.customer_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM agent_task_transition_ledger tl WHERE tl.task_ref = t.task_ref
        )
      GROUP BY t.customer_id`,
  );
  return rows.map((r) => ({ customerId: r.customer_id, count: Number(r.count) }));
}

/** Count the founder's meetings in the week ahead across enabled calendars (a global figure). */
export function buildFetchUpcomingMeetings(
  calendar: Pick<CalendarPort, 'listUpcomingEvents'>,
  lookaheadDays: number,
): () => Promise<number> {
  return async () => {
    const events = await calendar.listUpcomingEvents({ lookaheadDays, matchEmails: [], maxEvents: 100 });
    return events.length;
  };
}

export interface WeeklyReviewWorkerDeps {
  notifier: Pick<FounderNotifierPort, 'notifyAdmin'>;
  readLastRun: () => Promise<string | null>;
  writeLastRun: (week: string) => Promise<void>;
  tz: string;
  hour: number;
  windowDays: number;
  intervalMs: number;
  log: SyncLogger;
  /** The founder's calendar reader. OMITTED when CALENDAR_ENABLED=false — the upcoming-meetings
   *  fact is then "unavailable" rather than a wrong zero. */
  calendar?: Pick<CalendarPort, 'listUpcomingEvents'>;
  /** The chief-of-staff synthesizer. OMITTED when WEEKLY_REVIEW is wired without a provider — the
   *  review then posts the deterministic facts digest only. */
  synthesizer?: WeeklyReviewSynthesizerPort;
  /** Clock seam — defaults to the wall clock. */
  now?: () => Date;
}

export function buildWeeklyReviewWorker(deps: WeeklyReviewWorkerDeps): WorkerDefinition {
  const now = deps.now ?? (() => new Date());
  const fetchUpcomingMeetings = deps.calendar
    ? buildFetchUpcomingMeetings(deps.calendar, deps.windowDays)
    : undefined;
  return {
    name: 'review:weekly',
    intervalMs: deps.intervalMs,
    runImmediately: true, // post this week's review at boot if the Friday/hour + week guard allow
    run: async () => {
      await runWeeklyReview({
        fetchInboxVolume,
        fetchDraftOutcomes: fetchResolvedDraftDecisions,
        fetchAwaitingReply,
        fetchOpenTasks: fetchOpenTasksPerCustomer,
        fetchUpcomingMeetings,
        synthesizer: deps.synthesizer,
        notifier: deps.notifier,
        readLastRun: deps.readLastRun,
        writeLastRun: deps.writeLastRun,
        now,
        tz: deps.tz,
        hour: deps.hour,
        windowDays: deps.windowDays,
        log: deps.log,
      });
    },
  };
}
