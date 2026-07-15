# outbound-delivery

Outbound queue, rate limiting, business hours/holiday gating. Shipped by change 01 (M1.8), in `agent_orchestrator`.

## Requirements

### Requirement: All sends via the queue, all deliveries via adapters
Every outbound message SHALL be an `agent_outbound_queue` row referencing a channel instance; a drainer worker SHALL dispatch approved, due rows through the instance's `ChannelAdapter.send()` and record the provider message id. Direct sends bypassing the queue SHALL NOT exist. Real sending SHALL be gated by an explicit kill-switch, disabled by default, so the drainer is inert until deliberately enabled.

#### Scenario: Draft awaits approval
- **WHEN** a row has `is_draft = true` and no `approved_at`
- **THEN** the drainer never dispatches it

#### Scenario: Kill-switch off
- **WHEN** the outbound kill-switch is not enabled
- **THEN** the drainer is not registered and nothing is ever sent, regardless of queue contents

### Requirement: Rate limiting per recipient
WhatsApp-type instances SHALL enforce a per-recipient hourly cap (default 10) and a minimum inter-send gap (default 5s), configurable per customer; rows over the limit get `send_after` pushed rather than dropped. After 3 consecutive delivery failures to one recipient, sends to that recipient pause and the founder is alerted (failure circuit-breaker).

#### Scenario: Burst of replies
- **WHEN** 12 messages for one contact are approved within an hour
- **THEN** 10 are sent respecting the 5s gap and 2 are scheduled into the next window

### Requirement: Business hours and holiday gating
Before dispatch the drainer SHALL check the customer's local time against `agent_business_hours` and `agent_holidays` (global + customer-faith holidays). Outside the window, `send_after` SHALL be set to the next business window opening and a note posted to the customer's Telegram topic.

#### Scenario: Message ready on a holiday
- **WHEN** a reply is approved on a customer-relevant holiday
- **THEN** it is scheduled for the next working day 09:00 in the customer's timezone and the founder sees "queued until …" in the topic

### Requirement: Delivery failures are classified — never silently duplicate-sent
Because whatsapp_manager delivers a message before it responds to the send call and offers no idempotency key, a send failure SHALL be classified by whether the message might already have reached the recipient: `ECONNREFUSED`/`ENOTFOUND`/`429`/`503` are retriable (not yet delivered) and retry with exponential backoff up to 3 attempts before failing+alerting; `400`/`403` are permanent failures; timeout/`5xx`/`ECONNRESET`/unknown errors are **possibly-delivered** and SHALL go to manual review rather than being auto-resent, since a resend could double-deliver to the customer.

#### Scenario: whatsapp_manager offline
- **WHEN** `POST /outbound/send` returns 503 (client not ready)
- **THEN** the row retries with backoff and eventually alerts rather than silently dropping

#### Scenario: Ambiguous failure after likely delivery
- **WHEN** a send throws `ECONNRESET` after the underlying message may already have reached WhatsApp
- **THEN** the row is marked for manual review, not auto-retried — an unnecessary resend is worse than a delayed one
