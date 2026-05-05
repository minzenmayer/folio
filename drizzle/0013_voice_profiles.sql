-- Phase 15a (2026-05-05): Voice ID — per-platform voice profile.
--
-- Two tables ship together:
--   · voice_profiles: per (user, platform) row carrying Claude's
--     auto-derived schema (summary + attributes + things_to_avoid)
--     plus the user's manual additions that persist across rebuilds.
--   · voice_canonical_pieces: a join table flagging which source
--     pieces represent the user's voice "best." profileVault always
--     samples canonical first, recency-weighted random second.
--
-- Spec: ~/Desktop/Thoughtbed/phase15a_voice_id_spec.md
--
-- Both additive. Safe to run on a live db.

-- ── voice_profiles ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "voice_profiles" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"          uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "platform"         text NOT NULL,

  -- Claude-derived (read-only in the UI; rebuild overwrites).
  "summary"                 text,
  "attributes_auto"         jsonb NOT NULL DEFAULT '[]'::jsonb,
  "things_to_avoid_auto"    jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- User-authored (editable; persists across rebuilds).
  "attributes_manual"       jsonb NOT NULL DEFAULT '[]'::jsonb,
  "things_to_avoid_manual"  jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Build provenance.
  "built_at"        timestamptz,
  "built_from_ids"  jsonb NOT NULL DEFAULT '[]'::jsonb,

  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "voice_profiles_platform_chk"
    CHECK (platform IN ('longform', 'linkedin')),
  CONSTRAINT "voice_profiles_user_platform_uniq"
    UNIQUE (user_id, platform)
);

CREATE INDEX IF NOT EXISTS "idx_voice_profiles_user"
  ON "voice_profiles" (user_id);

-- ── voice_canonical_pieces ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "voice_canonical_pieces" (
  "user_id"      uuid        NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "source_kind"  text        NOT NULL,
  "source_id"    uuid        NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, source_kind, source_id),

  CONSTRAINT "voice_canonical_pieces_source_kind_chk"
    CHECK (source_kind IN ('newsletter_issue', 'obsidian_note', 'linkedin_post'))
);

-- Hot-path: list per-platform canonical for a user. source_kind alone
-- maps to platform (longform = newsletter_issue + obsidian_note;
-- linkedin = linkedin_post), so this index covers both.
CREATE INDEX IF NOT EXISTS "idx_voice_canonical_user_kind"
  ON "voice_canonical_pieces" (user_id, source_kind);

-- The source_id is a soft FK (no real REFERENCES) because the target
-- depends on source_kind. Cleanup of dangling rows (when a source is
-- deleted) is inert — the LEFT JOIN reads in profile-vault.ts skip
-- nulls, and a future maintenance sweep can prune.
