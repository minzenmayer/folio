// Folio · Database Schema
// Full schema as specified in Issue 09.
// All Idea object fields shipped from Day 1, even where v0 UI doesn't surface them.
// Migrating shape later is harder than over-specifying now.

import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  jsonb,
  vector,
  index,
  check,
  uniqueIndex,
  unique,
  date,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ────────────────────────────────────────────
// USERS — managed by Clerk; we mirror just the ID + minimal profile
// ────────────────────────────────────────────
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkId: text('clerk_id').notNull().unique(),
  email: text('email').notNull(),
  name: text('name'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  // Phase 17 (2026-05-05): one-time onboarding mass-claim gate. Null
  // means the pass has not yet run for this user. Set to now() at the
  // end of the chunked pass (see /api/onboarding/phase17-seed). Once
  // set, the pass never runs again for this user.
  phase17SeededAt: timestamp('phase17_seeded_at', { withTimezone: true }),
});

// ────────────────────────────────────────────
// IDEAS — the foundational primitive
// ────────────────────────────────────────────
export const ideas = pgTable(
  'ideas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // identity
    title: text('title').notNull(),
    essence: text('essence'),
    // Phase 14b — Garden redesign (2026-05-04). Long-form text that
    // grows over time as merges append to it. Distinct from essence,
    // which is the one-paragraph hand-curated line.
    body: text('body'),
    posedAs: text('posed_as'),
    tags: text('tags').array().default(sql`'{}'`),
    themes: text('themes').array().default(sql`'{}'`),

    // state — text + check constraint instead of enum (more migratable)
    maturity: text('maturity').notNull().default('seed'),
    // 'seed' | 'forming' | 'shaping' | 'ready' | 'circulated' | 'dormant'
    energy: text('energy').notNull().default('active'),
    // 'active' | 'warming' | 'cooling' | 'archived'

    // provenance
    origin: text('origin').notNull().default('captured'),
    // 'captured' | 'noticed' | 'synthesized' | 'spawned'
    originRef: uuid('origin_ref'),
    parentIdeaId: uuid('parent_idea_id').references((): any => ideas.id),

    // signal — denormalized, refreshed via trigger or background job
    weight: integer('weight').default(0),
    pull: integer('pull').default(0),
    heat: real('heat').default(0),

    // Sprint 7: retrieval substrate. Computed from title + essence + body
    // on every successful save. Nullable so rows that pre-date Sprint 7 — or
    // whose embedText() call failed — still read cleanly; backfillEmbeddings
    // sweeps NULLs in batches.
    embedding: vector('embedding', { dimensions: 1536 }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
    lastVisitedAt: timestamp('last_visited_at', { withTimezone: true }),
    lastEvolvedAt: timestamp('last_evolved_at', { withTimezone: true }),

    // Direction B (2026-05-04): when this idea was promoted from an
    // extracted_ideas row, link back so the Garden card can render
    // "from <source>" + click-through. Nullable for hand-authored ideas.
    sourceExtractedIdeaId: uuid('source_extracted_idea_id').references(
      () => extractedIdeas.id,
      { onDelete: 'set null' }
    ),

    // Phase 14b — Garden redesign (2026-05-04). Lifecycle columns.
    // 'hot' | 'warm' | 'cool' | 'cold' | 'set_aside' (check-constrained in SQL).
    temperature: text('temperature').notNull().default('warm'),
    temperatureUpdatedAt: timestamp('temperature_updated_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    // # digest surfaces without user action — anti-calcification rule.
    // Increments on each digest surface; resets on any user action. 3 unacted → cool one step.
    digestSurfaceCount: integer('digest_surface_count').notNull().default(0),
    digestSurfaceFirstAt: timestamp('digest_surface_first_at', {
      withTimezone: true,
    }),
    // 'Mark hot' sets pinned_until = now() + 14 days; auto-cool paused while pinned.
    pinnedUntil: timestamp('pinned_until', { withTimezone: true }),
    // 'authored' (hand-curated)
    // | 'claimed' (made-mine from extracted_idea — user wrote a sentence)
    // | 'auto_claimed' (Phase 17 — extracted from a user-authored source
    //   like CSL / vault / LinkedIn; the user already wrote the prose so
    //   the partner ideas row gets created automatically; refining the
    //   essence flips this to 'claimed').
    claimKind: text('claim_kind').notNull().default('authored'),
  },
  (table) => ({
    userVisitedIdx: index('idx_ideas_user_visited').on(
      table.userId,
      table.lastVisitedAt
    ),
    userMaturityIdx: index('idx_ideas_user_maturity').on(
      table.userId,
      table.maturity
    ),
    userTemperatureIdx: index('idx_ideas_temperature').on(
      table.userId,
      table.temperature
    ),
    embeddingIdx: index('idx_ideas_embedding').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops')
    ),
  })
);

