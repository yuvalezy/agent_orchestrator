import type { Notification } from '../ports/founder-notifier.port';
import type { MeetingPrepRequest } from '../ports/llm.port';

// Meeting-prep pack assembly + render (WP7(a), CORE — pure, ports-only: imports no adapter, D1). A
// worker matches an upcoming calendar event to a known customer (attendee-email match, the reverse of
// meeting-context.ts) and hands this module the assembled FACTS; here we (1) shape the PII-light-ish
// synth request for the ≤3 talking-points pass, and (2) render the DETERMINISTIC pack posted to the
// customer's founder-facing Telegram topic (informational, no buttons).
//
// PII posture: this posts to the founder's OWN private customer topic — the SAME surface where draft
// cards already show full customer message bodies — so short truncated conversation snippets are in
// scope here (each capped at SNIPPET_MAX chars). The pack is NEVER logged (the worker logs counts only).

/** Per-snippet truncation for the recent-conversation section (a prep glance, not a transcript). */
export const SNIPPET_MAX = 120;
/** Defensive clamp on the rendered talking points (the synth schema already caps at 3). */
export const MEETING_PREP_MAX_POINTS = 3;

export interface PrepEvent {
  id: string;
  title: string;
  startsAt: Date;
  allDay: boolean;
}

export interface PrepTask {
  title: string;
  ageDays: number;
}

export interface PrepSnippet {
  direction: 'inbound' | 'outbound';
  /** The message body — truncated to SNIPPET_MAX at render/request time (not here). */
  body: string;
}

export interface PrepCommitment {
  text: string;
  dueAt: Date | null;
  duePrecision: 'day' | 'week' | 'none' | null;
}

/** Everything the pack renders / the synthesis reasons over, for ONE matched upcoming meeting. */
export interface MeetingPrepFacts {
  customerName: string;
  event: PrepEvent;
  openTasks: PrepTask[];
  awaitingReplyCount: number;
  pendingDraftCount: number;
  /** Recent inbound/outbound turns, newest first (the worker caps the count). */
  recentSnippets: PrepSnippet[];
  /** Open commitments the founder made to this customer. */
  openCommitments: PrepCommitment[];
}

/** Truncate a snippet to SNIPPET_MAX (whitespace-collapsed) with an ellipsis when clipped. */
function truncateSnippet(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX - 1).trimEnd()}…` : flat;
}

/** The meeting's founder-local time line: 'all day' or 'Tue Jul 15, 2:00 PM'. */
export function meetingTimeLine(event: PrepEvent, tz: string): string {
  if (event.allDay) {
    return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz }).format(event.startsAt);
  }
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: tz,
  }).format(event.startsAt);
}

/** A commitment rendered as "text (due Fri Jul 18)" / "text (overdue)" / "text" — one label used by
 *  both the synth request and the deterministic pack so they never disagree. */
function commitmentLabel(c: PrepCommitment, now: Date, tz: string): string {
  if (!c.dueAt) return c.text;
  const when = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz }).format(c.dueAt);
  if (c.dueAt.getTime() < now.getTime()) return `${c.text} (overdue)`;
  return `${c.text} (due ${c.duePrecision === 'week' ? '~' : ''}${when})`;
}

/**
 * Shape the FACTS into the talking-points synthesis request (PURE). Snippets are truncated and open
 * commitments flattened to labelled strings — the same values the deterministic pack renders, so the
 * model reasons over exactly what the founder will see. Newest snippets first (as assembled).
 */
export function buildPrepRequest(facts: MeetingPrepFacts, now: Date, tz: string): MeetingPrepRequest {
  return {
    customerName: facts.customerName,
    meetingTitle: facts.event.title,
    meetingTime: meetingTimeLine(facts.event, tz),
    openTasks: facts.openTasks.map((t) => ({ title: t.title, ageDays: t.ageDays })),
    awaitingReplyCount: facts.awaitingReplyCount,
    pendingDraftCount: facts.pendingDraftCount,
    recentSnippets: facts.recentSnippets.map((s) => ({ direction: s.direction, text: truncateSnippet(s.body) })),
    openCommitments: facts.openCommitments.map((c) => commitmentLabel(c, now, tz)),
  };
}

/**
 * Render the deterministic prep pack (PURE) into a founder-facing informational Notification (no
 * buttons). `talkingPoints` is the best-effort synthesis: null (or empty) omits the section entirely —
 * a synthesis failure posts the deterministic pack unchanged, never a "talking points unavailable"
 * line (the pack stands on its own). Points are defensively clamped to MEETING_PREP_MAX_POINTS.
 */
export function renderPrepPack(
  facts: MeetingPrepFacts,
  talkingPoints: string[] | null,
  now: Date,
  tz: string,
): Notification {
  const parts: string[] = [];
  parts.push(`🗓️ ${meetingTimeLine(facts.event, tz)} — ${facts.event.title}`);

  parts.push('', `📋 Open tasks (${facts.openTasks.length})`);
  if (facts.openTasks.length === 0) parts.push('  none');
  for (const t of facts.openTasks) parts.push(`  • ${t.title} — ${t.ageDays}d old`);

  parts.push('', `Awaiting your reply: ${facts.awaitingReplyCount} · pending drafts: ${facts.pendingDraftCount}`);

  if (facts.openCommitments.length > 0) {
    parts.push('', `⏰ Open commitments (${facts.openCommitments.length})`);
    for (const c of facts.openCommitments) parts.push(`  • ${commitmentLabel(c, now, tz)}`);
  }

  if (facts.recentSnippets.length > 0) {
    parts.push('', 'Recent messages');
    for (const s of facts.recentSnippets) {
      const who = s.direction === 'outbound' ? 'you' : facts.customerName;
      parts.push(`  • ${who}: ${truncateSnippet(s.body)}`);
    }
  }

  const points = (talkingPoints ?? []).slice(0, MEETING_PREP_MAX_POINTS);
  if (points.length > 0) {
    parts.push('', '🎯 Talking points');
    for (const p of points) parts.push(`  • ${p}`);
  }

  return {
    title: `📋 Meeting prep — ${facts.customerName}`,
    body: parts.join('\n'),
    severity: 'info',
  };
}
