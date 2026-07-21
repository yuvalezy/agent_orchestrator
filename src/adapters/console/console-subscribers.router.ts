import { Router, type Response } from 'express';
import {
  getFounderAppDeviceState,
  listAllFounderAppDevices,
  revokeDeviceById,
  unregisterDevicePush,
} from '../founder-app/founder-app-repo';
import {
  disablePushSubscription,
  getPushSubscriptionState,
  listAllPushSubscriptions,
} from '../push/web-push-repo';
import { auditApproval } from './console-approvals-repo';
import type { ConsoleAuditContext } from './console-repo';

// Founder-console subscribers surface: list + revoke the AO Founder PWA phone
// devices and the console browser web-push subs. Mounted under /console/api/subscribers
// by the parent console router — so it inherits session-auth + CSRF + audit-context +
// no-store. Each mutation reuses the existing core repo fns (no new SQL write paths)
// and records a content-free audit row via the shared auditApproval helper.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validId = (v: string): boolean => /^\d+$/.test(v) && Number(v) > 0;
const auditCtx = (res: Response): ConsoleAuditContext => res.locals.consoleAuditContext as ConsoleAuditContext;

export function buildConsoleSubscribersRouter(): Router {
  const router = Router();

  router.get('/devices', async (_req, res, next) => {
    try {
      res.json({ data: await listAllFounderAppDevices() });
    } catch (err) { next(err); }
  });

  router.get('/browsers', async (_req, res, next) => {
    try {
      res.json({ data: await listAllPushSubscriptions() });
    } catch (err) { next(err); }
  });

  router.post('/devices/:id/disable-push', async (req, res, next) => {
    if (!UUID_RE.test(req.params.id)) return void res.status(400).json({ error: 'invalid id' });
    try {
      const before = await getFounderAppDeviceState(req.params.id);
      if (!before) return void res.status(404).json({ error: 'not found' });
      await unregisterDevicePush(req.params.id);
      await auditApproval(auditCtx(res), 'push.disable', 'founder_app_device', req.params.id, before.pushEnabled ? 'active' : 'push-off', 'push-off');
      res.status(200).json({ data: { id: req.params.id, pushEnabled: false } });
    } catch (err) { next(err); }
  });

  router.post('/devices/:id/revoke', async (req, res, next) => {
    if (!UUID_RE.test(req.params.id)) return void res.status(400).json({ error: 'invalid id' });
    try {
      const before = await getFounderAppDeviceState(req.params.id);
      if (!before) return void res.status(404).json({ error: 'not found' });
      const revokedAt = await revokeDeviceById(req.params.id);
      if (!revokedAt) return void res.status(404).json({ error: 'not found' });
      await auditApproval(auditCtx(res), 'push.revoke', 'founder_app_device', req.params.id, before.revokedAt ? 'revoked' : 'active', 'revoked');
      res.status(200).json({ data: { id: req.params.id, revokedAt } });
    } catch (err) { next(err); }
  });

  router.post('/browsers/:id/remove', async (req, res, next) => {
    if (!validId(req.params.id)) return void res.status(400).json({ error: 'invalid id' });
    try {
      const before = await getPushSubscriptionState(req.params.id);
      if (!before) return void res.status(404).json({ error: 'not found' });
      let disabledAt = before.disabledAt;
      if (!disabledAt) {
        await disablePushSubscription(req.params.id, 'gone');
        const after = await getPushSubscriptionState(req.params.id);
        disabledAt = after?.disabledAt ?? new Date().toISOString();
      }
      await auditApproval(auditCtx(res), 'push.remove', 'founder_push_subscription', req.params.id, before.disabledAt ? 'removed' : 'active', 'removed');
      res.status(200).json({ data: { id: req.params.id, disabledAt } });
    } catch (err) { next(err); }
  });

  return router;
}