// ────────────────────────────────────────────
// CAPTURES — raw material; the bank's content
// ────────────────────────────────────────────
export const captures = pgTable(
  'captures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ideaId: uuid('idea_id').references(() => ideas.id, {
      onDelete: 'set null',
    }),
    // null = unfiled, in Inbox

    type: text('type').notNull(),
    // 'link' | 'quote' | 'image' | 'voice_memo' | 'doc' | 'feed_item' | 'paste'
    source: text('source'),
    body: text('body').notNull(),
    summary: text('summary'),

    embedding: vector('embedding', { dimensions: 1536 }),

    status: text('status').default('inbox'),
    // 'inbox' | 'attached' | 'stashed' | 'discarded'

    capturedVia: text('captured_via').notNull(),
    // 'paste' | 'extension' | 'share' | 'manual' | 'email' | 'feed' | 'mobile'
    capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow(),
    metadata: jsonb('metadata').default({}),
  },
  (table) => ({
    embeddingIdx: index('idx_captures_embedding').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops')
    ),
    userIdeaIdx: index('idx_captures_user_idea').on(
      table.userId,
      table.ideaId,
      table.capturedAt
    ),
    inboxIdx: index('idx_captures_inbox')
      .on(table.userId, table.status)
      .where(sql`${table.status} = 'inbox'`),
  })
);

// ────────────────────────────────────────────
// ARTIFACTS — built things
// ────────────────────────────────────────────
export const artifacts = pgTable('artifacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  ideaId: uuid('idea_id')
    .notNull()
    .references(() => ideas.id, { onDelete: 'cascade' }),

  format: text('format').notNull().default('draft'),
  // 'essay' | 'post' | 'newsletter' | 'talk' | 'draft'
  title: text('title').notNull(),
  body: jsonb('body').notNull().default({}),
  // ProseMirror JSON for editor fidelity

  status: text('status').default('draft'),
  // 'draft' | 'complete' | 'shipped'
  voiceMatchScore: real('voice_match_score'),
  wordCount: integer('word_count').default(0),

  builtAt: timestamp('built_at', { withTimezone: true }).defaultNow(),
  shippedAt: timestamp('shipped_at', { withTimezone: true }),
  shippedDestination: text('shipped_destination'),
  ingredientIdeaIds: uuid('ingredient_idea_ids').array().default(sql`'{}'`),

  embedding: vector('embedding', { dimensions: 1536 }),
});

// ────────────────────────────────────────────
// THREADS — journal entries on an idea
// ────────────────────────────────────────────
export const threads = pgTable('threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  ideaId: uuid('idea_id')
    .notNull()
    .references(() => ideas.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('journal'),
  // 'journal' | 'log' | 'synthesis' | 'graph'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  lastEvolvedAt: timestamp('last_evolved_at', { withTimezone: true }),
});

