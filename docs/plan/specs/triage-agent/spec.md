# triage-agent

Intent extraction, classification, action routing. Shipped by change 01 (M1.5b, M1.6, M1.7), in `agent_orchestrator`.

## Requirements

### Requirement: Intent extraction with structured output
For each pending inbox row the triage agent SHALL load context (customer config, open tasks via `TaskTargetPort`, recent thread messages) and extract one or more intents via `AgentLlmPort` using a JSON-schema-constrained output (category, summary, suggested title, priority, confidence). Model IDs SHALL come from configuration.

#### Scenario: One message, two intents
- **WHEN** a message reports a bug AND asks for a new feature
- **THEN** two intents are extracted and each is routed independently (two tasks, or task + comment), and dedup for the second intent excludes tasks created earlier in the same triage run

### Requirement: Intent categories and default actions
The classifier SHALL use the categories `new_feature_request`, `custom_development`, `bug_report`, `question_existing`, `follow_up`, `info_provided`, `compliment`, `unclear`, `new_contact`, with the default actions from the product spec (bug → high-priority task; follow_up/info_provided → comment on the related task; compliment → log; unclear → ask founder).

#### Scenario: Bug report
- **WHEN** an intent is classified `bug_report` with confidence ≥ 0.5
- **THEN** a task is created with priority `high` and tags including `bug`

### Requirement: Deduplication order — portal source-triple first, then bridge, then similarity
Before creating a task the agent SHALL check, in order: (1) `TaskTargetPort.findTasksBySource` for the thread's source triple across **all** statuses (the portal forbids a second task per thread ever, not just while open) — any match is commented on, full stop; (2) the local `agent_tasks` bridge for a task created from this thread within 7 days; (3) title-similarity ≥ 0.8 against the same customer's currently-**open** tasks, to best-effort bridge a genuinely new request that arrives on a different channel/thread than the original. Within an existing email thread, step (1)/(2) always wins — a genuinely new request inside an old thread is additionally flagged to the founder rather than silently commented.

#### Scenario: Customer follows up in the same thread
- **WHEN** a customer replies "any update?" in a thread that spawned task T last week
- **THEN** the reply is added as a comment on T with relationship `contributed_to`, and no new task is created

#### Scenario: Cross-channel duplicate is a known, accepted gap
- **WHEN** a customer asks about the same issue once over WhatsApp and once over email
- **THEN** two tasks may be created — dedup keys per-channel on the source triple, and the fuzzy title-similarity step is best-effort only; this is accepted for Phase 1 (a false merge across genuinely different requests is worse than an occasional duplicate) and is deferred to change 02, where embeddings supply a real cross-channel identity signal

### Requirement: Escalation is a first-class outcome
Intents with confidence < 0.5, category `unclear`, or failed dedup judgment SHALL be routed to the founder via `askFounder` with actionable options; the founder's choice SHALL be executed and recorded as the decision outcome.

#### Scenario: Vague message
- **WHEN** a customer writes "what about the thing we discussed?"
- **THEN** no task is created and the founder gets the message with context and options (create task / comment on task X / ignore)

### Requirement: CC-only email requires an explicit, confident ask to act
An email where the founder's account is only in CC (not TO) SHALL stay context-only (no task, no founder ping) unless the extracted intent is both confidently actionable and a real ask directed at the founder — a CC'd low-confidence or unclear intent never pings.

#### Scenario: Founder CC'd on an internal customer thread
- **WHEN** the founder is CC'd on an email between two other people with no direct ask
- **THEN** the message is stored for context only — no task, no notification

### Requirement: Service desk resolution prefers the BP reference
For service desk tickets, contact resolution SHALL try the ticket's business-partner reference first (`findCustomerByBpRef`), then email-contact match, then domain-based proposal, then skip — since a ticket's `requesterBPID`/`requesterContactID` is the most reliable link when populated.

#### Scenario: Ticket with a populated BP reference
- **WHEN** a new ticket has `requesterBPID` set to a known customer's BP
- **THEN** the ticket resolves directly to that customer without falling back to email/domain matching

### Requirement: Every action audited
Each triage run SHALL write an `agent_decisions` row with the full agent output; founder confirmations, undos, and edits SHALL be recorded as `human_override` with outcome `accepted`/`modified`/`rejected` — the raw material for the change-03 learning loop.

#### Scenario: Founder undoes a task
- **WHEN** the founder taps ❌ on a task notification
- **THEN** the task is cancelled via `TaskTargetPort.setStatus` and the decision row outcome becomes `rejected`
