// View-model normalizers for the v2 cockpit. The reused console read models return
// broad snake_case rows; the app frontend renders by a small, stable discriminant. We
// normalize HERE (presentation only — the SQL is still reused verbatim) so the frontend
// gets one deterministic shape and never hardcodes the console's event_type table.

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
  inbox: { kind: 'inbound', itemKind: 'inbox' },
  outbound: { kind: 'outbound', itemKind: 'outbound' },
  decision: { kind: 'decision', itemKind: 'decision' },
  // A task link is an inline marker with no detail route.
  task_link: { kind: 'notification', itemKind: null },
};

/** Map a console customerTimeline row (snake_case + jsonb metadata) to a TimelineRow. */
export function toTimelineRow(row: Record<string, unknown>): TimelineRow {
  const eventType = String(row.event_type);
  const shape = TIMELINE_MAP[eventType] ?? { kind: 'notification' as const, itemKind: null };
  const entityId = String(row.entity_id);
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  let title: string | null = null;
  let snippet: string | null = null;
  if (eventType === 'inbox' || eventType === 'outbound') {
    title = (metadata.subject as string | null) ?? null;
  } else if (eventType === 'decision') {
    title = (metadata.decision_type as string | null) ?? null;
    snippet = (metadata.task_ref as string | null) ?? null;
  } else if (eventType === 'task_link') {
    title = (metadata.task_ref as string | null) ?? null;
  }
  return {
    id: `${eventType}:${entityId}`,
    kind: shape.kind,
    itemKind: shape.itemKind,
    itemId: shape.itemKind ? entityId : null,
    title,
    snippet,
    status: (row.status as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}
