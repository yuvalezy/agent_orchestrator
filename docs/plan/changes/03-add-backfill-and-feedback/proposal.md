# Change 03 — Backfill, Memory Seeding & Feedback Loop (Phase 3)

**Depends on:** 02 deployed (memory store exists).

## Why

A newly onboarded customer starts with an empty memory — the agent can't answer "what's the history on the audit feature?". Backfill seeds ~1.5 years of history per customer. Separately, founder corrections captured since change 01 should start teaching the agent, with acceptance-rate metrics telling us when auto-send (change 04) is safe.

## What changes

| Capability | Summary |
|---|---|
| `backfill` (new) | Resumable per-customer, per-source import driven by `agent_backfill_progress` checkpoints. Sources in order: portal projects/tasks → service desk tickets → email (both instances, cutoff-bounded, via `ChannelAdapter.fetchHistory`) → WhatsApp history. Progress reported to the customer's Telegram topic. Starred-email review flow (one-time, during backfill only). |
| `feedback-learning` (new) | Corrections from `agent_decisions` written into `agent_memory` as `feedback` chunks (original message + agent output + human correction) and injected into future retrieval; daily acceptance-rate report to the admin topic; weekly cross-customer pattern detection. |
| `channel-gateway` (modified) | `fetchHistory` implemented for WhatsApp (whatsapp_manager `GET /messages/:number` keyset paging + export endpoints) and Gmail (query-bounded thread listing). |
| `customer-registry` (modified) | Onboarding transitions `backfill_status` and triggers the backfill job automatically. |

## Key design points

- `agent_backfill_progress` uses `(customer_id, source_ref)` rows where `source_ref` is a channel instance id or the literal `target:projects` / `target:service_desk` — consistent with the registry model, checkpoint every 50 items, resumable after any failure.
- Backfilled inbox rows carry `is_backfill = true` and never enter triage — they exist for context and memory embedding only.
- Feedback memory gets a retrieval boost (recency + type weighting) so corrections influence similar future messages quickly.
- Acceptance metrics computed from `agent_decisions` (per intent category, per customer, 30-day window) — the exact gate change 04 reads.

## Success criteria

After onboarding + backfill, a query like "history with HolaDoc on the audit feature" retrieves accurate backfilled context; daily report shows acceptance rate trending; corrections demonstrably alter subsequent drafts for similar questions.
