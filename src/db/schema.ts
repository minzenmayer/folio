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
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ──────────────────────────────────────────────
// USERS — managed by Clerk; we mirror just the ID + minimal profile
// ──────────────────────────────────────────────
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkId: text('clerk_id').notNull().unique(),
  email: text('email').notNull(),
  name: text('name'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ──────────────────────────────────────────────
// IDEAS — the foundational primitive
// ──────────────────────────────────────────────
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

// ──────────────────────────────────────────────
// CAPTURES — raw material; the bank's content
// ──────────────────────────────────────────────
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

// ──────────────────────────────────────────────
// ARTIFACTS — built things
// ──────────────────────────────────────────────
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

// ──────────────────────────────────────────────
// THREADS — journal entries on an idea
// ──────────────────────────────────────────────
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

// ──────────────────────────────────────────────
// IDEA EDGES — typed relationships between ideas
// ──────────────────────────────────────────────
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

// ──────────────────────────────────────────────
// ASSISTANT_OFFERS — log of what the Assistant suggested
// Used to tune retrieval over time and track acceptance
// ──────────────────────────────────────────────
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

// ──────────────────────────────────────────────
// DRAFTS — Sprint 5: The Page
// In-progress writing surfaces. Tiptap doc serialized as ProseMirror JSON.
// May mature into an idea + artifact later; nullable ideaId reflects that.
// ──────────────────────────────────────────────
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

// ──────────────────────────────────────────────
// DRAFT VERSIONS — Sprint 6: history trail for The Page
// Every successful save snapshots into here, with a 30s coalesce window
// (an autosave row younger than 30s gets overwritten in place rather than
// duplicated). Restoring a version creates a new row with source='restore'.
// ──────────────────────────────────────────────
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

// ──────────────────────────────────────────────
// Type exports for inference
// ──────────────────────────────────────────────
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

export type NewUser = typeof users.$inferInsert;
export type NewIdea = typeof ideas.$inferInsert;
export type NewCapture = typeof captures.$inferInsert;
export type NewArtifact = typeof artifacts.$inferInsert;
export type NewDraft = typeof drafts.$inferInsert;
export type NewDraftVersion = typeof draftVersions.$inferInsert;
