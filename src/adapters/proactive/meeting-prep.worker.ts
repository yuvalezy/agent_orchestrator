import { env } from '../../config/env';
import { logger } from '../../logger';
import { query } from '../../db';
import type { WorkerDefinition } from '../../workers/worker-runner';
import type { SyncLogger } from '../../knowledge/sync';
import type { FounderNotifierPort, Notification } from '../../ports/founder-notifier.port';
import type { CalendarEvent, CalendarPort } from '../../ports/calendar.port';
import type { MeetingPrepSynthesizerPort } from '../../ports/llm.port';
import { claimChase, releaseChase } from '../../proactive/chaser-ledger';
import { assembleBriefFacts } from '../../knowledge/customer-brief-repo';
import { listOpenCommitmentsForCustomer } from '../../commitments/commitment-repo';
import {
  buildPrepRequest,
  renderPrepPack,
  type MeetingPrepFacts,
  type PrepSnippet,
} from '../../triage/meeting-prep';
import { fetchAwaitingReply } from '../query/briefing-repo';
import { buildCalendarAdapter } from '../calendar';
import { buildLlmRouter } from '../llm/factory';
import { OUTBOUND_CONTACT_ATTRIBUTION_JOIN } from './outbound-attribution';

// WP7(a) MEETING PREP WORKER (ADAPTER — concrete worker builder, may import adapters). Every few
// minutes it reads the founder's upcoming calendar events, keeps only those starting within the next
// PREP_LEAD_MINUTES that MATCH a known customer (reverse of meeting-context.ts: the event's attendee
// emails → a customer via agent_customer_contacts), and posts ONE prep pack per event to that
// customer's founder-facing Telegram topic. Exactly-once per event_id via the WP2 chaser ledger
// (kind 'meeting_prep' — reused, no second table). NEVER logs event details or message bodies.
//
// The pack is DETERMINISTIC (open tasks, awaiting/pending counts, recent snippets, open commitments)
// plus a BEST-EFFORT ≤3 talking-points synthesis grounded only on those facts — a synthesis failure
// posts the deterministic pack unchanged. A transient POST failure releases the claim and stops the
// tick (mirrors the chasers) so the event re-observes next tick rather than being lost or double-posted.

/** Cap on the calendar read (a founder's near-term agenda, not a display limit). */
const MAX_EVENTS = 25;
/** Recent conversation snippets folded into a prep pack (the task's "last ~5"). */
const RECENT_SNIPPETS = 5;
/** Look-back window + task cap reused for the "open tasks" fact (mirrors the WP6 brief facts). */
const FACTS_WINDOW_DAYS = 30;
const FACTS_MAX_TASKS = 8;

/** A calendar event matched to a known customer (the reverse attendee-email lookup). */
export interface MatchedCustomer {
  customerId: string;
  customerName: string;
}

export interface MeetingPrepWorkerDeps {
  /** Upcoming events over `lookaheadDays` (the reader returns every event; matching is done below). */
  listUpcomingEvents: (input: { lookaheadDays: number; maxEvents: number }) => Promise<CalendarEvent[]>;
  /** Reverse attendee→customer match: the customer whose contact email is on the event, or null. */
  matchCustomer: (attendeeEmails: string[]) => Promise<MatchedCustomer | null>;
  /** Exactly-once per event_id — TRUE iff THIS call is the first to claim this event's prep. */
  claimPrep: (eventId: string) => Promise<boolean>;
  /** Roll back a claim after a TRANSIENT post failure so the next tick re-observes the event. */
  releasePrep: (eventId: string) => Promise<void>;
  /** Assemble the deterministic prep facts for a matched event (open tasks, counts, snippets, commitments). */
  assembleFacts: (input: { customer: MatchedCustomer; event: CalendarEvent }) => Promise<MeetingPrepFacts>;
  /** Best-effort ≤3 talking-points synthesis over the facts; may throw (the caller degrades to null). */
  synthesize?: (facts: MeetingPrepFacts) => Promise<string[]>;
  /** Post the pack to the customer's founder-facing topic (informational, no buttons). */
  postPack: (customerId: string, notification: Notification) => Promise<void>;
  getNow?: () => Date;
  log: SyncLogger;
  intervalMs: number;
  /** Only events starting within this many minutes from now are prepped. */
  leadMinutes: number;
  /** IANA tz for the pack's date/time rendering + due labels (the founder's local week). */
  tz: string;
}

