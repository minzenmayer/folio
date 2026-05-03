// Folio · Shared studio server actions
//
// Sprint 7 ships two pieces of plumbing that belong to no single room:
//
//   • backfillEmbeddings({ kind })  — sweeps rows where embedding IS NULL,
//     computes them in batches of 10, sleeps 200ms between batches. Needed
//     because Sprint 3's createCapture already embedded but pre-Sprint-7
//     ideas/drafts and pre-Sprint-3 captures don't.
//
//   • findSimilar({ text, kinds, limit }) — top-N rows across captures /
//     ideas / drafts ordered by cosine distance to the query embedding.
//     The single retrieval primitive that the "Related" panel consumes
//     today and that Sprint 8's Assistant rail will consume tomorrow.
//
// Both are strictly user-scoped — every query carries a userId match — and
// both rely on pgvector's <=> cosine-distance operator with HNSW indexes
// (idx_*_embedding) for shaping the result.

'use server';

import { eq, and, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, captures, ideas, drafts } from '@/db';
import { requireUser } from '@/lib/auth';
import { embedText } from '@/lib/embed';
import { tiptapJsonToText } from '@/lib/exports';

// ─── shared helpers ────────────────────────────────────────

// Mirror of ideaEmbedSource from /studio/ideas/actions.ts — kept here so the
// backfill computes embeddings the same way the save path does. If the save
// path's source-text shape changes, change this too (write-time and search-
// time embeddings must stay aligned, otherwise neighbors drift).
function ideaEmbedSource(idea: {
  title: string;
  essence: string | null;
}): string | null {
  const parts = [idea.title.trim()];
  const essence = idea.essence?.trim();
  if (essence) parts.push(essence.slice(0, 2000));
  const text = parts.join('\n\n').trim();
  return text.length > 0 ? text : null;
}

