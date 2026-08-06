CREATE TABLE IF NOT EXISTS agent_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  step TEXT NOT NULL,
  state JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_state_run_agent_key
  ON agent_state (run_id, agent_name);
