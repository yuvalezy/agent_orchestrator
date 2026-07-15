import { DateTime } from 'luxon';
import { logger } from '../../logger';
import type { WorkerDefinition } from '../../workers/worker-runner';
import type { FounderNotifierPort, Notification } from '../../ports/founder-notifier.port';
import type { OutboundMessage } from '../../ports/channel.port';
import type { ChannelRegistry } from '../channel-registry';
import { computeSendWindow, type BusinessHour, type Holiday } from '../../outbound/send-window';
import { OutboundSendError } from '../../outbound/send-error';
import * as outboundRepo from '../../outbound/outbound-repo';
import type { ClaimedOutbound } from '../../outbound/outbound-repo';

// Outbound drainer worker (M1.8). Composition/adapter layer: it resolves the send
// adapter from the registry and dispatches approved rows, gated by the failure
// circuit-breaker → business-hours/holiday window → per-recipient rate limit
// (mermaid in the blueprint §3). Every deferral is deferUntil-FIRST-then-notify
// (D-E) so a crash parks the row instead of stranding a 'sending'. Logs ONLY
// { worker, id, status } metadata — NEVER a message body.

const NAME = 'outbound:drainer';
const CLAIM_BATCH = 25;
const MAX_SEND_ATTEMPTS = 3; // per-row retry cap (spec: "up to 3 attempts")
const RETRY_BASE_BACKOFF_MS = 60_000; // exponential: base × 2^retry_count
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The outbound-repo surface the drainer depends on (injectable for tests). */
export interface OutboundRepo {
  reclaimStuck(stuckMinutes: number): Promise<string[]>;
  claimDue(limit: number, channelTypes: string[]): Promise<ClaimedOutbound[]>;
  markSent(id: string, providerMessageId: string): Promise<void>;
  retryLater(id: string, err: string, maxAttempts: number, backoffMs: number): Promise<{ failed: boolean }>;
  deferUntil(id: string, sendAfter: Date): Promise<void>;
  failReview(id: string, reason: string, opts?: { possiblyDelivered?: boolean }): Promise<void>;
  countSentSince(instanceId: string, recipient: string, sinceIso: string): Promise<number>;
  oldestSentSince(instanceId: string, recipient: string, sinceIso: string): Promise<Date | null>;
  lastSentAt(instanceId: string, recipient: string): Promise<Date | null>;
  failuresSince(instanceId: string, recipient: string, sinceIso: string): Promise<number>;
  loadBusinessHours(): Promise<BusinessHour[]>;
  loadHolidays(sinceIso: string, untilIso: string): Promise<Holiday[]>;
}

