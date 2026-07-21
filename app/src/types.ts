// The single feed row shape, mirroring `founder_app_messages` (see M6 blueprint).
export type Direction = 'in' | 'out';
export type Kind = 'chat' | 'notification' | 'question';
export type Severity = 'info' | 'action' | 'warning';

export interface Button { id: string; label: string }

/** The meeting-draft view a `mkbook`/`mkcancel` card carries on its context (see the FROZEN shared
 *  contract). Duplicated as `MeetingDraftView` in MeetingDraftCard, which owns the render. */
export interface MeetingDraftAttendeeRef { name: string; email: string | null; unresolved: boolean }
export interface MeetingDraftContext {
  id: string;
  status: 'drafting' | 'booked' | 'cancelled';
  title: string;
  startsAt: string | null;
  durationMinutes: number;
  timezone: string;
  attendees: MeetingDraftAttendeeRef[];
  conflicts: string[];
  needs: string[];
  messageId: string | null;
  meetLink: string | null;
  htmlLink: string | null;
}

/** A card's durable origin (server: migration 043). `contextRef` is the inbox/outbound row the
 *  card was raised from — enough to open the thread behind it. `meetingDraft` rides here on a
 *  meeting-draft card (`founder_app_messages.context.meetingDraft`). */
export interface MessageContext {
  contextRef?: { kind: 'inbox' | 'outbound'; ref: string } | null;
  entityRef?: string | null;
  meetingDraft?: MeetingDraftContext | null;
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

/** Current durable chat session. Rows are newest-first on the wire, matching MessagePage. */
export interface ChatPage extends MessagePage { conversationId: string }
export interface ChatPost { data: Message[]; conversationId: string }

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

// ── Calendar day view ───────────────────────────────────────────────────────

/** The palette keys a calendar account may be colored. This is the SINGLE source of truth shared
 *  with the backend: the DB column `calendar_accounts.color` stores one of these keys, and the day
 *  view looks the rendered Tailwind classes up by it (see `paletteFor` in CalendarScreen). */
export const CALENDAR_COLOR_KEYS = ['sky', 'violet', 'emerald', 'teal', 'rose', 'indigo', 'fuchsia', 'cyan'] as const;
export type CalendarColorKey = typeof CALENDAR_COLOR_KEYS[number];

/** One event on the day grid. `startsAt`/`endsAt` are ISO instants rendered in the day's `tz`;
 *  `allDay` rows skip the grid and show as a banner. `color` is the `CalendarColorKey` the source
 *  calendar is colored (matched to `calendar_accounts.color` server-side) and drives the block's
 *  palette; `calendarId`/`calendarAccountId` identify which account the event came from.
 *  `attendeeEmails` is lowercased/deduped and always includes the organizer (empty when none);
 *  `organizerEmail` is the host (also present in `attendeeEmails`). `customerId`/`customerName`
 *  are present iff the event originated from a meeting request, so the invitee picker can default
 *  to that customer's contact list. */
export interface CalendarEvent {
  id: string;
  calendarLabel: string;
  calendarAccountId: string;
  calendarId: string;
  color: CalendarColorKey;
  title: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  attendeeEmails: string[];
  organizerEmail: string | null;
  customerId?: string;
  customerName?: string;
}

/** One email contact — scoped form (single customer). Returned by GET /api/customers/:id/contacts. */
export interface CustomerContact {
  name: string;
  email: string;
  isPrimary: boolean;
}

/** One email contact — unscoped form (all customers). Returned by GET /api/contacts. */
export interface DirectoryContact {
  customerId: string;
  customerName: string;
  name: string;
  email: string;
  isPrimary: boolean;
}

/** One of the founder's calendars the day view reads from / writes to. `color` matches the
 *  palette key above; `isHost` marks the founder's primary calendar. */
export interface CalendarAccountSummary {
  id: string;
  label: string;
  color: CalendarColorKey;
  isHost: boolean;
}

/** When the day view is opened from a pending "pick a time" card, the meeting it will book:
 *  its duration and the four slots the card already suggested (highlighted on the grid). */
export interface CalendarMeeting {
  messageId: string;
  durationMinutes: number;
  proposedSlots: { startsAt: string; endsAt: string }[];
}

/** A suggested, "soft" hold on the day (a walk, a gym block): a hint the founder can still book
 *  over, drawn as a distinct band under the real events. Minutes are from local midnight in `tz`. */
export interface CalendarSoftBlock {
  startMinutes: number;
  endMinutes: number;
  label: string;
}

/** GET /app/api/calendar?day=…[&messageId=…] → `{ data: CalendarDay }`. `businessHours` minutes are
 *  from local midnight in `tz`; null when no business hours are configured. `dayWindow` is the grid's
 *  base visible extent (e.g. 06:00–20:00); the view still widens it to fit any out-of-range event.
 *  `calendars` is the founder's accounts the day's events are drawn from, for rendering legend/chips. */
export interface CalendarDay {
  day: string;
  tz: string;
  businessHours: { startMinutes: number; endMinutes: number } | null;
  dayWindow?: { startMinutes: number; endMinutes: number };
  softBlocks?: CalendarSoftBlock[];
  events: CalendarEvent[];
  calendars: CalendarAccountSummary[];
  meeting?: CalendarMeeting;
}
