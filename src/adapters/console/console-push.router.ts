import { Router } from 'express';
import type { WebPushConfig } from '../../config/web-push';
import { parsePushSubscription, pushSubscriptionStorageEnabled, registerPushSubscription, unregisterPushSubscription } from '../push/web-push-repo';

export function buildConsolePushRouter(config: WebPushConfig | null): Router {
  const router = Router();
  router.get('/status', (_req, res) => {
    res.json({ data: {
      configured: config !== null,
      registrationAvailable: config !== null && pushSubscriptionStorageEnabled(),
      publicKey: config?.publicKey ?? null,
    } });
  });

  router.post('/subscription', async (req, res, next) => {
    if (!config || !pushSubscriptionStorageEnabled()) return void res.status(503).json({ error: 'web push unavailable' });
    const subscription = parsePushSubscription(req.body);
    if (!subscription) return void res.status(400).json({ error: 'invalid push subscription' });
    try {
      if (!(await registerPushSubscription(subscription))) return void res.status(409).json({ error: 'browser registration limit reached' });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  router.delete('/subscription', async (req, res, next) => {
    if (!config || !pushSubscriptionStorageEnabled()) return void res.status(503).json({ error: 'web push unavailable' });
    const subscription = parsePushSubscription(req.body);
    if (!subscription) return void res.status(400).json({ error: 'invalid push subscription' });
    try {
      await unregisterPushSubscription(subscription.endpoint);
      res.status(204).end();
    } catch (err) { next(err); }
  });
  return router;
}
