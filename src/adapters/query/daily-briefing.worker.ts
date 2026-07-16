import type { WorkerDefinition } from '../../workers/worker-runner';
import type { FounderNotifierPort } from '../../ports/founder-notifier.port';
import type { CalendarPort } from '../../ports/calendar.port';
import type { BriefingSynthesizerPort } from '../../ports/llm.port';
import type { SyncLogger } from '../../knowledge/sync';
import { runDailyBriefing, type CommitmentDueItem, type PendingItem } from '../../query/daily-briefing';
import { listPendingDrafts, listPendingBackfillProposals } from '../console/console-approvals-repo';
import {
  buildFetchTodayMeetings,
  fetchAwaitingReply,
  fetchCommitmentsDue,
  fetchOvernightUnprocessed,
  fetchTodayHolidays,
  fetchUrgentItems,
  listCustomerEmails,
} from './briefing-repo';

// Daily-briefing WORKER builder (ADAPTER). Wraps runDailyBriefing in a WorkerDefinition with
// runImmediately:true (post at boot if today's briefing is still owed and the founder-local hour
// has passed) and a POLL interval; the core's configured-hour gate + last-run-day guard make the
// interval safe (exactly one post per calendar day, at/after the configured hour). This builder
// only assembles deps + maps the console approvals-repo rows down to the PII-light PendingItem the
// core consumes — the message/draft/proposal BODIES the repo returns are dropped here and never
// reach the digest. Task 3.1's four section reads live in ./briefing-repo.
//
// The interval is POLL granularity, not the schedule: DAILY_BRIEFING_HOUR is the schedule, and the
// interval only bounds how late a post can land (see env.ts DAILY_BRIEFING_INTERVAL_MS).

export interface DailyBriefingWorkerDeps {
  notifier: Pick<FounderNotifierPort, 'notifyAdmin'>;
  readLastRun: () => Promise<string | null>;
  writeLastRun: (day: string) => Promise<void>;
  tz: string;
  topN?: number;
  log: SyncLogger;
  intervalMs: number;
  /** Founder-local hour (0–23) the briefing fires at (DAILY_BRIEFING_HOUR). */
  hour: number;
  /** Cut on change 06's urgency scale (DAILY_BRIEFING_URGENT_MIN_SCORE). */
  urgentMinScore?: number;
  /** The founder's calendar reader. OMITTED when CALENDAR_ENABLED=false — today's meetings are
   *  then left out of the digest rather than reported as an empty day (holidays still render:
   *  they are a DB read and do not depend on Google). */
  calendar?: Pick<CalendarPort, 'listUpcomingEvents'>;
  /** WP1 chief-of-staff synthesizer. OMITTED when BRIEFING_SYNTHESIS_ENABLED=false — the digest
   *  then renders without the "🧭 Focus" section (exactly like an unwired task-3.1 section). */
  synthesizer?: BriefingSynthesizerPort;
  /** WP7(b): due-commitments read. OMITTED when COMMITMENT_TRACKING_ENABLED=false — the "⏰
   *  Commitments due" section is then left out entirely. */
  commitmentTrackingEnabled?: boolean;
  /** WP7(a): when true (MEETING_PREP_ENABLED + a calendar), today's meetings are matched to known
   *  customer emails so a matched one flags "📋 Prep". OMITTED → no meeting is flagged (unchanged). */
  meetingPrepEnabled?: boolean;
  /** Clock seam — defaults to the wall clock. */
  now?: () => Date;
}

/** Reuse the console Approvals read queries; keep only customer + createdAt (drop bodies).
 *  Exported so the Telegram `/pending` and `/briefing` slash commands read the SAME queues. */
export async function fetchPendingDrafts(): Promise<PendingItem[]> {
  const rows = await listPendingDrafts();
  return rows.map((r) => ({
    customerId: r.customer_id,
    customerName: r.customer_name,
    createdAt: new Date(r.created_at),
  }));
}

export async function fetchPendingProposals(): Promise<PendingItem[]> {
  const rows = await listPendingBackfillProposals();
  return rows.map((r) => ({
    customerId: r.customer_id,
    customerName: r.customer_name,
    createdAt: new Date(r.created_at),
  }));
}

export function buildDailyBriefingWorker(deps: DailyBriefingWorkerDeps): WorkerDefinition {
  const now = deps.now ?? (() => new Date());
  const fetchTodayMeetings = deps.calendar
    ? buildFetchTodayMeetings(deps.calendar, deps.tz, deps.meetingPrepEnabled ? listCustomerEmails : undefined)
    : undefined;
  // WP7(b): only wire the due-commitments read when tracking is on, so the section is otherwise absent.
  const commitmentsDue: ((cutoff: Date) => Promise<CommitmentDueItem[]>) | undefined = deps.commitmentTrackingEnabled
    ? fetchCommitmentsDue
    : undefined;
  return {
    name: 'briefing:daily',
    intervalMs: deps.intervalMs,
    // Post at boot when today's briefing is still owed AND the configured hour has passed —
    // the catch-up path for a process that was down at the hour (see decideBriefingRun).
    runImmediately: true,
    run: async () => {
      await runDailyBriefing({
        fetchPendingDrafts,
        fetchPendingProposals,
        fetchOvernightUnprocessed,
        fetchUrgentItems,
        fetchAwaitingReply,
        fetchTodayHolidays,
        fetchTodayMeetings,
        fetchCommitmentsDue: commitmentsDue,
        notifier: deps.notifier,
        readLastRun: deps.readLastRun,
        writeLastRun: deps.writeLastRun,
        now,
        tz: deps.tz,
        hour: deps.hour,
        topN: deps.topN,
        urgentMinScore: deps.urgentMinScore,
        synthesizer: deps.synthesizer,
        log: deps.log,
      });
    },
  };
}
