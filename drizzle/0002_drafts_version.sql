-- Folio · 0002_drafts_version.sql
-- Sprint 6: optimistic concurrency for drafts.
--
-- Adds a `version` column that's bumped on every successful update.
-- updateDraft uses WHERE id=? AND version=? to detect concurrent edits
-- (e.g. same draft open in two tabs). On mismatch, the action returns
-- the server's current state and the client surfaces a conflict banner.
--
-- All existing rows get version=1 (the default). New rows from createDraft
-- also start at 1 (Drizzle picks up the default). After a successful save
-- the value becomes 2, then 3, etc.
--
-- Apply via Neon SQL editor, or run npm run db:push against DATABASE_URL.

ALTER TABLE drafts
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
