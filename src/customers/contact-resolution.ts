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
  /** Resolve a customer directly by its portal BP ref (the service_desk primary
   *  key — D-A revised: `agent_customers.bp_ref == ticket.requesterBPID`). */
  findCustomerByBpRef(bpRef: string): Promise<{ customerId: string } | null>;
  findContactByAddress(
    channelType: string,
    address: string,
  ): Promise<{ customerId: string; contactId: string } | null>;
  findCustomersByEmailDomain(domain: string): Promise<Array<{ id: string; displayName: string }>>;
}

export const dbContactResolutionQueries: ContactResolutionQueries = {
  async findCustomerByBpRef(bpRef) {
    const { rows } = await query<{ id: string }>(
      'SELECT id FROM agent_customers WHERE bp_ref = $1',
      [bpRef],
    );
    return rows[0] ? { customerId: rows[0].id } : null;
  },
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

/** Email-domain propose fallback (email-only affordance — no reliable domain for a
 *  bare phone/whatsapp/telegram address, and a bp-ref UUID has no `@`). */
async function proposeByEmailDomain(
  deps: ContactResolutionQueries,
  address: string,
): Promise<ContactResolution> {
  const at = address.lastIndexOf('@');
  if (at < 0) return { kind: 'unknown' };
  const domain = address.slice(at + 1);
  if (!domain) return { kind: 'unknown' };
  const matches = await deps.findCustomersByEmailDomain(domain);
  if (matches.length === 1) {
    return { kind: 'propose', customerId: matches[0].id, customerName: matches[0].displayName };
  }
  return { kind: 'unknown' };
}

export async function resolveContact(
  input: { channelType: string; address: string },
  deps: ContactResolutionQueries = dbContactResolutionQueries,
): Promise<ContactResolution> {
  // D-A (revised): a service_desk requester is identified PRIMARILY by BP-ref and
  // secondarily by email. The single `address` carries a bp-ref UUID OR an email;
  // try each in order (each lookup harmlessly misses the wrong identity type). This
  // runs ABOVE the email-only guard below so a bp-ref (no `@`) still gets its BP
  // lookup before the early-return — a proposed contact is imported as
  // channel_type='email' (B4) so the next ticket's email fallback hits it.
  if (input.channelType === 'service_desk') {
    const byBp = await deps.findCustomerByBpRef(input.address);
    if (byBp) return { kind: 'known', customerId: byBp.customerId, contactId: '' };
    const byEmail = await deps.findContactByAddress('email', input.address);
    if (byEmail) return { kind: 'known', ...byEmail };
    return proposeByEmailDomain(deps, input.address); // '@'-less bp-ref → unknown
  }

  const exact = await deps.findContactByAddress(input.channelType, input.address);
  if (exact) return { kind: 'known', ...exact };

  // Domain-based proposal is an email-only affordance (no reliable domain for a
  // bare phone/whatsapp/telegram address).
  if (input.channelType !== 'email') return { kind: 'unknown' };
  return proposeByEmailDomain(deps, input.address);
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
