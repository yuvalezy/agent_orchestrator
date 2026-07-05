-- 005: task bridge ◆ opaque task_ref
CREATE TABLE agent_tasks (
  id              BIGSERIAL PRIMARY KEY,
  task_ref        TEXT NOT NULL,             -- opaque TaskTargetPort ref (today: EZY task UUID)
  customer_id     UUID REFERENCES agent_customers(id),
  inbox_message_id BIGINT REFERENCES agent_inbox(id),
  relationship    TEXT CHECK (relationship IN ('created_from','contributed_to','follow_up')),
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_agent_tasks_ref ON agent_tasks(task_ref);
CREATE INDEX idx_agent_tasks_inbox ON agent_tasks(inbox_message_id);
