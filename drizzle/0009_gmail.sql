-- Phase 13 (2026-05-04): Gmail OAuth connector for subscribed-newsletter ingest.
--
-- Adds gmail_messages (mirrors linkedin_posts shape with Gmail-specific
-- header columns) and extends extracted_ideas to point at a fourth source
-- kind. The XOR check on extracted_ideas grows a fourth branch so a row
-- still references exactly one of:
--   newsletter_issue, obsidian_note, linkedin_post, gmail_message.
--
-- OAuth refresh token lives encrypted on connector_accounts.encryptedSecret
-- (same crypto module as Beehiiv). Access tokens expire ~1hr and are
-- re-minted on demand via getOrRefreshAccessToken() — never persisted.
-- connector_accounts.metadata carries:
--   { googleEmail, lastHistoryId, syncCompletedAt, googleClientIdHash? }
--
-- Triage (per Direction B / commit 3673f99): every detected message lands
-- as status='pending'. The user promotes / dismisses / snoozes from a new
-- tab on /studio/insights. Only status='promoted' messages are eligible
-- for embedding + extractIdeas + Reflect retrieval.

-- ─── gmail_messages ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS "gmail_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "connector_account_id" uuid NOT NULL REFERENCES "connector_accounts"("id") ON DELETE CASCADE,

  -- Gmail message id (e.g. "18f3c1a2b9d4e7f0"). Composite uniqueness
  -- with user_id so re-syncs are idempotent.
  "external_id" text NOT NULL,

  -- Gmail thread id. Same message can recur across syncs; the thread id
  -- groups a conversation if we ever want to roll up.
  "thread_id" text,

  -- Sender. from_address is the parsed RFC-5322 mailbox (e.g.
  -- "lenny@lennysnewsletter.com"); from_name is the display name when
  -- present. Both nullable because malformed messages exist.
  "from_address" text,
  "from_name" text,

  -- Gmail Subject header. Retained verbatim — we use it for the triage
  -- UI list, the Reflect rail label ("newsletter you read: <subject>"),
  -- and as part of the embedded blob.
  "subject" text,

  -- Gmail's auto-generated 100-200 char preview. Cheap to surface in the
  -- triage list without rendering the full body.
  "snippet" text,

  -- Stripped plaintext body — what we feed to embedText + extractIdeas.
  -- Capped at 16k chars at write time (extractIdeas truncates at 12k;
  -- 4k headroom for cleaning to take a second pass without re-fetching).
  "body_text" text,

  -- Original HTML kept for forward-compat (rendering links/images in the
  -- triage UI, future "view original" surface). Nullable because some
  -- newsletters are plaintext-only.
  "body_html" text,

  -- Same single-source-of-truth pattern as linkedin_posts: body_clean is
  -- what retrieval reads, body_text is the raw strip. Lets pre-embed
  -- cleaning land later without backfilling embeddings.
  "body_clean" text,

  -- Gmail's internalDate (ms-since-epoch from Gmail's servers, not the
  -- Date: header — internalDate is what Gmail sorts by). Coerced to
  -- timestamptz at insert time. NOT NULL because every Gmail message has it.
  "posted_at" timestamp with time zone NOT NULL,

  -- Detection-quality audit. Records WHICH heuristic flagged this message
  -- as a newsletter so we can spot-check the false-positive rate later.
  --   'detected_substack' | 'detected_beehiiv' | 'detected_mailchimp'
  --   | 'detected_convertkit' | 'detected_ghost' | 'detected_buttondown'
  --   | 'list_unsubscribe' | 'subject_keyword'
  "newsletter_kind" text NOT NULL,

  -- Triage state. Mirrors extracted_ideas.triage_status semantics:
  --   'pending'   — fresh ingest, awaiting user attention.
  --   'promoted'  — user said "this is a real newsletter, ingest it".
  --                 On promote: embed + extractIdeas fire.
  --   'dismissed' — user said "not a newsletter, ignore". Row stays for
  --                 audit trail but embedding stays null forever.
  --   'snoozed'   — hide until snooze_until <= now(); same default-query
  --                 unhide pattern as extracted_ideas.
  "status" text NOT NULL DEFAULT 'pending',
  "promoted_at" timestamp with time zone,
  "dismissed_at" timestamp with time zone,
  "snooze_until" timestamp with time zone,

  -- Vector embedding of body_clean (or body_text fallback). NULL for
  -- non-promoted messages — we only spend OpenAI tokens on promoted ones.
  -- 1536-dim to match text-embedding-3-small.
  "embedding" vector(1536),

  -- Full Gmail API payload (the messages.get response). Stashed for
  -- forward-compat: header re-parse if our parser drops something, future
  -- attachment surfacing, debugging detection misses.
  "raw" jsonb,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "gmail_messages_user_external_unique" UNIQUE ("user_id", "external_id")
);

-- Hot-path index for the triage queue: WHERE user_id = $1 AND status = $2.
CREATE INDEX IF NOT EXISTS "idx_gmail_messages_user_status"
  ON "gmail_messages" ("user_id", "status");

-- Sort newsletter messages by recency in the triage UI.
CREATE INDEX IF NOT EXISTS "idx_gmail_messages_user_posted_at"
  ON "gmail_messages" ("user_id", "posted_at" DESC);

-- Account scoping for disconnect cleanup + per-account counts.
CREATE INDEX IF NOT EXISTS "idx_gmail_messages_user_account"
  ON "gmail_messages" ("user_id", "connector_account_id");

-- HNSW partial index — only rows we've actually embedded. Keeps the
-- index tight; pending/dismissed rows never bloat it.
CREATE INDEX IF NOT EXISTS "idx_gmail_messages_embedding"
  ON "gmail_messages" USING hnsw ("embedding" vector_cosine_ops)
  WHERE "embedding" IS NOT NULL;

-- ─── extracted_ideas: add fourth source kind ──────────────
ALTER TABLE "extracted_ideas"
  ADD COLUMN IF NOT EXISTS "gmail_message_id" uuid
    REFERENCES "gmail_messages"("id") ON DELETE CASCADE;

-- Replace the three-way XOR check with a four-way version. Drop-then-add
-- is the standard PG pattern (Phase 12 used the same shape).
ALTER TABLE "extracted_ideas"
  DROP CONSTRAINT IF EXISTS "extracted_ideas_source_xor";

ALTER TABLE "extracted_ideas"
  ADD CONSTRAINT "extracted_ideas_source_xor" CHECK (
    (source_kind = 'newsletter_issue' AND newsletter_issue_id IS NOT NULL AND obsidian_note_id IS NULL  AND linkedin_post_id IS NULL  AND gmail_message_id IS NULL)
    OR
    (source_kind = 'obsidian_note'    AND newsletter_issue_id IS NULL  AND obsidian_note_id IS NOT NULL AND linkedin_post_id IS NULL  AND gmail_message_id IS NULL)
    OR
    (source_kind = 'linkedin_post'    AND newsletter_issue_id IS NULL  AND obsidian_note_id IS NULL  AND linkedin_post_id IS NOT NULL AND gmail_message_id IS NULL)
    OR
    (source_kind = 'gmail_message'    AND newsletter_issue_id IS NULL  AND obsidian_note_id IS NULL  AND linkedin_post_id IS NULL  AND gmail_message_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS "idx_extracted_ideas_gmail_source"
  ON "extracted_ideas" ("gmail_message_id")
  WHERE "gmail_message_id" IS NOT NULL;
