-- Phase 15 (Voice ID UX rework — 2026-05-05): replace the canonical-pieces
-- model with a 5-sample-picker model that mirrors Ghostbase's training UX.
-- Each row is a single training sample for a (user, platform). Three kinds:
--   · corpus: pointer to an existing piece in newsletter_issues /
--             obsidian_notes / linkedin_posts. body fetched at read time.
--   · paste:  user-pasted text. title + body stored inline.
--   · upload: file-uploaded text (txt/md initially; pdf/docx later).
--             title + body stored inline. filename optional.
--
-- App layer caps at 5 samples per (user, platform). Order via `position`.
-- voice_canonical_pieces stays in the schema for now but is no longer
-- read; we'll drop it once the new flow is settled.

CREATE TABLE IF NOT EXISTS "voice_training_samples" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "platform"    text NOT NULL,
  "kind"        text NOT NULL,

  -- For kind='corpus': pointer into the source tables.
  "source_kind" text,
  "source_id"   uuid,

  -- For kind='paste' and kind='upload': inline content.
  "title"       text NOT NULL,
  "body"        text NOT NULL,
  "filename"    text,

  "position"    integer NOT NULL DEFAULT 0,
  "created_at"  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "voice_training_samples_platform_chk"
    CHECK (platform IN ('longform', 'linkedin')),
  CONSTRAINT "voice_training_samples_kind_chk"
    CHECK (kind IN ('corpus', 'paste', 'upload')),
  -- corpus rows must have source pointer; paste/upload must not.
  CONSTRAINT "voice_training_samples_kind_xor"
    CHECK (
      (kind = 'corpus' AND source_kind IS NOT NULL AND source_id IS NOT NULL)
      OR
      (kind IN ('paste', 'upload') AND source_kind IS NULL AND source_id IS NULL)
    ),
  CONSTRAINT "voice_training_samples_source_kind_chk"
    CHECK (source_kind IS NULL OR source_kind IN ('newsletter_issue', 'obsidian_note', 'linkedin_post'))
);

CREATE INDEX IF NOT EXISTS "idx_voice_training_samples_user_platform"
  ON "voice_training_samples" (user_id, platform, position);
