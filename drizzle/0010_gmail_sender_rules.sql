-- Phase 14a (2026-05-04): Gmail sender rules — allowlist + blocklist.
--
-- Triage burden reduction. Lets the user pre-decide what should and
-- shouldn't land in the Gmail triage queue without re-reading every
-- message from the same sender.
--
-- Two rule kinds, exclusive per row:
--   · sender_address rule (fully-qualified, e.g. "lenny@lennysnewsletter.com")
--   · sender_domain rule  (e.g. "nba.com")
-- Per-address rules win over per-domain rules at evaluation time.
--
-- Two actions:
--   · 'allow' — bypass triage. Detected message lands as status='promoted'
--               on ingest, embeds + extracts ideas in the same pass.
--   · 'block' — never reach the triage queue. classifyAndPersist drops the
--               message before parseGmailMessage even runs.
--
-- The XOR check enforces the "exactly one of address-or-domain" invariant.
-- The UNIQUE constraint prevents duplicate (user, target, action) rows so
-- the auto-suggested-rules path can use plain INSERT … ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS "gmail_sender_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "sender_address" text,
  "sender_domain" text,
  "action" text NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "gmail_sender_rules_xor"
    CHECK ((sender_address IS NOT NULL)::int + (sender_domain IS NOT NULL)::int = 1),
  CONSTRAINT "gmail_sender_rules_action_chk"
    CHECK (action IN ('allow', 'block')),
  CONSTRAINT "gmail_sender_rules_unique"
    UNIQUE (user_id, sender_address, sender_domain, action)
);

-- Hot-path lookups: per-(user, sender_address) and per-(user, sender_domain).
-- Partial so each index only carries the rows that have the column set.
CREATE INDEX IF NOT EXISTS "idx_gmail_sender_rules_user_addr"
  ON "gmail_sender_rules" ("user_id", "sender_address")
  WHERE "sender_address" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_gmail_sender_rules_user_domain"
  ON "gmail_sender_rules" ("user_id", "sender_domain")
  WHERE "sender_domain" IS NOT NULL;
