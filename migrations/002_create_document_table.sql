CREATE TABLE IF NOT EXISTS document (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id TEXT NOT NULL,
  source TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  region TEXT,
  date DATE,
  page INTEGER,
  section TEXT,
  object_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  raw_text TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS document_external_id_source_key
  ON document (external_id, source);
