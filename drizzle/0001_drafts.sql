-- Folio · 0001_drafts.sql
-- Sprint 5: The Page (Tiptap writing surface).
-- Adds the `drafts` table for in-progress writing.
-- Apply via Neon SQL editor, or run `npm run db:push` against DATABASE_URL.

CREATE TABLE IF NOT EXISTS drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text,
  content_json jsonb NOT NULL,
  idea_id uuid REFERENCES ideas(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_drafts_user_updated
  ON drafts(user_id, updated_at);
