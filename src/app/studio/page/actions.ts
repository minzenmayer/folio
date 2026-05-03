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
// Called by the debounced auto-save. Owns title derivation, updatedAt bump,
// and optimistic-concurrency gating via drafts.version.
//
// Contract: client sends the version it last saw; server matches it in the
// WHERE clause and bumps to expectedVersion+1 on success. If no row matches
// (someone else bumped the version in between), we re-fetch the current state
// and return it as a typed conflict response. The client suspends its save
// loop and shows a Reload / Keep-mine banner.
//
// Returning a discriminated union (instead of throwing) keeps the success
// path cheap and lets the client branch cleanly.
const updateDraftSchema = z.object({
  draftId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
  // Tiptap docs are arbitrary JSON. We trust the shape because we generated it
  // and the request is authed. Bigger payloads (>~1MB) are unusual at this
  // stage; revisit if telemetry shows otherwise.
  contentJson: z.unknown(),
});

export type UpdateDraftResult =
  | {
      ok: true;
      savedAt: string;
      title: string | null;
      version: number;
    }
  | {
      ok: false;
      conflict: true;
      currentDoc: unknown;
      currentVersion: number;
      currentTitle: string | null;
      currentUpdatedAt: string;
    };

export async function updateDraft(input: unknown): Promise<UpdateDraftResult> {
  const user = await requireUser();
  const data = updateDraftSchema.parse(input);

  const title = deriveTitle(data.contentJson);
  const newVersion = data.expectedVersion + 1;

  const updated = await db
    .update(drafts)
    .set({
      contentJson: data.contentJson as any,
      title,
      version: newVersion,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(drafts.id, data.draftId),
        eq(drafts.userId, user.id),
        eq(drafts.version, data.expectedVersion)
      )
    )
    .returning({ id: drafts.id, version: drafts.version });

  if (updated.length === 0) {
    // Either the draft doesn't exist (or isn't ours), or version mismatch.
    // Re-fetch to distinguish — a missing row is an error; a version mismatch
    // is a recoverable conflict.
    const [current] = await db
      .select({
        version: drafts.version,
        contentJson: drafts.contentJson,
        title: drafts.title,
        updatedAt: drafts.updatedAt,
      })
      .from(drafts)
      .where(and(eq(drafts.id, data.draftId), eq(drafts.userId, user.id)))
      .limit(1);

    if (!current) {
      // Draft was deleted (e.g. user trashed it from another tab) or never
      // belonged to this user. Throwing here surfaces as the editor's
      // "save failed" state; the client can then refresh and end up at /404.
      throw new Error('Draft not found');
    }

    return {
      ok: false,
      conflict: true,
      currentDoc: current.contentJson,
      currentVersion: current.version,
      currentTitle: current.title,
      currentUpdatedAt: current.updatedAt.toISOString(),
    };
  }

  revalidatePath('/studio/page');
  revalidatePath(`/studio/page/${data.draftId}`);

  return {
    ok: true,
    savedAt: new Date().toISOString(),
    title,
    version: newVersion,
  };
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
