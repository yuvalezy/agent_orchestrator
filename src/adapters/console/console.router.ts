import express, { Router, type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ConsoleConfig } from '../../config/console';
import { getConsoleOverview, getHealth } from '../../health/health.service';
import { logger } from '../../logger';
import { cancelOutbound, customerDetail, customerTimeline, decisionDetail, inboxDetail, listCustomers, listDecisions, listInbox, listOutbound, outboundDetail, requeueInbox, type ConsoleAuditContext } from './console-repo';
import { ConsoleSessionStore } from './console-session';
import { buildConsoleApprovalsRouter } from './console-approvals.router';
import { buildConsoleSettingsRouter } from './console-settings.router';
import { buildConsoleConnectorsRouter, buildConnectorsOAuthCallback } from './console-connectors.router';
import { getConsoleInsights, parseInsightDays } from './console-insights-repo';

function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.set('Cache-Control', 'no-store');
  next();
}

function attemptKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function validId(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) > 0;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Console failures must not serialize upstream exception messages or attached payloads. */
export function projectConsoleFailure(err: unknown): { err: { name: string | undefined }; response: { error: 'console request failed' } } {
  return {
    err: { name: (err as { name?: string } | undefined)?.name },
    response: { error: 'console request failed' },
  };
}

/** Build a portal UI URL from a mirrored task reference; this never contacts the portal. */
export function portalTaskUrl(portalBaseUrl: string | null, taskRef: unknown): string | null {
  if (!portalBaseUrl || typeof taskRef !== 'string' || !taskRef.trim() || taskRef.length > 200) return null;
  return `${portalBaseUrl.replace(/\/+$/, '')}/projects/tasks/${encodeURIComponent(taskRef)}`;
}

function portalTasksUrl(portalBaseUrl: string | null): string | null {
  return portalBaseUrl ? `${portalBaseUrl.replace(/\/+$/, '')}/projects/tasks` : null;
}

function withPortalTaskLinks(data: Record<string, unknown>[], portalBaseUrl: string | null): Record<string, unknown>[] {
  return data.map((event) => {
    const metadata = event.metadata as { task_ref?: unknown } | null;
    const url = portalTaskUrl(portalBaseUrl, metadata?.task_ref);
    return url ? { ...event, portal_task_url: url } : event;
  });
}

function withPortalTaskLink(data: Record<string, unknown>, portalBaseUrl: string | null): Record<string, unknown> {
  const url = portalTaskUrl(portalBaseUrl, data.task_ref);
  return url ? { ...data, portal_task_url: url } : data;
}

