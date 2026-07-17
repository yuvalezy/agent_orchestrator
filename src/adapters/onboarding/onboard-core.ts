import { logger } from '../../logger';
import { buildEzyPortalGateway } from '../ezy-portal/factory';
import { buildWhatsAppDirectoryClient } from '../whatsapp-manager/factory';
import { buildTelegramNotifier } from '../telegram/factory';
import {
  deriveEmailDomain,
  upsertCustomer,
  importContact,
  claimTelegramTopic,
  normalizeEmailAddress,
  normalizeWhatsappAddress,
  welcomeNotification,
} from '../../customers';

// Core onboarding composition (blueprint §3), extracted from scripts/onboard-customer.ts so BOTH
// the CLI (`npm run onboard`) and the console onboarding screen run the IDENTICAL sequence: EZY
// reads → work-item-type membership check → upsertCustomer → import BP + WhatsApp contacts → claim
// the Telegram topic. Idempotent on bp_ref; re-running refreshes fields and skips Telegram once a
// topic exists. This is an ADAPTER composition (it wires gateways + notifier to the pure
// src/customers core) — the same role scripts/onboard-customer.ts played, now importable by both.
//
// The memory SEED (cutoff, WA history, inventory, dry sweep) is deliberately NOT here — see
// backfill-seed.ts. The CLI keeps owning argument parsing, docs-root pre-flight, and the seed.

export interface OnboardCoreInput {
  bpRef: string;
  projectRef: string;
  /** When absent, auto-picked only if the project type has exactly one work item type. */
  workItemTypeRef?: string;
}

export interface OnboardCoreResult {
  customerId: string;
  created: boolean;
  displayName: string;
  workItemTypeRef: string;
  bpContactsImported: number;
  waContactsImported: number;
  /** whatsapp_manager directory import skipped (reachability/auth) — the rest still committed. */
  waBlocked: boolean;
  /** The topic id BEFORE this run (null → a fresh topic was created + a welcome sent). */
  telegramTopicId: string | null;
}

export interface OnboardCoreDeps {
  ezy: Pick<ReturnType<typeof buildEzyPortalGateway>, 'getCustomer' | 'listContacts' | 'listWorkItemTypes'>;
  wa: Pick<ReturnType<typeof buildWhatsAppDirectoryClient>, 'listWhitelist' | 'listGroups'>;
  notifier: Pick<ReturnType<typeof buildTelegramNotifier>, 'ensureCustomerTopic' | 'notifyCustomerEvent'>;
}

export function defaultOnboardCoreDeps(): OnboardCoreDeps {
  return {
    ezy: buildEzyPortalGateway(),
    wa: buildWhatsAppDirectoryClient(),
    notifier: buildTelegramNotifier(),
  };
}

/** A bad/ambiguous work-item-type ref — founder input, surfaced to the caller (CLI throws to
 *  stderr; console maps it to a 422 with the list of valid options). */
export class WorkItemTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkItemTypeError';
  }
}

