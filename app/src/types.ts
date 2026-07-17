// The single feed row shape, mirroring `founder_app_messages` (see M6 blueprint).
export type Direction = 'in' | 'out';
export type Kind = 'chat' | 'notification' | 'question';
export type Severity = 'info' | 'action' | 'warning';

export interface Button { id: string; label: string }

/** A card's durable origin (server: migration 043). `contextRef` is the inbox/outbound row the
 *  card was raised from — enough to open the thread behind it. */
export interface MessageContext {
  contextRef?: { kind: 'inbox' | 'outbound'; ref: string } | null;
  entityRef?: string | null;
}

export interface Message {
  id: string;
  direction: Direction;
  kind: Kind;
  title: string | null;
  body: string;
  severity: Severity | null;
  customerRef: string | null;
  notificationRef: string | null;
  buttons: Button[] | null;
  decidedOptionId: string | null;
  /** EZY Portal deep link (Notification.url). Absent → no "Open Task" button; never guess one. */
  linkUrl?: string | null;
  /** Where this card came from, so a tap can open its thread. */
  context?: MessageContext | null;
  /** Set once the founder acknowledged the card; dismissed cards leave the attention queue. */
  dismissedAt?: string | null;
  createdAt: string;
  /** Client-only flag: an optimistic row not yet confirmed by the server. */
  pending?: boolean;
}

/** GET /app/api/messages — newest-first page. `nextCursor` is the `before`
 *  value to request the next (older) page, or null when the feed is exhausted. */
export interface MessagePage { data: Message[]; nextCursor: string | null }

/** GET /app/api/config — Firebase is null when push is not configured server-side. */
export interface AppConfig {
  firebase: FirebaseWebConfig | null;
  vapidKey: string | null;
}

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  messagingSenderId: string;
  appId: string;
  storageBucket?: string;
  measurementId?: string;
}

// ── v2 cockpit read models ──────────────────────────────────────────────────

/** An undecided buttoned message joined with its customer's display name. `customerId`
 *  (when present) is the customers-list id used to group the Pending tab; we fall back
 *  to `customerRef` if the backend leaves it unset. */
export interface AttentionCard extends Message {
  customerName: string | null;
  customerId?: string | null;
}

/** A top urgency-inbox item; itemKind/itemId open its detail sheet when present. */
export interface UrgencyItem {
  id: string;
  customerName: string | null;
  title: string | null;
  score: number;
  snippet: string | null;
  createdAt: string;
  itemKind: DetailKind | null;
  itemId: string | null;
}

export interface Attention { decisions: AttentionCard[]; urgency: UrgencyItem[] }

export interface CustomerRow {
  id: string;
  displayName: string;
  lastActivityAt: string | null;
  lastActivitySnippet: string | null;
  pendingCount: number;
}
export interface CustomerPage { data: CustomerRow[]; nextCursor: string | null }

/** customerDetail passthrough — displayName is the only field the header needs. */
export interface CustomerDetail { id: string; displayName: string; [key: string]: unknown }

export type TimelineKind = 'inbound' | 'outbound' | 'decision' | 'notification';
export type DetailKind = 'inbox' | 'outbound' | 'decision';

/** One thread event. `id` is `${eventType}:${entityId}` — the same shape a card's
 *  `context.contextRef` yields, so a card can point at its own row in the thread. */
export interface TimelineRow {
  id: string;
  kind: TimelineKind;
  itemKind: DetailKind | null;
  itemId: string | null;
  title: string | null;
  snippet: string | null;
  status: string | null;
  createdAt: string;
  /** Who sent it (inbound/outbound rows only). */
  senderName: string | null;
  /** The portal task this row concerns (decision + task-link rows). */
  taskRef: string | null;
  /** Browsable "Open Task" target, formatted server-side. Null → render no button; never
   *  construct one client-side (the portal base is server config the app cannot see). */
  linkUrl: string | null;
  /** Triage classification, rendered as chips rather than concatenated into the title. */
  category: string | null;
  priority: string | null;
}
export interface TimelinePage { data: TimelineRow[]; nextCursor: string | null }

/** Detail-sheet passthrough: an opaque key/value record rendered generically. */
export type DetailRow = Record<string, unknown>;
