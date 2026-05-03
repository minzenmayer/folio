-- Sprint 15 Wave 2 — Obsidian connector + extracted ideas substrate.
--
-- Two tables:
--
--   1. obsidian_notes — vault notes synced via the Git-backed connector.
--      Mirrors newsletter_issues' shape: per-(user, externalId) row with
--      its own embedding column + HNSW index so notes participate in
--      findSimilar alongside captures, ideas, drafts, and newsletter
--      issues. externalId is the vault-relative path; blobSha + commitSha
--      give us cheap "what's changed since last sync" diffs.
--
--   2. extracted_ideas — the unit of meaning extractIdeas() pulls out of
--      a source (a newsletter issue, an Obsidian note). Each row is one
--      Idea with title/claim/evidence + depth/breadth signals that
--      Wave 3's retrieval ranking will boost matches against. Source is
--      tracked via a kind discriminator + nullable per-source FKs so
--      cascading delete from the source row cleans up its extracted
--      ideas automatically.
--
-- Idempotent — uses CREATE TABLE/INDEX IF NOT EXISTS so re-runs are safe.
-- Plays nicely with 0005_beehiiv.sql (connector_accounts, newsletter_issues
-- already exist).

-- ────────────────────────────────────────────
-- obsidian_notes
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS obsidian_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_account_id UUID NOT NULL
    REFERENCES connector_accounts(id) ON DELETE CASCADE,

  -- Vault-relative path, e.g. 'Areas/Newsletter/Idea Density.md'. Unique
  -- per user — upsert key the way newsletter_issues uses Beehiiv post id.
  external_id TEXT NOT NULL,
  -- Same value as external_id, kept as a separate column for clarity in
  -- queries that join against link targets.
  path TEXT NOT NULL,

  -- Git blob sha (40-hex). Lets the sync engine diff: same blob = no
  -- re-embed, no LLM call, just skip.
  blob_sha TEXT,
  -- Last commit sha we observed touching this file. Mostly informational
  -- — useful when chasing "why did this re-sync".
  commit_sha TEXT,

  title TEXT NOT NULL,

  -- Parsed YAML frontmatter, kept whole. Wave 2's extractIdeas reads
  -- properties (type, area, status, tags, links) directly off this blob
  -- so adding a property to the curation formula doesn't require a schema
  -- change.
  frontmatter JSONB DEFAULT '{}'::jsonb,

  -- Markdown body with the frontmatter block stripped. Source for embedding
  -- and for findSimilar snippet rendering.
  body_text TEXT,
  -- Raw file content as it appeared in the vault. Useful for re-extracting
  -- if the parser changes (no need to refetch from GitHub).
  body_markdown TEXT,

  -- Outbound [[wikilinks]] and [markdown](links) extracted from body. Stored
  -- as plain text — no FK to other notes — because Obsidian links can point
  -- at not-yet-existing notes, and we don't want a write here to fail
  -- because a sibling hasn't been pulled yet.
  links TEXT[] DEFAULT ARRAY[]::TEXT[],
  -- Union of frontmatter `tags` array and `#inline` tags found in body.
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],

  word_count INTEGER,

  embedding VECTOR(1536),

  -- Full GitHub blob/file response for future-proofing. Same idea as
  -- newsletter_issues.raw — a place to land fields we don't surface yet.
  raw JSONB,

  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  UNIQUE (user_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_obsidian_notes_user_path
  ON obsidian_notes (user_id, path);

CREATE INDEX IF NOT EXISTS idx_obsidian_notes_user_account
  ON obsidian_notes (user_id, connector_account_id);

CREATE INDEX IF NOT EXISTS idx_obsidian_notes_embedding
  ON obsidian_notes USING hnsw (embedding vector_cosine_ops);

-- ────────────────────────────────────────────
-- extracted_ideas
-- ────────────────────────────────────────────
-- One row per (source, idea-extracted-from-source). When the source is
-- updated, the sync engine clears existing rows and re-runs extractIdeas;
-- when the source is deleted, ON DELETE CASCADE clears them.
--
-- source_kind discriminates which of the two FK columns is set (CHECK
-- constraint enforces exactly one). This is gentler than a single
-- polymorphic id with no referential integrity.
CREATE TABLE IF NOT EXISTS extracted_ideas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- 'newsletter_issue' | 'obsidian_note' (extend as new providers land).
  source_kind TEXT NOT NULL,
  newsletter_issue_id UUID
    REFERENCES newsletter_issues(id) ON DELETE CASCADE,
  obsidian_note_id UUID
    REFERENCES obsidian_notes(id) ON DELETE CASCADE,

  CONSTRAINT extracted_ideas_source_xor CHECK (
    (source_kind = 'newsletter_issue' AND newsletter_issue_id IS NOT NULL AND obsidian_note_id IS NULL)
    OR
    (source_kind = 'obsidian_note' AND obsidian_note_id IS NOT NULL AND newsletter_issue_id IS NULL)
  ),

  title TEXT NOT NULL,
  claim TEXT NOT NULL,
  evidence TEXT,

  -- 0..1. How thoroughly the source treats this idea. Wave 3's retrieval
  -- ranking boosts high-depth matches before the LLM sees them.
  depth_signal REAL NOT NULL DEFAULT 0,
  -- 0..1. How broadly applicable / cross-cutting the idea is. Boosts
  -- breadth_signal lifts ideas that connect across the bed.
  breadth_signal REAL NOT NULL DEFAULT 0,

  -- Concept names linked from this idea (within the same source). Plain
  -- text — same reasoning as obsidian_notes.links.
  links TEXT[] DEFAULT ARRAY[]::TEXT[],

  -- Citation back to the source: { kind, sourceId, title, url? }. Wave 3's
  -- synthesis prompt reads from this to generate "You explored [X] in
  -- [issue/note title]" reasoning lines.
  source_ref JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- title + claim + evidence, embedded together. findSimilar can rank
  -- against this column for ideas-aware retrieval.
  embedding VECTOR(1536),

  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_extracted_ideas_user_kind
  ON extracted_ideas (user_id, source_kind);

CREATE INDEX IF NOT EXISTS idx_extracted_ideas_newsletter_source
  ON extracted_ideas (newsletter_issue_id)
  WHERE newsletter_issue_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_extracted_ideas_obsidian_source
  ON extracted_ideas (obsidian_note_id)
  WHERE obsidian_note_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_extracted_ideas_signals
  ON extracted_ideas (user_id, depth_signal DESC, breadth_signal DESC);

CREATE INDEX IF NOT EXISTS idx_extracted_ideas_embedding
  ON extracted_ideas USING hnsw (embedding vector_cosine_ops);