export async function onboardCustomerCore(
  input: OnboardCoreInput,
  deps: OnboardCoreDeps = defaultOnboardCoreDeps(),
): Promise<OnboardCoreResult> {
  const { ezy, wa, notifier } = deps;

  // ── EZY reads ──────────────────────────────────────────────────────────────
  const customer = await ezy.getCustomer(input.bpRef);
  const contacts = await ezy.listContacts(input.bpRef);
  const workItemTypes = await ezy.listWorkItemTypes(input.projectRef); // proves the 2-hop

  // Enforce work-item-type membership BEFORE writing (blueprint §3 / DA flag 3): the ref must
  // belong to this project's project type, else task-create 422s at M1.5a. Auto-pick only when
  // the project type has exactly one type.
  let workItemTypeRef: string;
  if (input.workItemTypeRef) {
    if (!workItemTypes.some((t) => t.ref === input.workItemTypeRef)) {
      throw new WorkItemTypeError(
        `work item type is not a type of this project's project type. ` +
          `Valid: ${workItemTypes.map((t) => `${t.name}=${t.ref}`).join(', ')}`,
      );
    }
    workItemTypeRef = input.workItemTypeRef;
  } else if (workItemTypes.length === 1) {
    workItemTypeRef = workItemTypes[0].ref;
  } else {
    throw new WorkItemTypeError(
      `This project type has ${workItemTypes.length} work item types — choose one. ` +
        `Options: ${workItemTypes.map((t) => `${t.name}=${t.ref}`).join(', ')}`,
    );
  }

  const primaryEmail = (contacts.find((c) => c.isPrimary) ?? contacts[0])?.email;
  const emailDomain = deriveEmailDomain(customer.website, customer.email ?? primaryEmail);

  // ── Upsert the customer (idempotent on bp_ref) ──────────────────────────────
  const upserted = await upsertCustomer({
    bpRef: customer.ref,
    displayName: customer.name,
    website: customer.website,
    emailDomain,
    projectRef: input.projectRef,
    workItemTypeRef,
  });

  // ── Import contacts: BP directory (email + whatsapp only) ────────────────────
  let bpImported = 0;
  for (const c of contacts) {
    if (c.email) {
      await importContact({
        customerId: upserted.id,
        channelType: 'email',
        address: normalizeEmailAddress(c.email),
        displayName: c.name || undefined,
        isPrimary: c.isPrimary,
        directoryContactRef: c.ref,
      });
      bpImported += 1;
    }
    if (c.whatsapp) {
      await importContact({
        customerId: upserted.id,
        channelType: 'whatsapp',
        address: normalizeWhatsappAddress(c.whatsapp),
        displayName: c.name || undefined,
        isPrimary: c.isPrimary,
        directoryContactRef: c.ref,
      });
      bpImported += 1;
    }
    // bare phone / telegram skipped: no ChannelType home yet (blueprint §3).
  }

  // ── Import contacts: whatsapp_manager whitelist + groups (HTTP; client-filter) ─
  // Blocked-on-config tolerant: if WA auth is not yet configured (401), this step is skipped with
  // a clear warning and onboarding still completes the rest.
  let waImported = 0;
  let waBlocked = false;
  try {
    const [whitelist, groups] = await Promise.all([wa.listWhitelist(), wa.listGroups()]);
    for (const w of whitelist.filter((e) => e.ezy_bp_id === input.bpRef)) {
      await importContact({
        customerId: upserted.id,
        channelType: 'whatsapp',
        address: normalizeWhatsappAddress(w.phone_number),
        displayName: w.ezy_contact_name ?? w.label ?? undefined,
      });
      waImported += 1;
    }
    for (const g of groups.filter((e) => e.ezy_bp_id === input.bpRef)) {
      await importContact({
        customerId: upserted.id,
        channelType: 'whatsapp',
        address: normalizeWhatsappAddress(g.group_id),
        displayName: g.subject ?? undefined,
        isGroup: true,
      });
      waImported += 1;
    }
  } catch (err) {
    waBlocked = true;
    logger.warn(
      { err },
      'whatsapp_manager directory import SKIPPED (reachability/auth) — re-run onboarding once WA is configured',
    );
  }

  // ── Telegram topic (idempotent; guarded by telegram_topic_id) ────────────────
  if (upserted.telegramTopicId) {
    logger.info(
      { customerId: upserted.id, topicId: upserted.telegramTopicId },
      'Already onboarded — topic exists; skipping Telegram (no new topic, no welcome)',
    );
  } else {
    const topic = await notifier.ensureCustomerTopic(upserted.id, customer.name);
    const claim = await claimTelegramTopic(upserted.id, topic.ref);
    if (claim.claimed) {
      await notifier.notifyCustomerEvent(upserted.id, welcomeNotification(customer.name));
      logger.info({ customerId: upserted.id, topicId: claim.topicId }, 'Topic created + welcome sent');
    } else {
      logger.warn(
        { customerId: upserted.id, keptTopicId: claim.topicId, orphanedTopicRef: topic.ref },
        'Lost topic-claim race — another run won; our freshly-created topic is orphaned (manual cleanup)',
      );
    }
  }

  return {
    customerId: upserted.id,
    created: upserted.created,
    displayName: customer.name,
    workItemTypeRef,
    bpContactsImported: bpImported,
    waContactsImported: waImported,
    waBlocked,
    telegramTopicId: upserted.telegramTopicId,
  };
}