export const threadEntries = pgTable('thread_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  threadId: uuid('thread_id')
    .notNull()
    .references(() => threads.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  entryType: text('entry_type').notNull().default('text'),
  // 'text' | 'voice' | 'quote'
  sourceCaptureId: uuid('source_capture_id').references(() => captures.id),
  sourceArtifactId: uuid('source_artifact_id').references(() => artifacts.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  embedding: vector('embedding', { dimensions: 1536 }),
});

// ────────────────────────────────────────────
// IDEA EDGES — typed relationships between ideas
// ────────────────────────────────────────────
export const ideaEdges = pgTable('idea_edges', {
  id: uuid('id').primaryKey().defaultRandom(),
  fromIdea: uuid('from_idea')
    .notNull()
    .references(() => ideas.id, { onDelete: 'cascade' }),
  toIdea: uuid('to_idea')
    .notNull()
    .references(() => ideas.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  // 'parent' | 'supports' | 'extends' | 'echoes' | 'contradicts' | 'supersedes'
  strength: real('strength').default(1),
  userConfirmed: integer('user_confirmed').default(0),
  // 0 = suggested by Assistant, 1 = user-confirmed
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ────────────────────────────────────────────
// ASSISTANT_OFFERS — log of what the Assistant suggested
// Used to tune retrieval over time and track acceptance
// ────────────────────────────────────────────
export const assistantOffers = pgTable('assistant_offers', {
  id: uuid('id').primaryKey().defaultRandom(),
  artifactId: uuid('artifact_id').references(() => artifacts.id, {
    onDelete: 'cascade',
  }),
  paragraphIndex: integer('paragraph_index'),
  offerType: text('offer_type').notNull(),
  // 'capture_pull' | 'angle' | 'tension' | 'voice'
  sourceCaptureId: uuid('source_capture_id').references(() => captures.id),
  sourceIdeaId: uuid('source_idea_id').references(() => ideas.id),
  confidence: real('confidence'),
  actedOn: integer('acted_on').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ────────────────────────────────────────────
// DRAFTS — Sprint 5: The Page
// In-progress writing surfaces. Tiptap doc serialized as ProseMirror JSON.
// May mature into an idea + artifact later; nullable ideaId reflects that.
// ────────────────────────────────────────────
export const drafts = pgTable(
  'drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Implicit title — derived from the first H1 in contentJson on each save.
    // Nullable so empty drafts read as "Untitled" in the rail.
    title: text('title'),

    // Tiptap doc as ProseMirror JSON (default empty doc on insert).
    contentJson: jsonb('content_json').notNull(),

    // Drafts can mature into ideas. Until then, no parent.
    ideaId: uuid('idea_id').references(() => ideas.id, {
      onDelete: 'set null',
    }),

    // Optimistic-concurrency token. Bumped on every successful update.
    // updateDraft gates the WHERE on this; mismatch = concurrent edit.
    version: integer('version').notNull().default(1),

    // Sprint 7: retrieval substrate. Computed from tiptapJsonToText(contentJson)
    // on every successful save (createDraft / updateDraft / restoreDraftVersion).
    // Same nullable + best-effort pattern as ideas.embedding.
    embedding: vector('embedding', { dimensions: 1536 }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userUpdatedIdx: index('idx_drafts_user_updated').on(
      table.userId,
      table.updatedAt
    ),
    embeddingIdx: index('idx_drafts_embedding').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops')
    ),
  })
);

// ────────────────────────────────────────────
// DRAFT VERSIONS — Sprint 6: history trail for The Page
// Every successful save snapshots into here, with a 30s coalesce window
// (an autosave row younger than 30s gets overwritten in place rather than
// duplicated). Restoring a version creates a new row with source='restore'.
// ────────────────────────────────────────────
export const draftVersions = pgTable(
  'draft_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    contentJson: jsonb('content_json').notNull(),
    wordCount: integer('word_count'),
    source: text('source').notNull(),
    // 'autosave' | 'restore'  (room for 'manual' later)
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    draftCreatedIdx: index('idx_draft_versions_draft_created').on(
      table.draftId,
      table.createdAt
    ),
  })
);

// ────────────────────────────────────────────
// CONNECTOR_ACCOUNTS — Sprint 13: per-(user, provider) integration record
// Generic across providers. The plaintext API key never lives here —
// `encryptedSecret` holds AES-256-GCM ciphertext (see src/lib/crypto.ts).
// On Disconnect we zero the secret but keep the row for status tracking
// and so newsletter_issues stay reachable through the FK chain.
// ────────────────────────────────────────────
export const connectorAccounts = pgTable(
  'connector_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    provider: text('provider').notNull(),
    // 'beehiiv' | 'obsidian' | 'linkedin' | 'gdrive' | 'gmail'

    status: text('status').notNull().default('pending'),
    // 'pending' | 'connected' | 'error' | 'disconnected'

    encryptedSecret: text('encrypted_secret'),
    // base64(iv || authTag || ciphertext) — see src/lib/crypto.ts

    metadata: jsonb('metadata').default({}),
    // beehiiv:  { publicationId, publication_name, webhook_id?, plan_tier? }
    // linkedin: { profileUrl, lastApifyRunId?, lastApifyDatasetId? }

    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastSyncStatus: text('last_sync_status'),
    // 'ok' | 'partial' | 'rate_limited' | 'auth_failed' | 'error'
    lastSyncError: text('last_sync_error'),
    lastSyncCount: integer('last_sync_count'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userProviderIdx: index('idx_connector_accounts_user_provider').on(
      table.userId,
      table.provider
    ),
  })
);

// ────────────────────────────────────────────
// NEWSLETTER_ISSUES — Sprint 13: published Beehiiv issues, ingested via
// /api/cron + manual sync. Mirrors a Beehiiv post with the bits the bed
// cares about (title, body_html, body_text, publish_date, audience). The
// embedding column lets findSimilar surface past issues alongside captures,
// ideas, and drafts so the user's own published voice resonates while
// they're writing.
// ────────────────────────────────────────────
export const newsletterIssues = pgTable(
  'newsletter_issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectorAccountId: uuid('connector_account_id')
      .notNull()
      .references(() => connectorAccounts.id, { onDelete: 'cascade' }),

    externalId: text('external_id').notNull(),
    // Beehiiv post id (e.g. 'post_abc123...'). Unique per user — upsert key.

    publicationId: text('publication_id').notNull(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    slug: text('slug'),
    webUrl: text('web_url'),

    audience: text('audience'),
    // 'free' | 'premium' | 'all'

    status: text('status'),
    // mirrors Beehiiv: 'draft' | 'confirmed' | 'archived'

    publishDate: timestamp('publish_date', { withTimezone: true }),

    bodyHtml: text('body_html'),
    bodyText: text('body_text'),

    contentTags: text('content_tags').array().default(sql`'{}'`),
    wordCount: integer('word_count'),

    embedding: vector('embedding', { dimensions: 1536 }),

    raw: jsonb('raw'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userPublishIdx: index('idx_newsletter_issues_user_publish').on(
      table.userId,
      table.publishDate
    ),
    embeddingIdx: index('idx_newsletter_issues_embedding').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops')
    ),
  })
);

