// Folio · Idea server actions
//
// Sprint 7: every successful create/update path also recomputes and stores
// the row's embedding, so the Library participates in retrieval alongside
// captures. Best-effort: failures log but never block the save (same pattern
// as snapshotVersion in /studio/page/actions.ts). Source text is the same
// shape we'll feed findSimilar later — title + essence + a body slice — so
// search-time and write-time embeddings stay aligned.

'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db, ideas } from '@/db';
import { requireUser } from '@/lib/auth';
import { embedText } from '@/lib/embed';

// ─── helpers ───────────────────────────────────

/**
 * Build the source text we feed into the embedder for an idea row.
 * Identity-forward: title is the strongest signal, essence is the framing,
 * body is supporting detail — and right now ideas don't carry a body field
 * separate from essence, so the slice is essentially essence again.
 *
 * Mirrors the shape findSimilar will use as the query for "show me what's
 * related to this idea" so write-time and search-time stay aligned.
 */
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

/**
 * Best-effort embedding write. Computes embedding for the given text and
 * patches the row in place. Logs but never throws — saves are sacred,
 * embedding is auxiliary.
 */
async function patchIdeaEmbedding(
  ideaId: string,
  userId: string,
  text: string | null
) {
  try {
    if (!text) return;
    const embedding = await embedText(text);
    await db
      .update(ideas)
      .set({ embedding })
      .where(and(eq(ideas.id, ideaId), eq(ideas.userId, userId)));
  } catch (err) {
    console.warn('[patchIdeaEmbedding] failed', err);
  }
}

// ─── createIdea ─────────────────────────────────
const createIdeaSchema = z.object({
  title: z.string().min(1).max(280),
  essence: z.string().max(2000).optional(),
});

export async function createIdea(input: unknown) {
  const user = await requireUser();
  const data = createIdeaSchema.parse(input);

  const [idea] = await db
    .insert(ideas)
    .values({
      userId: user.id,
      title: data.title.trim(),
      essence: data.essence?.trim() || null,
      origin: 'noticed',
      maturity: 'seed',
      energy: 'active',
      lastVisitedAt: new Date(),
      lastEvolvedAt: new Date(),
    })
    .returning();

  // Best-effort embedding. The redirect below fires regardless.
  await patchIdeaEmbedding(
    idea.id,
    user.id,
    ideaEmbedSource({ title: idea.title, essence: idea.essence })
  );

  revalidatePath('/studio/ideas');
  redirect(`/studio/ideas/${idea.id}`);
}

// ─── updateIdea (essence, title) ─────────────────
const updateIdeaSchema = z.object({
  ideaId: z.string().uuid(),
  title: z.string().min(1).max(280).optional(),
  essence: z.string().max(2000).optional().nullable(),
  maturity: z
    .enum(['seed', 'forming', 'shaping', 'ready', 'circulated', 'dormant'])
    .optional(),
});

export async function updateIdea(input: unknown) {
  const user = await requireUser();
  const data = updateIdeaSchema.parse(input);

  await db
    .update(ideas)
    .set({
      ...(data.title !== undefined && { title: data.title.trim() }),
      ...(data.essence !== undefined && {
        essence: data.essence?.trim() || null,
      }),
      ...(data.maturity !== undefined && { maturity: data.maturity }),
      updatedAt: new Date(),
      lastEvolvedAt: new Date(),
    })
    .where(and(eq(ideas.id, data.ideaId), eq(ideas.userId, user.id)));

  // Re-embed only when the substantive fields changed (title or essence).
  // A pure maturity change isn't a content change; skip the OpenAI round-trip.
  if (data.title !== undefined || data.essence !== undefined) {
    const [fresh] = await db
      .select({ title: ideas.title, essence: ideas.essence })
      .from(ideas)
      .where(and(eq(ideas.id, data.ideaId), eq(ideas.userId, user.id)))
      .limit(1);
    if (fresh) {
      await patchIdeaEmbedding(data.ideaId, user.id, ideaEmbedSource(fresh));
    }
  }

  revalidatePath(`/studio/ideas/${data.ideaId}`);
  revalidatePath('/studio/ideas');
}

// ─── visitIdea (touch lastVisitedAt) ─────────────
export async function visitIdea(ideaId: string) {
  const user = await requireUser();
  await db
    .update(ideas)
    .set({ lastVisitedAt: new Date() })
    .where(and(eq(ideas.id, ideaId), eq(ideas.userId, user.id)));
}