export interface OutboundDrainerConfig {
  registry: Pick<ChannelRegistry, 'get'>;
  notifier: FounderNotifierPort;
  intervalMs: number;
  ratePerHour: number;
  minGapMs: number;
  maxRecipientFailures: number;
  failureWindowMin: number;
  defaultTz: string;
  stuckMinutes: number;
  /** M2(d) kill-switch (OUTBOUND_EMAIL_ENABLED, default false). When false the claim
   *  stays WhatsApp-only (M1.8 behaviour, byte-identical); when true, email rows are
   *  ALSO claimed + routed to the Gmail adapter. Dormant until flipped. */
  emailEnabled?: boolean;
  /** Defaults to the real outbound-repo module; overridden in tests. */
  repo?: OutboundRepo;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function buildOutboundDrainerWorker(cfg: OutboundDrainerConfig): WorkerDefinition {
  const repo: OutboundRepo = cfg.repo ?? outboundRepo;
  const { registry, notifier } = cfg;

  // The channels this drainer is allowed to CLAIM. WhatsApp is always armed (M1.8);
  // email is armed only behind OUTBOUND_EMAIL_ENABLED (M2(d), default off). A row on
  // any other/unflagged channel is never claimed → nothing sends by surprise.
  const claimChannelTypes: string[] = ['whatsapp', ...(cfg.emailEnabled ? ['email'] : [])];

  const alertAdmin = (body: string, severity: Notification['severity'] = 'warning'): Promise<void> =>
    notifier
      .notifyAdmin({ title: 'Outbound', body, severity })
      .catch((err) => logger.error({ worker: NAME, reason: (err as Error)?.message }, 'outbound: admin alert failed'));

  const note = async (row: ClaimedOutbound, n: Notification): Promise<void> => {
    const p = row.customer_id ? notifier.notifyCustomerEvent(row.customer_id, n) : notifier.notifyAdmin(n);
    await p.catch((err) => logger.error({ worker: NAME, id: row.id, reason: (err as Error)?.message }, 'outbound: note failed'));
  };

  async function classify(row: ClaimedOutbound, err: unknown): Promise<void> {
    let retriable = false;
    let possiblyDelivered = true; // conservative default for an unclassified throw
    let reason = 'unknown send error';
    if (err instanceof OutboundSendError) {
      retriable = err.retriable;
      possiblyDelivered = err.possiblyDelivered;
      reason = err.reason;
    } else if (err instanceof Error) {
      reason = err.name; // metadata only (never a body)
    }

    if (possiblyDelivered) {
      await repo.failReview(row.id, reason, { possiblyDelivered: true });
      logger.info({ worker: NAME, id: row.id, status: 'failReview' }, 'outbound: possibly-delivered failure (no resend)');
      await alertAdmin(`#${row.id} to ${row.recipient_address} FAILED (possibly delivered — no auto-resend): ${reason}. Manual review needed.`);
    } else if (retriable) {
      const backoff = RETRY_BASE_BACKOFF_MS * 2 ** Math.min(row.retry_count, 6);
      const { failed } = await repo.retryLater(row.id, reason, MAX_SEND_ATTEMPTS, backoff);
      logger.info({ worker: NAME, id: row.id, status: failed ? 'failed' : 'retry' }, 'outbound: transient failure');
      if (failed) await alertAdmin(`#${row.id} to ${row.recipient_address} FAILED after ${MAX_SEND_ATTEMPTS} attempts: ${reason}.`);
    } else {
      // Permanent, definitely-not-delivered (400/403) → counts toward the breaker.
      await repo.failReview(row.id, reason, { possiblyDelivered: false });
      logger.info({ worker: NAME, id: row.id, status: 'failReview' }, 'outbound: permanent rejection');
      await alertAdmin(`#${row.id} to ${row.recipient_address} permanently rejected: ${reason}.`);
    }
  }

  async function processRow(row: ClaimedOutbound, businessHours: BusinessHour[], holidays: Holiday[], alertedPauses: Set<string>): Promise<void> {
    // (a) send-capable adapter?
    const reg = registry.get(row.channel_instance_id);
    const adapter = reg?.adapter;
    if (!adapter || !adapter.capabilities.canSend) {
      await repo.failReview(row.id, 'no send-capable adapter for instance');
      logger.info({ worker: NAME, id: row.id, status: 'failReview' }, 'outbound: no send-capable adapter');
      await alertAdmin(`#${row.id} to ${row.recipient_address}: no send-capable adapter for its instance — needs review.`);
      return;
    }

    // (a2) ACCOUNT-ISOLATION guard. A reply MUST leave on the SAME instance it arrived
    // on — a work-account thread can never egress a personal account (and vice-versa),
    // nor an email row through a WhatsApp adapter. registry.get(id) returns the adapter
    // bound to THAT instance, so this defends against a registry mis-wire: if the
    // resolved adapter's instance id / channel_type disagrees with the row, we refuse
    // to send (failReview) rather than cross-contaminate. NEVER logs addresses/bodies.
    const inst = adapter.instance;
    if (inst.id !== row.channel_instance_id || inst.channelType !== row.channel_type) {
      await repo.failReview(row.id, 'account-isolation mismatch: resolved adapter instance/channel differs from row');
      logger.error(
        { worker: NAME, id: row.id, status: 'failReview', rowInstance: row.channel_instance_id, rowChannel: row.channel_type, adapterInstance: inst.id, adapterChannel: inst.channelType },
        'outbound: account-isolation mismatch — refusing to send',
      );
      await alertAdmin(`#${row.id}: account-isolation mismatch (row instance ${row.channel_instance_id}/${row.channel_type} ≠ adapter ${inst.id}/${inst.channelType}) — refused, needs review.`);
      return;
    }

    const now = Date.now();

    // (b) failure circuit-breaker (D-L, spec:13) — pause a recipient after N recent failures.
    const failSince = new Date(now - cfg.failureWindowMin * 60_000).toISOString();
    const failures = await repo.failuresSince(row.channel_instance_id, row.recipient_address, failSince);
    if (failures >= cfg.maxRecipientFailures) {
      await repo.deferUntil(row.id, new Date(now + cfg.failureWindowMin * 60_000)); // defer FIRST
      logger.info({ worker: NAME, id: row.id, status: 'paused' }, 'outbound: recipient paused (failure breaker)');
      // Alert ONCE per recipient per tick — N queued rows to one paused recipient
      // must not fan out to N identical alerts (F2).
      const pauseKey = `${row.channel_instance_id}|${row.recipient_address}`;
      if (!alertedPauses.has(pauseKey)) {
        alertedPauses.add(pauseKey);
        await alertAdmin(`Sends to ${row.recipient_address} paused after ${failures} failures (auto-resumes in ~${cfg.failureWindowMin}m).`);
      }
      return;
    }

    // (c) business-hours / holiday window (D-D/E). An explicitly scheduled founder
    // command carries a narrow override; every other guard remains active.
    if (!row.bypass_send_window) {
      const tz = row.timezone ?? cfg.defaultTz;
      const faith = row.customer_id ? row.faith : 'none';
      const win = computeSendWindow({ nowUtc: new Date(now), tz, businessHours, holidays, faith });
      if (!win.allowed) {
        const until = win.nextOpenUtc ?? new Date(now + DAY_MS);
        await repo.deferUntil(row.id, until); // defer FIRST (D-E), then notify once
        logger.info({ worker: NAME, id: row.id, status: 'deferred' }, 'outbound: outside send window');
        if (!win.nextOpenUtc) {
          await alertAdmin(`#${row.id} to ${row.recipient_address}: no open window within 14 days — deferred 24h.`);
        }
        const whenLocal = DateTime.fromJSDate(until, { zone: tz }).toFormat('ccc dd LLL HH:mm');
        await note(row, { title: 'Message queued', body: `Queued until ${whenLocal} (${win.reason}).`, severity: 'info' });
        return;
      }
    }

    // (d) per-recipient rate limit (D-F) — internal pacing, NO notify.
    const hourSince = new Date(now - HOUR_MS).toISOString();
    const sentInHour = await repo.countSentSince(row.channel_instance_id, row.recipient_address, hourSince);
    if (sentInHour >= cfg.ratePerHour) {
      const oldest = await repo.oldestSentSince(row.channel_instance_id, row.recipient_address, hourSince);
      const base = oldest ?? new Date(now);
      await repo.deferUntil(row.id, new Date(base.getTime() + HOUR_MS));
      logger.info({ worker: NAME, id: row.id, status: 'rate_deferred' }, 'outbound: hourly cap reached');
      return;
    }
    const last = await repo.lastSentAt(row.channel_instance_id, row.recipient_address);
    if (last && now - last.getTime() < cfg.minGapMs) {
      await repo.deferUntil(row.id, new Date(last.getTime() + cfg.minGapMs));
      logger.info({ worker: NAME, id: row.id, status: 'gap_deferred' }, 'outbound: min-gap not elapsed');
      return;
    }

    // (e) dispatch. isGroup from the joined contact row (R37); threadKey/subject/inReplyTo
    // from the row; attachment_ref (JSONB) → media reference resolved by the adapter (M2 B).
    const msg: OutboundMessage = {
      instanceId: row.channel_instance_id,
      recipientAddress: row.recipient_address,
      threadKey: row.thread_key ?? undefined,
      inReplyTo: row.in_reply_to ?? undefined,
      subject: row.subject ?? undefined,
      body: row.body,
      attachment: row.attachment_ref ?? undefined,
      isGroup: row.is_group ?? false,
    };
    try {
      const { providerMessageId } = await adapter.send(msg);
      await repo.markSent(row.id, providerMessageId);
      logger.info({ worker: NAME, id: row.id, status: 'sent' }, 'outbound: sent');
    } catch (err) {
      await classify(row, err);
    }
  }

  return {
    name: NAME,
    intervalMs: cfg.intervalMs,
    run: async () => {
      // Reclaim stuck 'sending' rows first (possibly delivered → failReview + ONE alert).
      const stuck = await repo.reclaimStuck(cfg.stuckMinutes);
      if (stuck.length) {
        logger.info({ worker: NAME, count: stuck.length, status: 'reclaimed' }, 'outbound: stuck sends reclaimed');
        await alertAdmin(`${stuck.length} outbound row(s) stuck in 'sending' beyond ${cfg.stuckMinutes}m → marked failed for manual review (possibly delivered).`);
      }

      const rows = await repo.claimDue(CLAIM_BATCH, claimChannelTypes);
      if (!rows.length) return;

      // Load the gating config ONCE per tick (global in Phase 1).
      const businessHours = await repo.loadBusinessHours();
      const nowMs = Date.now();
      const holidays = await repo.loadHolidays(isoDate(nowMs - DAY_MS), isoDate(nowMs + 15 * DAY_MS));

      const alertedPauses = new Set<string>(); // dedupe breaker alerts within this tick (F2)
      for (const row of rows) {
        try {
          await processRow(row, businessHours, holidays, alertedPauses);
        } catch (err) {
          // A DB/unexpected error leaves the row 'sending' → reclaimStuck handles it
          // by age (never a resend). One bad row can't block the batch.
          logger.error({ worker: NAME, id: row.id, reason: (err as Error)?.message }, 'outbound: row failed — will be reclaimed');
        }
      }
    },
  };
}
