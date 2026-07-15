# llm-gateway

Multi-provider LLM routing (Anthropic/OpenAI/DeepSeek), per-role models, tokens, default + fallback. Shipped by change 01 (M1.4), in `agent_orchestrator`.

## Requirements

### Requirement: Multi-provider LLM support out of the box
The system SHALL ship provider clients for **Anthropic (Claude)**, **OpenAI**, and **DeepSeek**, each with free model selection (model IDs are configuration, never hardcoded). All LLM usage in core code SHALL go through `AgentLlmPort`, which routes to providers via configuration — adding a provider is a new `LlmProviderClient` adapter only.

#### Scenario: Switch triage to DeepSeek
- **WHEN** the triage role is configured as `deepseek:deepseek-chat`
- **THEN** intent extraction runs on DeepSeek with no code change and structured output still validates against the intent schema

### Requirement: Runtime-manageable API tokens per provider
API tokens for any provider SHALL be settable and rotatable at runtime via the admin surface, stored encrypted at rest (AES-256-GCM sealed credentials store, env fallback), never in plaintext DB columns or logs.

#### Scenario: Add a provider token later
- **WHEN** a DeepSeek token is added via the admin endpoint after initial deployment
- **THEN** the DeepSeek provider becomes usable without restart or code change

### Requirement: Default provider with fallback
Configuration SHALL define a default provider and an ordered fallback chain. When the active provider fails hard (auth error, rate-limit exhaustion after retries, 5xx after retries, or provider-declared refusal), the request SHALL be retried on the next provider in the chain with that provider's configured model for the same role; fallback usage SHALL be logged and surfaced in the admin Telegram topic.

#### Scenario: Anthropic outage
- **WHEN** the default provider (Anthropic) returns 529 after retries during triage
- **THEN** the same triage request is completed by the configured fallback provider and an admin notice records the failover

#### Scenario: No silent degradation
- **WHEN** all providers in the chain fail
- **THEN** the inbox row follows the normal retry/failed lifecycle — nothing is dropped or guessed

### Requirement: Role-based model configuration
Each LLM role (triage/intent extraction, similarity judging, drafting — later: query answering) SHALL be independently configurable as `provider:model`, with per-provider defaults when a role doesn't specify one. Structured-output requests SHALL be normalized per provider (Anthropic `output_config.format`; OpenAI/DeepSeek JSON-schema/function modes) behind the same port method.

#### Scenario: Cheap classifier, strong drafter
- **WHEN** roles are configured `classify=deepseek:deepseek-chat`, `draft=anthropic:claude-sonnet-5`
- **THEN** each call uses its role's provider/model and both return schema-valid results

### Requirement: Per-provider usage accounting and daily cost cap
Every LLM call SHALL record provider, model, role, token counts, and computed cost to the cost-tracking table (whatsapp_manager `api_costs` pattern), enabling per-customer/per-day cost reporting. A configurable, timezone-pinned daily cost cap SHALL act as a kill-switch when exceeded.

#### Scenario: Cost report
- **WHEN** the daily admin report runs (change 03)
- **THEN** LLM spend is reportable by provider and by customer

#### Scenario: Daily cap hit
- **WHEN** the day's accumulated cost (in the pinned timezone) reaches the configured cap
- **THEN** further LLM calls are refused rather than silently continuing to spend
