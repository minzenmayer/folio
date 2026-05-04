-- Direction B (2026-05-04): triage flow on extracted_ideas.
--
-- Insights becomes a queue, not a flat browse view. Each auto-extracted
-- claim starts as 'pending'. The user triages with:
--
--   · promote  → copies the claim into ideas (maturity='seed') with a
--                back-pointer; extracted row stays but flips to
--                'promoted' so it disappears from the default queue.
--   · dismiss  → flips to 'dismissed', gone from the queue forever.
--   · snooze   → flips to 'snoozed' with a snooze_until 30 days out.
--                The default query (triage_status='pending' OR snoozed
--                AND snooze_until <= now()) reads it back when ripe.
--
-- Existing rows default to 'pending' so today's 200+ claims become a
-- triage backlog. Garden (/studio/ideas) is the single curated layer,
-- now seeded from both manual + promoted ideas.

ALTER TABLE "extracted_ideas"
  ADD COLUMN IF NOT EXISTS "triage_status" text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "triaged_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "snooze_until" timestamp with time zone;

-- Index to keep the default Insights query fast: we WHERE on
-- (user_id, triage_status) plus a snooze_until tail check. Composite
-- on the two hot columns; snooze_until stays unindexed (only ~10% of
-- rows will ever carry it).
CREATE INDEX IF NOT EXISTS "idx_extracted_ideas_user_triage"
  ON "extracted_ideas" ("user_id", "triage_status");

-- Back-pointer on ideas: when a row was promoted from an extracted
-- idea, link back so the Garden card can render "from <source>" and
-- click-through to the original. Nullable because hand-authored ideas
-- don't have a source. ON DELETE SET NULL — if the source row is
-- garbage-collected (e.g. source content disappeared), the promoted
-- idea stays alive but loses its provenance link.
ALTER TABLE "ideas"
  ADD COLUMN IF NOT EXISTS "source_extracted_idea_id" uuid
    REFERENCES "extracted_ideas"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "idx_ideas_source_extracted"
  ON "ideas" ("source_extracted_idea_id")
  WHERE "source_extracted_idea_id" IS NOT NULL;
