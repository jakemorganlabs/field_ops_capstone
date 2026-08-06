CREATE TABLE IF NOT EXISTS audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES run(id) ON DELETE SET NULL,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  action TEXT NOT NULL,
  old_value JSONB,
  new_value JSONB,
  actor TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
