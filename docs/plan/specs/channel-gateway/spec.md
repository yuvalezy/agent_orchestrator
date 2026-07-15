# channel-gateway

Generic channel port, channel instance registry, WhatsApp / Gmail / Service Desk adapters. Shipped by change 01 (M1.1, M1.3, M1.6, M1.7), in `agent_orchestrator`.

## Requirements

### Requirement: Channel instance registry
The system SHALL represent every connected message source/sink as a row in `channel_instances` (channel_type, provider, name, config, credentials_ref, status, sync_cursor). No schema object SHALL enumerate channel names in CHECK constraints; all message tables reference `channel_instances(id)`.

#### Scenario: Adding a future channel requires no schema change
- **WHEN** a new adapter (e.g. Slack) is registered with a new `channel_instances` row of type `slack`
- **THEN** inbox ingestion, outbound delivery, and contact resolution operate on it without any database migration

#### Scenario: Paused instance
- **WHEN** an instance has `status = 'paused'`
- **THEN** its pollers stop, its webhook payloads are acknowledged but queued as pending, and no outbound is dispatched through it

#### Scenario: Misconfigured instance is skipped, not fatal
- **WHEN** a `channel_instances` row is missing required credentials/config (e.g. a Gmail instance with no OAuth token)
- **THEN** the registry skips that instance at boot (logged) rather than failing startup for all channels

### Requirement: Generic channel adapter port
Every adapter SHALL implement `ChannelAdapter` (see archived `changes/archive/01-add-channel-foundation-and-triage/design.md`): optional `startPush`, mandatory `pull(cursor)`, `send`, `health`, declared `capabilities`. Core code SHALL interact with channels only through this port and the registry.

#### Scenario: Capability-driven behavior
- **WHEN** the triage layer formats output for a channel without `subjects` capability (WhatsApp)
- **THEN** subject lines are omitted without channel-specific conditionals in core code

### Requirement: Normalized inbound message
Adapters SHALL map provider payloads to `InboundMessage` with: provider message id, thread key, sender address normalized per channel type (digits-only phone, lowercased email), best-effort text body (voice transcript when available), attachment refs, and the full raw payload preserved.

#### Scenario: WhatsApp voice note
- **WHEN** whatsapp_manager delivers an audio message whose `transcript` is populated
- **THEN** the `InboundMessage.body` is the transcript and the media reference is kept as an attachment

### Requirement: Explicit group routing on send
Outbound sends SHALL carry an explicit `isGroup` flag resolved from the stored contact identity (`agent_customer_contacts.is_group`), never inferred from address formatting. Address-format inference is unreliable (e.g. whatsapp_manager's own number normalization strips the hyphens a group id needs to be recognized by).

#### Scenario: Reply into a WhatsApp group
- **WHEN** an approved outbound row targets a known group contact
- **THEN** the adapter sends with `{groupId}`, not `{number}` — a misroute would be rejected as not-whitelisted

### Requirement: WhatsApp adapter over whatsapp_manager HTTP
The WhatsApp adapter SHALL ingest via the signed webhook (HMAC `X-Signature` verified against the shared secret) as primary path and via `GET /messages?updated_since=<cursor>` for startup catch-up and periodic reconciliation; it SHALL send via `POST /outbound/send` and SHALL NOT access the whatsapp_manager database directly.

#### Scenario: Invalid webhook signature
- **WHEN** a webhook POST arrives with a missing or wrong HMAC signature
- **THEN** it is rejected with 401 and nothing is written to the inbox

#### Scenario: Missed messages during downtime
- **WHEN** the orchestrator restarts after 2 hours down
- **THEN** the catch-up pull from the persisted cursor ingests every message received meanwhile, exactly once

#### Scenario: Late voice transcript
- **WHEN** whatsapp_manager transcribes a voice note after the webhook already fired (transcription never re-fires the webhook)
- **THEN** the transcript is only observable via the next reconciliation pull — pull reconciliation is the sole delivery path for late transcripts, not a best-effort extra

### Requirement: Email channel with pluggable provider and multiple accounts
The email adapter SHALL support N configured instances (Phase 1: gmail personal + work), each delegating provider I/O to an `EmailProviderClient`. The Gmail client SHALL use the History API with a persisted cursor (falling back to full sync, capped to a bounded lookback window, when the cursor is expired). Replies SHALL preserve threading via `In-Reply-To`/`References`; personal and work accounts SHALL never be cross-used for a thread. The adapter SHALL skip self-sent mail (no ingest loop from the account's own `SENT` folder).

#### Scenario: Second provider later
- **WHEN** an Outlook `EmailProviderClient` is implemented and an instance row added
- **THEN** the email adapter and all downstream processing work unchanged

#### Scenario: Reply goes out on the receiving account
- **WHEN** an approved reply targets a thread that arrived on the work instance
- **THEN** it is sent through the work instance with correct threading headers

### Requirement: Service desk adapter (ingestion side)
The service desk adapter SHALL poll `TicketingPort.listChangedTickets` and emit new tickets and new public external thread entries as `InboundMessage` rows (thread key = ticket ref); its `send` SHALL post a public thread reply. It SHALL skip internal notes and staff-authored entries (`authorIsExternal=false`) as outbound/non-actionable, ingesting only customer-authored (`authorIsExternal=true`) entries.

#### Scenario: New ticket ingested
- **WHEN** a customer opens a ticket in the portal
- **THEN** an inbox row appears within one poll interval with the ticket ref as thread key

#### Scenario: Staff reply is not customer input
- **WHEN** a portal staff member posts a public reply from the agent view
- **THEN** the entry is skipped — no inbox row, no re-triage of the founder's own team's words
