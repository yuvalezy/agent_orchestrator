import express, { Router, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { DateTime } from 'luxon';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env';
import type { ConsoleConfig } from '../../config/console';
import type { FirebaseConfig } from '../../config/firebase';
import type { ConversationalQueryService } from '../../query/conversational-query-service';
import { logger } from '../../logger';
import { DeviceAuth } from './founder-app-auth';
import type { FounderAppFeed } from './founder-app-feed';
import type { AppFounderNotifier } from './app-founder-notifier';
import { decodeCursor } from './founder-app-repo';
import type { ChatSession, ChatTurn, ConversationRelation, DismissResult, FeedMessage, FounderAppDevice, InsertMessageInput, MessagePage } from './founder-app-repo';
import { camelizeDeep } from './founder-app-serialize';
import { toUrgencyItem, toTimelineRow } from './founder-app-cockpit-view';
import type { AttentionDecision, CustomerAugment } from './founder-app-cockpit-repo';
import type { Page } from '../console/console-repo';
import type { AppMeetingTimeOutcome } from '../triage/meeting-scheduler.factory';
import type { FounderAppCalendar } from './founder-app-calendar';
import type { replaceDraftBodyAndApprove } from '../../outbound/outbound-repo';
import type { DraftReviserService } from '../../triage/draft-revise';
import type { MeetingDraftView } from '../../scheduling/app-meeting-draft';
import { TranscriptionError } from '../llm/openai-transcription.client';

// The AO Founder PWA API + static shell (M6), mounted at /app and gated by the same
// ConsoleConfig presence as /console. Auth is a DB-backed device token (a phone stays
// logged in for months); the rest is the chat feed, decision taps, live SSE, and FCM
// registration. No message content is ever logged here — only ids/metadata.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_ID_RE = /^\d+$/;
/** A bare wall-clock from `<input type="datetime-local">`: "2026-07-17T15:00" (seconds optional).
 *  No zone by design — the server anchors it in the meeting's founder tz. */
const LOCAL_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
/** A calendar day the day view is asked for: "2026-07-20". No zone — anchored in env.CALENDAR_TZ. */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A "📅 Pick a time" card's signature: its slot buttons are `ms0…`. Only that card takes a
 *  typed time — a duration card (`md30`) is a step too early (no slot to override yet). */
const SLOT_BUTTON_RE = /^ms\d+$/;
/** Any meeting-scheduling card carries a duration (`md30`) OR a slot (`ms0`) button — the signature
 *  the dismiss route matches to abandon a "Wants to talk" / "Pick a time" card (both are questions,
 *  which planDismiss refuses, so the dedicated route uses this instead of /api/dismiss). */
const MEETING_BUTTON_RE = /^m[ds]\d+$/;
/** Synthetic option recorded when a meeting card is DISMISSED (abandoned, no booking, no task). Not
 *  a real button — markDecidedByRef's containment guard would match none, so the route clears the
 *  card + siblings by ref via dismissMeetingCards. */
const MEETING_DISMISS_OPTION = 'mdismiss';
/** Marks a "Pick a time" card resolved when the founder booked by TYPING rather than tapping a
 *  slot — no slot button was chosen, so a sentinel clears it from the queue (first-writer-wins,
 *  exactly the markDecidedByRef path a tap uses). Never a real, tappable option. */
const MEETING_TYPED_TIME_OPTION = 'mtyped';
/** A draft card's signature: bare option ids stored by partitionButtons. Edit needs 'de';
 *  Revise needs 'dv' (only present when DRAFT_REVISE_ENABLED was on at present-time). */
const DRAFT_EDIT_OPT = 'de';
const DRAFT_REVISE_OPT = 'dv';
const MAX_LABEL = 120;
const MAX_TEXT = 4000;
const MAX_FCM_TOKEN = 4096;
/** Cap on a posted voice-note body. OpenAI's own transcription limit is 25 MB, so a larger
 *  upload can never succeed — reject it at the door rather than stream it to the adapter. */
const MAX_AUDIO_BYTES = '25mb';
const MAX_OPTION_ID = 64;
/** Sanity cap on a standalone block-time duration (8h) — a fat-fingered value can't reserve a week. */
const MAX_BLOCK_MINUTES = 480;
/** Cap on the number of attendee emails a single PUT /calendar/event or POST /calendar/block accepts.
 *  Google's own per-event ceiling is higher; this is a blast-radius guard against a malformed body
 *  sending thousands of emails before the writer ever reaches the API. */
const MAX_ATTENDEES = 50;
/** Simple email shape check — not RFC-perfect. The writer + Google both validate further; this
 *  only stops a blatantly-wrong value (no `@`, empty, malformed) from reaching the network. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;
/** How many top urgency items ride along on the attention screen. */
const ATTENTION_URGENCY_LIMIT = 20;
/** How many upcoming reminders the PWA list returns (soonest first). */
const REMINDERS_LIMIT = 50;

/** The console read models the cockpit reuses (adapter-to-adapter; never fork the SQL). */
export interface FounderAppCockpitReads {
  listCustomers: (input: { search?: unknown; cursor?: unknown; limit?: unknown }) => Promise<Page<Record<string, unknown>> | null>;
  customerDetail: (id: string) => Promise<Record<string, unknown> | null>;
  customerTimeline: (id: string, input: { limit?: unknown; cursor?: unknown; omitNoiseDecisions?: boolean }) => Promise<Page<Record<string, unknown>> | null>;
  inboxDetail: (id: string) => Promise<Record<string, unknown> | null>;
  outboundDetail: (id: string) => Promise<Record<string, unknown> | null>;
  decisionDetail: (id: string) => Promise<Record<string, unknown> | null>;
  listUrgencyInbox: (input: { cursor?: unknown; limit?: unknown }) => Promise<(Page<Record<string, unknown>> & { asOf: string }) | null>;
  listAttentionDecisions: (limit?: number) => Promise<AttentionDecision[]>;
  augmentCustomers: (customerIds: string[]) => Promise<Map<string, CustomerAugment>>;
  /** One customer's individual EMAIL contacts — the invitee-picker roster when an event is
   *  customer-linked. Mirrors listCustomerEmailContacts in scheduling-repo. */
  listCustomerContacts: (customerId: string) => Promise<Array<{ name: string; email: string; isPrimary: boolean }>>;
  /** EVERY email contact across every customer (joined with display_name) — the "show all" toggle
   *  in the invitee picker. Mirrors listAllEmailContacts in scheduling-repo. */
  listAllContacts: () => Promise<Array<{ customerId: string; customerName: string; name: string; email: string; isPrimary: boolean }>>;
  /** Batch-resolve calendar events → the customer each meeting-originated event belongs to.
   *  Mirrors findCustomerByEventIds in founder-app-cockpit-repo. Absent from the map = no link. */
  findCustomerByEventIds: (eventIds: string[]) => Promise<Map<string, { customerId: string; customerName: string }>>;
}

/** Repo surface the router needs — injected so tests run without a database. */
export interface FounderAppRepo {
  createDevice: (tokenHash: string, label: string | null) => Promise<string>;
  touchDeviceByTokenHash: (tokenHash: string) => Promise<FounderAppDevice | null>;
  revokeDeviceByTokenHash: (tokenHash: string) => Promise<void>;
  setDeviceFcmToken: (deviceId: string, fcmToken: string) => Promise<void>;
  unregisterDevicePush: (deviceId: string) => Promise<void>;
  insertMessage: (input: InsertMessageInput) => Promise<FeedMessage>;
  listMessages: (opts: { before?: string | null; beforeId?: string | null; limit: number }) => Promise<MessagePage>;
  getMessage: (id: string) => Promise<FeedMessage | null>;
  dismissMessage: (id: string) => Promise<DismissResult>;
  /** Clear ONE card by id (for a synthetic resolution not in the card's buttons — a typed time). */
  markDecidedById: (id: string, optionId: string) => Promise<FeedMessage | null>;
  /** Clear EVERY still-open card on a meeting ref (target + sibling duration/slot cards) with a
   *  synthetic option — the meeting-dismiss gesture. Returns the changed rows for the SSE re-emit. */
  dismissMeetingCards: (notificationRef: string, optionId: string) => Promise<FeedMessage[]>;
  getOrCreateChatSession: (customerRef: string | null) => Promise<ChatSession>;
  resetChatSession: (customerRef: string | null) => Promise<ChatSession>;
  listChatMessages: (sessionId: string, opts: { before?: string | null; beforeId?: string | null; limit: number }) => Promise<MessagePage>;
  listRecentChatTurns: (sessionId: string, limit?: number) => Promise<ChatTurn[]>;
  insertChatExchange: (input: { sessionId: string; customerRef: string | null; question: string; answer: string; relation: ConversationRelation }) => Promise<[FeedMessage, FeedMessage]>;
}

export interface FounderAppDeps {
  repo: FounderAppRepo;
  feed: FounderAppFeed;
  /** The founder query engine (internal scope); null when QUERY_ENGINE_ENABLED is off. */
  query: ConversationalQueryService | null;
  /** The app mirror — holds the shared decision handler and the FCM fan-out. */
  notifier: AppFounderNotifier;
  /** Public Firebase config echoed to the authed client; null disables push client-side. */
  firebase: FirebaseConfig | null;
  /** v2 cockpit read models (reused console-repo SQL + app-specific augmentation). */
  cockpit: FounderAppCockpitReads;
  /**
   * Book a founder-chosen wall-clock time on a pending meeting — the PWA's equal to Telegram's
   * "reply with a time". A GETTER, not the handler itself: the fanout notifier it books through
   * is constructed after this router (the money-loop), so it is late-bound. Absent, or returning
   * null (meeting scheduling off / Telegram not configured) → `POST /api/meeting-time` answers 503.
   */
  meetingReply?: () => ((input: { meetingId: string; localTime: string; by: string }) => Promise<AppMeetingTimeOutcome>) | null;
  /** Edit+approve a draft in place (replace body → approve). null when KNOWLEDGE_DRAFT_ENABLED
   *  is off → POST /api/drafts/:id/edit answers 404. The SAME core fn the console + Telegram edit
   *  path calls (no thread marker — the new body rides in the POST body). */
  editDraft: typeof replaceDraftBodyAndApprove | null;
  /** The 🔁 Revise service, built with the APP notifier so a regenerated draft re-presents as a
   *  new app card. null when DRAFT_REVISE_ENABLED is off → POST /api/drafts/:id/revise answers 404.
   *  reviseFromInstruction NEVER throws. */
  reviser: DraftReviserService | null;
  /** Compose a NEW customer draft email — the PWA's equal of Telegram's `/draft email <prompt>`.
   *  Composes grounded in the customer's knowledge, enqueues is_draft=true, opens the audit
   *  decision, and presents the Approve/Edit/Reject card through the APP notifier (it lands in the
   *  app feed). OPTIONAL — absent when KNOWLEDGE_DRAFT_ENABLED is off → POST /api/drafts/compose
   *  answers 503. Built by buildAppComposeDraft with the SAME core presenter `/draft email` uses. */
  composeDraft?: (input: { customerId: string; prompt: string; by: string }) => Promise<{ ok: true; queueId: string } | { ok: false; reason: string }>;
  /**
   * Iterative meeting scheduling from a customer chat — the marquee chief-of-staff flow. The founder
   * proposes a meeting in words ("meeting with Shlomo at 2pm"), refines the SAME draft across turns
   * ("add Dana", "15:00 thursday"), then books it. Each verb also keeps the draft's ONE feed card in
   * sync (insert first turn, update-in-place on refine). Customer-scoped: attendees resolve against
   * THAT customer's contacts. OPTIONAL — absent (MEETING_SCHEDULING_ENABLED off) → the routes answer
   * 503. Built by buildAppMeetingDraftGated over the SAME booking primitive the Telegram lane uses.
   */
  meetingDraft?: {
    proposeOrRefine: (input: { chatSessionId: string; customerId: string; customerName: string; utterance: string }) => Promise<MeetingDraftView>;
    book: (input: { draftId: string }) => Promise<{ ok: true; view: MeetingDraftView } | { ok: false; reason: string; view: MeetingDraftView }>;
    resolveAttendee: (input: { draftId: string; name: string; email: string }) => Promise<MeetingDraftView>;
    cancel: (input: { draftId: string }) => Promise<MeetingDraftView>;
  };
  /**
   * App-origin reminders (the PWA's own scheduled_actions rows, no Telegram anchors). OPTIONAL so
   * main.ts still compiles without them — absent → every /api/reminders route answers 503. Built
   * in main.ts from scheduling-repo's createAppReminder/listUpcomingReminders/cancelScheduledAction,
   * with the founder-tz (env.CALENDAR_TZ) already applied to executeAt by the router.
   */
  reminders?: {
    create: (input: { body: string; executeAt: Date; timezone: string; customerId: string | null; createdBy: string }) => Promise<{ id: string }>;
    listUpcoming: (limit: number) => Promise<Array<{ id: string; body: string; executeAt: string; customerId: string | null }>>;
    cancel: (id: string) => Promise<{ result: 'cancelled' | 'already' | 'too_late'; customerId: string | null }>;
  };
  /**
   * The calendar day view — every event across every founder calendar for a navigable day, the
   * founder's business-hours window, a pending meeting's proposed slots (to highlight), and a
   * standalone "block my time" write. OPTIONAL so main.ts still compiles without it — absent (or
   * CALENDAR_ENABLED off) → GET /api/calendar and POST /api/calendar/block answer 503. Built by
   * buildFounderAppCalendar at the composition edge (all tz anchoring + send-window reuse there).
   */
  calendar?: FounderAppCalendar;
  /**
   * Abandon the OPEN meeting request behind a "Wants to talk" / "Pick a time" card — the dismiss
   * gesture for a meeting card (planDismiss refuses questions, and a meeting card IS a question).
   * Guarded to the open states: a booked / settled meeting owns a real event + invite and is left
   * untouched (returns false → the route answers 'not_pending'). Makes NO task. A plain meeting-repo
   * fn (no scheduler needed) → wired unconditionally like reminders; absent → the route answers 503.
   */
  dismissMeeting?: (meetingId: string) => Promise<boolean>;
  /**
   * Transcribe a founder voice note recorded in the PWA chat composer — the SAME OpenAI adapter
   * the Telegram voice path uses (buildOpenAiTranscriptionClient). OPTIONAL so main.ts still
   * compiles without it — absent → POST /api/transcribe answers 503. Present but OpenAI
   * unconfigured (no OPENAI_API_KEY) → the adapter throws a non-retryable "not configured"
   * TranscriptionError, which the route also maps to 503, so it can just always be passed.
   */
  transcribe?: (input: { data: Uint8Array; filename: string; mimeType: string }) => Promise<string>;
}

function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.set('Cache-Control', 'no-store');
  next();
}

function attemptKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function optionalLabel(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined; // present but wrong type → reject
  const trimmed = value.trim();
  if (trimmed.length > MAX_LABEL) return undefined;
  return trimmed || null;
}

/**
 * Coerce a request body's `attendeeEmails` into a clean list, or `undefined` to signal a
 * malformed body (caller → 400). `null` is treated as "absent" (no attendee change); a present
 * array is checked for shape (string[], each a basic email, ≤ MAX_ATTENDEES). Trimming/
 * lowercasing happens at the writer — this only guards the wire shape.
 */
function optionalAttendees(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return undefined;
  if (value.length > MAX_ATTENDEES) return undefined;
  const out: string[] = [];
  for (const e of value) {
    if (typeof e !== 'string') return undefined;
    const trimmed = e.trim();
    if (!trimmed || !EMAIL_RE.test(trimmed)) return undefined;
    out.push(trimmed);
  }
  return out;
}

/** Coerce a request body's `sendUpdates` ('all' | 'none') or `undefined`/`null` → undefined. Any
 *  other value → undefined-signals-malformed sentinel is unnecessary: the writer only consumes
 *  the value when attendeeEmails is also supplied, so a stray string is silently ignored. */
function optionalSendUpdates(value: unknown): 'all' | 'none' | undefined {
  return value === 'all' || value === 'none' ? value : undefined;
}

function device(res: Response): FounderAppDevice {
  return res.locals.appDevice as FounderAppDevice;
}

/**
 * Enabling push is cross-origin, and app.ts's global `helmet()` ships a 'self'-only
 * default policy that blocks it: getToken() calls Firebase Installations and then FCM
 * registration, and a CSP-blocked fetch rejects as a bare "Failed to fetch" — which is
 * exactly what the push toggle reported.
 *
 * This stayed invisible until FIREBASE_* was configured: with push unconfigured the
 * toggle never renders, so nothing ever crossed an origin. The policy was always wrong;
 * the app simply never reached the part of itself that needed it.
 *
 * Scoped to THIS router on purpose — it re-sets the header only for /app, so the console
 * and every other surface keep the strict default. script-src stays 'self': the worker
 * handles push natively and pulls in no third-party script (app/public/sw.js).
 */
const FIREBASE_CSP = helmet.contentSecurityPolicy({
  useDefaults: true,
  directives: {
    // getToken() → Firebase Installations (mints the app instance id) → FCM
    // registration (exchanges it + the VAPID key for the device token). Delivery
    // itself needs nothing here: it arrives over the browser's own push channel.
    'connect-src': [
      "'self'",
      'https://firebaseinstallations.googleapis.com',
      'https://fcmregistrations.googleapis.com',
      'https://fcm.googleapis.com',
    ],
    'worker-src': ["'self'"],
  },
});