/**
 * Build the meeting-prep worker. Startup catch-up is off (runImmediately defaults to false): a boot
 * should not fan a calendar read + LLM synthesis out before the first interval; a meeting inside the
 * lead window is still caught on the first tick.
 */
export function buildMeetingPrepWorker(deps: MeetingPrepWorkerDeps): WorkerDefinition {
  const now = deps.getNow ?? ((): Date => new Date());
  // The reader takes whole days; round the minute-based lead up to at least one day of look-ahead.
  const lookaheadDays = Math.max(1, Math.ceil(deps.leadMinutes / (24 * 60)));
  return {
    name: 'meeting:prep',
    intervalMs: deps.intervalMs,
    run: async () => {
      const t = now();
      const horizon = t.getTime() + deps.leadMinutes * 60_000;
      const events = await deps.listUpcomingEvents({ lookaheadDays, maxEvents: MAX_EVENTS });

      for (const ev of events) {
        // Only timed events inside the lead window: an all-day event's 00:00 start sorts before `now`,
        // and a meeting that already started is not prep. So [now, horizon] excludes both.
        const startMs = ev.startsAt.getTime();
        if (startMs < t.getTime() || startMs > horizon) continue;

        const match = await deps.matchCustomer(ev.attendeeEmails);
        if (!match) continue; // no known customer on this event → skip (per spec)

        // Exactly-once per event: claim BEFORE assembling/posting so a crash mid-post is at-most-once.
        if (!(await deps.claimPrep(ev.id))) continue;

        let facts: MeetingPrepFacts;
        try {
          facts = await deps.assembleFacts({ customer: match, event: ev });
        } catch (err) {
          // A fact-assembly (DB) miss is not routine — release so the event re-observes, then move on.
          await deps.releasePrep(ev.id);
          deps.log.warn({ reason: (err as Error)?.message }, 'meeting-prep: fact assembly failed — released for retry');
          continue;
        }

        let talkingPoints: string[] | null = null;
        if (deps.synthesize) {
          try {
            talkingPoints = await deps.synthesize(facts);
          } catch {
            // Best-effort: a synthesis failure posts the deterministic pack without bullets.
            talkingPoints = null;
          }
        }

        try {
          await deps.postPack(match.customerId, renderPrepPack(facts, talkingPoints, t, deps.tz));
        } catch (err) {
          // TRANSIENT post failure: release the claim and STOP the tick (already-posted events stay
          // claimed; only this one retries next tick) — mirrors the chaser workers.
          await deps.releasePrep(ev.id);
          deps.log.warn({ reason: (err as Error)?.message }, 'meeting-prep: post failed — released, tick held');
          break;
        }
        deps.log.info({ customerId: match.customerId, synthesized: talkingPoints !== null }, 'meeting-prep: pack posted');
      }
    },
  };
}

// ── Concrete reads (adapter SQL, kept next to the worker) ────────────────────────────────────────

interface ContactMatchRow {
  customer_id: string;
  display_name: string;
}

/** Reverse attendee→customer match: the customer whose EMAIL contact is on the event. Lower-cased +
 *  deduped emails come from the reader; a single query returns the first matching customer. When two
 *  customers share an attendee (rare — a shared meeting), the lowest customer id wins deterministically. */
async function matchCustomerByEmails(attendeeEmails: string[]): Promise<MatchedCustomer | null> {
  if (attendeeEmails.length === 0) return null;
  const { rows } = await query<ContactMatchRow>(
    `SELECT c.customer_id::text AS customer_id, cu.display_name
       FROM agent_customer_contacts c
       JOIN agent_customers cu ON cu.id = c.customer_id
      WHERE c.channel_type = 'email' AND lower(c.address) = ANY($1::text[])
      ORDER BY c.customer_id ASC
      LIMIT 1`,
    [attendeeEmails.map((e) => e.toLowerCase())],
  );
  const r = rows[0];
  return r ? { customerId: r.customer_id, customerName: r.display_name } : null;
}

interface SnippetRow {
  direction: 'inbound' | 'outbound';
  body: string;
}

/** Recent inbound + outbound snippets for a customer, newest first. Inbound rows carry the customer_id
 *  (set at triage); outbound rows carry none, so they are attributed via the channel_thread_id contact
 *  join — the same predicate the commitment worker uses — so the founder's OWN side of the chat shows too. */