// ────────────────────────────────────────────
// OBSIDIAN_NOTES — Sprint 15 Wave 2: vault notes synced via the Git-backed
// Obsidian connector. Mirrors newsletter_issues' shape (per-(user,
// externalId) row + embedding for findSimilar). externalId == path so
// the upsert key survives renames-as-deletes-plus-inserts (Obsidian's
// rename semantics through Git, anyway).
//
// blob_sha is the Git blob's content hash; the sync engine skips re-embed
// when it matches what's already stored.
// ────────────────────────────────────────────
export const obsidianNotes = pgTable(
  'obsidian_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectorAccountId: uuid('connector_account_id')
      .notNull()
      .references(() => connectorAccounts.id, { onDelete: 'cascade' }),

    externalId: text('external_id').notNull(),
    path: text('path').notNull(),

    blobSha: text('blob_sha'),
    commitSha: text('commit_sha'),

    title: text('title').notNull(),

    frontmatter: jsonb('frontmatter').default({}),

    bodyText: text('body_text'),
    bodyMarkdown: text('body_markdown'),

    links: text('links').array().default(sql`'{}'`),
    tags: text('tags').array().default(sql`'{}'`),

    wordCount: integer('word_count'),

    embedding: vector('embedding', { dimensions: 1536 }),

    raw: jsonb('raw'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userPathIdx: index('idx_obsidian_notes_user_path').on(
      table.userId,
      table.path
    ),
    userAccountIdx: index('idx_obsidian_notes_user_account').on(
      table.userId,
      table.connectorAccountId
    ),
    embeddingIdx: index('idx_obsidian_notes_embedding').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops')
    ),
  })
);

// ────────────────────────────────────────────
// LINKEDIN_POSTS — Phase 12 (2026-05-04)
// ────────────────────────────────────────────
// Mirrors obsidian_notes: per-user table of source documents that get
// embedded + idea-extracted on every sync. Populated by
// src/lib/linkedin-sync.ts which calls the Apify
// harvestapi/linkedin-profile-posts actor against the user's profile
// URL. Idempotent on (user_id, external_id) — the LinkedIn URN.
// See drizzle/0007_linkedin.sql for the matching SQL migration.
// ────────────────────────────────────────────
export const linkedinPosts = pgTable(
  'linkedin_posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectorAccountId: uuid('connector_account_id')
      .notNull()
      .references(() => connectorAccounts.id, { onDelete: 'cascade' }),

    externalId: text('external_id').notNull(),
    linkedinUrl: text('linkedin_url').notNull(),

    content: text('content'),
    bodyClean: text('body_clean'),

    postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),

    postType: text('post_type').notNull().default('post'),

    authorId: text('author_id'),
    authorHandle: text('author_handle'),
    authorName: text('author_name'),

    imageUrls: text('image_urls').array().default(sql`'{}'`),

    reactionCount: integer('reaction_count'),
    commentCount: integer('comment_count'),
    shareCount: integer('share_count'),

    embedding: vector('embedding', { dimensions: 1536 }),

    raw: jsonb('raw'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userExternalUnique: uniqueIndex('linkedin_posts_user_external_unique').on(
      table.userId,
      table.externalId
    ),
    userAccountIdx: index('idx_linkedin_posts_user_account').on(
      table.userId,
      table.connectorAccountId
    ),
    userPostedAtIdx: index('idx_linkedin_posts_user_posted_at').on(
      table.userId,
      table.postedAt
    ),
    embeddingIdx: index('idx_linkedin_posts_embedding').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops')
    ),
  })
);


// ────────────────────────────────────────────
// GMAIL_MESSAGES — Phase 13 (2026-05-04): subscribed-newsletter ingest via
// Gmail OAuth (Testing mode, single test user). Each row is one Gmail
// message we've classified as a newsletter via the detection ladder
// (platform sender domain → List-Unsubscribe header → subject keyword
// tiebreaker). Idempotent on (user_id, external_id) where external_id is
// the Gmail message id.
//
// Triage flow: every detected message lands as status='pending'. The
// Insights triage queue surfaces it; promote → embed + extractIdeas fire.
// dismiss → row stays for audit trail, embedding stays null forever.
// snooze → hide until snooze_until <= now().
//
// See drizzle/0009_gmail.sql for the matching SQL migration.
// ────────────────────────────────────────────
export const gmailMessages = pgTable(
  'gmail_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectorAccountId: uuid('connector_account_id')
      .notNull()
      .references(() => connectorAccounts.id, { onDelete: 'cascade' }),

    externalId: text('external_id').notNull(),
    threadId: text('thread_id'),

    fromAddress: text('from_address'),
    fromName: text('from_name'),

    subject: text('subject'),
    snippet: text('snippet'),

    bodyText: text('body_text'),
    bodyHtml: text('body_html'),
    bodyClean: text('body_clean'),

    postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),

    // Detection-quality audit. Records WHICH heuristic flagged this
    // message — lets us spot-check false positives later.
    //   'detected_substack' | 'detected_beehiiv' | 'detected_mailchimp'
    //   | 'detected_convertkit' | 'detected_ghost' | 'detected_buttondown'
    //   | 'list_unsubscribe' | 'subject_keyword'
    newsletterKind: text('newsletter_kind').notNull(),

    // Triage state — mirrors extracted_ideas.triageStatus semantics.
    //   'pending' (default) — fresh ingest, awaiting user attention.
    //   'promoted' — user said "real newsletter, ingest it".
    //   'dismissed' — user said "ignore" (audit-trail row, never embedded).
    //   'snoozed' — hide until snooze_until <= now().
    status: text('status').notNull().default('pending'),
    promotedAt: timestamp('promoted_at', { withTimezone: true }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    snoozeUntil: timestamp('snooze_until', { withTimezone: true }),

    // NULL for non-promoted rows — we only spend embed tokens on promoted
    // messages. The HNSW index is partial (WHERE embedding IS NOT NULL).
    embedding: vector('embedding', { dimensions: 1536 }),

    raw: jsonb('raw'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userExternalUnique: uniqueIndex('gmail_messages_user_external_unique').on(
      table.userId,
      table.externalId
    ),
    userStatusIdx: index('idx_gmail_messages_user_status').on(
      table.userId,
      table.status
    ),
    userPostedAtIdx: index('idx_gmail_messages_user_posted_at').on(
      table.userId,
      table.postedAt
    ),
    userAccountIdx: index('idx_gmail_messages_user_account').on(
      table.userId,
      table.connectorAccountId
    ),
    embeddingIdx: index('idx_gmail_messages_embedding').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops')
    ),
  })
);


