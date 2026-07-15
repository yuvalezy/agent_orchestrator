# customer-registry

Customer master records, contact identity mapping, onboarding. Shipped by change 01 (M1.2), in `agent_orchestrator`.

## Requirements

### Requirement: Customer master record linked via opaque directory ref
Each customer SHALL be an `agent_customers` row holding an opaque `bp_ref` (resolved through `CustomerDirectoryPort`), display name, website-derived `email_domain`, target `project_ref` + `work_item_type_ref`, timezone, faith, preferred language, default email instance, and Telegram topic id. Core code SHALL never interpret `bp_ref`.

#### Scenario: Email domain derived on save
- **WHEN** a customer is created with website `https://www.holadocmed.com`
- **THEN** `email_domain` is stored as `holadocmed.com`

### Requirement: Contact identity keyed by channel type + address
`agent_customer_contacts` SHALL map `(channel_type, normalized address)` → customer, spanning all instances of that type; WhatsApp groups map with `is_group = true`.

#### Scenario: Same sender on both Gmail accounts
- **WHEN** john@holadocmed.com emails the personal account and later the work account
- **THEN** both inbox rows resolve to the same customer via one contact row

### Requirement: Sender resolution ladder
Inbound resolution SHALL try: exact `(channel_type, address)` match → email-domain match on `agent_customers.email_domain` → unknown. Unknown sender from a known domain SHALL trigger a founder proposal (add contact / ignore) via Telegram; unknown domain SHALL be skipped with a counter and included in a weekly admin digest.

#### Scenario: New colleague from known domain
- **WHEN** maria@holadocmed.com (no contact row) sends an email
- **THEN** the message stays pending-resolution and the founder receives an "add Maria to HolaDoc?" prompt with buttons; approving creates the contact row and releases the message for triage

### Requirement: Onboarding flow
A single onboarding action SHALL: create the customer from a directory BP, import directory contacts and whatsapp_manager whitelist/group links as contact identities, capture `project_ref` and `work_item_type_ref` (validated via `TaskTargetPort.listWorkItemTypes`), create the customer's Telegram forum topic, and post a welcome message. Re-running onboarding for an already-onboarded BP SHALL be a no-op (idempotent) — no duplicate customer/contact/topic rows.

#### Scenario: Onboarding completes prerequisites for task creation
- **WHEN** onboarding finishes for a customer
- **THEN** the stored `work_item_type_ref` is valid for the stored `project_ref`, so a subsequent `createTask` cannot fail on a missing work item type

#### Scenario: Re-onboarding is a no-op
- **WHEN** onboarding is run again for a BP that already has a customer row
- **THEN** no new customer, contact, or Telegram topic is created, and the existing topic is reused
