import { query } from '../db';
import { FounderNotifierPort } from '../ports';
import { newContactProposal } from './notifications';

// Contact resolution (blueprint §4). Core domain: depends only on src/ports +
// src/db, NEVER on adapters (D1). Assumes `address` arrives ALREADY normalized
// by the calling channel (digits-only WhatsApp, lowercased email) — this does
// exact-match only.
//
//   known   → an existing contact row matches exactly. Resolved, no notification.
//   propose → no exact match, but an email whose domain matches EXACTLY ONE
//             customer. Surfaced to the founder via askFounder (send-only until
//             M1.5b wires the reply).
//   unknown → everything else. Classification only; the skip/counter side effect
//             has no home until a real agent_inbox row exists (M1.3/M1.5b).

export type ContactResolution =
  | { kind: 'known'; customerId: string; contactId: string }
  | { kind: 'propose'; customerId: string; customerName: string }
  | { kind: 'unknown' };

/**
 * Data-access seam so the known/propose/unknown logic is unit-testable without a
 * live DB. Defaults to the real Postgres-backed queries.
 */
export interface ContactResolutionQueries {
  findContactByAddress(
    channelType: string,
    address: string,
  ): Promise<{ customerId: string; contactId: string } | null>;
  findCustomersByEmailDomain(domain: string): Promise<Array<{ id: string; displayName: string }>>;
}

export const dbContactResolutionQueries: ContactResolutionQueries = {
  async findContactByAddress(channelType, address) {
    const { rows } = await query<{ customer_id: string; id: string }>(
      'SELECT customer_id, id FROM agent_customer_contacts WHERE channel_type = $1 AND address = $2',
      [channelType, address],
    );
    return rows[0] ? { customerId: rows[0].customer_id, contactId: rows[0].id } : null;
  },
  async findCustomersByEmailDomain(domain) {
    const { rows } = await query<{ id: string; display_name: string }>(
      'SELECT id, display_name FROM agent_customers WHERE email_domain = $1',
      [domain],
    );
    return rows.map((r) => ({ id: r.id, displayName: r.display_name }));
  },
};

export async function resolveContact(
  input: { channelType: string; address: string },
  deps: ContactResolutionQueries = dbContactResolutionQueries,
): Promise<ContactResolution> {
  const exact = await deps.findContactByAddress(input.channelType, input.address);
  if (exact) return { kind: 'known', ...exact };

  // Domain-based proposal is an email-only affordance (no reliable domain for a
  // bare phone/whatsapp/telegram address).
  if (input.channelType !== 'email') return { kind: 'unknown' };
  const at = input.address.lastIndexOf('@');
  if (at < 0) return { kind: 'unknown' };
  const domain = input.address.slice(at + 1);
  if (!domain) return { kind: 'unknown' };

  const matches = await deps.findCustomersByEmailDomain(domain);
  if (matches.length === 1) {
    return { kind: 'propose', customerId: matches[0].id, customerName: matches[0].displayName };
  }
  return { kind: 'unknown' };
}

/**
 * Send the founder an "add this contact?" proposal. Takes the port as a
 * parameter (never imports the adapter). SEND-ONLY — the yes/no tap is not
 * routed until M1.5b (DA flag 5).
 */
export async function proposeAddContact(
  notifier: FounderNotifierPort,
  input: { customerId: string; customerName: string; channelType: string; address: string },
): Promise<void> {
  await notifier.askFounder(
    input.customerId,
    newContactProposal(input.customerName, input.channelType, input.address),
    [
      { id: 'add_contact:yes', label: 'Add contact' },
      { id: 'add_contact:no', label: 'Ignore' },
    ],
  );
}