// ────────────────────────────────────────────
// EXTRACTED_IDEAS — Sprint 15 Wave 2: the unit of meaning extractIdeas()
// pulls out of a source. Each row is one Idea with title/claim/evidence +
// depth/breadth signals. Wave 3's retrieval ranking will boost matches by
// these signals; for Wave 2 they're written + retrievable but not yet
// consumed by the assistant.
//
// Source is a discriminated FK: source_kind picks which of the two
// nullable reference columns is set. ON DELETE CASCADE on each FK means
// re-syncing a source naturally cleans up its previously-extracted ideas
// (the sync path deletes the source row on full-replace; for partial
// updates we delete-by-source explicitly).
// ────────────────────────────────────────────
export const extractedIdeas = pgTable(
  'extracted_ideas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // 'newsletter_issue' | 'obsidian_note' | 'linkedin_post' | 'gmail_message'
    sourceKind: text('source_kind').notNull(),
    newsletterIssueId: uuid('newsletter_issue_id').references(
      () => newsletterIssues.id,
      { onDelete: 'cascade' }
    ),
    obsidianNoteId: uuid('obsidian_note_id').references(
      () => obsidianNotes.id,
      { onDelete: 'cascade' }
    ),
    // Phase 12: third source kind. Same XOR pattern — exactly one of
    // newsletter_issue_id, obsidian_note_id, linkedin_post_id is set.
    linkedinPostId: uuid('linkedin_post_id').references(
      () => linkedinPosts.id,
      { onDelete: 'cascade' }
    ),
    // Phase 13: fourth source kind. Same XOR pattern — exactly one of
    // newsletter_issue_id, obsidian_note_id, linkedin_post_id, gmail_message_id is set.
    gmailMessageId: uuid('gmail_message_id').references(
      () => gmailMessages.id,
      { onDelete: 'cascade' }
    ),

    title: text('title').notNull(),
    claim: text('claim').notNull(),
    evidence: text('evidence'),

    depthSignal: real('depth_signal').notNull().default(0),
    breadthSignal: real('breadth_signal').notNull().default(0),

    links: text('links').array().default(sql`'{}'`),

    sourceRef: jsonb('source_ref').notNull().default({}),

    // Direction B (2026-05-04): triage flow.
    // 'pending' (default) — fresh extraction, awaiting user attention.
    // 'promoted' — user moved this into the Garden as a hand-curated idea.
    //              The matching ideas row carries source_extracted_idea_id.
    // 'dismissed' — user explicitly hid; never resurface.
    // 'snoozed' — DEPRECATED in Phase 14b; legacy rows migrated to 'pending'+cold.
    triageStatus: text('triage_status').notNull().default('pending'),
    triagedAt: timestamp('triaged_at', { withTimezone: true }),
    snoozeUntil: timestamp('snooze_until', { withTimezone: true }),

    // Phase 14b — Garden redesign (2026-05-04). Lifecycle columns mirror ideas.
    // Default 'cool' for unclaimed extracted ideas; bumped on rail retrieval,
    // promoted to a partner ideas row when the user claims (writes a sentence).
    temperature: text('temperature').notNull().default('cool'),
    temperatureUpdatedAt: timestamp('temperature_updated_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    digestSurfaceCount: integer('digest_surface_count').notNull().default(0),
    // The user's "Make it mine" sentence — copied to ideas.body on claim.
    claimText: text('claim_text'),

    embedding: vector('embedding', { dimensions: 1536 }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    sourceXor: check(
      'extracted_ideas_source_xor',
      sql`(${table.sourceKind} = 'newsletter_issue' AND ${table.newsletterIssueId} IS NOT NULL AND ${table.obsidianNoteId} IS NULL  AND ${table.linkedinPostId} IS NULL  AND ${table.gmailMessageId} IS NULL)
          OR
          (${table.sourceKind} = 'obsidian_note'    AND ${table.obsidianNoteId} IS NOT NULL AND ${table.newsletterIssueId} IS NULL  AND ${table.linkedinPostId} IS NULL  AND ${table.gmailMessageId} IS NULL)
          OR
          (${table.sourceKind} = 'linkedin_post'    AND ${table.linkedinPostId} IS NOT NULL AND ${table.newsletterIssueId} IS NULL  AND ${table.obsidianNoteId} IS NULL  AND ${table.gmailMessageId} IS NULL)
          OR
          (${table.sourceKind} = 'gmail_message'    AND ${table.gmailMessageId} IS NOT NULL AND ${table.newsletterIssueId} IS NULL  AND ${table.obsidianNoteId} IS NULL  AND ${table.linkedinPostId} IS NULL)`
    ),
    userKindIdx: index('idx_extracted_ideas_user_kind').on(
      table.userId,
      table.sourceKind
    ),
    newsletterSourceIdx: index('idx_extracted_ideas_newsletter_source')
      .on(table.newsletterIssueId)
      .where(sql`${table.newsletterIssueId} IS NOT NULL`),
    obsidianSourceIdx: index('idx_extracted_ideas_obsidian_source')
      .on(table.obsidianNoteId)
      .where(sql`${table.obsidianNoteId} IS NOT NULL`),
    linkedinSourceIdx: index('idx_extracted_ideas_linkedin_source')
      .on(table.linkedinPostId)
      .where(sql`${table.linkedinPostId} IS NOT NULL`),
    gmailSourceIdx: index('idx_extracted_ideas_gmail_source')
      .on(table.gmailMessageId)
      .where(sql`${table.gmailMessageId} IS NOT NULL`),
    signalsIdx: index('idx_extracted_ideas_signals').on(
      table.userId,
      table.depthSignal,
      table.breadthSignal
    ),
    embeddingIdx: index('idx_extracted_ideas_embedding').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops')
    ),
    userTriageIdx: index('idx_extracted_ideas_user_triage').on(
      table.userId,
      table.triageStatus
    ),
    userTemperatureIdx: index('idx_extracted_ideas_temperature').on(
      table.userId,
      table.temperature
    ),
  })
);

