/**
 * src/db/schema.ts — Sprint 15 Wave 2
 *
 * Full Drizzle schema.  Changes from Wave 1:
 *   + obsidianNotes table
 *   + extractedIdeas table (XOR FK to newsletter_issues or obsidian_notes)
 *   + obsidian entry in the ConnectorId enum
 */

import {
  pgTable,
  pgEnum,
  text,
  uuid,
  timestamp,
  jsonb,
  real,
  integer,
  boolean,
  check,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

export const connectorIdEnum = pgEnum('connector_id', [
  'beehiiv',
  'obsidian',   // ← Wave 2
]);

// ─────────────────────────────────────────────────────────────────────────────
// users
// ─────────────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id:        uuid('id').primaryKey().defaultRandom(),
  email:     text('email').notNull().unique(),
  name:      text('name'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────────────────────
// newsletter_issues
// ─────────────────────────────────────────────────────────────────────────────

export const newsletterIssues = pgTable(
  'newsletter_issues',
  {
    id:          uuid('id').primaryKey().defaultRandom(),
    beehiivId:   text('beehiiv_id').notNull().unique(),
    title:       text('title'),
    subtitle:    text('subtitle'),
    content:     text('content').notNull().default(''),
    summary:     text('summary'),
    tags:        text('tags').array().notNull().default(sql`'{}'`),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    status:      text('status').notNull().default('draft'),
    createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ([
    index('newsletter_issues_published_at_idx').on(t.publishedAt),
    index('newsletter_issues_status_idx').on(t.status),
  ])
);

// ─────────────────────────────────────────────────────────────────────────────
// obsidian_notes   (Wave 2)
// ─────────────────────────────────────────────────────────────────────────────

export const obsidianNotes = pgTable(
  'obsidian_notes',
  {
    /** Stable ID: "owner/repo::vault/relative/path.md" */
    id:          text('id').primaryKey(),
    repoFull:    text('repo_full').notNull(),
    title:       text('title'),
    content:     text('content').notNull().default(''),
    frontmatter: jsonb('frontmatter').notNull().default({}),
    tags:        text('tags').array().notNull().default(sql`'{}'`),
    wikilinks:   text('wikilinks').array().notNull().default(sql`'{}'`),
    blobSha:     text('blob_sha'),
    syncedAt:    timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ([
    index('obsidian_notes_repo_full_idx').on(t.repoFull),
    index('obsidian_notes_synced_at_idx').on(t.syncedAt),
  ])
);

// ─────────────────────────────────────────────────────────────────────────────
// extracted_ideas   (Wave 2)
// ─────────────────────────────────────────────────────────────────────────────

export const extractedIdeas = pgTable(
  'extracted_ideas',
  {
    id:            uuid('id').primaryKey().defaultRandom(),

    // Exactly one of these must be non-NULL (XOR enforced by check constraint).
    issueId:       uuid('issue_id').references(() => newsletterIssues.id, { onDelete: 'cascade' }),
    noteId:        text('note_id').references(() => obsidianNotes.id,     { onDelete: 'cascade' }),

    title:         text('title').notNull(),
    claim:         text('claim').notNull(),
    evidence:      text('evidence'),

    depthScore:    real('depth_score'),
    breadthScore:  real('breadth_score'),

    outboundLinks: text('outbound_links').array().notNull().default(sql`'{}'`),
    sourceRef:     text('source_ref'),

    extractedAt:   timestamp('extracted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ([
    check(
      'extracted_ideas_single_source',
      sql`(${t.issueId} IS NOT NULL)::int + (${t.noteId} IS NOT NULL)::int = 1`
    ),
    index('extracted_ideas_issue_id_idx').on(t.issueId),
    index('extracted_ideas_note_id_idx').on(t.noteId),
    index('extracted_ideas_depth_idx').on(t.depthScore),
    index('extracted_ideas_breadth_idx').on(t.breadthScore),
  ])
);

// ─────────────────────────────────────────────────────────────────────────────
// user_connectors
// ─────────────────────────────────────────────────────────────────────────────

export const userConnectors = pgTable(
  'user_connectors',
  {
    id:          uuid('id').primaryKey().defaultRandom(),
    userId:      uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    connectorId: connectorIdEnum('connector_id').notNull(),
    credentials: jsonb('credentials').notNull().default({}),
    syncedAt:    timestamp('synced_at', { withTimezone: true }),
    createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ([
    uniqueIndex('user_connectors_user_connector_uidx').on(t.userId, t.connectorId),
    index('user_connectors_connector_id_idx').on(t.connectorId),
  ])
);

// ─────────────────────────────────────────────────────────────────────────────
// newsletter_embeddings
// ─────────────────────────────────────────────────────────────────────────────

export const newsletterEmbeddings = pgTable(
  'newsletter_embeddings',
  {
    id:        uuid('id').primaryKey().defaultRandom(),
    issueId:   uuid('issue_id').notNull().references(() => newsletterIssues.id, { onDelete: 'cascade' }),
    chunkIdx:  integer('chunk_idx').notNull().default(0),
    content:   text('content').notNull(),
    // pgvector column — declared as text here; actual type set by migration.
    embedding: text('embedding'),
    model:     text('model').notNull().default('text-embedding-3-small'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ([
    uniqueIndex('newsletter_embeddings_issue_chunk_uidx').on(t.issueId, t.chunkIdx),
    index('newsletter_embeddings_issue_id_idx').on(t.issueId),
  ])
);
