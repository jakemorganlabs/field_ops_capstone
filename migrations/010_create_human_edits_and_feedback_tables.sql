CREATE TABLE IF NOT EXISTS human_edits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  field_path TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  reason TEXT,
  applied BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES run(id) ON DELETE CASCADE,
  rating INTEGER,
  comment TEXT,
  flagged_fields JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