// ────────────────────────────────────────────
// VOICE — Phase 15a (2026-05-05)
// Per-platform voice profile + canonical-piece flagging.
// See drizzle/0013_voice_profiles.sql + spec at
// ~/Desktop/Thoughtbed/phase15a_voice_id_spec.md.
// ────────────────────────────────────────────
export const voiceProfiles = pgTable(
  'voice_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // 'longform' | 'linkedin' — see CHECK constraint below.
    platform: text('platform').notNull(),

    // Claude-derived (read-only in UI; rebuild overwrites).
    summary: text('summary'),
    attributesAuto: jsonb('attributes_auto').notNull().default([]),
    thingsToAvoidAuto: jsonb('things_to_avoid_auto').notNull().default([]),

    // User-authored (editable; persists across rebuilds).
    attributesManual: jsonb('attributes_manual').notNull().default([]),
    thingsToAvoidManual: jsonb('things_to_avoid_manual').notNull().default([]),

    // Build provenance.
    builtAt: timestamp('built_at', { withTimezone: true }),
    builtFromIds: jsonb('built_from_ids').notNull().default([]),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    platformChk: check(
      'voice_profiles_platform_chk',
      sql`${table.platform} IN ('longform', 'linkedin')`
    ),
    userPlatformUniq: uniqueIndex('voice_profiles_user_platform_uniq').on(
      table.userId,
      table.platform
    ),
    userIdx: index('idx_voice_profiles_user').on(table.userId),
  })
);

// Join table flagging which source pieces feed the profile build.
// source_id is a soft FK — its real target depends on source_kind, so
// no Drizzle .references() at this level. Cleanup of dangling rows is
// inert (LEFT JOINs skip nulls; future maintenance sweep can prune).
export const voiceCanonicalPieces = pgTable(
  'voice_canonical_pieces',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceKind: text('source_kind').notNull(),
    sourceId: uuid('source_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: uniqueIndex('voice_canonical_pieces_pkey').on(
      table.userId,
      table.sourceKind,
      table.sourceId
    ),
    sourceKindChk: check(
      'voice_canonical_pieces_source_kind_chk',
      sql`${table.sourceKind} IN ('newsletter_issue', 'obsidian_note', 'linkedin_post')`
    ),
    userKindIdx: index('idx_voice_canonical_user_kind').on(
      table.userId,
      table.sourceKind
    ),
  })
);

// ────────────────────────────────────────────
// VOICE TRAINING SAMPLES — Phase 15 UX rework (2026-05-05)
// 5-sample-picker model matching Ghostbase. Each row is one sample
// for a (user, platform). Corpus samples carry a pointer; paste +
// upload samples carry inline title/body. App layer caps at 5 per
// (user, platform).
// ────────────────────────────────────────────
export const voiceTrainingSamples = pgTable(
  'voice_training_samples',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // 'longform' | 'linkedin'
    platform: text('platform').notNull(),
    // 'corpus' | 'paste' | 'upload'
    kind: text('kind').notNull(),

    // For kind='corpus' only: pointer into the source tables.
    sourceKind: text('source_kind'),
    sourceId: uuid('source_id'),

    // For kind='paste' / 'upload': inline content.
    title: text('title').notNull(),
    body: text('body').notNull(),
    filename: text('filename'),

    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    platformChk: check(
      'voice_training_samples_platform_chk',
      sql`${table.platform} IN ('longform', 'linkedin')`
    ),
    kindChk: check(
      'voice_training_samples_kind_chk',
      sql`${table.kind} IN ('corpus', 'paste', 'upload')`
    ),
    sourceKindChk: check(
      'voice_training_samples_source_kind_chk',
      sql`${table.sourceKind} IS NULL OR ${table.sourceKind} IN ('newsletter_issue', 'obsidian_note', 'linkedin_post')`
    ),
    userPlatformIdx: index('idx_voice_training_samples_user_platform').on(
      table.userId,
      table.platform,
      table.position
    ),
  })
);

