-- Sprint 13 Wave 1 — connectors substrate + Beehiiv newsletter issues.
--
-- This migration adds two tables:
--
--   1. connector_accounts — generic per-(user, provider) connection record.
--      Stores the encrypted API key, a status enum, last-sync metadata, and
--      provider-specific data in a JSONB blob. Sprint 14 (Obsidian) and
--      Sprint 15 (LinkedIn) reuse the same table; only the `provider` and
--      `metadata` shape change per integration.
--
--   2. newsletter_issues — Beehiiv-shaped table for the user's published
--      issues. Has its own embedding column + HNSW index so issues
--      participate in findSimilar alongside captures, ideas, and drafts
--      via Sprint 7's retrieval substrate.
--
-- Encryption: the `encrypted_secret` column holds the API key wrapped via
-- AES-256-GCM by src/lib/crypto.ts using CONNECTOR_ENCRYPTION_KEY. Plaintext
-- never lands in the row. Disconnect zeroes the column but keeps the row
-- (for status='disconnected') so the user's issue archive isn't lost.
--
-- Idempotent — uses CREATE TABLE/INDEX IF NOT EXISTS so re-runs are safe.

-- ─────────────────────────────────────────────
-- connector_accounts
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS connector_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- 'beehiiv' | 'obsidian' | 'linkedin' | 'gdrive' | 'gmail'
  provider TEXT NOT NULL,

  -- 'pending' | 'connected' | 'error' | 'disconnected'
  -- 'pending' is the brief window between insert and first successful
  -- validation against the provider; 'error' means the credential was
  -- rejected (re-prompt on the card); 'disconnected' is a soft delete
  -- that keeps newsletter_issues intact.
  status TEXT NOT NULL DEFAULT 'pending',

  -- AES-256-GCM-wrapped API key. Format: base64(iv || authTag || ciphertext).
  -- Null when status='disconnected' (we zero on disconnect).
  encrypted_secret TEXT,

  -- Provider-specific data:
  --   beehiiv: { publicationId, publication_name, webhook_id?, plan_tier? }
  metadata JSONB DEFAULT '{}'::jsonb,

  last_sync_at TIMESTAMPTZ,

  -- 'ok' | 'partial' | 'rate_limited' | 'auth_failed' | 'error'
  last_sync_status TEXT,
  last_sync_error TEXT,
  last_sync_count INTEGER,

  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_connector_accounts_user_provider
  ON connector_accounts (user_id, provider);

-- ─────────────────────────────────────────────
-- newsletter_issues
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS newsletter_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Cascade matters: hard-disconnect (admin path) wipes issues with the
  -- account. The default Disconnect button keeps the row but the user
  -- can opt to nuke later.
  connector_account_id UUID NOT NULL
    REFERENCES connector_accounts(id) ON DELETE CASCADE,

  -- Beehiiv post id (e.g. 'post_abc123def...'). Unique per user so the
  -- same Beehiiv post can't be ingested twice; upsert key for re-syncs.
  external_id TEXT NOT NULL,

  publication_id TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  slug TEXT,
  web_url TEXT,

  -- 'free' | 'premium' | 'all' (Beehiiv audience filter values)
  audience TEXT,

  -- Mirrors Beehiiv: 'draft' | 'confirmed' | 'archived'. We typically only
  -- ingest status='confirmed' but keep the column for future re-sync logic.
  status TEXT,
  publish_date TIMESTAMPTZ,

  -- Full HTML as Beehiiv rendered it. Useful for display/export later.
  body_html TEXT,
  -- HTML stripped to plain prose. Source for embedding + findSimilar
  -- snippet rendering.
  body_text TEXT,

  content_tags TEXT[] DEFAULT ARRAY[]::TEXT[],
  word_count INTEGER,

  embedding VECTOR(1536),

  -- Full Beehiiv response for future-proofing — if their schema gains
  -- fields we want, we can backfill from raw without re-fetching.
  raw JSONB,

  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  UNIQUE (user_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_newsletter_issues_user_publish
  ON newsletter_issues (user_id, publish_date DESC);

CREATE INDEX IF NOT EXISTS idx_newsletter_issues_embedding
  ON newsletter_issues USING hnsw (embedding vector_cosine_ops);