export function buildConsoleRouter(config: ConsoleConfig, assetsDir?: string): Router {
  const router = Router();
  const sessions = new ConsoleSessionStore(config);
  router.use('/api', noStore);

  router.post('/api/session', async (req, res) => {
    const key = attemptKey(req);
    const password = (req.body as { password?: unknown } | undefined)?.password;
    if (!sessions.canAttempt(key) || typeof password !== 'string' || !(await sessions.verifyPassword(password))) {
      sessions.recordFailedAttempt(key);
      res.status(401).json({ error: 'invalid credentials' });
      return;
    }
    sessions.clearAttempts(key);
    const session = sessions.create(res);
    res.status(201).json({ data: { csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() } });
  });

  router.delete('/api/session', (req, res) => {
    sessions.destroy(req, res);
    res.status(204).end();
  });

  // PUBLIC (pre-session) Google OAuth callback (B2). Google redirects here as a top-level cross-site
  // navigation, so the strict-sameSite session cookie is absent — this route authenticates via the
  // SIGNED `state` minted by the session+CSRF-guarded POST /oauth/start, not the session. Registered
  // before the session guard so it is reachable; the guarded connectors router mounts below.
  router.get('/api/connectors/oauth/callback', buildConnectorsOAuthCallback({ sessionSecret: config.sessionSecret }));

  router.use('/api', (req, res, next) => {
    const session = sessions.get(req);
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.locals.consoleSession = session;
    next();
  });

  router.use('/api', (_req, res, next) => {
    const auditContext: ConsoleAuditContext = { actor: 'founder', requestId: crypto.randomUUID() };
    res.locals.consoleAuditContext = auditContext;
    res.set('X-Request-ID', auditContext.requestId);
    next();
  });

  router.get('/api/session', (_req, res) => {
    const session = res.locals.consoleSession as { csrfToken: string; expiresAt: number };
    res.json({ data: { csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() } });
  });

  router.get('/api/overview', async (_req, res, next) => {
    try {
      res.json({ data: await getConsoleOverview() });
    } catch (err) {
      next(err);
    }
  });
  router.get('/api/insights', async (req, res, next) => {
    const days = parseInsightDays(req.query.days);
    if (days === null) return void res.status(400).json({ error: 'invalid date range' });
    try {
      const insights = await getConsoleInsights(days);
      res.json({ data: { ...insights, taskInventory: { ...insights.taskInventory, portalUrl: portalTasksUrl(config.portalBaseUrl) } } });
    } catch (err) {
      next(err);
    }
  });
  router.get('/api/workers', async (_req, res, next) => {
    try {
      res.json({ data: (await getHealth()).workers });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/inbox', async (req, res, next) => {
    try {
      const page = await listInbox(req.query);
      if (!page) {
        res.status(400).json({ error: 'invalid filter or cursor' });
        return;
      }
      res.json(page);
    } catch (err) {
      next(err);
    }
  });
  router.get('/api/inbox/:id', async (req, res, next) => {
    if (!validId(req.params.id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    try {
      const data = await inboxDetail(req.params.id);
      if (!data) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json({ data });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/outbound', async (req, res, next) => {
    try {
      const page = await listOutbound(req.query);
      if (!page) {
        res.status(400).json({ error: 'invalid filter or cursor' });
        return;
      }
      res.json(page);
    } catch (err) {
      next(err);
    }
  });
  router.get('/api/outbound/:id', async (req, res, next) => {
    if (!validId(req.params.id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    try {
      const data = await outboundDetail(req.params.id);
      if (!data) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json({ data });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/decisions', async (req, res, next) => {
    try {
      const page = await listDecisions(req.query);
      if (!page) {
        res.status(400).json({ error: 'invalid filter or cursor' });
        return;
      }
      res.json({ ...page, data: page.data.map((decision) => withPortalTaskLink(decision, config.portalBaseUrl)) });
    } catch (err) {
      next(err);
    }
  });
  router.get('/api/decisions/:id', async (req, res, next) => {
    if (!validId(req.params.id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    try {
      const data = await decisionDetail(req.params.id);
      if (!data) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json({ data: withPortalTaskLink(data, config.portalBaseUrl) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/customers', async (req, res, next) => {
    try {
      const page = await listCustomers(req.query);
      if (!page) return void res.status(400).json({ error: 'invalid search or cursor' });
      res.json(page);
    } catch (err) { next(err); }
  });
  router.get('/api/customers/:id', async (req, res, next) => {
    if (!UUID_RE.test(req.params.id)) return void res.status(400).json({ error: 'invalid customer id' });
    try {
      const data = await customerDetail(req.params.id);
      if (!data) return void res.status(404).json({ error: 'not found' });
      res.json({ data });
    } catch (err) { next(err); }
  });
  router.get('/api/customers/:id/timeline', async (req, res, next) => {
    if (!UUID_RE.test(req.params.id)) return void res.status(400).json({ error: 'invalid customer id' });
    try {
      const timeline = await customerTimeline(req.params.id, req.query);
      if (!timeline) return void res.status(400).json({ error: 'invalid limit or cursor' });
      res.json({ ...timeline, data: withPortalTaskLinks(timeline.data, config.portalBaseUrl) });
    } catch (err) { next(err); }
  });

  router.use('/api', (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    if (!sessions.csrfValid(req, res.locals.consoleSession as { csrfToken: string })) {
      res.status(403).json({ error: 'csrf validation failed' });
      return;
    }
    next();
  });

  router.post('/api/inbox/:id/requeue', async (req, res, next) => {
    if (!validId(req.params.id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    try {
      const result = await requeueInbox(req.params.id, res.locals.consoleAuditContext as ConsoleAuditContext);
      if (result === 'not_found') return void res.status(404).json({ error: 'not found' });
      if (result === 'conflict') return void res.status(409).json({ error: 'state changed; refresh and review' });
      res.status(200).json({ data: { id: req.params.id, status: 'pending' } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/outbound/:id/cancel', async (req, res, next) => {
    if (!validId(req.params.id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    try {
      const result = await cancelOutbound(req.params.id, res.locals.consoleAuditContext as ConsoleAuditContext);
      if (result === 'not_found') return void res.status(404).json({ error: 'not found' });
      if (result === 'conflict') return void res.status(409).json({ error: 'state changed; refresh and review' });
      res.status(200).json({ data: { id: req.params.id, status: 'cancelled' } });
    } catch (err) {
      next(err);
    }
  });

  router.use('/api/approvals', buildConsoleApprovalsRouter());
  router.use('/api/settings', buildConsoleSettingsRouter());
  router.use('/api/connectors', buildConsoleConnectorsRouter({ sessionSecret: config.sessionSecret }));

  router.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

  // Assets contain no runtime data and are intentionally public so the login page
  // can boot. Every API response remains session-protected and no-store.
  if (assetsDir && existsSync(path.join(assetsDir, 'index.html'))) {
    router.use(express.static(assetsDir, { index: false, fallthrough: true, maxAge: 0 }));
    router.get('/{*splat}', (_req, res) => {
      res.set('Cache-Control', 'no-store');
      res.sendFile(path.join(assetsDir, 'index.html'));
    });
  } else {
    router.get('/', (_req, res) => res.status(503).json({ error: 'console UI assets unavailable' }));
  }

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const safe = projectConsoleFailure(err);
    logger.error({ err: safe.err }, 'console request failed');
    res.status(500).json(safe.response);
  });
  return router;
}
