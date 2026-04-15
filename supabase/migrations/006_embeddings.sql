CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS embedding vector(1536);

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS resume_text text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS resume_embedding vector(1536);

CREATE INDEX IF NOT EXISTS jobs_embedding_idx
  ON jobs USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS profiles_embedding_idx
  ON profiles USING hnsw (resume_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
