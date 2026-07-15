# 07 — Founder Memory Explorer

## Intent

Give the founder a protected console surface to inspect the indexed customer corpus,
internal Project Brain, and the curated repository source inventory. The founder can
add, replace, or retire customer/global draft guidance without editing sync-owned
documents or weakening the customer/internal isolation boundary.

## Decisions

- Customer and internal corpora have separate API paths and never share retrieval SQL.
- Synced guides/tasks, history, and Project Brain chunks are read-only evidence.
- Founder guidance is an auditable `correction` memory: facts are relevance-gated and
  style directives use the existing always-on style lane.
- Replacements and retirements mark old guidance `superseded`; all draft-facing
  retrieval and pattern queries exclude it.
- Repository access is the configured source allow-list and index health, not an
  external RBAC integration or live repository query.
