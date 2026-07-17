import express, { Router, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ConsoleConfig } from '../../config/console';
import type { FirebaseConfig } from '../../config/firebase';
import type { QueryService } from '../../query/query-service';
import { logger } from '../../logger';
import { DeviceAuth } from './founder-app-auth';
import type { FounderAppFeed } from './founder-app-feed';
import type { AppFounderNotifier } from './app-founder-notifier';
import { decodeCursor } from './founder-app-repo';
import type { FeedMessage, FounderAppDevice, InsertMessageInput, MessagePage } from './founder-app-repo';
import { camelizeDeep } from './founder-app-serialize';
import { toUrgencyItem, toTimelineRow } from './founder-app-cockpit-view';
import type { AttentionDecision, CustomerAugment } from './founder-app-cockpit-repo';
import type { Page } from '../console/console-repo';

// The AO Founder PWA API + static shell (M6), mounted at /app and gated by the same
// ConsoleConfig presence as /console. Auth is a DB-backed device token (a phone stays
// logged in for months); the rest is the chat feed, decision taps, live SSE, and FCM
// registration. No message content is ever logged here — only ids/metadata.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_ID_RE = /^\d+$/;
const MAX_LABEL = 120;
const MAX_TEXT = 4000;
const MAX_FCM_TOKEN = 4096;
const MAX_OPTION_ID = 64;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;
/** How many top urgency items ride along on the attention screen. */
const ATTENTION_URGENCY_LIMIT = 20;

/** The console read models the cockpit reuses (adapter-to-adapter; never fork the SQL). */
export interface FounderAppCockpitReads {
  listCustomers: (input: { search?: unknown; cursor?: unknown; limit?: unknown }) => Promise<Page<Record<string, unknown>> | null>;
  customerDetail: (id: string) => Promise<Record<string, unknown> | null>;
  customerTimeline: (id: string, input: { limit?: unknown; cursor?: unknown }) => Promise<Page<Record<string, unknown>> | null>;
  inboxDetail: (id: string) => Promise<Record<string, unknown> | null>;
  outboundDetail: (id: string) => Promise<Record<string, unknown> | null>;
  decisionDetail: (id: string) => Promise<Record<string, unknown> | null>;
  listUrgencyInbox: (input: { cursor?: unknown; limit?: unknown }) => Promise<(Page<Record<string, unknown>> & { asOf: string }) | null>;
  listAttentionDecisions: (limit?: number) => Promise<AttentionDecision[]>;
  augmentCustomers: (customerIds: string[]) => Promise<Map<string, CustomerAugment>>;
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
}

export interface FounderAppDeps {
  repo: FounderAppRepo;
  feed: FounderAppFeed;
  /** The founder query engine (internal scope); null when QUERY_ENGINE_ENABLED is off. */
  query: QueryService | null;
  /** The app mirror — holds the shared decision handler and the FCM fan-out. */
  notifier: AppFounderNotifier;
  /** Public Firebase config echoed to the authed client; null disables push client-side. */
  firebase: FirebaseConfig | null;
  /** v2 cockpit read models (reused console-repo SQL + app-specific augmentation). */
  cockpit: FounderAppCockpitReads;
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
      const inbound = await deps.repo.insertMessage({ direction: 'in', kind: 'chat', body: trimmed, customerRef: customerId });
      deps.feed.publish(inbound);
      const result = customerId
        ? await deps.query.answer(trimmed, { customer: { customerId, customerName: customerName! } })
        : await deps.query.answer(trimmed, { forceInternal: true });
      const answerBody = result.answer ?? "I don't have anything on that yet.";
      const outbound = await deps.repo.insertMessage({ direction: 'out', kind: 'chat', body: answerBody, customerRef: customerId });
      deps.feed.publish(outbound);
      res.status(201).json({ data: [inbound, outbound] });
    } catch (err) {
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
      const page = await deps.cockpit.customerTimeline(req.params.id, { cursor: req.query.cursor, limit: req.query.limit });
      if (!page) return void res.status(400).json({ error: 'invalid limit or cursor' });
      res.json({ data: page.data.map(toTimelineRow), nextCursor: page.nextCursor });
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
