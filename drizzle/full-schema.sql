-- Folio · v0 full schema
-- Paste this entire file into Neon's SQL Editor and Run.
-- It enables pgvector and creates all 8 tables + indexes.
-- Equivalent to running `npm run db:push` locally.

-- ─── Extensions ───
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── USERS ───
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_id text NOT NULL UNIQUE,
  email text NOT NULL,
  name text,
  created_at timestamptz DEFAULT now()
);

-- ─── IDEAS ───
CREATE TABLE IF NOT EXISTS ideas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  essence text,
  posed_as text,
  tags text[] DEFAULT '{}',
  themes text[] DEFAULT '{}',
  maturity text NOT NULL DEFAULT 'seed',
  energy text NOT NULL DEFAULT 'active',
  origin text NOT NULL DEFAULT 'captured',
  origin_ref uuid,
  parent_idea_id uuid REFERENCES ideas(id),
  weight integer DEFAULT 0,
  pull integer DEFAULT 0,
  heat real DEFAULT 0,
  embedding vector(1536),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  last_visited_at timestamptz,
  last_evolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ideas_user_visited ON ideas(user_id, last_visited_at);
CREATE INDEX IF NOT EXISTS idx_ideas_user_maturity ON ideas(user_id, maturity);
CREATE INDEX IF NOT EXISTS idx_ideas_embedding
  ON ideas USING hnsw (embedding vector_cosine_ops);

-- ─── CAPTURES ───
CREATE TABLE IF NOT EXISTS captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idea_id uuid REFERENCES ideas(id) ON DELETE SET NULL,
  type text NOT NULL,
  source text,
  body text NOT NULL,
  summary text,
  embedding vector(1536),
  status text DEFAULT 'inbox',
  captured_via text NOT NULL,
  captured_at timestamptz DEFAULT now(),
  metadata jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_captures_embedding
  ON captures USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_captures_user_idea
  ON captures(user_id, idea_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_captures_inbox
  ON captures(user_id, status) WHERE status = 'inbox';

-- ─── ARTIFACTS ───
CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  format text NOT NULL DEFAULT 'draft',
  title text NOT NULL,
  body jsonb NOT NULL DEFAULT '{}',
  status text DEFAULT 'draft',
  voice_match_score real,
  word_count integer DEFAULT 0,
  built_at timestamptz DEFAULT now(),
  shipped_at timestamptz,
  shipped_destination text,
  ingredient_idea_ids uuid[] DEFAULT '{}',
  embedding vector(1536)
);

-- ─── THREADS ───
CREATE TABLE IF NOT EXISTS threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'journal',
  created_at timestamptz DEFAULT now(),
  last_evolved_at timestamptz
);

-- ─── THREAD ENTRIES ───
CREATE TABLE IF NOT EXISTS thread_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  body text NOT NULL,
  entry_type text NOT NULL DEFAULT 'text',
  source_capture_id uuid REFERENCES captures(id),
  source_artifact_id uuid REFERENCES artifacts(id),
  created_at timestamptz DEFAULT now(),
  embedding vector(1536)
);

-- ─── IDEA EDGES ───
CREATE TABLE IF NOT EXISTS idea_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_idea uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  to_idea uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  kind text NOT NULL,
  strength real DEFAULT 1,
  user_confirmed integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- ─── ASSISTANT_OFFERS ───
CREATE TABLE IF NOT EXISTS assistant_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid REFERENCES artifacts(id) ON DELETE CASCADE,
  paragraph_index integer,
  offer_type text NOT NULL,
  source_capture_id uuid REFERENCES captures(id),
  source_idea_id uuid REFERENCES ideas(id),
  confidence real,
  acted_on integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- ─── DRAFTS ───  (Sprint 5: The Page; version added in Sprint 6; embedding in Sprint 7)
CREATE TABLE IF NOT EXISTS drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text,
  content_json jsonb NOT NULL,
  idea_id uuid REFERENCES ideas(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1,
  embedding vector(1536),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_drafts_user_updated
  ON drafts(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_drafts_embedding
  ON drafts USING hnsw (embedding vector_cosine_ops);

-- ─── DRAFT_VERSIONS ───  (Sprint 6 wave 3: history trail)
CREATE TABLE IF NOT EXISTS draft_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_json jsonb NOT NULL,
  word_count integer,
  source text NOT NULL,
  -- 'autosave' | 'restore'
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_draft_versions_draft_created
  ON draft_versions(draft_id, created_at);

-- Done. You should now have 10 tables visible in Neon's Tables panel.
