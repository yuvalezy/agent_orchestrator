import 'dotenv/config';
import { pool } from '../src/db';
import { logger } from '../src/logger';
import { buildEzyPortalGateway } from '../src/adapters/ezy-portal';
import { buildWhatsAppDirectoryClient } from '../src/adapters/whatsapp-manager/factory';
import { buildTelegramNotifier } from '../src/adapters/telegram/factory';
import {
  deriveEmailDomain,
  upsertCustomer,
  importContact,
  claimTelegramTopic,
  normalizeEmailAddress,
  normalizeWhatsappAddress,
  welcomeNotification,
} from '../src/customers';

// Onboarding CLI — a composition root (like src/main.ts): the ONE place allowed
// to pair core (src/customers) with adapters (D1). Wires the EZY gateway, the
// whatsapp_manager directory client, and the Telegram notifier, then runs the
// idempotent onboarding flow from the blueprint §3 sequence diagram.
//
//   npm run onboard -- --bp-ref=<uuid> --project-ref=<uuid> [--work-item-type-ref=<uuid>]
//
// Idempotent: re-running for the same bp_ref refreshes fields, re-imports
// contacts harmlessly, and skips Telegram entirely once a topic exists.

interface Args {
  bpRef: string;
  projectRef: string;
  workItemTypeRef?: string;
}

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    let tok = argv[i];
    if (tok === '--') continue;
    if (!tok.startsWith('--')) continue;
    tok = tok.slice(2);
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      map.set(tok.slice(0, eq), tok.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        map.set(tok, next);
        i += 1;
      } else {
        map.set(tok, 'true');
      }
    }
  }
  const bpRef = map.get('bp-ref');
  const projectRef = map.get('project-ref');
  if (!bpRef || !projectRef) {
    throw new Error(
      'Usage: npm run onboard -- --bp-ref=<uuid> --project-ref=<uuid> [--work-item-type-ref=<uuid>]',
    );
  }
  return { bpRef, projectRef, workItemTypeRef: map.get('work-item-type-ref') };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ezy = buildEzyPortalGateway();
  const wa = buildWhatsAppDirectoryClient();

  // ── EZY reads ──────────────────────────────────────────────────────────────
  const customer = await ezy.getCustomer(args.bpRef);
  const contacts = await ezy.listContacts(args.bpRef);
  const workItemTypes = await ezy.listWorkItemTypes(args.projectRef); // proves the 2-hop

  // Enforce work-item-type membership BEFORE writing (blueprint §3 / DA flag 3):
  // the ref must belong to this project's project type, else task-create 422s at
  // M1.5a. Auto-pick only when the project type has exactly one type.
  let workItemTypeRef: string;
  if (args.workItemTypeRef) {
    if (!workItemTypes.some((t) => t.ref === args.workItemTypeRef)) {
      throw new Error(
        `work-item-type-ref ${args.workItemTypeRef} is not a type of this project's project type. ` +
          `Valid: ${workItemTypes.map((t) => `${t.name}=${t.ref}`).join(', ')}`,
      );
    }
    workItemTypeRef = args.workItemTypeRef;
  } else if (workItemTypes.length === 1) {
    workItemTypeRef = workItemTypes[0].ref;
  } else {
    throw new Error(
      `Project type has ${workItemTypes.length} work item types — pass --work-item-type-ref=<uuid>. ` +
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
    projectRef: args.projectRef,
    workItemTypeRef,
  });
  logger.info(
    { customerId: upserted.id, created: upserted.created, emailDomain: emailDomain ?? null },
    upserted.created ? 'Customer created' : 'Customer refreshed',
  );

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
  // Blocked-on-config tolerant: if WA auth is not yet configured (401), this step
  // is skipped with a clear warning and onboarding still completes the rest.
  let waImported = 0;
  let waBlocked = false;
  try {
    const [whitelist, groups] = await Promise.all([wa.listWhitelist(), wa.listGroups()]);
    for (const w of whitelist.filter((e) => e.ezy_bp_id === args.bpRef)) {
      await importContact({
        customerId: upserted.id,
        channelType: 'whatsapp',
        address: normalizeWhatsappAddress(w.phone_number),
        displayName: w.ezy_contact_name ?? w.label ?? undefined,
      });
      waImported += 1;
    }
    for (const g of groups.filter((e) => e.ezy_bp_id === args.bpRef)) {
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
    const notifier = buildTelegramNotifier();
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

  logger.info(
    {
      customerId: upserted.id,
      created: upserted.created,
      bpContactsImported: bpImported,
      waContactsImported: waImported,
      waBlocked,
    },
    'Onboarding complete',
  );
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'Onboarding failed');
    pool.end().finally(() => process.exit(1));
  });
