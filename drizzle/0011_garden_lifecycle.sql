-- Phase 14b — Garden redesign · Migration 0011
-- Adds lifecycle columns to ideas + extracted_ideas. All additive, all defaulted,
-- safe to run on a live db with no UI cutover yet.
--
-- Two axes after this lands:
--   maturity (existing, unchanged)
--   temperature (new): 'hot' | 'warm' | 'cool' | 'cold' | 'set_aside'
--
-- See spec: ~/Desktop/Thoughtbed/garden_redesign_spec.md (sections 3 + 7).

-- ── ideas ─────────────────────────────────────────────────────────────
ALTER TABLE ideas
  ADD COLUMN IF NOT EXISTS temperature             text         NOT NULL DEFAULT 'warm',
  ADD COLUMN IF NOT EXISTS temperature_updated_at  timestamptz  NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS digest_surface_count    integer      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS digest_surface_first_at timestamptz,
  ADD COLUMN IF NOT EXISTS pinned_until            timestamptz,
  ADD COLUMN IF NOT EXISTS claim_kind              text         NOT NULL DEFAULT 'authored';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ideas_temperature_chk'
  ) THEN
    ALTER TABLE ideas
      ADD CONSTRAINT ideas_temperature_chk
      CHECK (temperature IN ('hot', 'warm', 'cool', 'cold', 'set_aside'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ideas_claim_kind_chk'
  ) THEN
    ALTER TABLE ideas
      ADD CONSTRAINT ideas_claim_kind_chk
      CHECK (claim_kind IN ('authored', 'claimed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ideas_temperature ON ideas (user_id, temperature);

-- ── extracted_ideas ───────────────────────────────────────────────────
ALTER TABLE extracted_ideas
  ADD COLUMN IF NOT EXISTS temperature            text         NOT NULL DEFAULT 'cool',
  ADD COLUMN IF NOT EXISTS temperature_updated_at timestamptz  NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS digest_surface_count   integer      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claim_text             text;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'extracted_ideas_temperature_chk'
  ) THEN
    ALTER TABLE extracted_ideas
      ADD CONSTRAINT extracted_ideas_temperature_chk
      CHECK (temperature IN ('hot', 'warm', 'cool', 'cold', 'set_aside'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_extracted_ideas_temperature
  ON extracted_ideas (user_id, temperature);

-- ── snooze migration (snooze concept dies; map existing snoozed → pending+cold) ──
UPDATE extracted_ideas
   SET triage_status = 'pending',
       temperature = 'cold',
       temperature_updated_at = now()
 WHERE triage_status = 'snoozed';