// ────────────────────────────────────────────
// Type exports for inference
// ────────────────────────────────────────────
export type User = typeof users.$inferSelect;
export type Idea = typeof ideas.$inferSelect;
export type Capture = typeof captures.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type Thread = typeof threads.$inferSelect;
export type ThreadEntry = typeof threadEntries.$inferSelect;
export type IdeaEdge = typeof ideaEdges.$inferSelect;
export type AssistantOffer = typeof assistantOffers.$inferSelect;
export type Draft = typeof drafts.$inferSelect;
export type DraftVersion = typeof draftVersions.$inferSelect;
export type ConnectorAccount = typeof connectorAccounts.$inferSelect;
export type NewsletterIssue = typeof newsletterIssues.$inferSelect;
export type ObsidianNote = typeof obsidianNotes.$inferSelect;
export type ExtractedIdea = typeof extractedIdeas.$inferSelect;
export type VoiceProfile = typeof voiceProfiles.$inferSelect;
export type VoiceCanonicalPiece = typeof voiceCanonicalPieces.$inferSelect;
export type VoiceTrainingSample = typeof voiceTrainingSamples.$inferSelect;

export type NewUser = typeof users.$inferInsert;
export type NewIdea = typeof ideas.$inferInsert;
export type NewCapture = typeof captures.$inferInsert;
export type NewArtifact = typeof artifacts.$inferInsert;
export type NewDraft = typeof drafts.$inferInsert;
export type NewDraftVersion = typeof draftVersions.$inferInsert;
export type NewConnectorAccount = typeof connectorAccounts.$inferInsert;
export type NewNewsletterIssue = typeof newsletterIssues.$inferInsert;
export type NewObsidianNote = typeof obsidianNotes.$inferInsert;
export type LinkedinPost = typeof linkedinPosts.$inferSelect;
export type NewLinkedinPost = typeof linkedinPosts.$inferInsert;
export type GmailMessage = typeof gmailMessages.$inferSelect;
export type NewGmailMessage = typeof gmailMessages.$inferInsert;
export type NewExtractedIdea = typeof extractedIdeas.$inferInsert;


// ────────────────────────────────────────────
// GMAIL_SENDER_RULES — Phase 14a (2026-05-04)
// ────────────────────────────────────────────
// Per-user allowlist + blocklist rules for the Gmail triage queue.
//
// Two rule kinds, exclusive per row (XOR check at the SQL layer):
//   · sender_address — full mailbox match, e.g. "lenny@lennysnewsletter.com"
//   · sender_domain  — domain match, e.g. "nba.com"
// At evaluation time per-address rules win over per-domain rules.
//
// Two actions:
//   · 'allow' — bypass triage; detected message lands status='promoted'
//               and embeds + extracts ideas in the same write.
//   · 'block' — never reach the triage queue; classifyAndPersist drops
//               the message before parsing.
//
// reason carries 'manual' (user clicked the row menu) or 'auto_suggested'
// (system noticed N dismisses/promotes from the same domain and the user
// clicked the suggestion banner).
//
// See drizzle/0010_gmail_sender_rules.sql for the migration.
// ────────────────────────────────────────────
export const gmailSenderRules = pgTable(
  'gmail_sender_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    senderAddress: text('sender_address'),
    senderDomain: text('sender_domain'),
    action: text('action').notNull(),
    // 'allow' | 'block'
    reason: text('reason'),
    // 'manual' | 'auto_suggested' (future: 'imported', etc.)
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    xor: check(
      'gmail_sender_rules_xor',
      sql`(${table.senderAddress} IS NOT NULL)::int + (${table.senderDomain} IS NOT NULL)::int = 1`
    ),
    actionChk: check(
      'gmail_sender_rules_action_chk',
      sql`${table.action} IN ('allow', 'block')`
    ),
    uniqueRule: uniqueIndex('gmail_sender_rules_unique').on(
      table.userId,
      table.senderAddress,
      table.senderDomain,
      table.action
    ),
    userAddrIdx: index('idx_gmail_sender_rules_user_addr')
      .on(table.userId, table.senderAddress)
      .where(sql`${table.senderAddress} IS NOT NULL`),
    userDomainIdx: index('idx_gmail_sender_rules_user_domain')
      .on(table.userId, table.senderDomain)
      .where(sql`${table.senderDomain} IS NOT NULL`),
  })
);

export type GmailSenderRule = typeof gmailSenderRules.$inferSelect;
export type NewGmailSenderRule = typeof gmailSenderRules.$inferInsert;


