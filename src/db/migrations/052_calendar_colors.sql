-- 052: per-calendar color — one palette key per calendar_accounts row, so events from each
-- calendar render in a stable, distinguishable color (replaces the FE label-hash). The palette
-- keys (sky, violet, ...) are the single source of truth shared with the FE's CAL_PALETTE.
-- Forward-only, transactional (the migrate runner wraps each file in BEGIN/COMMIT).

-- 1. Add nullable first so the backfill can populate it.
ALTER TABLE calendar_accounts
  ADD COLUMN IF NOT EXISTS color TEXT;

-- 2. Backfill: assign distinct palette keys by row order (Work → sky, Personal → violet, ...).
--    Wrap in a DO block with a CTE that assigns row_number() and maps to the palette array.
--    Idempotent: only touches rows still NULL, so a re-run (or a partial earlier run) is a no-op.
DO $$
DECLARE
  palette TEXT[] := ARRAY['sky','violet','emerald','teal','rose','indigo','fuchsia','cyan'];
BEGIN
  WITH ordered AS (
    SELECT id, (ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) - 1) % 8 AS idx
      FROM calendar_accounts
     WHERE color IS NULL
  )
  UPDATE calendar_accounts ca
     SET color = palette[(o.idx + 1)]
    FROM ordered o
   WHERE ca.id = o.id;
END $$;

-- 3. Make NOT NULL + CHECK. Every row must now have a palette key. Bare ADD CONSTRAINT is safe —
--    the migrate runner is one-shot (forward-only, checksummed in schema_migrations), so it never
--    re-applies this file. Mirrors the named-CHECK pattern in 022 / 050.
ALTER TABLE calendar_accounts
  ALTER COLUMN color SET NOT NULL,
  ADD CONSTRAINT calendar_accounts_color_chk
    CHECK (color IN ('sky','violet','emerald','teal','rose','indigo','fuchsia','cyan'));
