import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ConsoleConfig } from '../../config/console';
import { getHealth } from '../../health/health.service';
import { logger } from '../../logger';
import { cancelOutbound, decisionDetail, inboxDetail, listDecisions, listInbox, listOutbound, outboundDetail, requeueInbox } from './console-repo';
import { ConsoleSessionStore } from './console-session';

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

  router.use('/api', (req, res, next) => {
    const session = sessions.get(req);
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.locals.consoleSession = session;
    next();
  });

  router.get('/api/session', (_req, res) => {
    const session = res.locals.consoleSession as { csrfToken: string; expiresAt: number };
    res.json({ data: { csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() } });
  });

  router.get('/api/overview', async (_req, res, next) => {
    try {
      res.json({ data: await getHealth() });
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
        res.status(400).json({ error: 'invalid cursor' });
        return;
      }
      res.json(page);
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
      res.json({ data });
    } catch (err) {
      next(err);
    }
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
      const result = await requeueInbox(req.params.id);
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
      const result = await cancelOutbound(req.params.id);
      if (result === 'not_found') return void res.status(404).json({ error: 'not found' });
      if (result === 'conflict') return void res.status(409).json({ error: 'state changed; refresh and review' });
      res.status(200).json({ data: { id: req.params.id, status: 'cancelled' } });
    } catch (err) {
      next(err);
    }
  });

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
    logger.error({ err: { name: (err as { name?: string } | undefined)?.name } }, 'console request failed');
    res.status(500).json({ error: 'console request failed' });
  });
  return router;
}
