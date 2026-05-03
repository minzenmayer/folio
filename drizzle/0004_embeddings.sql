-- Folio · 0004_embeddings.sql
-- Sprint 7: retrieval substrate.
--
-- Adds an `embedding vector(1536)` column to ideas and drafts so they can
-- participate in similarity search alongside captures. HNSW indexes use
-- cosine ops to match the @ai-sdk/openai text-embedding-3-small output
-- shape we already store on captures.
--
-- The column stays nullable on purpose: existing rows have no embedding
-- until the backfillEmbeddings server action sweeps them. Save paths
-- (createIdea / updateIdea / createDraft / updateDraft / restoreDraftVersion)
-- compute and store the embedding inline in a best-effort try/catch — same
-- pattern as snapshotVersion: failures log but never block the save.
--
-- Apply via Neon SQL editor, or run npm run db:push against DATABASE_URL.

ALTER TABLE ideas  ADD COLUMN IF NOT EXISTS embedding vector(1536);
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS embedding vector(1536);

CREATE INDEX IF NOT EXISTS idx_ideas_embedding
  ON ideas  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_drafts_embedding
  ON drafts USING hnsw (embedding vector_cosine_ops);
