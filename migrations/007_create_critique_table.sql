CREATE TABLE IF NOT EXISTS critique (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  score INTEGER,
  issues JSONB,
  corrected_bom JSONB,
  corrected_proposal JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
