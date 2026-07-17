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

/**
 * A secondary founder surface fanned out ALONGSIDE the primary (Telegram). Each mirror
 * receives the same notifications/questions and the same decision handler, so a tap on
 * any surface routes to the one registered handler. Mirrors are best-effort: a throw is
 * caught by the fanout and never blocks the primary or the other mirrors.
 *
 * Only the four founder-facing verbs are mirrored — ensureCustomerTopic and onMessage
 * stay Telegram-only (a mirror owns no topics and captures no free-text replies).
 */
export interface NotifierMirror {
  notifyCustomerEvent(customerId: string, n: Notification, buttons?: Array<{ id: string; label: string }>): Promise<void>;
  notifyAdmin(n: Notification): Promise<void>;
  askFounder(customerId: string, question: Notification, options: Array<{ id: string; label: string }>): Promise<void>;
  onDecision(handler: (d: DecisionEvent) => Promise<void>): void;
}

/** Wraps the urgent web-push channel as a mirror. Behavior is unchanged from the old
 *  inlined fanout: notifyAdmin/notifyCustomerEvent route to push (urgency-gated inside
 *  WebPushNotifier); askFounder and decisions are not a web-push concern. */
export class WebPushMirror implements NotifierMirror {
  constructor(private readonly push: WebPushNotifier) {}
  notifyCustomerEvent(customerId: string, n: Notification): Promise<void> {
    return this.push.notify(n, `/console/?view=customers&customerId=${encodeURIComponent(customerId)}`);
  }
  notifyAdmin(n: Notification): Promise<void> {
    return this.push.notify(n, '/console/?view=workers');
  }
  async askFounder(): Promise<void> {}
  onDecision(): void {}
}

/**
 * A stand-in PRIMARY for a Telegram-less money loop. Every founder-facing verb is a
 * no-op, so `new FanoutFounderNotifier(new HeadlessPrimaryNotifier(), [appNotifier, …])`
 * delivers PURELY through its mirrors (the AO Founder app, urgent web-push) while the
 * fanout's primary-first contract stays intact — the primary simply does nothing before
 * each mirror runs, so the observable mirror behavior is byte-identical to a real primary
 * whose verbs happen to succeed silently.
 *
 * Semantics of the two Telegram-only concepts in a mirror-only world:
 *  - ensureCustomerTopic returns a SYNTHETIC ref (`headless:<customerId>`): a mirror owns no
 *    forum topic, so there is nothing to create or claim — the ref only satisfies the port.
 *  - onMessage / onDecision are no-ops here: free-text capture and inbound taps arrive on the
 *    mirrors themselves (the app router dispatches its own taps), never through this primary.
 */
export class HeadlessPrimaryNotifier implements FounderNotifierPort {
  async ensureCustomerTopic(customerId: string): Promise<{ ref: string }> { return { ref: `headless:${customerId}` }; }
  async notifyCustomerEvent(): Promise<void> {}
  async notifyAdmin(): Promise<void> {}
  async askFounder(): Promise<void> {}
  onDecision(): void {}
  onMessage(): void {}
}

/** Telegram (or a HeadlessPrimaryNotifier stand-in) remains first/authoritative; every mirror is a best-effort side channel. */
export class FanoutFounderNotifier implements FounderNotifierPort {
  constructor(private readonly primary: FounderNotifierPort, private readonly mirrors: NotifierMirror[]) {}
  ensureCustomerTopic(customerId: string, name: string): Promise<{ ref: string }> { return this.primary.ensureCustomerTopic(customerId, name); }
  async notifyCustomerEvent(customerId: string, n: Notification, buttons?: Array<{ id: string; label: string }>): Promise<void> {
    await this.primary.notifyCustomerEvent(customerId, n, buttons);
    for (const mirror of this.mirrors) {
      await mirror.notifyCustomerEvent(customerId, n, buttons).catch(() => logger.warn('mirror delivery failed after customer notification'));
    }
  }
  async notifyAdmin(n: Notification): Promise<void> {
    await this.primary.notifyAdmin(n);
    for (const mirror of this.mirrors) {
      await mirror.notifyAdmin(n).catch(() => logger.warn('mirror delivery failed after admin notification'));
    }
  }
  async askFounder(customerId: string, question: Notification, options: Array<{ id: string; label: string }>): Promise<void> {
    await this.primary.askFounder(customerId, question, options);
    for (const mirror of this.mirrors) {
      await mirror.askFounder(customerId, question, options).catch(() => logger.warn('mirror delivery failed after founder question'));
    }
  }
  onDecision(handler: (d: DecisionEvent) => Promise<void>): void {
    this.primary.onDecision(handler);
    for (const mirror of this.mirrors) mirror.onDecision(handler);
  }
  onMessage(handler: (m: MessageEvent) => Promise<void>): void { this.primary.onMessage?.(handler); }
}
