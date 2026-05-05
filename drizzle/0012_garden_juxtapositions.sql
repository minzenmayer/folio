-- Phase 14b — Garden redesign · Migration 0012
-- New tables: garden_juxtapositions, garden_digest_runs.
-- See spec: ~/Desktop/Thoughtbed/garden_redesign_spec.md sections 6 + 7.

CREATE TABLE IF NOT EXISTS garden_juxtapositions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  heuristic    text        NOT NULL,

  left_kind    text        NOT NULL,
  left_id      uuid        NOT NULL,
  right_kind   text        NOT NULL,
  right_id     uuid        NOT NULL,

  question     text        NOT NULL,
  reasoning    text        NOT NULL,
  score        real        NOT NULL,

  surfaced_at  timestamptz,
  acted_on     text,
  acted_at     timestamptz,

  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT garden_juxtapositions_left_kind_chk
    CHECK (left_kind IN ('idea', 'extracted_idea')),
  CONSTRAINT garden_juxtapositions_right_kind_chk
    CHECK (right_kind IN ('idea', 'extracted_idea')),
  CONSTRAINT garden_juxtapositions_heuristic_chk
    CHECK (heuristic IN ('tension_within_theme', 'self_disagreement', 'old_echo_of_new')),
  CONSTRAINT garden_juxtapositions_acted_chk
    CHECK (acted_on IS NULL OR acted_on IN ('opened', 'claimed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS idx_garden_juxtapositions_user_surfaced
  ON garden_juxtapositions (user_id, surfaced_at);

CREATE INDEX IF NOT EXISTS idx_garden_juxtapositions_user_pending
  ON garden_juxtapositions (user_id, score DESC)
  WHERE surfaced_at IS NULL;

CREATE TABLE IF NOT EXISTS garden_digest_runs (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_date          date        NOT NULL,
  selected          jsonb       NOT NULL,
  juxtaposition_id  uuid        REFERENCES garden_juxtapositions(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT garden_digest_runs_user_date_unique UNIQUE (user_id, run_date)
);

CREATE INDEX IF NOT EXISTS idx_garden_digest_runs_user_date
  ON garden_digest_runs (user_id, run_date DESC);