// Mirror of draftEmbedSource from /studio/page/actions.ts — same stay-aligned
// reasoning as ideaEmbedSource above.
function draftEmbedSource(
  contentJson: unknown,
  title: string | null
): string | null {
  const body = tiptapJsonToText(contentJson).trim();
  const head = title?.trim();
  const text = head ? `${head}\n\n${body}` : body;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Source text for a capture. Sprint 3's createCapture embeds the body
// directly; we replicate that here.
function captureEmbedSource(capture: { body: string }): string | null {
  const text = capture.body.trim();
  return text.length > 0 ? text : null;
}

const BATCH_SIZE = 10;
const BATCH_SLEEP_MS = 200;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * pgvector wants the embedding as a Postgres literal of shape '[1,2,3,...]'
 * when interpolated through `sql` template literals. Drizzle's standard
 * .set({ embedding }) handles this for INSERT/UPDATE on the typed column,
 * but the ORDER BY ... <=> $1 path inside findSimilar needs the literal.
 */
function vectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

// ─── backfillEmbeddings ───────────────────────────────────────

export type BackfillKind = 'captures' | 'ideas' | 'drafts' | 'all';

export type BackfillResult = {
  scanned: Record<'captures' | 'ideas' | 'drafts', number>;
  embedded: Record<'captures' | 'ideas' | 'drafts', number>;
  failed: number;
};

const backfillSchema = z.object({
  kind: z.enum(['captures', 'ideas', 'drafts', 'all']).default('all'),
});

export async function backfillEmbeddings(
  input: unknown = {}
): Promise<BackfillResult> {
  const user = await requireUser();
  const { kind } = backfillSchema.parse(input);

  const result: BackfillResult = {
    scanned: { captures: 0, ideas: 0, drafts: 0 },
    embedded: { captures: 0, ideas: 0, drafts: 0 },
    failed: 0,
  };

  if (kind === 'captures' || kind === 'all') {
    const rows = await db
      .select({ id: captures.id, body: captures.body })
      .from(captures)
      .where(and(eq(captures.userId, user.id), isNull(captures.embedding)));
    result.scanned.captures = rows.length;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const slice = rows.slice(i, i + BATCH_SIZE);
      const settled = await Promise.allSettled(
        slice.map(async (row) => {
          const text = captureEmbedSource(row);
          if (!text) return false;
          const embedding = await embedText(text);
          await db
            .update(captures)
            .set({ embedding })
            .where(
              and(eq(captures.id, row.id), eq(captures.userId, user.id))
            );
          return true;
        })
      );
      for (const s of settled) {
        if (s.status === 'fulfilled' && s.value) result.embedded.captures++;
        else if (s.status === 'rejected') result.failed++;
      }
      if (i + BATCH_SIZE < rows.length) await sleep(BATCH_SLEEP_MS);
    }
  }

  if (kind === 'ideas' || kind === 'all') {
    const rows = await db
      .select({
        id: ideas.id,
        title: ideas.title,
        essence: ideas.essence,
      })
      .from(ideas)
      .where(and(eq(ideas.userId, user.id), isNull(ideas.embedding)));
    result.scanned.ideas = rows.length;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const slice = rows.slice(i, i + BATCH_SIZE);
      const settled = await Promise.allSettled(
        slice.map(async (row) => {
          const text = ideaEmbedSource(row);
          if (!text) return false;
          const embedding = await embedText(text);
          await db
            .update(ideas)
            .set({ embedding })
            .where(and(eq(ideas.id, row.id), eq(ideas.userId, user.id)));
          return true;
        })
      );
      for (const s of settled) {
        if (s.status === 'fulfilled' && s.value) result.embedded.ideas++;
        else if (s.status === 'rejected') result.failed++;
      }
      if (i + BATCH_SIZE < rows.length) await sleep(BATCH_SLEEP_MS);
    }
  }

  if (kind === 'drafts' || kind === 'all') {
    const rows = await db
      .select({
        id: drafts.id,
        title: drafts.title,
        contentJson: drafts.contentJson,
      })
      .from(drafts)
      .where(and(eq(drafts.userId, user.id), isNull(drafts.embedding)));
    result.scanned.drafts = rows.length;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const slice = rows.slice(i, i + BATCH_SIZE);
      const settled = await Promise.allSettled(
        slice.map(async (row) => {
          const text = draftEmbedSource(row.contentJson, row.title);
          if (!text) return false;
          const embedding = await embedText(text);
          await db
            .update(drafts)
            .set({ embedding })
            .where(and(eq(drafts.id, row.id), eq(drafts.userId, user.id)));
          return true;
        })
      );
      for (const s of settled) {
        if (s.status === 'fulfilled' && s.value) result.embedded.drafts++;
        else if (s.status === 'rejected') result.failed++;
      }
      if (i + BATCH_SIZE < rows.length) await sleep(BATCH_SLEEP_MS);
    }
  }

  return result;
}

// ─── findSimilar ───────────────────────────────────

export type SimilarKind = 'capture' | 'idea' | 'draft';

export type SimilarHit = {
  kind: SimilarKind;
  id: string;
  title: string | null;
  snippet: string | null;
  similarity: number; // 0..1, 1 = identical
};

const findSimilarSchema = z.object({
  text: z.string().min(1).max(8000),
  kinds: z
    .array(z.enum(['capture', 'idea', 'draft']))
    .min(1)
    .default(['capture', 'idea', 'draft']),
  limit: z.number().int().min(1).max(50).default(10),
  // Caller passes when retrieval is "things related to X" and X itself
  // shouldn't show up in its own related list.
  excludeIdeaId: z.string().uuid().optional(),
  excludeDraftId: z.string().uuid().optional(),
  excludeCaptureId: z.string().uuid().optional(),
});

