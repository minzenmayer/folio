// Folio · Shared studio server actions
//
// Sprint 7 shipped two pieces of plumbing that belong to no single room:
//
//   • backfillEmbeddings({ kind })  — sweeps rows where embedding IS NULL,
//     computes them in batches of 10, sleeps 200ms between batches. Needed
//     because Sprint 3's createCapture already embedded but pre-Sprint-7
//     ideas/drafts and pre-Sprint-3 captures don't.
//
//   • findSimilar({ text, kinds, limit }) — top-N rows across captures /
//     ideas / drafts ordered by cosine distance to the query embedding.
//     The retrieval primitive that the Related panel and Sprint 8's
//     AssistantRailLive both consume.
//
// Sprint 9 adds the generative half:
//
//   • reflect({ draftId }) — loads the draft, runs findSimilar on its text,
//     hands draft + grounding hits to Claude (via @ai-sdk/anthropic), and
//     returns a 2-3 sentence reflection in the user's own voice. Failures
//     return as a typed { ok: false } variant rather than throwing, so the
//     Assistant rail can render a graceful error state.
//
// All three actions are strictly user-scoped. The vector queries use
// pgvector's <=> cosine-distance operator with HNSW indexes
// (idx_*_embedding); reflect() pays for one extra embedding round-trip
// (via findSimilar) which is cheap enough at Haiku-tier costs to ignore.

'use server';

import { eq, and, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, captures, ideas, drafts } from '@/db';
import { requireUser } from '@/lib/auth';
import { embedText } from '@/lib/embed';
import { tiptapJsonToText } from '@/lib/exports';
import { generateReflection } from '@/lib/llm';

// ─── shared helpers ───────────────────────────────────

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

// ─── backfillEmbeddings ─────────────────────────────────

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

// ─── findSimilar ─────────────────────────────────

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

// ─── reflect — Sprint 9 generative Assistant ─────────────────────────

// Below this length the reflection isn't worth running — Claude needs at
// least a sentence or two to anchor on. Mirrors the MIN_QUERY_CHARS in
// AssistantRailLive's debounced retrieval; both feel like the same
// "got something to chew on" threshold to the user.
const MIN_REFLECT_CHARS = 50;

// Cap on grounding hits passed to Claude. Five is enough to shape the
// reflection without inflating prompt cost or letting the bracket
// citations sprawl past visual scanability.
const REFLECT_HIT_LIMIT = 5;

const reflectSchema = z.object({
  draftId: z.string().uuid(),
});

export type ReflectResult =
  | {
      ok: true;
      reflection: string;
      sources: SimilarHit[];
      basedOnChars: number;
    }
  | {
      ok: false;
      reason: 'too_short' | 'no_text' | 'error';
      message: string;
    };

/**
 * Generate a reflection on a draft, grounded in the user's own bank.
 *
 * Returns a discriminated union so the Assistant rail can branch cleanly:
 *   · too_short / no_text → friendly nudge in the UI ("write a bit more").
 *   · error → render a quiet failure note; Claude downtime shouldn't 500.
 *   · ok → reflection text + sources for the "drawn from" list.
 *
 * Generation failure is a soft failure (returns ok: false). Auth + ownership
 * mismatches still throw — those are bugs, not user-facing states.
 */
export async function reflect(input: unknown): Promise<ReflectResult> {
  const user = await requireUser();
  const { draftId } = reflectSchema.parse(input);

  // Confirm ownership and grab the doc + title.
  const [draft] = await db
    .select({
      id: drafts.id,
      contentJson: drafts.contentJson,
      title: drafts.title,
    })
    .from(drafts)
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, user.id)))
    .limit(1);
  if (!draft) throw new Error('Draft not found');

  // Flatten the Tiptap doc to plain text for both retrieval and the prompt.
  // Title (when present) is prefixed so the H1 informs grounding even if the
  // body doesn't mention it.
  const draftBody = tiptapJsonToText(draft.contentJson).trim();
  const draftHead = draft.title?.trim();
  const draftText = draftHead ? `${draftHead}\n\n${draftBody}` : draftBody;

  if (draftText.length === 0) {
    return {
      ok: false,
      reason: 'no_text',
      message: 'Nothing to reflect on yet — start writing.',
    };
  }
  if (draftText.length < MIN_REFLECT_CHARS) {
    return {
      ok: false,
      reason: 'too_short',
      message: 'Write a bit more, then try again.',
    };
  }

  // Best-effort retrieval. If the embedding call fails (no key, network
  // blip), Claude still gets the draft alone — the reflection just won't
  // cite the bank. Better than failing the whole feature on retrieval.
  let sources: SimilarHit[] = [];
  try {
    sources = await findSimilar({
      text: draftText.slice(0, 4000),
      kinds: ['capture', 'idea', 'draft'],
      limit: REFLECT_HIT_LIMIT,
      excludeDraftId: draftId,
    });
  } catch (err) {
    console.warn('[reflect] findSimilar failed; continuing ungrounded', err);
  }

  try {
    const reflection = await generateReflection({
      draftText,
      hits: sources.map((s, i) => ({
        index: i + 1,
        kind: s.kind,
        title: s.title,
        snippet: s.snippet,
      })),
    });
    return {
      ok: true,
      reflection,
      sources,
      basedOnChars: draftText.length,
    };
  } catch (err) {
    console.error('[reflect] generation failed', err);
    const message = err instanceof Error ? err.message : 'reflection failed';
    return { ok: false, reason: 'error', message };
  }
}
