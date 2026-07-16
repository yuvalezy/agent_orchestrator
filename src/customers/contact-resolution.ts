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
  /** The email address of the HUMAN behind a non-email contact — see findContactEmail. */
  findContactEmailByAddress(channelType: string, address: string): Promise<string | null>;
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
  async findContactEmailByAddress(channelType, address) {
    // Self-join on directory_contact_ref: the portal directory ref is what ties one PERSON's
    // channels together (onboarding.ts writes it), so a WhatsApp number resolves to the email of
    // the same human — e.g. 50766736013 → iyelinek@holadocmed.com.
    //
    // Two hard guards:
    //  • `w.is_group IS NOT TRUE` — in a shared group the sender is NOT the contact row (the
    //    address is the group jid), so a join from it would invite the group's contact rather
    //    than whoever actually asked to talk.
    //  • the ref must be NON-NULL on both sides — SQL would happily match NULL=NULL in a naive
    //    join formulation, and "two contacts with no directory ref" is not "the same person".
    const { rows } = await query<{ address: string }>(
      `SELECT e.address
         FROM agent_customer_contacts w
         JOIN agent_customer_contacts e
           ON e.directory_contact_ref = w.directory_contact_ref
          AND e.channel_type = 'email'
        WHERE w.channel_type = $1
          AND w.address = $2
          AND w.is_group IS NOT TRUE
          AND w.directory_contact_ref IS NOT NULL
        ORDER BY e.is_primary DESC, e.created_at ASC
        LIMIT 1`,
      [channelType, address],
    );
    return rows[0]?.address ?? null;
  },
};

/**
 * The email address to invite when a customer asks to meet, or null when we cannot know it.
 *
 * An email-origin ask needs no lookup — the sender IS the attendee. Anything else routes through
 * the directory ref (see findContactEmailByAddress).
 *
 * Null is a normal answer, not an error: group chats have no single asker, and a contact may
 * simply have no email on file. The caller books WITHOUT an attendee in that case (the Meet link
 * in the reply is the invitation) rather than guessing at an address — an invitation sent to the
 * wrong person is worse than one not sent at all.
 *
 * ⚠︎ The ref is never re-verified: onboarding.ts COALESCEs it and never clears it, so a contact
 * who has left the company still resolves to their old mailbox. The founder is shown the address
 * before anything is sent, which is the only real check available here.
 */
export async function findContactEmail(
  channelType: string,
  address: string,
  q: ContactResolutionQueries = dbContactResolutionQueries,
): Promise<string | null> {
  const addr = address.trim().toLowerCase();
  if (!addr) return null;
  if (channelType === 'email') return addr;
  return q.findContactEmailByAddress(channelType, addr);
}

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
