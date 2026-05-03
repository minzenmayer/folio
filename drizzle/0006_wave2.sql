-- Sprint 15 Wave 2 — Obsidian connector + extracted ideas substrate.
--
-- Two tables:
--
--   1. obsidian_notes — vault notes synced via the Git-backed Obsidian
--      connector. Mirrors newsletter_issues' shape so shared queries
--      (e.g. backfill, extract-ideas sweep) can union both sources.
--
--   2. extracted_ideas — one row per idea extracted from any source
--      (newsletter_issues OR obsidian_notes). An XOR check constraint
--      enforces exactly one FK per row so the table stays normalised as
--      we add more sources in Wave 3.
--
-- Run order: after 0005 (which created newsletter_issues + embeddings).
-- Safe to re-run: all DDL is IF NOT EXISTS / IF NOT EXISTS equivalent.

-- ── obsidian_notes ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS obsidian_notes (
  id            TEXT        PRIMARY KEY,          -- vault-relative path, e.g. "notes/foo.md"
  repo_full     TEXT        NOT NULL,             -- "owner/repo" of the vault
  title         TEXT,
  content       TEXT        NOT NULL DEFAULT '',
  frontmatter   JSONB       NOT NULL DEFAULT '{}',
  tags          TEXT[]      NOT NULL DEFAULT '{}',
  wikilinks     TEXT[]      NOT NULL DEFAULT '{}',
  blob_sha      TEXT,                             -- last-seen Git blob SHA (skip-sync sentinel)
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS obsidian_notes_repo_full_idx
  ON obsidian_notes (repo_full);

CREATE INDEX IF NOT EXISTS obsidian_notes_tags_idx
  ON obsidian_notes USING GIN (tags);

CREATE INDEX IF NOT EXISTS obsidian_notes_synced_at_idx
  ON obsidian_notes (synced_at DESC);

-- ── extracted_ideas ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS extracted_ideas (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Exactly one of these two FKs must be non-NULL (enforced by check below).
  issue_id             UUID        REFERENCES newsletter_issues (id) ON DELETE CASCADE,
  note_id              TEXT        REFERENCES obsidian_notes    (id) ON DELETE CASCADE,

  title                TEXT        NOT NULL,
  claim                TEXT        NOT NULL,
  evidence             TEXT,

  -- Curation signals (0–1 floats, NULL until calibrated).
  depth_score          REAL,
  breadth_score        REAL,

  -- Structural metadata.
  outbound_links       TEXT[]      NOT NULL DEFAULT '{}',
  source_ref           TEXT,                       -- e.g. URL or vault path fragment

  -- pgvector embedding (1536-dim, text-embedding-3-small).
  embedding            vector(1536),

  extracted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- XOR: exactly one source FK is non-NULL.
  CONSTRAINT extracted_ideas_single_source CHECK (
    (issue_id IS NOT NULL)::INT + (note_id IS NOT NULL)::INT = 1
  )
);

CREATE INDEX IF NOT EXISTS extracted_ideas_issue_id_idx
  ON extracted_ideas (issue_id)
  WHERE issue_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS extracted_ideas_note_id_idx
  ON extracted_ideas (note_id)
  WHERE note_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS extracted_ideas_depth_idx
  ON extracted_ideas (depth_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS extracted_ideas_breadth_idx
  ON extracted_ideas (breadth_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS extracted_ideas_embedding_idx
  ON extracted_ideas USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