// ────────────────────────────────────────────
// GARDEN_JUXTAPOSITIONS — Phase 14b (2026-05-04)
// ────────────────────────────────────────────
// System-surfaced creative juxtapositions (the marquee partnership move).
// Each row is a pair of ideas the system flagged as creatively connected
// — same theme + opposite stance, contradictory self-claim, or new claim
// with a dormant ancestor. Plus a generated provocation question.
//
// Polymorphic refs: left_id and right_id can point at either `ideas` or
// `extracted_ideas`, distinguished by left_kind / right_kind. App-level
// referential integrity (no FK — application sweeps stale rows on idea
// delete). See drizzle/0012_garden_juxtapositions.sql.
// ────────────────────────────────────────────
export const gardenJuxtapositions = pgTable(
  'garden_juxtapositions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // 'tension_within_theme' | 'self_disagreement' | 'old_echo_of_new'
    heuristic: text('heuristic').notNull(),

    leftKind: text('left_kind').notNull(),  // 'idea' | 'extracted_idea'
    leftId: uuid('left_id').notNull(),
    rightKind: text('right_kind').notNull(),
    rightId: uuid('right_id').notNull(),

    question: text('question').notNull(),
    reasoning: text('reasoning').notNull(),
    score: real('score').notNull(),

    surfacedAt: timestamp('surfaced_at', { withTimezone: true }),
    actedOn: text('acted_on'),  // 'opened' | 'claimed' | 'skipped' | null
    actedAt: timestamp('acted_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userSurfacedIdx: index('idx_garden_juxtapositions_user_surfaced').on(
      table.userId,
      table.surfacedAt
    ),
    userPendingIdx: index('idx_garden_juxtapositions_user_pending')
      .on(table.userId, table.score)
      .where(sql`${table.surfacedAt} IS NULL`),
  })
);

// ────────────────────────────────────────────
// GARDEN_DIGEST_RUNS — Phase 14b (2026-05-04)
// Daily digest snapshot. Cron writes one row per (user, date). Page reads cache.
// ────────────────────────────────────────────
export const gardenDigestRuns = pgTable(
  'garden_digest_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    runDate: timestamp('run_date', { mode: 'date', withTimezone: false }).notNull(),
    // jsonb: [{ kind: 'idea' | 'extracted_idea', id: uuid, reason: string }]
    selected: jsonb('selected').notNull(),
    juxtapositionId: uuid('juxtaposition_id').references(
      () => gardenJuxtapositions.id,
      { onDelete: 'set null' }
    ),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userDateIdx: index('idx_garden_digest_runs_user_date').on(
      table.userId,
      table.runDate
    ),
    userDateUnique: uniqueIndex('garden_digest_runs_user_date_unique').on(
      table.userId,
      table.runDate
    ),
  })
);

export type GardenJuxtaposition = typeof gardenJuxtapositions.$inferSelect;
export type NewGardenJuxtaposition = typeof gardenJuxtapositions.$inferInsert;
export type GardenDigestRun = typeof gardenDigestRuns.$inferSelect;
export type NewGardenDigestRun = typeof gardenDigestRuns.$inferInsert;

// ────────────────────────────────────────────────────────────────────
// IDEA_CLUSTERS — Phase 17 (2026-05-05) garden maturation v2
// ────────────────────────────────────────────────────────────────────
//
// Per-day cluster snapshots produced by the garden-digest cron.
// computeClusters groups ideas + extracted_ideas by cosine ≥ 0.75 +
// shared theme tag and writes one row per cluster. The default Garden
// surface reads today's run via readClustersForToday.
//
// Cluster identity is per-day (not durable across days). Members live
// in members jsonb as { kind, id, ripeness } objects.
//
// `theme` is the shared theme tag the cluster shares; null when the
// cluster's identity comes from cosine alone (rare).

export const ideaClusters = pgTable(
  'idea_clusters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    runDate: date('run_date').notNull(),
    repKind: text('rep_kind').notNull(),
    repId: uuid('rep_id').notNull(),
    theme: text('theme'),
    memberCount: integer('member_count').notNull().default(1),
    members: jsonb('members').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userDateIdx: index('idx_idea_clusters_user_date').on(
      table.userId,
      table.runDate
    ),
    uniqByRep: unique('idea_clusters_user_run_rep_unique').on(
      table.userId,
      table.runDate,
      table.repKind,
      table.repId
    ),
  })
);

export type IdeaClusterRow = typeof ideaClusters.$inferSelect;
export type NewIdeaCluster = typeof ideaClusters.$inferInsert;


// ────────────────────────────────────────────
// CHAT_SESSIONS — Phase 23 v2 slice 7
// Persists a Writing × With-assistant coaching thread so the user
// can navigate away (open a source in a new tab, get pulled into a
// meeting) and come back via /studio?chat=<id> without losing the
// conversation. Sidebar surfaces recent sessions.
// ────────────────────────────────────────────
export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    title: text('title').notNull(),
    topic: text('topic').notNull(),

    // 'newsletter' | 'linkedin' | 'unknown'
    platformGuess: text('platform_guess').notNull().default('unknown'),

    // CoachTurn[] — { kind: 'user' | 'assistant', text?, proposal?,
    // carriedAngleLine?, carriedSourceIds?, refinementKey? }.
    turns: jsonb('turns').notNull().default([]),

    // 'thread' | 'coaching' | 'finalized'
    stage: text('stage').notNull().default('coaching'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userUpdatedIdx: index('chat_sessions_user_updated_idx').on(
      table.userId,
      table.updatedAt
    ),
  })
);

export type ChatSessionRow = typeof chatSessions.$inferSelect;
export type NewChatSession = typeof chatSessions.$inferInsert;
