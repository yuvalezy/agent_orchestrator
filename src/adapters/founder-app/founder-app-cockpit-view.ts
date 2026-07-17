// View-model normalizers for the v2 cockpit. The reused console read models return
// broad snake_case rows; the app frontend renders by a small, stable discriminant. We
// normalize HERE (presentation only — the SQL is still reused verbatim) so the frontend
// gets one deterministic shape and never hardcodes the console's event_type table.

import { portalTaskUrl } from '../shared/portal-url';

/** A top urgency-inbox item, tappable into its inbox detail sheet. */
export interface UrgencyItem {
  id: string;
  customerName: string | null;
  title: string | null;
  score: number;
  snippet: string | null;
  createdAt: string;
  /** Urgency items are always inbox rows → tap opens GET /items/inbox/<itemId>. */
  itemKind: 'inbox';
  itemId: string;
}

/** How a timeline row renders: inbound=left bubble, outbound=right bubble w/ status,
 *  decision/notification=inline marker. */
export type TimelineKind = 'inbound' | 'outbound' | 'decision' | 'notification';
/** The detail-sheet route for a tappable row; null = not tappable (e.g. task links). */
export type TimelineItemKind = 'inbox' | 'outbound' | 'decision' | null;

export interface TimelineRow {
  /** Globally unique row key (event_type + entity id never collide across tables). */
  id: string;
  kind: TimelineKind;
  itemKind: TimelineItemKind;
  itemId: string | null;
  title: string | null;
  snippet: string | null;
  status: string | null;
  createdAt: string;
  /** Who wrote an inbound/outbound message, when the channel gave us a name. */
  senderName: string | null;
  /** The portal task this row is about (decision + task_link rows). */
  taskRef: string | null;
  /**
   * The browsable "Open Task" target for `taskRef`, formatted server-side by the canonical
   * portalTaskUrl. Null when there is no task, or when no portal base is configured — the app
   * must NEVER build this itself: the base is server config the client cannot see, so a
   * client-side guess would render a button that goes nowhere.
   */
  linkUrl: string | null;
  /** Triage classification, for a chip. Null on rows with no triage output. */
  category: string | null;
  priority: string | null;
}

/** Map a console urgency row (snake_case) to the cockpit UrgencyItem. */
export function toUrgencyItem(row: Record<string, unknown>): UrgencyItem {
  const id = String(row.id);
  return {
    id,
    customerName: (row.customer_name as string | null) ?? null,
    title: (row.subject as string | null) ?? null,
    score: Number(row.urgency_score ?? 0),
    // No body in the urgency read model; the sender is the safe preview line.
    snippet: (row.sender_name as string | null) ?? null,
    createdAt: String(row.created_at),
    itemKind: 'inbox',
    itemId: id,
  };
}

const TIMELINE_MAP: Record<string, { kind: TimelineKind; itemKind: TimelineItemKind }> = {
  // inbox is the DEFAULT side only — a row's own metadata.direction overrides it below.
  inbox: { kind: 'inbound', itemKind: 'inbox' },
  outbound: { kind: 'outbound', itemKind: 'outbound' },
  decision: { kind: 'decision', itemKind: 'decision' },
  // A task link is an inline marker with no detail route.
  task_link: { kind: 'notification', itemKind: null },
};

/** Blank-as-null: the SQL hands back real nulls, but an empty subject would render as a live-looking
 *  empty title. Anything not a non-blank string collapses to null so the frontend has one absent. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** 'draft_reply' → 'Draft reply'. The last-resort decision label: only reached when the row carries
 *  no triage title (a draft/override), where the type IS the most meaningful thing we know. */
function humanizeDecisionType(value: string | null): string | null {
  if (!value) return null;
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * What a media message says when it says nothing: a photo, voice note or sticker arrives with an
 * EMPTY body, so without this the row is blank and the founder reads a placeholder where a picture
 * had been sent. 'ptt' is WhatsApp's push-to-talk voice note. An unknown/absent type yields null —
 * the caller keeps its own fallback rather than inventing a label for a kind we don't know.
 */
const MEDIA_LABEL: Record<string, string> = {
  image: '📷 Photo',
  video: '🎥 Video',
  ptt: '🎤 Voice note',
  audio: '🎤 Audio',
  document: '📎 Document',
  sticker: '🌟 Sticker',
};

/**
 * Map a console customerTimeline row (snake_case + jsonb metadata) to a TimelineRow.
 *
 * `portalBaseUrl` is the founder's portal origin (ConsoleConfig.portalBaseUrl) and is what turns a
 * bare task_ref into a link the founder can actually tap — the same job console.router's
 * `withPortalTaskLinks` does for its own timeline. Omit it and rows simply carry no linkUrl;
 * portalTaskUrl fails closed, so an unconfigured base yields no button rather than a dead one.
 */
export function toTimelineRow(row: Record<string, unknown>, portalBaseUrl: string | null = null): TimelineRow {
  const eventType = String(row.event_type);
  const shape = TIMELINE_MAP[eventType] ?? { kind: 'notification' as const, itemKind: null };
  const entityId = String(row.entity_id);
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  let kind = shape.kind;
  let title: string | null = null;
  let snippet: string | null = null;
  let senderName: string | null = null;
  let taskRef: string | null = null;
  let category: string | null = null;
  let priority: string | null = null;
  if (eventType === 'inbox' || eventType === 'outbound') {
    title = text(metadata.subject);
    // A media message carries no body: say what it IS rather than nothing. A caption, when there
    // is one, is the better line — so the label is the fallback, not the override.
    snippet = text(metadata.body_snippet) ?? MEDIA_LABEL[String(metadata.media_type ?? '')] ?? null;
    senderName = text(metadata.sender_name);
    // agent_inbox also holds the founder's OWN sent messages (direction='outbound'). They are still
    // inbox rows — the detail sheet route is unchanged — but they must render on the founder's side.
    if (eventType === 'inbox' && metadata.direction === 'outbound') kind = 'outbound';
  } else if (eventType === 'decision') {
    // What triage decided, in words. Falls back to the decision type, never to the task UUID.
    title = text(metadata.suggested_title) ?? humanizeDecisionType(text(metadata.decision_type));
    snippet = text(metadata.summary);
    taskRef = text(metadata.task_ref);
    category = text(metadata.category);
    priority = text(metadata.priority);
  } else if (eventType === 'task_link') {
    taskRef = text(metadata.task_ref);
    // The ref is the honest last resort: a linked task we never triaged has no title anywhere local.
    title = text(metadata.task_title) ?? taskRef;
  }
  return {
    id: `${eventType}:${entityId}`,
    kind,
    itemKind: shape.itemKind,
    itemId: shape.itemKind ? entityId : null,
    title,
    snippet,
    status: (row.status as string | null) ?? null,
    createdAt: String(row.created_at),
    senderName,
    taskRef,
    linkUrl: taskRef ? portalTaskUrl(portalBaseUrl, taskRef) : null,
    category,
    priority,
  };
}
