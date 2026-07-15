-- 032: register a customer's on-disk docs corpus in the DB.
--
-- Numbered 032, not 031: 031_founder_push_subscription_actor.sql is already committed
-- on master and 030_telegram_scheduling.sql is in flight, so both ordinals were taken
-- by the time this branch landed. The runner keys on filename, so a duplicate 031
-- would have applied cleanly and hidden a real ambiguity — two unrelated migrations
-- sharing an ordinal, ordered against each other only by lexical accident.
--
-- ADD COLUMN IF NOT EXISTS because this file was briefly numbered 031 and applied
-- under that name to development databases. Those DBs carry the columns but record
-- the old filename, so the rename makes 032 look unapplied and re-runs it; without
-- IF NOT EXISTS that re-run aborts on "column already exists" and takes boot down
-- with it. Same forward-only reconciliation master's own 031 performs for 029.
-- Fresh DBs get columns + CHECK here; already-migrated DBs no-op and keep the CHECK
-- the earlier application created.
--
-- Until now the customer-scoped entries in the compile-time KNOWLEDGE_SOURCES const
-- (adapters/knowledge/sources.ts) were hand-written, so onboarding a customer's docs
-- meant a code edit + redeploy. These two columns let onboarding register the corpus
-- as data; the composition root unions them onto the static const each sync tick.
--
-- Both NULL by default: a customer without docs_root registers NO doc source and is
-- simply never walked. Onboarding writes docs_root ONLY when the directory exists —
-- a guessed path is worse than a NULL (the walker THROWS on a missing root, which
-- would abort the whole corpus reconcile, every customer with it).
--
-- docs_repo selects the checkout base and mirrors KnowledgeSource.repo; NULL means
-- 'portal', where every customer corpus lives today. The CHECK pins it to the same
-- four checkouts the adapter can map to an absolute path, so a typo fails at
-- onboarding time instead of silently skipping the source on every later tick.
-- docs_root is REPO-RELATIVE, mirroring KnowledgeSource.root.
--
-- ⚠︎ No isolation column here on purpose: these docs are scoped by the row's own
-- bp_ref, which the reconciler re-resolves to customer_id and fail-closes on. A
-- customer corpus must NEVER fall back to shared (customer_id NULL = visible to
-- every customer = data leak).

ALTER TABLE agent_customers
  ADD COLUMN IF NOT EXISTS docs_repo TEXT CHECK (docs_repo IN ('portal','ai-agent','wms','ezy-integration')),
  ADD COLUMN IF NOT EXISTS docs_root TEXT;
