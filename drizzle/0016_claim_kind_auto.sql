-- Phase 18 hotfix — 2026-05-05
--
-- Allow 'auto_claimed' as a value on ideas.claim_kind.
-- Phase 17's auto-claim path writes claim_kind='auto_claimed' for partner
-- ideas rows created from user-authored extracted_ideas (CSL / vault /
-- LinkedIn). The existing ideas_claim_kind_chk CHECK constraint only
-- allowed 'authored' and 'claimed,' rejecting every auto-claim attempt
-- with: new row for relation "ideas" violates check constraint
-- "ideas_claim_kind_chk".
--
-- Drop the old constraint, add a new one that includes the third value.

ALTER TABLE ideas DROP CONSTRAINT IF EXISTS ideas_claim_kind_chk;
ALTER TABLE ideas ADD CONSTRAINT ideas_claim_kind_chk
  CHECK (claim_kind IN ('authored', 'claimed', 'auto_claimed'));