/**
 * Route-scoped RAW body parser for POST /api/transcribe — reads the recorded audio as a Buffer.
 * app.ts's global express.json() only parses application/json, so an `audio/*` body flows past it
 * untouched and reaches this parser (there is NO global catch-all body parser to eat it first).
 * The `type`
 * predicate matches only `audio/*`, so a non-audio content-type leaves req.body unparsed and the
 * route answers 400. Over-limit uploads make body-parser throw a 413 `entity.too.large`; the
 * wrapper maps that to a 400 (per the transcribe contract) rather than the generic error handler.
 */
const rawAudio = express.raw({
  type: (req) => (req.headers['content-type'] || '').startsWith('audio/'),
  limit: MAX_AUDIO_BYTES,
});
function rawAudioBody(req: Request, res: Response, next: NextFunction): void {
  rawAudio(req, res, (err: unknown) => {
    if (err) {
      const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode;
      if (status === 413) return void res.status(400).json({ error: 'audio too large' });
      return next(err);
    }
    next();
  });
}

export function buildFounderAppRouter(config: ConsoleConfig, assetsDir: string | undefined, deps: FounderAppDeps): Router {
  const router = Router();
  const auth = new DeviceAuth(config);

  router.use(FIREBASE_CSP);
  router.use('/api', noStore);

  // ── Public: device login ───────────────────────────────────────────────────────────
  router.post('/api/login', async (req, res) => {
    const key = attemptKey(req);
    const body = (req.body ?? {}) as { password?: unknown; label?: unknown };
    const label = optionalLabel(body.label);
    if (label === undefined) return void res.status(400).json({ error: 'invalid label' });
    // Rate-limit is distinct from a wrong password (429 vs 401) so the app can show
    // "too many attempts, wait a moment" rather than "wrong password".
    if (!auth.canAttempt(key)) return void res.status(429).json({ error: 'too many attempts' });
    if (typeof body.password !== 'string' || !(await auth.verifyPassword(body.password))) {
      auth.recordFailedAttempt(key);
      return void res.status(401).json({ error: 'invalid credentials' });
    }
    auth.clearAttempts(key);
    const { token, tokenHash } = auth.mintToken();
    try {
      await deps.repo.createDevice(tokenHash, label);
    } catch (err) {
      logger.error({ err: { name: (err as { name?: string })?.name } }, 'founder-app device registration failed');
      return void res.status(500).json({ error: 'login failed' });
    }
    auth.setCookie(res, token);
    res.status(201).json({ data: { label } });
  });

  // ── Auth gate: everything below needs a live device cookie ───────────────────────────
  router.use('/api', async (req, res, next) => {
    const token = auth.readToken(req);
    if (!token) return void res.status(401).json({ error: 'unauthorized' });
    try {
      const found = await deps.repo.touchDeviceByTokenHash(auth.hashToken(token));
      if (!found) {
        auth.clearCookie(res);
        return void res.status(401).json({ error: 'unauthorized' });
      }
      res.locals.appDevice = found;
      next();
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/logout', async (req, res, next) => {
    const token = auth.readToken(req);
    try {
      if (token) await deps.repo.revokeDeviceByTokenHash(auth.hashToken(token));
      auth.clearCookie(res);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Unwrapped (no `data` envelope) to match the app's config fetch contract: the client
  // reads body.firebase / body.vapidKey directly, and either being null self-disables push.
  router.get('/api/config', (_req, res) => {
    res.json({ firebase: deps.firebase?.webConfig ?? null, vapidKey: deps.firebase?.vapidKey ?? null });
  });

  // ── Feed ─────────────────────────────────────────────────────────────────────────────
  router.get('/api/messages', async (req, res, next) => {
    // `before` is the opaque cursor from a prior page's nextCursor (encodes created_at+id).
    let cursor: { before: string; beforeId: string } | null = null;
    if (typeof req.query.before === 'string' && req.query.before) {
      cursor = decodeCursor(req.query.before);
      if (!cursor) return void res.status(400).json({ error: 'invalid cursor' });
    }
    const limitRaw = Number(req.query.limit);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_PAGE) : DEFAULT_PAGE;
    try {
      res.json(await deps.repo.listMessages({ before: cursor?.before ?? null, beforeId: cursor?.beforeId ?? null, limit }));
    } catch (err) {
      next(err);
    }
  });

  // ── Durable scoped chat ────────────────────────────────────────────────────────────
  // GET is deliberately separate from the global Activity feed: it returns only the
  // currently active visible conversation for one exact scope.
  router.get('/api/chat', async (req, res, next) => {
    const rawCustomerId = req.query.customerId;
    if (rawCustomerId !== undefined && (typeof rawCustomerId !== 'string' || !UUID_RE.test(rawCustomerId))) {
      return void res.status(400).json({ error: 'invalid customer id' });
    }
    let cursor: { before: string; beforeId: string } | null = null;
    if (typeof req.query.before === 'string' && req.query.before) {
      cursor = decodeCursor(req.query.before);
      if (!cursor) return void res.status(400).json({ error: 'invalid cursor' });
    }
    const limitRaw = Number(req.query.limit);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_PAGE) : DEFAULT_PAGE;
    const customerId = typeof rawCustomerId === 'string' ? rawCustomerId : null;
    try {
      if (customerId && !(await deps.cockpit.customerDetail(customerId))) {
        return void res.status(404).json({ error: 'customer not found' });
      }
      const session = await deps.repo.getOrCreateChatSession(customerId);
      const page = await deps.repo.listChatMessages(session.id, {
        before: cursor?.before ?? null,
        beforeId: cursor?.beforeId ?? null,
        limit,
      });
      res.json({ ...page, conversationId: session.id });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/chat/reset', async (req, res, next) => {
    const rawCustomerId = (req.body as { customerId?: unknown } | undefined)?.customerId;
    if (rawCustomerId !== undefined && rawCustomerId !== null && (typeof rawCustomerId !== 'string' || !UUID_RE.test(rawCustomerId))) {
      return void res.status(400).json({ error: 'invalid customer id' });
    }
    const customerId = typeof rawCustomerId === 'string' ? rawCustomerId : null;
    try {
      if (customerId && !(await deps.cockpit.customerDetail(customerId))) {
        return void res.status(404).json({ error: 'customer not found' });
      }
      const session = await deps.repo.resetChatSession(customerId);
      res.status(201).json({ data: { conversationId: session.id } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/messages', async (req, res, next) => {
    const body = (req.body ?? {}) as { text?: unknown; customerId?: unknown };
    const text = body.text;
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) {
      return void res.status(400).json({ error: 'invalid message' });
    }
    // Optional customer scope: absent → internal "Project Brain"; present → that customer's
    // memory (the same customer-scoped path the console /api/query uses).
    if (body.customerId !== undefined && body.customerId !== null && (typeof body.customerId !== 'string' || !UUID_RE.test(body.customerId))) {
      return void res.status(400).json({ error: 'invalid customer id' });
    }
    if (!deps.query) return void res.status(503).json({ error: 'query service unavailable' });
    const customerId = typeof body.customerId === 'string' ? body.customerId : null;
    const trimmed = text.trim();
    try {
      let customerName: string | null = null;
      if (customerId) {
        const customer = await deps.cockpit.customerDetail(customerId);
        if (!customer || typeof customer.display_name !== 'string') return void res.status(404).json({ error: 'customer not found' });
        customerName = customer.display_name;
      }
      const session = await deps.repo.getOrCreateChatSession(customerId);
      const history = await deps.repo.listRecentChatTurns(session.id);
      const answered = customerId
        ? await deps.query.answerTurn(trimmed, history, { customer: { customerId, customerName: customerName! } })
        : await deps.query.answerTurn(trimmed, history, { forceInternal: true });
      const answerBody = answered.result.answer ?? "I don't have anything on that yet.";
      const exchange = await deps.repo.insertChatExchange({
        sessionId: session.id,
        customerRef: customerId,
        question: trimmed,
        answer: answerBody,
        relation: answered.relation,
      });
      for (const row of exchange) deps.feed.publish(row);
      res.status(201).json({ data: exchange, conversationId: session.id });
    } catch (err) {
      next(err);
    }
  });

  // ── Voice-note transcription (chat composer mic button) ──────────────────────────────
  // The PWA records a voice note via MediaRecorder and POSTs the RAW audio bytes here; we hand
  // them to the SAME OpenAI adapter the Telegram voice path uses and return the text for the
  // founder to review in the composer (transcription-to-text-box, NOT auto-send). Device-auth'd
  // + no-store like every /api route. rawAudioBody parses the audio/* body into a Buffer.
  router.post('/api/transcribe', rawAudioBody, async (req, res, next) => {
    const contentType = (req.headers['content-type'] || '').trim();
    if (!contentType.startsWith('audio/')) {
      return void res.status(400).json({ error: 'audio content-type required' });
    }
    // Absent injection → feature unwired. Present but OpenAI unconfigured self-reports below.
    if (!deps.transcribe) return void res.status(503).json({ error: 'transcription unavailable' });
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return void res.status(400).json({ error: 'empty audio body' });
    }
    try {
      const text = await deps.transcribe({
        data: new Uint8Array(body),
        filename: 'voice.webm',
        mimeType: contentType.split(';')[0].trim(),
      });
      res.json({ data: { text } });
    } catch (err) {
      // The adapter's "not configured" (no OPENAI_API_KEY) is a non-retryable TranscriptionError
      // → 503, matching the deps-absent case. Every other failure is a genuine error → 500.
      if (err instanceof TranscriptionError && /not configured/i.test(err.message)) {
        return void res.status(503).json({ error: 'transcription unavailable' });
      }
      next(err);
    }
  });

  // ── Decision taps ──────────────────────────────────────────────────────────────────
  router.post('/api/decisions', async (req, res, next) => {
    const body = (req.body ?? {}) as { messageId?: unknown; optionId?: unknown };
    if (typeof body.messageId !== 'string' || !UUID_RE.test(body.messageId)) {
      return void res.status(400).json({ error: 'invalid message id' });
    }
    if (typeof body.optionId !== 'string' || !body.optionId || body.optionId.length > MAX_OPTION_ID) {
      return void res.status(400).json({ error: 'invalid option' });
    }
    try {
      const row = await deps.repo.getMessage(body.messageId);
      if (!row) return void res.status(404).json({ error: 'not found' });
      if (!row.buttons?.some((b) => b.id === body.optionId)) {
        return void res.status(400).json({ error: 'unknown option' });
      }
      // Already decided: a re-tap of the SAME option is an idempotent no-op; a DIFFERENT
      // option is a stale keyboard and is refused.
      if (row.decidedOptionId) {
        return void (row.decidedOptionId === body.optionId
          ? res.json({ data: row })
          : res.status(409).json({ error: 'already decided' }));
      }
      // A meeting-draft card's Cancel is NOT a shared-decision option — the card carries no decision
      // ref (its live actions POST to /api/meeting-draft). Intercept it here: cancel the draft (frees
      // the session's active-draft slot and flips the card terminal), then dismiss the card so it
      // leaves the attention queue. Never reaches the decision bus.
      if (body.optionId === 'mkcancel') {
        const draftId = (row.context?.meetingDraft as { id?: string } | null | undefined)?.id;
        if (draftId && deps.meetingDraft) await deps.meetingDraft.cancel({ draftId });
        const dismissed = await deps.repo.dismissMessage(body.messageId);
        if (dismissed.ok) for (const r of dismissed.rows) deps.feed.publish(r);
        return void res.json({ data: dismissed.ok ? dismissed.rows : row });
      }
      // Dispatch through the SHARED composite handler: it runs the real decision handler
      // (idempotent via claimOverride) and THEN the mirror hook, which marks EVERY app row
      // sharing this ref as decided (first-writer-wins) and re-emits them over SSE. This is
      // the identical path a Telegram tap takes — so app-made and Telegram-made decisions
      // converge the mirror through ONE code path, and the app never records an option that
      // differs from the one that actually took effect. No messageId-based marking here.
      const dispatched = await deps.notifier.dispatchDecision({
        notificationRef: row.notificationRef ?? '',
        optionId: body.optionId,
        by: 'founder-app',
      });
      if (!dispatched) return void res.status(503).json({ error: 'decisions unavailable' });
      // Return the row as the shared hook left it (decided, unless its ref was empty).
      res.json({ data: (await deps.repo.getMessage(body.messageId)) ?? row });
    } catch (err) {
      next(err);
    }
  });

  // ── Typed time on a "📅 Pick a time" card ────────────────────────────────────────────
  // The PWA's equal to Telegram's "reply with a time — thursday 3pm". A rich client needs no
  // natural-language parse: a native datetime picker yields an unambiguous wall-clock, which the
  // scheduler anchors in the founder's tz and books through onTypedTime — the SAME code a Telegram
  // typed reply reaches, so a busy/past time is refused and re-notified identically. On a booking
  // we clear the card the first-writer-wins way a tapped slot does; the confirmation card itself
  // arrives separately over SSE (the scheduler notified through the fanout mirror).
  router.post('/api/meeting-time', async (req, res, next) => {
    const body = (req.body ?? {}) as { messageId?: unknown; localTime?: unknown };
    if (typeof body.messageId !== 'string' || !UUID_RE.test(body.messageId)) {
      return void res.status(400).json({ error: 'invalid message id' });
    }
    if (typeof body.localTime !== 'string' || !LOCAL_TIME_RE.test(body.localTime)) {
      return void res.status(400).json({ error: 'invalid time' });
    }
    const book = deps.meetingReply?.();
    if (!book) return void res.status(503).json({ error: 'meeting scheduling unavailable' });
    try {
      const row = await deps.repo.getMessage(body.messageId);
      if (!row) return void res.status(404).json({ error: 'not found' });
      // Only a "Pick a time" card (slot buttons + a meeting ref) takes a typed time.
      if (!row.notificationRef || !row.buttons?.some((b) => SLOT_BUTTON_RE.test(b.id))) {
        return void res.status(400).json({ error: 'not a scheduling card' });
      }
      // Already resolved (a slot tapped, or a time already typed) → refuse, mirroring /decisions.
      if (row.decidedOptionId) return void res.status(409).json({ error: 'already decided' });

      const outcome = await book({ meetingId: row.notificationRef, localTime: body.localTime, by: 'founder-app' });
      if (outcome.status === 'booked') {
        // Clear THIS slot card so it leaves the attention queue on every open client. 'mtyped' is
        // synthetic (not a button on the card), so markDecidedByRef's containment guard would match
        // nothing — mark the exact card by id and re-emit it over the feed (broadcasts to all
        // clients). The booking confirmation card itself arrives separately via the fanout mirror.
        const cleared = await deps.repo.markDecidedById(row.id, MEETING_TYPED_TIME_OPTION);
        if (cleared) deps.feed.publish(cleared);
      }
      res.json({ data: { status: outcome.status } });
    } catch (err) {
      next(err);
    }
  });

  // ── Dismiss a "Wants to talk" / "Pick a time" meeting card (abandon — no booking, no task) ──
  // planDismiss refuses 'question' cards (an askFounder fork must be ANSWERED) and a meeting card IS
  // a question, so this dedicated route handles the ONE specific meeting-abandon action WITHOUT
  // relaxing that global rule. Resolve the card → its meeting (notificationRef IS the
  // agent_meeting_requests id, the SAME mapping /api/meeting-time uses), guardedly abandon the OPEN
  // request (a booked meeting owns a real event + invite and is left untouched → 'not_pending'), then
  // clear the card AND any sibling open card on the same meeting (a duration + a slot card can coexist)
  // so it leaves the queue on every client. Returns 'dismissed' | 'not_pending' | 'not_a_meeting_card'.
  router.post('/api/meeting/:messageId/dismiss', async (req, res, next) => {
    if (!UUID_RE.test(req.params.messageId)) return void res.status(400).json({ error: 'invalid message id' });
    if (!deps.dismissMeeting) return void res.status(503).json({ error: 'meeting scheduling unavailable' });
    try {
      const row = await deps.repo.getMessage(req.params.messageId);
      if (!row) return void res.status(404).json({ error: 'not found' });
      // A meeting card carries a meeting ref AND md*/ms* buttons; anything else is not one, and the
      // meeting-abandon gesture does not apply (a plain notification uses /api/dismiss).
      if (!row.notificationRef || !row.buttons?.some((b) => MEETING_BUTTON_RE.test(b.id))) {
        return void res.json({ data: { status: 'not_a_meeting_card' } });
      }
      const abandoned = await deps.dismissMeeting(row.notificationRef);
      if (!abandoned) return void res.json({ data: { status: 'not_pending' } });
      // Clear the card + any sibling open meeting card on the same ref (all synthetic 'mdismiss', no
      // real button), and re-emit each over the feed so every open client drops it.
      const cleared = await deps.repo.dismissMeetingCards(row.notificationRef, MEETING_DISMISS_OPTION);
      for (const r of cleared) deps.feed.publish(r);
      res.json({ data: { status: 'dismissed' } });
    } catch (err) {
      next(err);
    }
  });

  // ── Edit a draft reply (replace body → approve) ──────────────────────────────────────
  // The PWA's equal to Telegram's ✏️ Edit + the console's /drafts/:id/edit. Keyed by the app
  // message UUID (the card-identity model /api/decisions uses), not the queueId: getMessage
  // resolves the row, validates it is an editable draft card (has 'de'), and the new body rides
  // in the POST body — no thread marker. Reuses the EXACT core fn the console/Telegram path calls.
  router.post('/api/drafts/:messageId/edit', async (req, res, next) => {
    if (!UUID_RE.test(req.params.messageId)) return void res.status(400).json({ error: 'invalid message id' });
    const body = (req.body as { body?: unknown } | undefined)?.body;
    if (typeof body !== 'string' || !body.trim() || body.length > MAX_TEXT) {
      return void res.status(400).json({ error: 'body is required' });
    }
    if (!deps.editDraft) return void res.status(404).json({ error: 'draft editing not enabled' });
    try {
      const row = await deps.repo.getMessage(req.params.messageId);
      if (!row) return void res.status(404).json({ error: 'not found' });
      if (!row.notificationRef || !row.buttons?.some((b) => b.id === DRAFT_EDIT_OPT)) {
        return void res.status(400).json({ error: 'not an editable draft' });
      }
      if (row.decidedOptionId) return void res.status(409).json({ error: 'already decided' });
      const queueId = row.notificationRef;
      const result = await deps.editDraft(queueId, body, 'founder-app');
      if (!result) return void res.status(409).json({ error: 'already decided' }); // guarded null = resolved elsewhere
      // Leave the attention queue the ONE mirror-marking way a tapped decision does — mark + re-emit
      // every app row on this ref (the SAME path /api/meeting-time uses after a booking).
      await deps.notifier.recordDecision({ notificationRef: queueId, optionId: DRAFT_EDIT_OPT, by: 'founder-app' });
      res.json({ data: { queueId, status: 'approved' } });
    } catch (err) {
      next(err);
    }
  });

  // ── Revise a draft reply (🔁 regenerate from a founder instruction) ───────────────────
  // The PWA's equal to Telegram's 🔁 Revise + the console's /drafts/:id/revise. The reviser
  // re-presents through the APP notifier and inserts a NEW card on the SAME ref, so the old card
  // is marked decided BEFORE regenerating (first-writer-wins while only it exists) — mirroring the
  // Telegram flow, where tapping 🔁 clears the old app card via onDecided before the instruction lands.
  router.post('/api/drafts/:messageId/revise', async (req, res, next) => {
    if (!UUID_RE.test(req.params.messageId)) return void res.status(400).json({ error: 'invalid message id' });
    const instruction = (req.body as { instruction?: unknown } | undefined)?.instruction;
    if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > MAX_TEXT) {
      return void res.status(400).json({ error: 'instruction is required' });
    }
    if (!deps.reviser) return void res.status(404).json({ error: 'revise not enabled' });
    try {
      const row = await deps.repo.getMessage(req.params.messageId);
      if (!row) return void res.status(404).json({ error: 'not found' });
      if (!row.notificationRef || !row.buttons?.some((b) => b.id === DRAFT_REVISE_OPT)) {
        return void res.status(400).json({ error: 'not a revisable draft' });
      }
      if (row.decidedOptionId) return void res.status(409).json({ error: 'already decided' });
      const queueId = row.notificationRef;
      // Mark the OLD card decided BEFORE regenerating (see route comment above).
      await deps.notifier.recordDecision({ notificationRef: queueId, optionId: DRAFT_REVISE_OPT, by: 'founder-app' });
      // NEVER throws; regenerates synchronously; on success re-presents a fresh draft card (SSE + FCM).
      await deps.reviser.reviseFromInstruction({ queueId, instruction, by: 'founder-app' });
      res.json({ data: { queueId, revised: true } });
    } catch (err) {
      next(err);
    }
  });

  // ── Compose a NEW draft email (the PWA's equal of Telegram's /draft email <prompt>) ───
  // Composes a customer email grounded in their knowledge, enqueues it is_draft=true, opens the
  // audit decision, and presents the Approve/Edit/Reject card through the APP notifier so it lands
  // in the app feed — the SAME core presenter `/draft email` uses. Unlike edit/revise (which act on
  // an EXISTING card keyed by the app message UUID), this MINTS a new draft, so it takes a customer
  // id + prompt directly. composeDraft absent (feature off / KNOWLEDGE_DRAFT_ENABLED off) → 503; an
  // unknown customer → 404; a no-email-route / already-resolved refusal → 409 (the reason echoed).
  router.post('/api/drafts/compose', async (req, res, next) => {
    const body = (req.body ?? {}) as { customerId?: unknown; prompt?: unknown };
    if (typeof body.customerId !== 'string' || !UUID_RE.test(body.customerId)) {
      return void res.status(400).json({ error: 'invalid customer id' });
    }
    if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > MAX_TEXT) {
      return void res.status(400).json({ error: 'prompt is required' });
    }
    if (!deps.composeDraft) return void res.status(503).json({ error: 'draft compose unavailable' });
    try {
      // The customer's language, name and knowledge ground the draft — an unknown customer can't be
      // drafted to (and would only cost an LLM call), so verify existence before composing.
      if (!(await deps.cockpit.customerDetail(body.customerId))) {
        return void res.status(404).json({ error: 'customer not found' });
      }
      const result = await deps.composeDraft({ customerId: body.customerId, prompt: body.prompt.trim(), by: 'founder-app' });
      if (!result.ok) return void res.status(409).json({ error: result.reason });
      res.json({ data: { queueId: result.queueId } });
    } catch (err) {
      next(err);
    }
  });

  // ── Meeting draft — iterative meeting scheduling in the customer chat ─────────────────
  // The marquee chief-of-staff flow. `text` is a natural-language utterance: the first proposes the
  // meeting ("meeting with Shlomo at 2pm"), each subsequent one REFINES the same draft ("add Dana",
  // "make it 15:00 thursday", "45 min"). Every call re-interprets the accumulated utterances against
  // THIS customer's contacts, revalidates free/busy, and evolves ONE card (the gateway handles the
  // feed). NOTHING is booked here — see /book. Customer-scoped (unknown customer → 404); meetingDraft
  // absent (MEETING_SCHEDULING_ENABLED off) → 503.
  router.post('/api/meeting-draft', async (req, res, next) => {
    const body = (req.body ?? {}) as { customerId?: unknown; text?: unknown };
    if (typeof body.customerId !== 'string' || !UUID_RE.test(body.customerId)) {
      return void res.status(400).json({ error: 'invalid customer id' });
    }
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > MAX_TEXT) {
      return void res.status(400).json({ error: 'text is required' });
    }
    if (!deps.meetingDraft) return void res.status(503).json({ error: 'meeting scheduling unavailable' });
    try {
      const customer = await deps.cockpit.customerDetail(body.customerId);
      if (!customer || typeof customer.display_name !== 'string') return void res.status(404).json({ error: 'customer not found' });
      const session = await deps.repo.getOrCreateChatSession(body.customerId);
      const view = await deps.meetingDraft.proposeOrRefine({
        chatSessionId: session.id,
        customerId: body.customerId,
        customerName: customer.display_name,
        utterance: body.text.trim(),
      });
      res.json({ data: view });
    } catch (err) {
      next(err);
    }
  });

  // ── Book a meeting draft (the ONE irreversible step) ──────────────────────────────────
  // Books the active draft NOW: re-checks the time is still future, then creates the calendar event
  // with a Meet link and fires invites (sendUpdates:'all') — unrecallable, so it is NEVER done on a
  // refine turn, only this explicit tap. Idempotent: the deterministic eventId is keyed on the draft
  // id, so a double tap collides at Google (409) instead of a second event. 409 with the current view
  // when the draft still `needs` a time/attendee or the time has lapsed; 503 when scheduling is off.
  router.post('/api/meeting-draft/:id/book', async (req, res, next) => {
    if (!UUID_RE.test(req.params.id)) return void res.status(400).json({ error: 'invalid draft id' });
    if (!deps.meetingDraft) return void res.status(503).json({ error: 'meeting scheduling unavailable' });
    try {
      const result = await deps.meetingDraft.book({ draftId: req.params.id });
      if (!result.ok) return void res.status(409).json({ error: result.reason, data: result.view });
      res.json({ data: { status: 'booked', view: result.view } });
    } catch (err) {
      next(err);
    }
  });

  // ── Resolve an unresolved attendee by PICKING a contact ───────────────────────────────
  // When the founder's word for someone ("Shlomo") doesn't match the stored contact ("Salomon
  // Kortovich"), the card offers the customer's email contacts as candidates. Tapping one posts
  // {name, email} here: `name` is the guess to replace, `email` MUST be one of the customer's
  // contacts (the core rejects anything else — never invents an invitee). Returns the refreshed view.
  router.post('/api/meeting-draft/:id/resolve', async (req, res, next) => {
    if (!UUID_RE.test(req.params.id)) return void res.status(400).json({ error: 'invalid draft id' });
    const body = (req.body ?? {}) as { name?: unknown; email?: unknown };
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > MAX_TEXT) {
      return void res.status(400).json({ error: 'name is required' });
    }
    if (typeof body.email !== 'string' || !body.email.trim() || body.email.length > MAX_TEXT) {
      return void res.status(400).json({ error: 'email is required' });
    }
    if (!deps.meetingDraft) return void res.status(503).json({ error: 'meeting scheduling unavailable' });
    try {
      const view = await deps.meetingDraft.resolveAttendee({ draftId: req.params.id, name: body.name.trim(), email: body.email.trim() });
      res.json({ data: view });
    } catch (err) {
      next(err);
    }
  });

  // ── Calendar day view ────────────────────────────────────────────────────────────────
  // Every event across every one of the founder's calendars for ONE navigable day (any past/future
  // day), plus the founder's business-hours window, so they can eyeball a free slot instead of
  // guessing. `messageId` (optional) resolves a pending "📅 Pick a time" card to its meeting so the
  // FE can highlight the slots already offered. The day is anchored in env.CALENDAR_TZ — never the
  // phone's zone. calendar dep absent (CALENDAR_ENABLED off) → 503; the events list is useful even
  // when the meeting doesn't resolve, so an unresolved messageId just omits `meeting`.
  router.get('/api/calendar', async (req, res, next) => {
    const day = req.query.day;
    if (typeof day !== 'string' || !DAY_RE.test(day)) return void res.status(400).json({ error: 'invalid day' });
    const messageIdRaw = req.query.messageId;
    if (messageIdRaw !== undefined && (typeof messageIdRaw !== 'string' || !UUID_RE.test(messageIdRaw))) {
      return void res.status(400).json({ error: 'invalid message id' });
    }
    if (!deps.calendar) return void res.status(503).json({ error: 'calendar unavailable' });
    const dayStart = DateTime.fromISO(day, { zone: env.CALENDAR_TZ }).startOf('day');
    if (!dayStart.isValid) return void res.status(400).json({ error: 'invalid day' });
    const dayEnd = dayStart.plus({ days: 1 });
    try {
      const [events, businessHours, calendars] = await Promise.all([
        deps.calendar.listRange({ timeMin: dayStart.toJSDate(), timeMax: dayEnd.toJSDate() }),
        deps.calendar.businessHoursForDay(day),
        deps.calendar.calendars(),
      ]);
      // Batch-resolve event → customer for the day's events. Meeting-originated events (those whose
      // id appears in agent_meeting_requests.event_id) tag with {customerId, customerName} so the FE
      // can default the invitee picker to THAT customer's contacts. Best-effort: an empty events list
      // or a read failure leaves the map empty (no customer tag), and the day view still renders.
      const eventIds = events.map((e) => e.id).filter(Boolean);
      let customerByEvent = new Map<string, { customerId: string; customerName: string }>();
      if (eventIds.length > 0) {
        try {
          customerByEvent = await deps.cockpit.findCustomerByEventIds(eventIds);
        } catch (err) {
          logger.warn({ reason: (err as Error)?.message }, 'calendar day view: event→customer batch failed — continuing without customer tags');
        }
      }
      const data: {
        day: string;
        tz: string;
        businessHours: { startMinutes: number; endMinutes: number } | null;
        // The VISIBLE grid extent (env-configured), DISTINCT from businessHours — a hint the FE still
        // widens to fit any out-of-range event. Soft holds (walk / gym) are shaded, weekday-filtered.
        dayWindow: { startMinutes: number; endMinutes: number };
        softBlocks: Array<{ startMinutes: number; endMinutes: number; label: string }>;
        events: Array<{
          id: string;
          calendarLabel: string;
          title: string;
          startsAt: Date;
          endsAt: Date;
          allDay: boolean;
          calendarAccountId: string;
          calendarId: string;
          color: string;
          /** Lowercased, deduped invitee emails (organizer included). Empty when the event has none. */
          attendeeEmails: string[];
          /** The organizer's email (also in attendeeEmails), or null. */
          organizerEmail: string | null;
          /** Present ONLY when this event originated from a customer meeting request — the invitee
           *  picker then defaults to that customer's contact list. Absent = no customer link. */
          customerId?: string;
          customerName?: string;
        }>;
        // The founder's calendar roster for the day-view dropdown (id + label + color + isHost).
        calendars: Array<{ id: string; label: string; color: string; isHost: boolean }>;
        meeting?: { messageId: string; durationMinutes: number; proposedSlots: Array<{ startsAt: string; endsAt: string }> };
      } = {
        day,
        tz: env.CALENDAR_TZ,
        businessHours,
        dayWindow: deps.calendar.dayWindow,
        softBlocks: deps.calendar.softBlocksForDay(day),
        events: events.map((e) => {
          const cust = customerByEvent.get(e.id);
          return {
            id: e.id,
            calendarLabel: e.calendarLabel,
            title: e.title,
            startsAt: e.startsAt,
            endsAt: e.endsAt,
            allDay: e.allDay,
            calendarAccountId: e.calendarAccountId,
            calendarId: e.calendarId,
            color: e.color,
            attendeeEmails: e.attendeeEmails,
            organizerEmail: e.organizerEmail,
            ...(cust ? { customerId: cust.customerId, customerName: cust.customerName } : {}),
          };
        }),
        calendars,
      };
      // Resolve the pending meeting the SAME way /api/meeting-time does: the card's notificationRef
      // IS the meeting id, and only a "Pick a time" card (slot buttons) carries one.
      if (typeof messageIdRaw === 'string') {
        const row = await deps.repo.getMessage(messageIdRaw);
        if (row?.notificationRef && row.buttons?.some((b) => SLOT_BUTTON_RE.test(b.id))) {
          const meeting = await deps.calendar.meetingForCard(row.notificationRef);
          if (meeting) data.meeting = { messageId: messageIdRaw, durationMinutes: meeting.durationMinutes, proposedSlots: meeting.proposedSlots };
        }
      }
      res.json({ data });
    } catch (err) {
      next(err);
    }
  });

  // ── Block time (standalone hold — no customer, no invitee) ────────────────────────────
  // Tapping a free slot in the day view that isn't a pending customer meeting books a private hold
  // on the founder host calendar. localTime is a bare wall-clock (datetime-local); the SERVER
  // anchors it in env.CALENDAR_TZ. FAIL-CLOSED + past-refused in the builder. Status vocabulary
  // matches /api/meeting-time ('booked'|'unavailable'|'invalid') so the FE reuses its handler.
  //
  // Optional attendeeEmails + sendUpdates turn a private hold into an actual invitation — the
  // "block + invite" one-tap path for "hold a meeting with these people" without going through the
  // full meeting-scheduling flow. When attendees are supplied and sendUpdates is omitted, the
  // builder defaults to 'all' (never silently invite). On `booked`, the response carries the new
  // event's id + write target so the FE can immediately re-edit (e.g. add a forgotten attendee).
  router.post('/api/calendar/block', async (req, res, next) => {
    const body = (req.body ?? {}) as {
      localTime?: unknown;
      durationMinutes?: unknown;
      title?: unknown;
      calendarAccountId?: unknown;
      attendeeEmails?: unknown;
      sendUpdates?: unknown;
    };
    if (typeof body.localTime !== 'string' || !LOCAL_TIME_RE.test(body.localTime)) {
      return void res.status(400).json({ error: 'invalid time' });
    }
    if (typeof body.durationMinutes !== 'number' || !Number.isInteger(body.durationMinutes) || body.durationMinutes <= 0 || body.durationMinutes > MAX_BLOCK_MINUTES) {
      return void res.status(400).json({ error: 'invalid duration' });
    }
    const title = optionalLabel(body.title); // null → default in the builder; undefined → wrong type/too long
    if (title === undefined) return void res.status(400).json({ error: 'invalid title' });
    // Optional explicit target — the day-view dropdown's calendar picker. UUID-shaped; absent → host.
    if (body.calendarAccountId !== undefined && body.calendarAccountId !== null && (typeof body.calendarAccountId !== 'string' || !UUID_RE.test(body.calendarAccountId))) {
      return void res.status(400).json({ error: 'invalid calendar account id' });
    }
    const attendeeEmails = optionalAttendees(body.attendeeEmails);
    if (attendeeEmails === undefined) return void res.status(400).json({ error: 'invalid attendeeEmails' });
    const sendUpdates = optionalSendUpdates(body.sendUpdates);
    if (!deps.calendar) return void res.status(503).json({ error: 'calendar unavailable' });
    try {
      const calendarAccountId = typeof body.calendarAccountId === 'string' ? body.calendarAccountId : undefined;
      const outcome = await deps.calendar.block({
        localTime: body.localTime,
        durationMinutes: body.durationMinutes,
        title: title ?? undefined,
        calendarAccountId,
        attendeeEmails: attendeeEmails ?? undefined,
        sendUpdates,
      });
      // Forward the event id + write target on `booked` so the FE can re-target an edit without a refetch.
      const data: { status: 'booked' | 'unavailable' | 'invalid'; eventId?: string; calendarAccountId?: string; calendarId?: string } = {
        status: outcome.status,
        ...(outcome.eventId ? { eventId: outcome.eventId, calendarAccountId: outcome.calendarAccountId, calendarId: outcome.calendarId } : {}),
      };
      res.json({ data });
    } catch (err) {
      next(err);
    }
  });

  // ── Edit an event (events.patch) ─────────────────────────────────────────────────────
  // The day-view's "edit" affordance: change an event's title, time, duration, OR attendee list on
  // the SAME calendar it already lives on (calendarAccountId names the writer). Conflict-DETECTED,
  // not conflict-BLOCKED: when the new window overlaps another event, the FIRST call returns
  // 'conflict' with the list of clashes; the FE confirms and re-submits with confirmConflict=true.
  // localTime is a bare wall-clock (datetime-local); the SERVER anchors it in env.CALENDAR_TZ.
  // A duration change WITHOUT a localTime is rejected as 'invalid' (v1 needs the start to resize).
  //
  // attendeeEmails is the FULL new attendee list (the FE merges current + added − removed — never
  // a delta). When supplied and sendUpdates is omitted, the builder defaults to 'all' so a newly
  // added invitee gets the email instead of being silently added.
  router.put('/api/calendar/event', async (req, res, next) => {
    const body = (req.body ?? {}) as {
      calendarAccountId?: unknown;
      eventId?: unknown;
      title?: unknown;
      localTime?: unknown;
      durationMinutes?: unknown;
      confirmConflict?: unknown;
      attendeeEmails?: unknown;
      sendUpdates?: unknown;
    };
    if (typeof body.calendarAccountId !== 'string' || !UUID_RE.test(body.calendarAccountId)) {
      return void res.status(400).json({ error: 'invalid calendar account id' });
    }
    if (typeof body.eventId !== 'string' || !body.eventId.trim() || body.eventId.length > 256) {
      return void res.status(400).json({ error: 'invalid event id' });
    }
    const title = optionalLabel(body.title);
    if (title === undefined) return void res.status(400).json({ error: 'invalid title' });
    if (body.localTime !== undefined && body.localTime !== null && (typeof body.localTime !== 'string' || !LOCAL_TIME_RE.test(body.localTime))) {
      return void res.status(400).json({ error: 'invalid time' });
    }
    const localTime = typeof body.localTime === 'string' ? body.localTime : undefined;
    if (
      body.durationMinutes !== undefined &&
      body.durationMinutes !== null &&
      (typeof body.durationMinutes !== 'number' || !Number.isInteger(body.durationMinutes) || body.durationMinutes <= 0 || body.durationMinutes > MAX_BLOCK_MINUTES)
    ) {
      return void res.status(400).json({ error: 'invalid duration' });
    }
    const durationMinutes = typeof body.durationMinutes === 'number' ? body.durationMinutes : undefined;
    if (body.confirmConflict !== undefined && body.confirmConflict !== null && typeof body.confirmConflict !== 'boolean') {
      return void res.status(400).json({ error: 'invalid confirmConflict' });
    }
    const attendeeEmails = optionalAttendees(body.attendeeEmails);
    if (attendeeEmails === undefined) return void res.status(400).json({ error: 'invalid attendeeEmails' });
    const sendUpdates = optionalSendUpdates(body.sendUpdates);
    // Must be changing SOMETHING — a PATCH with no fields is a no-op the FE should never send.
    if (title === null && localTime === undefined && durationMinutes === undefined && attendeeEmails === null) {
      return void res.status(400).json({ error: 'nothing to update' });
    }
    if (!deps.calendar) return void res.status(503).json({ error: 'calendar unavailable' });
    try {
      const outcome = await deps.calendar.updateEvent({
        calendarAccountId: body.calendarAccountId,
        eventId: body.eventId,
        title: title ?? undefined,
        localTime,
        durationMinutes,
        confirmConflict: body.confirmConflict === true,
        attendeeEmails: attendeeEmails ?? undefined,
        sendUpdates,
      });
      res.json({ data: outcome });
    } catch (err) {
      next(err);
    }
  });

  // ── Delete (cancel) an event ────────────────────────────────────────────────────────
  // The day-view's "delete" affordance: cancels the event on the SAME calendar it lives on.
  // Express 5 carries the JSON body on DELETE; calendarAccountId + eventId name the target.
  router.delete('/api/calendar/event', async (req, res, next) => {
    const body = (req.body ?? {}) as { calendarAccountId?: unknown; eventId?: unknown };
    if (typeof body.calendarAccountId !== 'string' || !UUID_RE.test(body.calendarAccountId)) {
      return void res.status(400).json({ error: 'invalid calendar account id' });
    }
    if (typeof body.eventId !== 'string' || !body.eventId.trim() || body.eventId.length > 256) {
      return void res.status(400).json({ error: 'invalid event id' });
    }
    if (!deps.calendar) return void res.status(503).json({ error: 'calendar unavailable' });
    try {
      const outcome = await deps.calendar.deleteEvent({ calendarAccountId: body.calendarAccountId, eventId: body.eventId });
      res.json({ data: { status: outcome.status } });
    } catch (err) {
      next(err);
    }
  });

  // ── Reminders (app-origin scheduled_actions, no Telegram anchors) ────────────────────
  // The PWA can create its own "nudge me at" reminders — the same scheduled_actions table
  // Telegram writes to, but with NULL Telegram anchors and action_kind='reminder'. localTime is
  // a bare wall-clock from a datetime-local input; the SERVER anchors it in the founder tz
  // (env.CALENDAR_TZ), exactly as /api/meeting-time's factory does — never the phone's zone. The
  // repo fns are OPTIONAL deps, so the routes 503 when reminders are unwired (money loop off).
  router.post('/api/reminders', async (req, res, next) => {
    const body = (req.body ?? {}) as { text?: unknown; localTime?: unknown; customerId?: unknown };
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > MAX_TEXT) {
      return void res.status(400).json({ error: 'invalid text' });
    }
    if (typeof body.localTime !== 'string' || !LOCAL_TIME_RE.test(body.localTime)) {
      return void res.status(400).json({ error: 'invalid time' });
    }
    if (body.customerId !== undefined && body.customerId !== null && (typeof body.customerId !== 'string' || !UUID_RE.test(body.customerId))) {
      return void res.status(400).json({ error: 'invalid customer id' });
    }
    if (!deps.reminders) return void res.status(503).json({ error: 'reminders unavailable' });
    // Anchor the wall-clock in the founder tz (the offered slots' zone), never the server's/phone's.
    const dt = DateTime.fromISO(body.localTime, { zone: env.CALENDAR_TZ });
    if (!dt.isValid) return void res.status(400).json({ error: 'invalid time' });
    if (dt.toMillis() <= Date.now()) return void res.status(400).json({ error: 'time is in the past' });
    const customerId = typeof body.customerId === 'string' ? body.customerId : null;
    const text = body.text.trim();
    try {
      if (customerId && !(await deps.cockpit.customerDetail(customerId))) {
        return void res.status(404).json({ error: 'customer not found' });
      }
      const { id } = await deps.reminders.create({
        body: text,
        executeAt: dt.toJSDate(),
        timezone: env.CALENDAR_TZ,
        customerId,
        createdBy: 'founder-app',
      });
      res.json({ data: { id } });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/reminders', async (_req, res, next) => {
    if (!deps.reminders) return void res.status(503).json({ error: 'reminders unavailable' });
    try {
      const rows = await deps.reminders.listUpcoming(REMINDERS_LIMIT);
      // Resolve the customer name off the reused cockpit read (null when unscoped or unknown).
      const data = await Promise.all(rows.map(async (r) => {
        let customerName: string | null = null;
        if (r.customerId) {
          const customer = await deps.cockpit.customerDetail(r.customerId);
          customerName = typeof customer?.display_name === 'string' ? customer.display_name : null;
        }
        return { id: r.id, body: r.body, executeAt: r.executeAt, customerId: r.customerId, customerName };
      }));
      res.json({ data });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/api/reminders/:id', async (req, res, next) => {
    if (!UUID_RE.test(req.params.id)) return void res.status(400).json({ error: 'invalid reminder id' });
    if (!deps.reminders) return void res.status(503).json({ error: 'reminders unavailable' });
    try {
      // Reuses cancelScheduledAction: 'cancelled' (was pending), 'already' (gone/terminal), or
      // 'too_late' (already firing/dispatched past the point of recall).
      const { result } = await deps.reminders.cancel(req.params.id);
      res.json({ data: { status: result } });
    } catch (err) {
      next(err);
    }
  });

  // ── Dismiss (acknowledge) ──────────────────────────────────────────────────────────
  // "I've seen this" — the app's inbox-zero gesture, and NOT a decision: the task, the
  // decision handler and Telegram are all untouched. It exists because approving what the
  // assistant did meant doing nothing, which left the card in the queue forever.
  //
  // Ref-keyed in the repo (planDismiss), so the several rows that legitimately mirror one
  // entity — tryR49Reconfirm re-notifies with the SAME ref — clear together. A 'question' is
  // refused: askFounder asks a real fork that must be answered, and a new surface must not
  // make it silently droppable.
  router.post('/api/dismiss', async (req, res, next) => {
    const body = (req.body ?? {}) as { messageId?: unknown };
    if (typeof body.messageId !== 'string' || !UUID_RE.test(body.messageId)) {
      return void res.status(400).json({ error: 'invalid message id' });
    }
    try {
      const result = await deps.repo.dismissMessage(body.messageId);
      if (!result.ok) {
        return void (result.reason === 'not_found'
          ? res.status(404).json({ error: 'not found' })
          : res.status(409).json({ error: 'not dismissible' }));
      }
      // Re-publish exactly the rows THIS call changed, so every open client drops them from
      // its queue without a refetch. An empty set is a legitimate re-dismiss no-op.
      for (const row of result.rows) deps.feed.publish(row);
      res.json({ data: result.rows });
    } catch (err) {
      next(err);
    }
  });

  // ── v2 cockpit reads (device-auth'd, camelCase, {data,nextCursor}) ───────────────────
  // The action queue: undecided app cards (customer name resolved) + top urgency items.
  router.get('/api/attention', async (_req, res, next) => {
    try {
      const [decisions, urgency] = await Promise.all([
        deps.cockpit.listAttentionDecisions(),
        deps.cockpit.listUrgencyInbox({ limit: String(ATTENTION_URGENCY_LIMIT) }),
      ]);
      res.json({ decisions, urgency: urgency ? urgency.data.map(toUrgencyItem) : [] });
    } catch (err) {
      next(err);
    }
  });

  // listCustomers rows augmented with pendingCount + last activity. Filters/paging/validation
  // come straight from the reused console-repo function (null → bad search or cursor → 400).
  router.get('/api/customers', async (req, res, next) => {
    try {
      const page = await deps.cockpit.listCustomers({ search: req.query.search, cursor: req.query.cursor, limit: req.query.limit });
      if (!page) return void res.status(400).json({ error: 'invalid search or cursor' });
      const ids = page.data.map((row) => String(row.id));
      const augment = await deps.cockpit.augmentCustomers(ids);
      const data = page.data.map((row) => {
        const extra = augment.get(String(row.id));
        return {
          ...(camelizeDeep(row) as Record<string, unknown>),
          pendingCount: extra?.pendingCount ?? 0,
          lastActivityAt: extra?.lastActivityAt ?? null,
          lastActivitySnippet: extra?.lastActivitySnippet ?? null,
        };
      });
      res.json({ data, nextCursor: page.nextCursor });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/customers/:id', async (req, res, next) => {
    if (!UUID_RE.test(req.params.id)) return void res.status(400).json({ error: 'invalid customer id' });
    try {
      const data = await deps.cockpit.customerDetail(req.params.id);
      if (!data) return void res.status(404).json({ error: 'not found' });
      res.json({ data: camelizeDeep(data) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/customers/:id/timeline', async (req, res, next) => {
    if (!UUID_RE.test(req.params.id)) return void res.status(400).json({ error: 'invalid customer id' });
    try {
      // omitNoiseDecisions is the app's own posture, NOT a client parameter: the cockpit drops
      // the triage rows that carry no content by construction (an `{"intents":[]}` decision per
      // no-op message). The console deliberately passes nothing — there, every decision row is
      // evidence. Filtering happens in SQL, so keyset paging stays correct.
      const page = await deps.cockpit.customerTimeline(req.params.id, { cursor: req.query.cursor, limit: req.query.limit, omitNoiseDecisions: true });
      if (!page) return void res.status(400).json({ error: 'invalid limit or cursor' });
      // portalBaseUrl turns a task_ref into a tappable "Open Task" — formatted here, never in the
      // client, which cannot see server config and would only guess a dead URL.
      res.json({ data: page.data.map((row) => toTimelineRow(row, config.portalBaseUrl)), nextCursor: page.nextCursor });
    } catch (err) {
      next(err);
    }
  });

  // ── Contact lists for the calendar invitee picker ───────────────────────────────────
  // The day view's "manage invitees" affordance reads one of these: the customer-linked list when
  // the tapped event carries a `customerId`, or the full list when the founder toggles "show all".
  // Both exclude groups (a group is a jid, not a person) and non-email channels — same predicate
  // as listScheduleRouteCandidates, so "invite everyone" cannot drift from what a send would target.
  router.get('/api/customers/:id/contacts', async (req, res, next) => {
    if (!UUID_RE.test(req.params.id)) return void res.status(400).json({ error: 'invalid customer id' });
    try {
      const rows = await deps.cockpit.listCustomerContacts(req.params.id);
      res.json({ data: rows });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/contacts', async (_req, res, next) => {
    try {
      const rows = await deps.cockpit.listAllContacts();
      res.json({ data: rows });
    } catch (err) {
      next(err);
    }
  });

  // Detail-sheet passthrough. kind picks the reused console-repo detail fn; anything else → 400.
  router.get('/api/items/:kind/:id', async (req, res, next) => {
    const detailFn =
      req.params.kind === 'inbox' ? deps.cockpit.inboxDetail
      : req.params.kind === 'outbound' ? deps.cockpit.outboundDetail
      : req.params.kind === 'decision' ? deps.cockpit.decisionDetail
      : null;
    if (!detailFn) return void res.status(400).json({ error: 'invalid kind' });
    if (!NUMERIC_ID_RE.test(req.params.id) || Number(req.params.id) <= 0) return void res.status(400).json({ error: 'invalid id' });
    try {
      const data = await detailFn(req.params.id);
      if (!data) return void res.status(404).json({ error: 'not found' });
      res.json({ data: camelizeDeep(data) });
    } catch (err) {
      next(err);
    }
  });

  // ── Live feed (SSE) ────────────────────────────────────────────────────────────────
  router.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.flushHeaders?.();
    res.write(': connected\n\n');
    const unsubscribe = deps.feed.subscribe((message) => {
      res.write(`data: ${JSON.stringify(message)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // ── FCM registration ───────────────────────────────────────────────────────────────
  router.post('/api/push/register', async (req, res, next) => {
    const token = (req.body as { fcmToken?: unknown } | undefined)?.fcmToken;
    if (typeof token !== 'string' || !token || token.length > MAX_FCM_TOKEN) {
      return void res.status(400).json({ error: 'invalid fcm token' });
    }
    try {
      await deps.repo.setDeviceFcmToken(device(res).id, token);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.delete('/api/push/register', async (_req, res, next) => {
    try {
      await deps.repo.unregisterDevicePush(device(res).id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

  // ── Static PWA shell ───────────────────────────────────────────────────────────────
  // The built app is public (the login screen must boot); every /api route above stays
  // device-gated and no-store. sw.js (app shell + FCM in one worker) / manifest.webmanifest
  // are served as ordinary files from the app root, so they resolve inside the /app scope.
  if (assetsDir && existsSync(path.join(assetsDir, 'index.html'))) {
    router.use(express.static(assetsDir, { index: false, fallthrough: true, maxAge: 0 }));
    router.get('/{*splat}', (_req, res) => {
      res.set('Cache-Control', 'no-store');
      res.sendFile(path.join(assetsDir, 'index.html'));
    });
  } else {
    router.get('/', (_req, res) => res.status(503).json({ error: 'founder app assets unavailable' }));
  }

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: { name: (err as { name?: string })?.name } }, 'founder-app request failed');
    res.status(500).json({ error: 'founder app request failed' });
  });

  return router;
}
