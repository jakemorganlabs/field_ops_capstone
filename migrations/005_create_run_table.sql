CREATE TABLE IF NOT EXISTS run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  spec_id UUID REFERENCES spec(id) ON DELETE SET NULL,
  proposal JSONB,
  bom JSONB,
  critique JSONB,
  total_cost TEXT,
  error TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
