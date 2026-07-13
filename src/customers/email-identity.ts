import { query } from '../db';

// CORE query (db-only): a customer's email identity for backfill/matching — the email domain
// (agent_customers.email_domain) plus every known email contact address. Used to build the Gmail
// search query that finds the customer's historical threads.

export interface CustomerEmailIdentity {
  domain: string | null;
  addresses: string[];
}

export async function getCustomerEmailIdentity(customerId: string): Promise<CustomerEmailIdentity> {
  const dom = await query<{ email_domain: string | null }>(
    'SELECT email_domain FROM agent_customers WHERE id = $1',
    [customerId],
  );
  const addrs = await query<{ address: string }>(
    "SELECT address FROM agent_customer_contacts WHERE customer_id = $1 AND channel_type = 'email'",
    [customerId],
  );
  return {
    domain: dom.rows[0]?.email_domain ?? null,
    addresses: addrs.rows.map((r) => r.address),
  };
}
