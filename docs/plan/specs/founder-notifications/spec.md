# founder-notifications

Notifier port + Telegram adapter, approval flow. Shipped by change 01 (M1.2, M1.5b), in `agent_orchestrator`.

## Requirements

### Requirement: Notifier behind a port
All founder-facing notifications SHALL go through `FounderNotifierPort` (customer event, admin event, ask-with-options, decision callback). The Telegram implementation SHALL be replaceable (change 06 adds mobile push alongside it).

#### Scenario: Second notifier later
- **WHEN** a push-notification implementation is added in change 06
- **THEN** triage and outbound code emit notifications unchanged

### Requirement: One forum supergroup, one topic per customer
The Telegram adapter SHALL post customer events into that customer's forum topic (created at onboarding via `createForumTopic`) and system/ops events into a pinned admin topic. Notification templates SHALL include channel, sender, message excerpt, classified intent, and a deep link to the created/updated task.

#### Scenario: New task notification
- **WHEN** a task is created from a HolaDoc WhatsApp message
- **THEN** the HolaDoc topic receives the templated notification with intent, priority, and task link

### Requirement: Inline-button decisions
Actionable notifications SHALL carry inline keyboard buttons (e.g. ✅ keep / ❌ undo; add contact / ignore). Button presses SHALL be acknowledged within Telegram, routed to the registered decision handler, and be idempotent (double-taps do not double-execute). The decision handler SHALL apply the underlying state change (e.g. `TaskTargetPort.setStatus`) before recording the notification as resolved, so a crash between the two never leaves a resolved notification whose action didn't happen.

#### Scenario: Undo task
- **WHEN** the founder taps ❌ on a new-task notification
- **THEN** the task is cancelled, the message is edited to show "undone", and the decision is recorded

### Requirement: Free-text founder input in context
When the agent asks a question in a topic, a subsequent founder text reply in that topic SHALL be captured and attached to the pending question as the founder's answer.

#### Scenario: Clarifying an unclear message
- **WHEN** the agent posts "Not enough context — what should I do?" and the founder replies "create a task titled X"
- **THEN** the reply resolves the pending decision and the described action is executed

### Requirement: Notification delivery is never marked complete before dispatch succeeds
The Telegram update-polling cursor SHALL only advance past an update once its resulting notification/dispatch has actually succeeded; a failed dispatch SHALL be retried on the next poll rather than silently skipped by cursor advancement.

#### Scenario: Dispatch fails transiently
- **WHEN** sending a notification for a given update fails
- **THEN** the poll cursor does not advance past that update, and the next poll retries it