async function fetchRecentSnippets(customerId: string, limit: number): Promise<PrepSnippet[]> {
  const { rows } = await query<SnippetRow>(
    `SELECT i.direction, i.body
       FROM agent_inbox i
       JOIN channel_instances ci ON ci.id = i.channel_instance_id
       ${OUTBOUND_CONTACT_ATTRIBUTION_JOIN}
      WHERE i.body IS NOT NULL
        AND (i.customer_id = $1::uuid OR ct.customer_id = $1::uuid)
      ORDER BY i.received_at DESC
      LIMIT $2`,
    [customerId, limit],
  );
  return rows.map((r) => ({ direction: r.direction, body: r.body }));
}

/**
 * Assemble the deterministic prep facts for a matched event. Reuses the WP6 brief-facts read for open
 * tasks + the pending-draft count, the daily-briefing awaiting-reply read (filtered to this customer),
 * a recent-snippets read, and the customer's open commitments. All best-effort local reads.
 */
async function assembleFactsFor(input: { customer: MatchedCustomer; event: CalendarEvent }, now: Date): Promise<MeetingPrepFacts> {
  const { customer, event } = input;
  const brief = await assembleBriefFacts(
    { customerId: customer.customerId, displayName: customer.customerName },
    { windowDays: FACTS_WINDOW_DAYS, maxMemories: 1, maxTasks: FACTS_MAX_TASKS, now: () => now },
  );
  // Awaiting-reply for THIS customer: the briefing's read (last-sent before now = all silent threads),
  // filtered locally — reuses the one "awaiting" definition rather than a second query.
  const awaiting = (await fetchAwaitingReply(now)).filter((a) => a.customerId === customer.customerId).length;
  const snippets = await fetchRecentSnippets(customer.customerId, RECENT_SNIPPETS);
  const commitments = await listOpenCommitmentsForCustomer(customer.customerId);

  return {
    customerName: customer.customerName,
    event: { id: event.id, title: event.title, startsAt: event.startsAt, allDay: event.allDay },
    openTasks: brief.openTasks.map((t) => ({ title: t.title, ageDays: t.ageDays })),
    awaitingReplyCount: awaiting,
    pendingDraftCount: brief.pendingDrafts,
    recentSnippets: snippets,
    openCommitments: commitments.map((c) => ({ text: c.text, dueAt: c.dueAt, duePrecision: c.duePrecision })),
  };
}

/**
 * Factory: wire the worker to the real deps. `notifier` is the SAME Telegram notifier the money loop
 * drives, so a prep pack lands in the customer's own topic (notifyCustomerEvent, no buttons). The
 * talking-points synthesizer is injected ONLY when BRIEFING_SYNTHESIS-style synthesis is desired —
 * here it is always wired (best-effort at the call site); a failure degrades to no bullets.
 */
export function buildMeetingPrepWorkerFactory(notifier: FounderNotifierPort): WorkerDefinition {
  const calendar: CalendarPort = buildCalendarAdapter();
  const synthesizer: MeetingPrepSynthesizerPort = buildLlmRouter({
    notifyAdmin: (msg) => notifier.notifyAdmin({ title: 'LLM gateway', body: msg, severity: 'warning' }),
  });
  const tz = env.CALENDAR_TZ;
  return buildMeetingPrepWorker({
    listUpcomingEvents: (input) =>
      calendar.listUpcomingEvents({ lookaheadDays: input.lookaheadDays, matchEmails: [], maxEvents: input.maxEvents }),
    matchCustomer: matchCustomerByEmails,
    claimPrep: (eventId) => claimChase('meeting_prep', eventId),
    releasePrep: (eventId) => releaseChase('meeting_prep', eventId),
    assembleFacts: (input) => assembleFactsFor(input, new Date()),
    synthesize: async (facts) => {
      const result = await synthesizer.synthesizeMeetingPrep(buildPrepRequest(facts, new Date(), tz));
      return result.talkingPoints;
    },
    postPack: (customerId, notification) => notifier.notifyCustomerEvent(customerId, notification),
    log: logger,
    intervalMs: env.MEETING_PREP_INTERVAL_MS,
    leadMinutes: env.PREP_LEAD_MINUTES,
    tz,
  });
}
