import { query } from '../db';
import { logger } from '../logger';

// Onboarding persistence (blueprint §3). Pure DB upserts — no adapter/HTTP
// imports (D1). Idempotency lives entirely in the DB's UNIQUE constraints
// (agent_customers.bp_ref, agent_customer_contacts(channel_type,address)) and
// the nullable telegram_topic_id guard; NO new migration.

export interface UpsertCustomerInput {
  bpRef: string;
  displayName: string;
  website?: string;
  emailDomain?: string;
  projectRef: string;
  workItemTypeRef: string;
}

export interface UpsertCustomerResult {
  id: string;
  telegramTopicId: string | null;
  created: boolean;
}

/**
 * Upsert on bp_ref. A re-run refreshes the mutable fields and returns the SAME
 * id and the CURRENT telegram_topic_id (so the caller can skip already-onboarded
 * customers). `created` distinguishes insert from update via the xmax=0 trick.
 */
export async function upsertCustomer(input: UpsertCustomerInput): Promise<UpsertCustomerResult> {
  const { rows } = await query<{
    id: string;
    telegram_topic_id: string | null;
    created: boolean;
  }>(
    `INSERT INTO agent_customers (bp_ref, display_name, website, email_domain, project_ref, work_item_type_ref)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (bp_ref) DO UPDATE SET
       display_name       = EXCLUDED.display_name,
       website            = EXCLUDED.website,
       email_domain       = EXCLUDED.email_domain,
       project_ref        = EXCLUDED.project_ref,
       work_item_type_ref = EXCLUDED.work_item_type_ref
     RETURNING id, telegram_topic_id, (xmax = 0) AS created`,
    [
      input.bpRef,
      input.displayName,
      input.website ?? null,
      input.emailDomain ?? null,
      input.projectRef,
      input.workItemTypeRef,
    ],
  );
  const row = rows[0];
  return { id: row.id, telegramTopicId: row.telegram_topic_id, created: row.created };
}

export interface ImportContactInput {
  customerId: string;
  channelType: string;
  address: string; // already normalized by the caller (digits WA / lowercased email)
  displayName?: string;
  isGroup?: boolean;
  isPrimary?: boolean;
  directoryContactRef?: string;
}

export interface ImportContactResult {
  id: string;
  created: boolean;
  reparented: boolean;
}

/**
 * Upsert a contact identity on (channel_type, address). Re-import is a harmless
 * DO UPDATE. If the address previously belonged to a DIFFERENT customer, the
 * upsert reparents it and we WARN (DA flag 4 hardening) — fine for a solo
 * operator, but a signal worth surfacing.
 */
export async function importContact(input: ImportContactInput): Promise<ImportContactResult> {
  const existing = await query<{ customer_id: string }>(
    'SELECT customer_id FROM agent_customer_contacts WHERE channel_type = $1 AND address = $2',
    [input.channelType, input.address],
  );
  const priorCustomerId = existing.rows[0]?.customer_id ?? null;
  const reparented = priorCustomerId !== null && priorCustomerId !== input.customerId;
  if (reparented) {
    logger.warn(
      { channelType: input.channelType, fromCustomerId: priorCustomerId, toCustomerId: input.customerId },
      'Contact address reparented to a new customer',
    );
  }

  const { rows } = await query<{ id: string; created: boolean }>(
    `INSERT INTO agent_customer_contacts
       (customer_id, channel_type, address, display_name, is_group, is_primary, directory_contact_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (channel_type, address) DO UPDATE SET
       customer_id           = EXCLUDED.customer_id,
       display_name          = COALESCE(EXCLUDED.display_name, agent_customer_contacts.display_name),
       is_group              = EXCLUDED.is_group,
       is_primary            = EXCLUDED.is_primary,
       directory_contact_ref = COALESCE(EXCLUDED.directory_contact_ref, agent_customer_contacts.directory_contact_ref)
     RETURNING id, (xmax = 0) AS created`,
    [
      input.customerId,
      input.channelType,
      input.address,
      input.displayName ?? null,
      input.isGroup ?? false,
      input.isPrimary ?? false,
      input.directoryContactRef ?? null,
    ],
  );
  return { id: rows[0].id, created: rows[0].created, reparented };
}

export interface ClaimTopicResult {
  claimed: boolean;
  topicId: string;
}

/**
 * Race-safe topic claim (blueprint §3). Sets telegram_topic_id only if still
 * NULL. rowCount=1 → we won (claimed our freshly-created topic); rowCount=0 → a
 * concurrent run won, so we read and return the winner's topic id. Deliberately
 * NOT a SELECT FOR UPDATE held across the Telegram HTTP call — the residual is a
 * rare orphaned duplicate topic, which the caller logs for manual cleanup.
 */
export async function claimTelegramTopic(
  customerId: string,
  topicRef: string,
): Promise<ClaimTopicResult> {
  const claim = await query<{ telegram_topic_id: string }>(
    `UPDATE agent_customers SET telegram_topic_id = $1
      WHERE id = $2 AND telegram_topic_id IS NULL
      RETURNING telegram_topic_id`,
    [topicRef, customerId],
  );
  if ((claim.rowCount ?? 0) > 0) {
    return { claimed: true, topicId: claim.rows[0].telegram_topic_id };
  }
  const winner = await query<{ telegram_topic_id: string | null }>(
    'SELECT telegram_topic_id FROM agent_customers WHERE id = $1',
    [customerId],
  );
  return { claimed: false, topicId: winner.rows[0]?.telegram_topic_id ?? topicRef };
}

// ── Channel address normalization (blueprint §4: the CALLING channel normalizes).
// Kept here as pure helpers the onboarding composition root applies before
// importContact, so BP and WA sources dedup on the same key.

/** Lowercase + trim an email address. */
export function normalizeEmailAddress(email: string): string {
  return email.trim().toLowerCase();
}

/** Digits-only WhatsApp/phone address (matches whatsapp_manager's normalization). */
export function normalizeWhatsappAddress(value: string): string {
  return value.replace(/\D/g, '');
}
