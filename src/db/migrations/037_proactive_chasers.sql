-- 037: WP2 proactive chasers — exactly-once (kind, episode) claim ledger for the two
-- polling chaser workers (stale in-progress task status updates + awaiting-reply nudges).
--
-- Both workers re-scan forever, so the SAME chaseable item surfaces on every pass. This
-- ledger is the idempotency gate that turns a repeated observation into a single founder-facing
-- draft, exactly as the M4 task-transition ledger (mig 033) does for done tasks — modelled on it.
--
-- `kind` names the chaser ('stale_task' | 'awaiting_reply'); `ref` is the per-EPISODE key the
-- worker computes so a NEW episode re-arms (and an unchanged one stays suppressed):
--   • stale_task    → '<taskRef>:<updatedAt ISO>'   — a later real update bumps updatedAt →
--                     a new staleness episode may chase again; an unchanged task never re-chases.
--   • awaiting_reply→ '<taskRef>:<lastOutboundAt ISO>' — a customer reply removes the row from
--                     the awaiting query, and a subsequent founder send advances lastOutboundAt →
--                     a new silence episode; the same silence never re-nudges.
--
-- claimChase INSERTs (kind, ref) ON CONFLICT DO NOTHING: the FIRST pass wins the row and drafts;
-- every later pass conflicts and suppresses. Claimed BEFORE the draft so a crash mid-draft is
-- at-most-once (the safe direction — never a second customer-facing draft). releaseChase DELETEs
-- the row so a TRANSIENT notify failure re-observes next tick. Append-only (no updates → no
-- set_updated_at trigger). Forward-only, transactional (the migrate runner wraps each file in
-- BEGIN/COMMIT).
CREATE TABLE IF NOT EXISTS agent_proactive_chaser_ledger (
  kind       TEXT NOT NULL,                    -- the chaser: 'stale_task' | 'awaiting_reply'
  ref        TEXT NOT NULL,                    -- the per-episode claim key (see header)
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ref)
);
