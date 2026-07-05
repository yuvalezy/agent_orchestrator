-- 011: TO/CC awareness for the email CC-only rule (M1.6 / DM6-4). First-class
-- column (queryable) rather than parsing raw_metadata. Null for non-email channels.
ALTER TABLE agent_inbox ADD COLUMN recipients JSONB;  -- {"to":[...],"cc":[...]}