export async function findSimilar(input: unknown): Promise<SimilarHit[]> {
  const user = await requireUser();
  const data = findSimilarSchema.parse(input);

  // Embed the query. If the OpenAI call fails we surface it; this is the
  // user-visible retrieval path, not a background save, so silent failure
  // would mean an empty Related panel for an unclear reason.
  const queryEmbedding = await embedText(data.text);
  const lit = vectorLiteral(queryEmbedding);

  const wanted = new Set<SimilarKind>(data.kinds);
  // Each kind queries its own table for top-N by cosine distance, then we
  // merge + sort in JS. Per-kind limit is the requested global limit so a
  // single kind can fill the result if the others return nothing.
  const perKindLimit = data.limit;

  const promises: Promise<SimilarHit[]>[] = [];

  if (wanted.has('capture')) {
    const captureWhere = data.excludeCaptureId
      ? sql`${captures.userId} = ${user.id}
            AND ${captures.embedding} IS NOT NULL
            AND ${captures.id} != ${data.excludeCaptureId}`
      : sql`${captures.userId} = ${user.id}
            AND ${captures.embedding} IS NOT NULL`;

    promises.push(
      db
        .select({
          id: captures.id,
          body: captures.body,
          summary: captures.summary,
          // 1 - cosine_distance == cosine_similarity; the <=> operator returns
          // the distance (0 = identical, 2 = opposite).
          distance: sql<number>`${captures.embedding} <=> ${lit}::vector`,
        })
        .from(captures)
        .where(captureWhere)
        .orderBy(sql`${captures.embedding} <=> ${lit}::vector`)
        .limit(perKindLimit)
        .then((rows) =>
          rows.map(
            (r): SimilarHit => ({
              kind: 'capture',
              id: r.id,
              title: r.summary ?? null,
              snippet: r.body,
              similarity: 1 - Number(r.distance),
            })
          )
        )
    );
  }

  if (wanted.has('idea')) {
    const ideaWhere = data.excludeIdeaId
      ? sql`${ideas.userId} = ${user.id}
            AND ${ideas.embedding} IS NOT NULL
            AND ${ideas.id} != ${data.excludeIdeaId}`
      : sql`${ideas.userId} = ${user.id}
            AND ${ideas.embedding} IS NOT NULL`;

    promises.push(
      db
        .select({
          id: ideas.id,
          title: ideas.title,
          essence: ideas.essence,
          distance: sql<number>`${ideas.embedding} <=> ${lit}::vector`,
        })
        .from(ideas)
        .where(ideaWhere)
        .orderBy(sql`${ideas.embedding} <=> ${lit}::vector`)
        .limit(perKindLimit)
        .then((rows) =>
          rows.map(
            (r): SimilarHit => ({
              kind: 'idea',
              id: r.id,
              title: r.title,
              snippet: r.essence,
              similarity: 1 - Number(r.distance),
            })
          )
        )
    );
  }

  if (wanted.has('draft')) {
    const draftWhere = data.excludeDraftId
      ? sql`${drafts.userId} = ${user.id}
            AND ${drafts.embedding} IS NOT NULL
            AND ${drafts.id} != ${data.excludeDraftId}`
      : sql`${drafts.userId} = ${user.id}
            AND ${drafts.embedding} IS NOT NULL`;

    promises.push(
      db
        .select({
          id: drafts.id,
          title: drafts.title,
          contentJson: drafts.contentJson,
          distance: sql<number>`${drafts.embedding} <=> ${lit}::vector`,
        })
        .from(drafts)
        .where(draftWhere)
        .orderBy(sql`${drafts.embedding} <=> ${lit}::vector`)
        .limit(perKindLimit)
        .then((rows) =>
          rows.map((r): SimilarHit => {
            // Use the H1-derived title when present; otherwise crib the
            // first ~120 chars of flattened text as the snippet.
            const flat = tiptapJsonToText(r.contentJson).trim();
            const snippet =
              flat.length > 0
                ? flat.slice(0, 200) + (flat.length > 200 ? '…' : '')
                : null;
            return {
              kind: 'draft',
              id: r.id,
              title: r.title,
              snippet,
              similarity: 1 - Number(r.distance),
            };
          })
        )
    );
  }

  const buckets = await Promise.all(promises);
  const all = buckets.flat();
  all.sort((a, b) => b.similarity - a.similarity);
  return all.slice(0, data.limit);
}
