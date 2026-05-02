-- Folio · 0000_init.sql
-- Run before drizzle migrations. Sets up the pgvector extension.
-- After running this, use: npm run db:push

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
