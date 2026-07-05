-- 008: business hours + holidays (unchanged from spec)
CREATE TABLE agent_business_hours (
  id              SERIAL PRIMARY KEY,
  day_of_week     SMALLINT CHECK (day_of_week BETWEEN 0 AND 6),  -- 0=Sunday
  start_time      TIME NOT NULL DEFAULT '09:00',
  end_time        TIME NOT NULL DEFAULT '18:00',
  is_working_day  BOOLEAN DEFAULT true
);

CREATE TABLE agent_holidays (
  id              SERIAL PRIMARY KEY,
  holiday_date    DATE NOT NULL,
  name            TEXT,
  faith           TEXT,
  UNIQUE(holiday_date, faith)
);

-- Phase 1 seed: Mon–Fri 09:00–18:00 working (tasks.md 2.3).
INSERT INTO agent_business_hours (day_of_week, start_time, end_time, is_working_day) VALUES
  (0, '09:00', '18:00', false), (1, '09:00', '18:00', true), (2, '09:00', '18:00', true),
  (3, '09:00', '18:00', true),  (4, '09:00', '18:00', true), (5, '09:00', '18:00', true),
  (6, '09:00', '18:00', false);
