import type { Notification, DecisionEvent } from '../../ports/founder-notifier.port';
import type { NotifierMirror } from '../push/web-push-notifier';
import { parseOptionData } from '../../triage/decision-handler';
import { logger } from '../../logger';
import type { FeedMessage, InsertMessageInput } from './founder-app-repo';
import type { FounderAppFeed } from './founder-app-feed';
import type { FcmSender } from './fcm-sender';

// AppFounderNotifier (M6) — the AO Founder PWA as a second first-class founder surface.
// A mirror of the FounderNotifierPort verbs: it appends the notification/question to the
// app feed (founder_app_messages), announces it to open SSE streams, and fans it out to
// every enabled device as a GENERIC FCM push (all severities, not just urgent).
//
// ── The decision contract ──────────────────────────────────────────────────────────
// notificationRef is NOT minted here or in the Telegram adapter: core callers build each
// button `id` as '<optionId>:<ref>' (e.g. 'x:<taskRef>', 'md30:<meetingId>'), and the
// Telegram adapter copies that verbatim into callback_data, splitting it back with core's
// parseOptionData on a tap. Both surfaces therefore receive the IDENTICAL button ids, so
// the ref is already shared upstream — nothing to lift into the composite.
//
// We store the BARE option id in each button and the shared '<ref>' in notification_ref.
// When the founder taps in the app, the router recombines {notification_ref, optionId}
// into a DecisionEvent that is byte-identical to the one a Telegram tap produces, and
// hands it to dispatchDecision — the SAME handler the callback poller registered.

export interface AppFounderNotifierDeps {
  insertMessage: (input: InsertMessageInput) => Promise<FeedMessage>;
  feed: FounderAppFeed;
  listPushDevices: () => Promise<Array<{ id: string; fcmToken: string | null }>>;
  /** Disable a device whose registration token FCM reports as dead. */
  disableDevicePush: (deviceId: string) => Promise<void>;
  /** null → FCM not configured; storing + SSE still work, only push is skipped. */
  sendPush: FcmSender | null;
  /** First-writer-wins mark of every app row sharing a decision's ref; returns the rows
   *  it actually decided. Shared by both decision surfaces so they can't diverge. */
  markDecidedByRef: (notificationRef: string, optionId: string) => Promise<FeedMessage[]>;
}

/** Split incoming notifier buttons into stored (bare-id) buttons + the shared ref. */
function partitionButtons(
  buttons?: Array<{ id: string; label: string }>,
): { stored: Array<{ id: string; label: string }> | null; notificationRef: string | null } {
  if (!buttons || buttons.length === 0) return { stored: null, notificationRef: null };
  const stored = buttons.map((b) => ({ id: parseOptionData(b.id).optionId, label: b.label }));
  // All buttons on one message share the ref (they concern one entity); take it from the first.
  const notificationRef = parseOptionData(buttons[0].id).notificationRef || null;
  return { stored, notificationRef };
}

export class AppFounderNotifier implements NotifierMirror {
  private decisionHandler: ((d: DecisionEvent) => Promise<void>) | null = null;

  constructor(private readonly deps: AppFounderNotifierDeps) {}

  async notifyAdmin(n: Notification): Promise<void> {
    await this.record({ direction: 'out', kind: 'notification', title: n.title, body: n.body, severity: n.severity ?? null });
  }

  async notifyCustomerEvent(customerId: string, n: Notification, buttons?: Array<{ id: string; label: string }>): Promise<void> {
    const { stored, notificationRef } = partitionButtons(buttons);
    await this.record({
      direction: 'out',
      kind: 'notification',
      title: n.title,
      body: n.body,
      severity: n.severity ?? null,
      customerRef: customerId,
      notificationRef,
      buttons: stored,
    });
  }

  async askFounder(customerId: string, question: Notification, options: Array<{ id: string; label: string }>): Promise<void> {
    const { stored, notificationRef } = partitionButtons(options);
    await this.record({
      direction: 'out',
      kind: 'question',
      title: question.title,
      body: question.body,
      severity: question.severity ?? null,
      customerRef: customerId,
      notificationRef,
      buttons: stored,
    });
  }

  /** Register the shared decision handler (the callback poller's routeDecision). */
  onDecision(handler: (d: DecisionEvent) => Promise<void>): void {
    this.decisionHandler = handler;
  }

  /** Route an app decision tap to the SAME handler a Telegram tap reaches. Returns
   *  false when no handler is registered (the money loop / Telegram is not configured). */
  async dispatchDecision(event: DecisionEvent): Promise<boolean> {
    if (!this.decisionHandler) return false;
    await this.decisionHandler(event);
    return true;
  }

  /**
   * Converge the app feed with a decision that fired on ANY surface: mark every mirrored
   * row sharing the decision's ref as decided (first-writer-wins) and re-emit each over
   * SSE so open clients upsert it (the Attention card drops, the badge decrements). This
   * is the ONE mirror-marking path — the composite decision handler (Telegram poller +
   * app endpoint alike) calls it after the real handler runs, so no surface can record a
   * different option than the one that actually took effect.
   */
  async recordDecision(event: DecisionEvent): Promise<void> {
    const decided = await this.deps.markDecidedByRef(event.notificationRef, event.optionId);
    for (const row of decided) this.deps.feed.publish(row);
  }

  /** Persist, announce, and best-effort push. Storing must not fail on a push error. */
  private async record(input: InsertMessageInput): Promise<FeedMessage> {
    const row = await this.deps.insertMessage(input);
    this.deps.feed.publish(row);
    await this.pushToDevices(row).catch((err) =>
      logger.warn({ reason: (err as Error)?.message }, 'founder-app FCM push failed (best-effort)'),
    );
    return row;
  }

  private async pushToDevices(row: FeedMessage): Promise<void> {
    if (!this.deps.sendPush) return;
    if (row.kind !== 'notification' && row.kind !== 'question') return;
    const devices = (await this.deps.listPushDevices()).filter((d): d is { id: string; fcmToken: string } => Boolean(d.fcmToken));
    if (devices.length === 0) return;
    // Deep-link scheme (v2 cockpit): a customer-scoped notification opens that customer's
    // screen; everything else opens the attention queue. Derived from the stored row so
    // notifyAdmin (no customerRef) and notifyCustomerEvent/askFounder route correctly.
    const route = row.customerRef ? `/app/customer/${row.customerRef}` : '/app/attention';
    const results = await this.deps.sendPush(devices.map((d) => d.fcmToken), {
      messageId: row.id,
      kind: row.kind,
      severity: row.severity,
      ref: row.notificationRef,
      route,
    });
    for (const result of results) {
      if (!result.unregistered) continue;
      const device = devices.find((d) => d.fcmToken === result.token);
      if (device) await this.deps.disableDevicePush(device.id);
    }
  }
}
