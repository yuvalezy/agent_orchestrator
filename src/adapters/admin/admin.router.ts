import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { logger } from '../../logger';
import { credentialsStore } from '../../config/credentials-store';
import { enqueueOutbound } from '../../outbound/outbound-repo';
import type { OutboundAttachmentRef } from '../../ports/channel.port';
import type { ChannelRegistry } from '../channel-registry';

// Admin API for provider-key management (DM4-8). Mounted ONLY when ADMIN_API_KEY
// is set (fail-closed — main.ts logs when it is not). Guarded by an x-admin-key
// header (constant-time compare, length-guarded first — same footgun as the M1.3
// signature). Secret VALUES are never returned or logged — only `last4`.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false; // length guard: timingSafeEqual throws on mismatch
  return crypto.timingSafeEqual(ab, bb);
}

/** The registry surface the /outbound seam needs (resolve an instance to enqueue against). */
type OutboundRegistry = Pick<ChannelRegistry, 'get' | 'whatsappPrimary'>;

/** Build the admin router. `adminKey` is resolved eagerly by the caller (main.ts).
 *  `registry` backs the M1.8 /outbound enqueue seam (instance resolution). */
export function buildAdminRouter(adminKey: string, registry: OutboundRegistry): Router {
  const router = Router();

  router.use((req: Request, res: Response, next: NextFunction) => {
    const provided = req.header('x-admin-key');
    if (!provided || !constantTimeEqual(provided, adminKey)) {
      logger.warn({ path: req.path }, 'admin: rejected (bad x-admin-key)');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  // Set / rotate a credential. The value is stored sealed; response shows last4 only.
  router.post('/credentials', async (req: Request, res: Response) => {
    const { name, value } = (req.body ?? {}) as { name?: unknown; value?: unknown };
    if (typeof name !== 'string' || !name.trim() || typeof value !== 'string' || !value) {
      res.status(400).json({ error: '"name" and "value" (non-empty strings) are required' });
      return;
    }
    try {
      const summary = await credentialsStore.set(name.trim(), value);
      res.status(200).json({ data: summary }); // {name,last4,updated_at} — never the value
    } catch (err) {
      logger.error({ reason: (err as Error)?.message }, 'admin: credential set failed');
      res.status(503).json({ error: 'credentials store unavailable (CREDENTIALS_ENCRYPTION_KEY unset?)' });
    }
  });

  router.get('/credentials', async (_req: Request, res: Response) => {
    res.json({ data: await credentialsStore.list() }); // last4 only
  });

  router.delete('/credentials/:name', async (req: Request, res: Response) => {
    const removed = await credentialsStore.remove(String(req.params.name));
    res.status(removed ? 200 : 404).json({ data: { removed } });
  });

  // Enqueue an outbound message (M1.8 seam; change 02's approve-flow reuses this).
  // Thin: validate → resolve instance → core enqueueOutbound (which normalizes the
  // recipient so the drainer's group join hits — F2). Validation returns 400/503,
  // never a 500 from an FK violation (F10). The `isGroup` field is accepted for
  // forward-compat; in M1.8 group routing is driven by the agent_customer_contacts
  // join (R37) — a per-message group flag needs a queue column (deferred).
  // M2 Milestone B: also accepts `inReplyTo` (quoted reply) and `attachment`
  // (media reference) — `body` becomes an optional caption when `attachment` is set.
  router.post('/outbound', async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const recipient = b.recipient;
    if (typeof recipient !== 'string' || !recipient.trim()) {
      res.status(400).json({ error: '"recipient" (non-empty string) is required' });
      return;
    }
    // body is optional when an attachment is present (caption-less media send); when
    // provided it must be a string (may be '' as an empty caption).
    if (b.body !== undefined && typeof b.body !== 'string') {
      res.status(400).json({ error: '"body" must be a string when provided' });
      return;
    }
    if (b.isGroup !== undefined && typeof b.isGroup !== 'boolean') {
      res.status(400).json({ error: '"isGroup" must be a boolean when provided' });
      return;
    }
    // Optional media reference (M2 Milestone B, F11): require NON-EMPTY source+ref and
    // string mimeType/filename when present, BEFORE relaxing the body rule — so a
    // {source:'x',ref:''}+empty-body request can't enqueue a guaranteed-fail junk row.
    let attachmentRef: OutboundAttachmentRef | null = null;
    if (b.attachment !== undefined) {
      const a = b.attachment as Record<string, unknown>;
      if (
        typeof a !== 'object' ||
        a === null ||
        Array.isArray(a) ||
        typeof a.source !== 'string' ||
        !a.source.trim() ||
        typeof a.ref !== 'string' ||
        !a.ref.trim() ||
        (a.mimeType !== undefined && typeof a.mimeType !== 'string') ||
        (a.filename !== undefined && typeof a.filename !== 'string')
      ) {
        res.status(400).json({ error: '"attachment" must be { source, ref (non-empty strings), mimeType?, filename? }' });
        return;
      }
      attachmentRef = {
        source: a.source,
        ref: a.ref,
        mimeType: a.mimeType as string | undefined,
        filename: a.filename as string | undefined,
      };
    }
    const bodyStr = typeof b.body === 'string' ? b.body : '';
    if (!bodyStr.trim() && !attachmentRef) {
      res.status(400).json({ error: 'one of "body" (non-empty) or "attachment" is required' });
      return;
    }

    let instanceId: string;
    let channelType: string;
    if (typeof b.instanceId === 'string' && b.instanceId.trim()) {
      const reg = registry.get(b.instanceId);
      if (!reg) {
        res.status(400).json({ error: 'unknown instanceId' });
        return;
      }
      instanceId = reg.instance.id;
      channelType = reg.instance.channelType;
    } else if (b.channel === 'whatsapp') {
      const wa = registry.whatsappPrimary();
      if (!wa) {
        res.status(503).json({ error: 'no ready whatsapp instance' });
        return;
      }
      instanceId = wa.instance.id;
      channelType = wa.instance.channelType;
    } else {
      res.status(400).json({ error: 'provide "instanceId" or channel:"whatsapp"' });
      return;
    }

    // M1.8 delivers WhatsApp only — reject other channels rather than enqueue a row
    // the WhatsApp-only drainer claim will never pick up (a silent dead-letter). F6.
    if (channelType !== 'whatsapp') {
      res.status(400).json({ error: `M1.8 supports WhatsApp outbound only (instance channel is "${channelType}")` });
      return;
    }

    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
    const customerId = str(b.customerId);
    if (customerId && !UUID_RE.test(customerId)) {
      res.status(400).json({ error: '"customerId" must be a UUID when provided' });
      return;
    }
    try {
      const id = await enqueueOutbound({
        channelInstanceId: instanceId,
        channelType,
        recipientAddress: recipient,
        body: bodyStr,
        threadKey: str(b.threadKey),
        subject: str(b.subject),
        inReplyTo: str(b.inReplyTo),
        attachmentRef,
        customerId,
      });
      logger.info({ instanceId, channelType, outboundId: id }, 'admin: outbound enqueued');
      res.status(201).json({ data: { id } });
    } catch (err) {
      // A well-formed but unknown customerId trips the FK (23503); an unparseable
      // value trips 22P02. Both are caller errors → 400, never a 500 (F3/F10).
      const code = (err as { code?: string })?.code;
      if (code === '23503' || code === '22P02') {
        res.status(400).json({ error: 'unknown or invalid customerId' });
        return;
      }
      logger.error({ instanceId, reason: (err as Error)?.message }, 'admin: outbound enqueue failed');
      res.status(500).json({ error: 'enqueue failed' });
    }
  });

  return router;
}
