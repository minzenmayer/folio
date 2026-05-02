// Folio · Idea server actions

'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db, ideas } from '@/db';
import { requireUser } from '@/lib/auth';

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
