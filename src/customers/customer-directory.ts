import { query } from '../db';

// CORE query (db-only): a customer's directory identity for backfill matching — its EZY business-
// partner ref (to map whatsapp_manager chats → customer), display name, and preferred language.
// Used by the WhatsApp history source to select only the target customer's chats.

export interface CustomerDirectoryInfo {
  bpRef: string | null;
  displayName: string;
  language: string | null;
}

export async function getCustomerDirectoryInfo(customerId: string): Promise<CustomerDirectoryInfo | null> {
  const { rows } = await query<{ bp_ref: string | null; display_name: string; preferred_language: string | null }>(
    'SELECT bp_ref, display_name, preferred_language FROM agent_customers WHERE id = $1',
    [customerId],
  );
  const r = rows[0];
  if (!r) return null;
  return { bpRef: r.bp_ref, displayName: r.display_name, language: r.preferred_language };
}
