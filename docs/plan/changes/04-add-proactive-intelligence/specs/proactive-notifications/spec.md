# proactive-notifications — Spec Delta

## ADDED Requirements

### Requirement: Source-channel resolution notifications
When a bridged task transitions to done, the system SHALL draft a customer notification in their preferred language and deliver it through the channel instance and thread the originating message arrived on (WhatsApp contact/group; email in-thread; service desk reply + ticket resolved).

#### Scenario: Feature request resolved
- **WHEN** the task created from a WhatsApp feature request is marked done
- **THEN** the requesting contact receives a WhatsApp message announcing the feature, after founder approval or a passing auto-send gate

### Requirement: Webhook-driven detection with updatedAfter backfill
Task status changes SHALL be detected via a `TaskEventSource` abstraction with two implementations: the portal webhook receiver (change 00 events, HMAC-verified) and `updatedAfter` polling for reconciliation and post-downtime backfill. Each transition SHALL be acted on exactly once regardless of which source reports it. The orchestrator SHALL NOT require access to the portal's message broker.

#### Scenario: Orchestrator downtime
- **WHEN** the orchestrator was down while three tasks completed (webhook deliveries missed or the subscription auto-disabled)
- **THEN** the startup `updatedAfter` catch-up detects all three transitions and each customer is notified exactly once

#### Scenario: Cloud portal
- **WHEN** the portal runs as a remote cloud instance
- **THEN** detection works entirely over HTTPS (webhooks in, REST polling out)

### Requirement: Gated auto-send
Auto-send SHALL occur only when ALL hold: the intent category's 30-day acceptance rate ≥ 85%, the customer has auto-send enabled, and the category is not excluded (new-task notifications, bug reports, and urgent-priority items are always excluded). Auto-sent messages SHALL be logged with `is_draft = false` and announced as FYI in the customer topic. A global kill switch SHALL disable auto-send immediately.

#### Scenario: Threshold not met
- **WHEN** `question_existing` acceptance is 82%
- **THEN** drafts for that category still require approval

### Requirement: Stale-task reminders
Tasks in progress with no update for a configurable number of days (default 5) SHALL trigger a founder reminder offering to draft a customer status update.

#### Scenario: Six silent days
- **WHEN** a HolaDoc task has been in-progress 6 days without updates
- **THEN** the founder sees a reminder in the HolaDoc topic with a one-tap "draft status update" action

### Requirement: Clarification auto-requests
For low-confidence or `unclear` intents, the system SHALL draft a clarification message addressed to the customer (founder-approved before send) rather than only escalating internally.

#### Scenario: Ambiguous request
- **WHEN** a message can't be classified confidently
- **THEN** the founder receives both the escalation and a ready-to-approve clarification draft for the customer
