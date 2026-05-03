-- Folio · 0003_draft_versions.sql
-- Sprint 6 wave 3: version history for drafts.
--
-- Every successful save creates a row here, EXCEPT when the most recent
-- version for the same draft is < 30s old AND source='autosave', in which
-- case updateDraft updates that row in place (the "coalesce window").
-- This keeps storage bounded during active typing without losing the
-- coarse-grained trail.
--
-- Restoring a version creates a NEW row with source='restore' on top of
-- the current draft state — linear, never destructive.
--
-- Apply via Neon SQL editor, or run npm run db:push against DATABASE_URL.

CREATE TABLE IF NOT EXISTS draft_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_json jsonb NOT NULL,
  word_count integer,
  source text NOT NULL,
  -- 'autosave' | 'restore'  (room for 'manual' later)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_draft_versions_draft_created
  ON draft_versions(draft_id, created_at);
