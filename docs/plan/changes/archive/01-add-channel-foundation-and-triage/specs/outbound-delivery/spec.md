# outbound-delivery — Spec Delta

## ADDED Requirements

### Requirement: All sends via the queue, all deliveries via adapters
Every outbound message SHALL be an `agent_outbound_queue` row referencing a channel instance; a drainer worker SHALL dispatch approved, due rows through the instance's `ChannelAdapter.send()` and record the provider message id. Direct sends bypassing the queue SHALL NOT exist.

#### Scenario: Draft awaits approval
- **WHEN** a row has `is_draft = true` and no `approved_at`
- **THEN** the drainer never dispatches it

### Requirement: Rate limiting per recipient
WhatsApp-type instances SHALL enforce a per-recipient hourly cap (default 10) and a minimum inter-send gap (default 5s), configurable per customer; rows over the limit get `send_after` pushed rather than dropped. After 3 consecutive delivery failures to one recipient, sends to that recipient pause and the founder is alerted.

#### Scenario: Burst of replies
- **WHEN** 12 messages for one contact are approved within an hour
- **THEN** 10 are sent respecting the 5s gap and 2 are scheduled into the next window

### Requirement: Business hours and holiday gating
Before dispatch the drainer SHALL check the customer's local time against `agent_business_hours` and `agent_holidays` (global + customer-faith holidays). Outside the window, `send_after` SHALL be set to the next business window opening and a note posted to the customer's Telegram topic.

#### Scenario: Message ready on a holiday
- **WHEN** a reply is approved on a customer-relevant holiday
- **THEN** it is scheduled for the next working day 09:00 in the customer's timezone and the founder sees "queued until …" in the topic

### Requirement: Delivery failures are retried, then surfaced
Failed dispatches SHALL retry with exponential backoff up to 3 attempts, then mark the row `failed` and alert the admin topic with the provider error.

#### Scenario: whatsapp_manager offline
- **WHEN** `POST /outbound/send` returns 503 (client not ready)
- **THEN** the row retries with backoff and eventually alerts rather than silently dropping
