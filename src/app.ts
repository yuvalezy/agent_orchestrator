import express, { NextFunction, Request, Response, Router } from 'express';
import helmet from 'helmet';
import { logger } from './logger';
import { getHealth } from './health/health.service';

/** Composition-injected routers (D1) — adapters wire these in src/main.ts. */
export interface AppDeps {
  /** whatsapp_manager webhook receiver (M1.3). Mounted BEFORE express.json() so
   *  its own path-scoped express.raw() wins for HMAC-over-raw-bytes verification. */
  whatsappWebhook?: Router;
}

/**
 * Pure Express factory — no side effects, no listen, no migrations. The
 * composition root (src/main.ts) owns bootstrap. This split keeps the app
 * independently testable (blueprint decision #1).
 */
export function buildApp(deps: AppDeps = {}) {
  const app = express();
  app.use(helmet());

  // Mount raw-body webhook receivers BEFORE the global JSON parser so their
  // path-scoped express.raw() handles the request end-to-end (a matched route
  // responds and the chain ends). Non-webhook paths fall through to express.json()
  // and the malformed-JSON 400 handler below, unchanged from M1.1 (DM3-1).
  if (deps.whatsappWebhook) app.use('/webhooks/whatsapp', deps.whatsappWebhook);

  app.use(express.json({ limit: '256kb' }));

  // Malformed / oversized JSON body → 400. Log ONLY safe request metadata, never
  // the error object: body-parser attaches the raw request body as `err.body`,
  // which pino's default `err` serializer would otherwise copy into the log (a
  // customer-data leak once webhook receivers mount on this app). logger.ts also
  // redacts `*.body` as defense-in-depth. Placed right after express.json() so it
  // catches only parser errors; route errors fall through to the handler below.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    const e = err as { type?: string; status?: number; statusCode?: number };
    if (e?.type === 'entity.parse.failed' || (err instanceof SyntaxError && (e.status ?? e.statusCode))) {
      logger.warn({ path: req.path, method: req.method }, 'Rejected malformed JSON body');
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }
    next(err);
  });

  // Public health check (no auth) — Docker/compose probe.
  // Exposes backlog (inbox + outbound queue) + worker statuses, and degrades to
  // 503 when the DB probe fails, independently of the backlog fields.
  app.get('/health', async (_req, res) => {
    try {
      const report = await getHealth();
      res.status(report.status === 'ok' ? 200 : 503).json(report);
    } catch (err) {
      logger.error({ err }, 'Health check failed');
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });

  app.get('/', (_req, res) => {
    res.json({ service: 'agent-orchestrator', endpoints: ['GET /health'] });
  });

  // 404
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  // Centralized error handler. Project the error to a safe shape before logging —
  // never hand the raw `err` to pino (its default serializer copies every
  // enumerable prop, including any attached request body).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: { name: (err as { name?: string })?.name } }, 'Unhandled route error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
