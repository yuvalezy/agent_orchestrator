import express, { Router } from 'express';
import { logger } from '../../logger';
import type { InboundMessage } from '../../ports/channel.port';
import { WebhookAuthError, type WhatsAppManagerAdapter } from './whatsapp-manager.adapter';

/**
 * Express router for the whatsapp_manager webhook push (tasks.md 3.2).
 *
 * The raw parser is PATH-SCOPED to this router (mounted at /webhooks/whatsapp) so
 * it never touches the global express.json() / 400-handler that M1.1 installed
 * for every other route (DM3-1, DA non-blocking #1). HMAC is verified over the
 * exact request bytes; a bad/missing signature → 401 and no DB write.
 *
 * On a write failure we answer 500 (whatsapp_manager is fire-and-forget and won't
 * retry) — the pull() reconciliation is the safety net that re-ingests the row.
 * We never log the message body.
 */
export function buildWhatsAppWebhookRouter(
  adapter: WhatsAppManagerAdapter,
  sink: (msg: InboundMessage) => Promise<unknown>,
): Router {
  const router = Router();

  router.post(
    '/',
    express.raw({ type: '*/*', limit: '512kb' }),
    async (req, res) => {
      const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      let msg: InboundMessage;
      try {
        msg = adapter.parseWebhook(rawBody, req.header('X-Signature'));
      } catch (err) {
        if (err instanceof WebhookAuthError) {
          logger.warn({ path: req.path }, 'whatsapp webhook: rejected (bad signature)');
          res.status(401).json({ error: 'invalid signature' });
          return;
        }
        // Malformed JSON after a valid signature — 400, do not retry-storm.
        logger.warn({ path: req.path }, 'whatsapp webhook: unparseable body');
        res.status(400).json({ error: 'invalid body' });
        return;
      }

      try {
        await sink(msg);
        res.status(200).json({ ok: true });
      } catch (err) {
        // Metadata only — the pull reconciliation will recover this row.
        logger.error(
          { providerMessageId: msg.providerMessageId, reason: (err as Error)?.message },
          'whatsapp webhook: ingest failed (pull will recover)',
        );
        res.status(500).json({ error: 'ingest failed' });
      }
    },
  );

  return router;
}
