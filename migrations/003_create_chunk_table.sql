CREATE TABLE IF NOT EXISTS chunk (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  embed_model TEXT NOT NULL,
  embedding VECTOR(1536),
  text TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  source TEXT NOT NULL,
  region TEXT,
  date DATE,
  page INTEGER,
  section TEXT,
  object_key TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS chunk_content_hash_index_model_key
  ON chunk (content_hash, chunk_index, embed_model);

CREATE INDEX IF NOT EXISTS chunk_embedding_hnsw_idx
  ON chunk USING hnsw (embedding vector_cosine_ops);
