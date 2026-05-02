// Folio · Inbox server actions
// The four-way promotion path from Issue 06: Attach / Promote / Stash / Discard.
// Plus capture creation (paste-based, v0).

'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db, captures, ideas } from '@/db';
import { requireUser } from '@/lib/auth';
import { embedText } from '@/lib/embed';

// ─── createCapture ─────────────────────────────────
// Paste a thought into the Inbox. Optionally attach inline.
const createCaptureSchema = z.object({
  body: z.string().min(1).max(50000),
  source: z.string().max(500).optional(),
  attachToIdeaId: z.string().uuid().optional().nullable(),
});

export async function createCapture(input: unknown) {
  const user = await requireUser();
  const data = createCaptureSchema.parse(input);

  // Embed inline (cheap; ~100ms). If save latency complaints emerge,
  // move to background via Inngest in Sprint 4.
  let embedding: number[] | undefined;
  try {
    embedding = await embedText(data.body);
  } catch (err) {
    console.warn('[createCapture] embedding failed; saving without', err);
  }

  await db.insert(captures).values({
    userId: user.id,
    ideaId: data.attachToIdeaId ?? null,
    type: 'paste',
    source: data.source ?? null,
    body: data.body.trim(),
    capturedVia: 'paste',
    status: data.attachToIdeaId ? 'attached' : 'inbox',
    embedding,
  });

  revalidatePath('/studio/inbox');
  if (data.attachToIdeaId) {
    revalidatePath(`/studio/ideas/${data.attachToIdeaId}`);
  }
}

// ─── attachToIdea ─────────────────────────────────
const attachSchema = z.object({
  captureId: z.string().uuid(),
  ideaId: z.string().uuid(),
});

export async function attachToIdea(input: unknown) {
  const user = await requireUser();
  const { captureId, ideaId } = attachSchema.parse(input);

  await db
    .update(captures)
    .set({ ideaId, status: 'attached' })
    .where(and(eq(captures.id, captureId), eq(captures.userId, user.id)));

  revalidatePath('/studio/inbox');
  revalidatePath(`/studio/ideas/${ideaId}`);
}

// ─── promoteToNewIdea ─────────────────────────────────
// Capture becomes the origin of a brand-new idea. Idea starts in seed state.
const promoteSchema = z.object({
  captureId: z.string().uuid(),
  ideaTitle: z.string().min(1).max(280),
});

export async function promoteToNewIdea(input: unknown) {
  const user = await requireUser();
  const { captureId, ideaTitle } = promoteSchema.parse(input);

  // Confirm capture belongs to this user.
  const [capture] = await db
    .select()
    .from(captures)
    .where(and(eq(captures.id, captureId), eq(captures.userId, user.id)))
    .limit(1);
  if (!capture) throw new Error('Capture not found');

  const [idea] = await db
    .insert(ideas)
    .values({
      userId: user.id,
      title: ideaTitle.trim(),
      origin: 'captured',
      originRef: captureId,
      maturity: 'seed',
      energy: 'active',
      lastVisitedAt: new Date(),
      lastEvolvedAt: new Date(),
    })
    .returning();

  await db
    .update(captures)
    .set({ ideaId: idea.id, status: 'attached' })
    .where(eq(captures.id, captureId));

  revalidatePath('/studio/inbox');
  revalidatePath('/studio/ideas');
  redirect(`/studio/ideas/${idea.id}`);
}

// ─── stashCapture ─────────────────────────────────
const stashSchema = z.object({ captureId: z.string().uuid() });

export async function stashCapture(input: unknown) {
  const user = await requireUser();
  const { captureId } = stashSchema.parse(input);

  await db
    .update(captures)
    .set({ status: 'stashed' })
    .where(and(eq(captures.id, captureId), eq(captures.userId, user.id)));

  revalidatePath('/studio/inbox');
}

// ─── discardCapture ─────────────────────────────────
const discardSchema = z.object({ captureId: z.string().uuid() });

export async function discardCapture(input: unknown) {
  const user = await requireUser();
  const { captureId } = discardSchema.parse(input);

  // Soft-delete via status; later we can prune discarded > N days.
  await db
    .update(captures)
    .set({ status: 'discarded' })
    .where(and(eq(captures.id, captureId), eq(captures.userId, user.id)));

  revalidatePath('/studio/inbox');
}
