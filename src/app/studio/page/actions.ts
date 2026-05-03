// Folio · The Page — server actions
// Sprint 5: drafts CRUD. Auto-save is debounced client-side and calls
// updateDraft() on every quiet beat.
//
// Conventions match Sprint 3 (inbox/ideas actions): `requireUser()` for auth,
// `revalidatePath()` for the rail and detail page. Title is derived from the
// first H1 in the Tiptap doc — a small bit of structural sugar so the user
// never has to type a title field.

'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq, and, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db, drafts } from '@/db';
import { requireUser } from '@/lib/auth';

// ─── helpers ──────────────────────────────────────

// Empty Tiptap/ProseMirror doc — what a fresh draft contains.
function emptyDoc() {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

/**
 * Walk the Tiptap JSON tree once, return the text of the first H1 node.
 * Keeps the rail title in sync with the visible heading without a
 * dedicated "title" input. Returns null if no H1 (or empty H1).
 */
function deriveTitle(doc: any): string | null {
  if (!doc || typeof doc !== 'object') return null;
  const stack: any[] = [doc];
  while (stack.length) {
    const node = stack.shift();
    if (!node) continue;
    if (
      node.type === 'heading' &&
      node.attrs?.level === 1 &&
      Array.isArray(node.content)
    ) {
      const text = node.content
        .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
        .map((c: any) => c.text)
        .join('')
        .trim();
      if (text.length > 0) return text.slice(0, 280);
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) stack.push(child);
    }
  }
  return null;
}

// ─── createDraft ──────────────────────────────────
// Empty draft, redirects into the editor immediately.
export async function createDraft() {
  const user = await requireUser();

  const [draft] = await db
    .insert(drafts)
    .values({
      userId: user.id,
      title: null,
      contentJson: emptyDoc(),
    })
    .returning();

  revalidatePath('/studio/page');
  redirect(`/studio/page/${draft.id}`);
}

// ─── updateDraft ──────────────────────────────────
// Called by the debounced auto-save. Owns title derivation + updatedAt bump.
const updateDraftSchema = z.object({
  draftId: z.string().uuid(),
  // Tiptap docs are arbitrary JSON. We trust the shape because we generated it
  // and the request is authed. Bigger payloads (>~1MB) are unusual at this
  // stage; revisit if telemetry shows otherwise.
  contentJson: z.unknown(),
});

export async function updateDraft(input: unknown) {
  const user = await requireUser();
  const data = updateDraftSchema.parse(input);

  const title = deriveTitle(data.contentJson);

  await db
    .update(drafts)
    .set({
      contentJson: data.contentJson as any,
      title,
      updatedAt: new Date(),
    })
    .where(and(eq(drafts.id, data.draftId), eq(drafts.userId, user.id)));

  revalidatePath('/studio/page');
  revalidatePath(`/studio/page/${data.draftId}`);

  return { savedAt: new Date().toISOString(), title };
}

// ─── deleteDraft ──────────────────────────────────
const deleteDraftSchema = z.object({ draftId: z.string().uuid() });

export async function deleteDraft(input: unknown) {
  const user = await requireUser();
  const { draftId } = deleteDraftSchema.parse(input);

  await db
    .delete(drafts)
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, user.id)));

  revalidatePath('/studio/page');
  redirect('/studio/page');
}

// ─── listDrafts ──────────────────────────────────
// Used by the rail. Server-side query; the rail itself is a Server Component.
export async function listDrafts() {
  const user = await requireUser();
  return db
    .select({
      id: drafts.id,
      title: drafts.title,
      updatedAt: drafts.updatedAt,
    })
    .from(drafts)
    .where(eq(drafts.userId, user.id))
    .orderBy(desc(drafts.updatedAt));
}
