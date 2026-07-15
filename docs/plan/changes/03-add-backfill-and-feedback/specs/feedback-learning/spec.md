# feedback-learning — Spec Delta

## ADDED Requirements

### Requirement: Corrections become memory
Every `agent_decisions` row resolved as `modified` or `rejected` SHALL produce a customer-scoped `agent_memory` row of type `feedback` containing the original message, the agent's output, and the human correction; retrieval SHALL weight `feedback` chunks above ordinary matches of similar relevance.

#### Scenario: Wrong-language draft corrected
- **WHEN** the founder rewrites an English draft into Spanish for a Spanish-speaking customer
- **THEN** the next draft for a similar question from that customer retrieves the feedback chunk and is generated in Spanish

### Requirement: Acceptance-rate metrics
The system SHALL compute rolling 30-day acceptance rates (accepted / modified / rejected) per intent category and per customer from `agent_decisions`, persist them, and post a daily summary to the admin Telegram topic. These metrics are the authoritative input for change 04 auto-send gating.

#### Scenario: Daily report
- **WHEN** the daily rollup runs
- **THEN** the admin topic receives draft counts, acceptance percentages, task counts, and the top rejection reason for the day

### Requirement: Cross-customer pattern detection
A weekly scan SHALL cluster the week's intents across customers and flag themes raised by 3+ customers to the admin topic as product/documentation suggestions.

#### Scenario: Shared feature demand
- **WHEN** three customers ask about Excel export in one week
- **THEN** the admin topic receives a pattern message naming the theme and the customers
