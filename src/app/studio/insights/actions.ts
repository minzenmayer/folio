// Thoughtbed · Insights triage actions (Direction B, 2026-05-04)
//
// Three actions on an extracted_ideas row:
//
//   · promoteInsight  — copy claim into the user's ideas table as a
//                       maturity='seed' row, link back via
//                       source_extracted_idea_id, mark the source row
//                       triage_status='promoted'.
//   · dismissInsight  — flip triage_status='dismissed', record triaged_at.
//   · snoozeInsight   — flip triage_status='snoozed', set snooze_until
//                       30 days out. The default Insights query unhides
//                       it when ripe (no cron needed).
//
// All three are scoped to the calling user — the WHERE clause includes
// userId so even a forged input id can't touch someone else's row.
//
// Garden (/studio/ideas) doesn't change — it queries the ideas table as
// before. Promoted rows show up there because they ARE ideas now;
// the source_extracted_idea_id back-pointer lets the card show "from
// <source>" + click-through.

'use server';

import { eq, and } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db, extractedIdeas, ideas } from '@/db';
import { requireUser } from '@/lib/auth';

export type TriageResult =
  | { ok: true }
  | { ok: false; reason: string; message: string };

const idSchema = z.object({ id: z.string().uuid() });

const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function loadOwnExtracted(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(extractedIdeas)
    .where(and(eq(extractedIdeas.id, id), eq(extractedIdeas.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function promoteInsight(input: unknown): Promise<TriageResult> {
  const user = await requireUser();
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_input', message: 'Bad insight id.' };
  }

  const row = await loadOwnExtracted(user.id, parsed.data.id);
  if (!row) {
    return { ok: false, reason: 'not_found', message: 'Insight not found.' };
  }

  // Derive the Idea's essence: the curated claim, optionally followed
  // by the evidence paragraph. Cap to a sane length so the Garden card
  // doesn't get unwieldy.
  const essence =
    row.evidence && row.evidence.length > 0
      ? `${row.claim}\n\n${row.evidence}`.slice(0, 4000)
      : row.claim.slice(0, 4000);

  // Insert the new Idea + flip the source row's triage_status atomically
  // enough — Drizzle/Neon HTTP doesn't expose interactive transactions
  // for this, but the two writes are independent (the FK only points
  // FROM ideas TO extracted_ideas; no circular dependency). If the
  // INSERT succeeds and the UPDATE fails we'd have an orphan ideas row;
  // the worst case is the user sees the same insight in their queue +
  // a duplicate in the Garden, which they can clean up. Acceptable.
  const [inserted] = await db
    .insert(ideas)
    .values({
      userId: user.id,
      title: row.title,
      essence,
      maturity: 'seed',
      sourceExtractedIdeaId: row.id,
    })
    .returning({ id: ideas.id });

  await db
    .update(extractedIdeas)
    .set({
      triageStatus: 'promoted',
      triagedAt: new Date(),
      snoozeUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(extractedIdeas.id, row.id));

  revalidatePath('/studio/insights');
  revalidatePath('/studio/ideas');
  // Also nudge the studio home — Recent ideas list reads off this table.
  revalidatePath('/studio');
  if (inserted?.id) revalidatePath(`/studio/ideas/${inserted.id}`);

  return { ok: true };
}

export async function dismissInsight(input: unknown): Promise<TriageResult> {
  const user = await requireUser();
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_input', message: 'Bad insight id.' };
  }

  await db
    .update(extractedIdeas)
    .set({
      triageStatus: 'dismissed',
      triagedAt: new Date(),
      snoozeUntil: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(extractedIdeas.id, parsed.data.id),
        eq(extractedIdeas.userId, user.id)
      )
    );

  revalidatePath('/studio/insights');
  return { ok: true };
}

export async function snoozeInsight(input: unknown): Promise<TriageResult> {
  const user = await requireUser();
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_input', message: 'Bad insight id.' };
  }

  await db
    .update(extractedIdeas)
    .set({
      triageStatus: 'snoozed',
      triagedAt: new Date(),
      snoozeUntil: new Date(Date.now() + SNOOZE_MS),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(extractedIdeas.id, parsed.data.id),
        eq(extractedIdeas.userId, user.id)
      )
    );

  revalidatePath('/studio/insights');
  return { ok: true };
}

/**
 * Undo a previous triage action. Useful for the user who hits "Dismiss"
 * by accident — surfaces in the Promoted/Dismissed views as a tiny
 * "Restore" link. Sets the row back to 'pending' and clears the
 * triage timestamps. Does NOT delete a promoted ideas row — those have
 * to be deleted via the Garden surface so the user makes the call
 * explicitly.
 */
export async function restoreInsight(input: unknown): Promise<TriageResult> {
  const user = await requireUser();
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_input', message: 'Bad insight id.' };
  }

  await db
    .update(extractedIdeas)
    .set({
      triageStatus: 'pending',
      triagedAt: null,
      snoozeUntil: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(extractedIdeas.id, parsed.data.id),
        eq(extractedIdeas.userId, user.id)
      )
    );

  revalidatePath('/studio/insights');
  return { ok: true };
}
