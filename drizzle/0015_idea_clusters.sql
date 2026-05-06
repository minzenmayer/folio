-- Phase 17 — Garden maturation v2 · 2026-05-05
--
-- Two changes:
--   1. New table `idea_clusters` — per-day cluster snapshots produced by
--      the garden-digest cron. Each row is one cluster: a representative
--      idea/extracted_idea + its members + the shared theme tag (if any).
--      Cluster view default Garden surface reads today's run from here.
--   2. New column `users.phase17_seeded_at` — gates the one-time
--      onboarding mass-claim pass (sets when the pass completes; null
--      means the pass has not run yet for this user).
--
-- The `claim_kind = 'auto_claimed'` value is enforced at the application
-- layer only. The column is plain text, no DB-level CHECK constraint to
-- update. Drizzle schema picks up the new value via TypeScript types.

CREATE TABLE idea_clusters (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_date     date NOT NULL,
  rep_kind     text NOT NULL CHECK (rep_kind IN ('idea', 'extracted_idea')),
  rep_id       uuid NOT NULL,
  theme        text,
  member_count integer NOT NULL DEFAULT 1,
  members      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, run_date, rep_kind, rep_id)
);

CREATE INDEX idx_idea_clusters_user_date
  ON idea_clusters (user_id, run_date DESC);

ALTER TABLE users
  ADD COLUMN phase17_seeded_at timestamptz;
