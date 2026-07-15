# founder-notifications — Spec Delta

## MODIFIED Requirements

### Requirement: Notifier behind a port
All founder-facing notifications SHALL go through `FounderNotifierPort`. Telegram SHALL remain the default implementation; the console MAY add a push implementation without changing triage, outbound, or core decision code. Push fan-out SHALL be explicitly configured and default to Telegram-only for routine events.

#### Scenario: Urgent push is enabled
- **WHEN** an event is classified urgent and the founder has an active push device
- **THEN** the notifier may deliver it through Telegram and push while using the same notification/decision identity

#### Scenario: Push is unavailable
- **WHEN** no device is registered or push delivery fails
- **THEN** the existing Telegram notification path continues and no customer-facing action is lost

### Requirement: Inline-button decisions
Actionable founder notifications SHALL carry an idempotent decision identity. Telegram and the console SHALL resolve the same persisted decision or queue row with conditional state changes; the first successful action wins and any later action SHALL be a no-op that reflects the handled state.

#### Scenario: Concurrent console and Telegram action
- **WHEN** the founder approves or resolves an action in the console while a Telegram callback for the same action is processed
- **THEN** at most one conditional state transition succeeds and both surfaces show the resulting handled state
