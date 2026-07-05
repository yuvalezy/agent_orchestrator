-- 002: customers
-- ◆ bp_ref/project_ref/work_item_type_ref opaque; default_email_instance_id (was
-- reply_from_email); telegram_topic_id (was telegram_channel_id, D7).
CREATE TABLE agent_customers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bp_ref          TEXT NOT NULL UNIQUE,      -- ◆ opaque CustomerDirectoryPort ref (today: EZY BP UUID)
  display_name    TEXT NOT NULL,
  website         TEXT,
  email_domain    TEXT,                      -- derived from website on save
  project_ref     TEXT,                      -- ◆ target project for new tasks
  work_item_type_ref TEXT,                   -- ◆ required by portal task creation (D5)
  faith           TEXT CHECK (faith IN ('jewish','christian','muslim','buddhist','none')),
  timezone        TEXT DEFAULT 'America/Panama',
  preferred_language TEXT DEFAULT 'es',
  default_email_instance_id UUID REFERENCES channel_instances(id),  -- ◆ was reply_from_email
  telegram_topic_id  TEXT,                   -- ◆ forum topic, was telegram_channel_id (D7)
  backfill_status TEXT DEFAULT 'pending' CHECK (backfill_status IN ('pending','in_progress','done','failed')),
  backfill_cutoff TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
CREATE TRIGGER trg_agent_customers_updated_at BEFORE UPDATE ON agent_customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();   -- ◆ BF2
