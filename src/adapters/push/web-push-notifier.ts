import webpush from 'web-push';
import crypto from 'node:crypto';
import type { FounderNotifierPort, Notification, DecisionEvent, MessageEvent } from '../../ports/founder-notifier.port';
import type { WebPushConfig } from '../../config/web-push';
import { activePushSubscriptions, disablePushSubscription, recordPushFailure, type ActivePushSubscription } from './web-push-repo';
import { logger } from '../../logger';

export interface PushMessage { title: 'Founder attention needed'; severity: 'warning'; route: string; tag: string }
export type PushSender = (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<{ statusCode?: number }>;

function safeRoute(value: string | undefined, fallback: string): string {
  if (value?.startsWith('/console/') || value?.startsWith('/console?')) return value;
  return fallback;
}

export function buildPushMessage(notification: Notification, fallback: string): PushMessage | null {
  if (notification.urgency !== 'urgent') return null;
  const route = safeRoute(notification.url, fallback);
  const tag = crypto.createHash('sha256').update(`${notification.entityRef ?? notification.title}|${route}|urgent`).digest('hex').slice(0, 24);
  return { title: 'Founder attention needed', severity: 'warning', route, tag };
}

export class WebPushNotifier {
  private readonly sender: PushSender;
  private recent = new Map<string, number>();

  constructor(
    config: WebPushConfig,
    sender?: PushSender,
    private readonly subscriptions: {
      list: () => Promise<ActivePushSubscription[]>;
      disable: (id: string, reason: 'invalid' | 'gone') => Promise<void>;
      recordFailure: (id: string) => Promise<void>;
    } = { list: activePushSubscriptions, disable: disablePushSubscription, recordFailure: recordPushFailure },
  ) {
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
    this.sender = sender ?? ((subscription, payload) => webpush.sendNotification(subscription, payload));
  }

  async notify(notification: Notification, fallbackRoute: string): Promise<void> {
    const message = buildPushMessage(notification, fallbackRoute);
    if (!message) return;
    const now = Date.now();
    for (const [tag, sentAt] of this.recent) if (sentAt <= now - 60_000) this.recent.delete(tag);
    if ((this.recent.get(message.tag) ?? 0) > now - 60_000) return;
    this.recent.set(message.tag, now);
    for (const subscription of await this.subscriptions.list()) {
      try {
        const response = await this.sender(subscription, JSON.stringify(message));
        if (response.statusCode === 404 || response.statusCode === 410) await this.subscriptions.disable(subscription.id, 'gone');
      } catch (err) {
        const status = (err as { statusCode?: unknown }).statusCode;
        if (status === 404 || status === 410) await this.subscriptions.disable(subscription.id, 'gone');
        else await this.subscriptions.recordFailure(subscription.id);
      }
    }
  }
}

/** Telegram remains first/authoritative; push is an urgent, best-effort side channel. */
export class FanoutFounderNotifier implements FounderNotifierPort {
  constructor(private readonly primary: FounderNotifierPort, private readonly push: WebPushNotifier) {}
  ensureCustomerTopic(customerId: string, name: string): Promise<{ ref: string }> { return this.primary.ensureCustomerTopic(customerId, name); }
  async notifyCustomerEvent(customerId: string, n: Notification, buttons?: Array<{ id: string; label: string }>): Promise<void> {
    await this.primary.notifyCustomerEvent(customerId, n, buttons);
    await this.push.notify(n, `/console/?view=customers&customerId=${encodeURIComponent(customerId)}`).catch(() => logger.warn('web push delivery failed after customer notification'));
  }
  async notifyAdmin(n: Notification): Promise<void> {
    await this.primary.notifyAdmin(n);
    await this.push.notify(n, '/console/?view=workers').catch(() => logger.warn('web push delivery failed after admin notification'));
  }
  askFounder(customerId: string, question: Notification, options: Array<{ id: string; label: string }>): Promise<void> { return this.primary.askFounder(customerId, question, options); }
  onDecision(handler: (d: DecisionEvent) => Promise<void>): void { this.primary.onDecision(handler); }
  onMessage(handler: (m: MessageEvent) => Promise<void>): void { this.primary.onMessage?.(handler); }
}
