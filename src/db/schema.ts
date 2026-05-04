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
    // 'snoozed' — hide until snooze_until <= now(); the default Insights
    //             query unhides it automatically when ripe.
    triageStatus: text('triage_status').notNull().default('pending'),
    triagedAt: timestamp('triaged_at', { withTimezone: true }),
    snoozeUntil: timestamp('snooze_until', { withTimezone: true }),

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
