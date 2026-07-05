-- 003: contact identities ◆ keyed by channel TYPE (identity spans instances)
CREATE TABLE agent_customer_contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID NOT NULL REFERENCES agent_customers(id),
  channel_type    TEXT NOT NULL,
  address         TEXT NOT NULL,             -- phone digits, lowercased email, SD contact ref
  display_name    TEXT,
  is_group        BOOLEAN DEFAULT false,     -- WhatsApp group ids
  is_primary      BOOLEAN DEFAULT false,
  directory_contact_ref TEXT,                -- EZY contact UUID when linked
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(channel_type, address)
);
