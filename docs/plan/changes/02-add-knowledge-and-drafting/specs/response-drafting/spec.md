# response-drafting — Spec Delta

## ADDED Requirements

### Requirement: Cited drafts for answerable questions
For `question_existing` intents, the system SHALL retrieve relevant memory and generate a reply draft in the customer's preferred language, queued with `is_draft = true` and presented in Telegram with source citations and approve/edit/reject buttons. No draft SHALL be sent without founder action in this change.

#### Scenario: Question answered from a guide
- **WHEN** a customer asks how to export commissions and the commissions guide covers it
- **THEN** a draft citing "Guide: Commissions Module" appears in the customer's topic for approval

### Requirement: Approval outcomes recorded
Approve SHALL release the queue row for delivery; edit SHALL send the founder's text and record the correction; reject SHALL cancel and record. All three land in `agent_decisions` with outcomes usable for acceptance-rate metrics (change 03) and auto-send gating (change 04).

#### Scenario: Edited draft
- **WHEN** the founder edits a draft before sending
- **THEN** the customer receives the edited text and the decision row stores both versions with outcome `modified`

### Requirement: Channel-correct delivery
Approved drafts SHALL deliver through the same channel instance the question arrived on, threaded correctly (email `In-Reply-To`/`References`; ticket thread reply; WhatsApp to the originating contact/group). Founder-initiated *new* emails SHALL use the customer's `default_email_instance_id`. Personal and work email accounts SHALL never cross-contaminate a thread.

#### Scenario: In-thread email reply
- **WHEN** a question arrived on the work Gmail account in thread T
- **THEN** the approved draft is sent from the work account into thread T

### Requirement: Release-note customer notifications
When release notes are ingested, the system SHALL identify customers with related task history, draft a personalized notification per customer in their language and primary channel, and queue the drafts for approval.

#### Scenario: Feature shipped that a customer requested
- **WHEN** release notes mention the audit-export feature requested by HolaDoc
- **THEN** a HolaDoc-specific draft notification appears for approval, referencing their original request
