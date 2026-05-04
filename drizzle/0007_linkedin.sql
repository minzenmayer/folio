-- Phase 12 (2026-05-04): LinkedIn inbound connector via Apify scraping.
--
-- Adds linkedin_posts (mirrors obsidian_notes shape) and extends
-- extracted_ideas to point at a third source kind. The XOR check on
-- extracted_ideas grows a third branch so a row references exactly one
-- of: newsletter_issue, obsidian_note, linkedin_post.
--
-- Apify token + LinkedIn profile URL live on the connector_accounts row
-- (encryptedSecret is unused — token is platform-level via env;
-- metadata.profileUrl + metadata.lastApifyRunId carry per-user state).

-- ─── linkedin_posts ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS "linkedin_posts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "connector_account_id" uuid NOT NULL REFERENCES "connector_accounts"("id") ON DELETE CASCADE,

  -- Apify-returned LinkedIn URN, e.g. "7451978026319364096".
  -- Composite uniqueness with user_id so re-syncs are idempotent.
  "external_id" text NOT NULL,

  -- Canonical post URL on linkedin.com, used for citation/click-through.
  "linkedin_url" text NOT NULL,

  -- Raw post body (LinkedIn allows ~3000 chars; some posts include
  -- newlines + URLs we keep as-is).
  "content" text,

  -- Lightly normalized text we feed into embedText. Stripped of trailing
  -- "Read more" markers, repeated whitespace, etc. body_clean is our
  -- single source of truth for retrieval; content keeps the raw shape
  -- for display/debugging.
  "body_clean" text,

  -- ISO timestamp from Apify (postedAt.date). NOT NULL because every
  -- post the actor returns has it.
  "posted_at" timestamp with time zone NOT NULL,

  -- LinkedIn-side post type. We currently only ingest "post"; "repost"
  -- and "comment" land here too if the actor returns them so we can
  -- filter at read-time without dropping data.
  "post_type" text NOT NULL DEFAULT 'post',

  -- Author identity from the scrape. Kept for sanity-checking that we're
  -- only ingesting Payton's own posts even if the actor returns others.
  "author_id" text,
  "author_handle" text,
  "author_name" text,

  -- Image URLs from postImages[]. Kept as text[] of URLs for now — we
  -- don't fetch/store the images themselves (they expire on LinkedIn's
  -- side anyway).
  "image_urls" text[] DEFAULT '{}'::text[],

  -- Engagement counts when the actor returns them. Nullable because not
  -- every actor build surfaces these.
  "reaction_count" integer,
  "comment_count" integer,
  "share_count" integer,

  -- Vector embedding of body_clean. 1536-dim to match
  -- text-embedding-3-small.
  "embedding" vector(1536),

  -- Full Apify payload, stashed for forward-compatibility (new fields
  -- the actor may emit later, debugging when content_clean drops something
  -- the user cares about, etc.).
  "raw" jsonb,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "linkedin_posts_user_external_unique" UNIQUE ("user_id", "external_id")
);

CREATE INDEX IF NOT EXISTS "idx_linkedin_posts_user_account"
  ON "linkedin_posts" ("user_id", "connector_account_id");
CREATE INDEX IF NOT EXISTS "idx_linkedin_posts_user_posted_at"
  ON "linkedin_posts" ("user_id", "posted_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_linkedin_posts_embedding"
  ON "linkedin_posts" USING hnsw ("embedding" vector_cosine_ops);

-- ─── extracted_ideas: add third source kind ──────────────
ALTER TABLE "extracted_ideas"
  ADD COLUMN IF NOT EXISTS "linkedin_post_id" uuid
    REFERENCES "linkedin_posts"("id") ON DELETE CASCADE;

-- Replace the old XOR check (newsletter_issue XOR obsidian_note) with a
-- three-way version. Drop-then-add is the standard PG pattern here.
ALTER TABLE "extracted_ideas"
  DROP CONSTRAINT IF EXISTS "extracted_ideas_source_xor";

ALTER TABLE "extracted_ideas"
  ADD CONSTRAINT "extracted_ideas_source_xor" CHECK (
    (source_kind = 'newsletter_issue' AND newsletter_issue_id IS NOT NULL AND obsidian_note_id IS NULL  AND linkedin_post_id IS NULL)
    OR
    (source_kind = 'obsidian_note'    AND newsletter_issue_id IS NULL  AND obsidian_note_id IS NOT NULL AND linkedin_post_id IS NULL)
    OR
    (source_kind = 'linkedin_post'    AND newsletter_issue_id IS NULL  AND obsidian_note_id IS NULL  AND linkedin_post_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS "idx_extracted_ideas_linkedin_source"
  ON "extracted_ideas" ("linkedin_post_id")
  WHERE "linkedin_post_id" IS NOT NULL;
