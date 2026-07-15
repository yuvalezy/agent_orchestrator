# triage-agent — Spec Delta

## ADDED Requirements

### Requirement: Intent extraction with structured output
For each pending inbox row the triage agent SHALL load context (customer config, open tasks via `TaskTargetPort.findOpenTasks`, recent thread messages) and extract one or more intents via `AgentLlmPort` using a JSON-schema-constrained output (category, summary, suggested title, priority, confidence). Model IDs SHALL come from configuration.

#### Scenario: One message, two intents
- **WHEN** a message reports a bug AND asks for a new feature
- **THEN** two intents are extracted and each is routed independently (two tasks, or task + comment)

### Requirement: Intent categories and default actions
The classifier SHALL use the categories `new_feature_request`, `custom_development`, `bug_report`, `question_existing`, `follow_up`, `info_provided`, `compliment`, `unclear`, `new_contact`, with the default actions from the product spec (bug → high-priority task; follow_up/info_provided → comment on the related task; compliment → log; unclear → ask founder).

#### Scenario: Bug report
- **WHEN** an intent is classified `bug_report` with confidence ≥ 0.5
- **THEN** a task is created with priority `high` and tags including `bug`

### Requirement: Deduplication before creation
Before creating a task the agent SHALL: (1) comment instead of create when a task is bridged to the same thread key within 7 days; (2) comment instead of create when title similarity to an open task for the same customer exceeds the threshold; (3) within an existing email thread, always comment — a genuinely new request inside an old thread is additionally flagged to the founder.

#### Scenario: Customer follows up in the same thread
- **WHEN** a customer replies "any update?" in a thread that spawned task T last week
- **THEN** the reply is added as a comment on T with relationship `contributed_to`, and no new task is created

### Requirement: Escalation is a first-class outcome
Intents with confidence < 0.5, category `unclear`, or failed dedup judgment SHALL be routed to the founder via `askFounder` with actionable options; the founder's choice SHALL be executed and recorded as the decision outcome.

#### Scenario: Vague message
- **WHEN** a customer writes "what about the thing we discussed?"
- **THEN** no task is created and the founder gets the message with context and options (create task / comment on task X / ignore)

### Requirement: Every action audited
Each triage run SHALL write an `agent_decisions` row with the full agent output; founder confirmations, undos, and edits SHALL be recorded as `human_override` with outcome `accepted`/`modified`/`rejected` — the raw material for the change-03 learning loop.

#### Scenario: Founder undoes a task
- **WHEN** the founder taps ❌ on a task notification
- **THEN** the task is cancelled via `TaskTargetPort.setStatus` and the decision row outcome becomes `rejected`
