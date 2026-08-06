CREATE TABLE IF NOT EXISTS spec (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_name TEXT NOT NULL,
  client_name TEXT,
  location TEXT,
  region TEXT,
  start_date DATE,
  end_date DATE,
  scope TEXT NOT NULL,
  materials JSONB,
  labor JSONB,
  constraints JSONB,
  notes TEXT,
  raw_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
