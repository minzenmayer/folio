// Folio · The Page — server actions
// Sprint 5: drafts CRUD. Auto-save is debounced client-side and calls
// updateDraft() on every quiet beat.
//
// Sprint 6 wave 1: optimistic concurrency on drafts.version.
// Sprint 6 wave 3: snapshot every save into draft_versions, with a 30s
// coalesce window (most-recent autosave row gets overwritten rather than
// duplicated during active typing). Adds listDraftVersions and
// restoreDraftVersion for the History modal.
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
import { db, drafts, draftVersions } from '@/db';
import { requireUser } from '@/lib/auth';

// ─── helpers ───────────────────────────────────

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

// Coalesce window for the snapshot policy. If the most recent autosave
// version for a draft is younger than this, the next autosave overwrites
// it in place rather than creating a new row.
const VERSION_COALESCE_MS = 30_000;

/**
 * Best-effort snapshot into draft_versions. Coalesces consecutive autosaves
 * within VERSION_COALESCE_MS; otherwise inserts a new row. Failures are
 * logged but don't block the save itself — saves are sacred, version
 * history is best-effort.
 */
async function snapshotVersion(
  userId: string,
  draftId: string,
  contentJson: unknown,
  source: 'autosave' | 'restore'
) {
  try {
    if (source === 'autosave') {
      const [latest] = await db
        .select({
          id: draftVersions.id,
          source: draftVersions.source,
          createdAt: draftVersions.createdAt,
        })
        .from(draftVersions)
        .where(eq(draftVersions.draftId, draftId))
        .orderBy(desc(draftVersions.createdAt))
        .limit(1);

      if (
        latest &&
        latest.source === 'autosave' &&
        Date.now() - latest.createdAt.getTime() < VERSION_COALESCE_MS
      ) {
        // Within the coalesce window — overwrite the existing autosave row
        // rather than burning a new history entry on every keystroke burst.
        await db
          .update(draftVersions)
          .set({ contentJson: contentJson as any })
          .where(eq(draftVersions.id, latest.id));
        return;
      }
    }

    await db.insert(draftVersions).values({
      draftId,
      userId,
      contentJson: contentJson as any,
      source,
    });
  } catch (err) {
    // Don't surface to the user — saves succeed even if history doesn't.
    console.warn('[snapshotVersion] failed', err);
  }
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
// optimistic-concurrency gating via drafts.version, and the version snapshot.
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

  // Snapshot into history. Best-effort — never blocks the save.
  await snapshotVersion(user.id, data.draftId, data.contentJson, 'autosave');

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

// ─── listDraftVersions ────────────────────────────────
// Used by the History modal. Verifies draft ownership before returning
// snapshots. Limit 50 — a deeper history would mean a different UX.
const listDraftVersionsSchema = z.object({ draftId: z.string().uuid() });

export type DraftVersionRow = {
  id: string;
  source: string;
  createdAt: string;
  contentJson: unknown;
};

export async function listDraftVersions(
  input: unknown
): Promise<DraftVersionRow[]> {
  const user = await requireUser();
  const { draftId } = listDraftVersionsSchema.parse(input);

  const [draft] = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, user.id)))
    .limit(1);
  if (!draft) throw new Error('Draft not found');

  const rows = await db
    .select({
      id: draftVersions.id,
      source: draftVersions.source,
      createdAt: draftVersions.createdAt,
      contentJson: draftVersions.contentJson,
    })
    .from(draftVersions)
    .where(eq(draftVersions.draftId, draftId))
    .orderBy(desc(draftVersions.createdAt))
    .limit(50);

  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
    contentJson: r.contentJson,
  }));
}

// ─── restoreDraftVersion ──────────────────────────────
// Replaces the draft's content with a historical version. Linear, never
// destructive — the act of restoring spawns a new draft_versions row with
// source='restore'. Bypasses optimistic concurrency: the user explicitly
// chose to time-travel, so we overwrite whatever's current.
const restoreDraftVersionSchema = z.object({
  draftId: z.string().uuid(),
  versionId: z.string().uuid(),
});

export type RestoreDraftResult = {
  savedAt: string;
  title: string | null;
  version: number;
  content: unknown;
};

export async function restoreDraftVersion(
  input: unknown
): Promise<RestoreDraftResult> {
  const user = await requireUser();
  const { draftId, versionId } = restoreDraftVersionSchema.parse(input);

  // Fetch draft + version together. Ownership check via draft.user_id.
  const [draft] = await db
    .select({ id: drafts.id, version: drafts.version })
    .from(drafts)
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, user.id)))
    .limit(1);
  if (!draft) throw new Error('Draft not found');

  const [version] = await db
    .select({
      id: draftVersions.id,
      contentJson: draftVersions.contentJson,
    })
    .from(draftVersions)
    .where(
      and(
        eq(draftVersions.id, versionId),
        eq(draftVersions.draftId, draftId)
      )
    )
    .limit(1);
  if (!version) throw new Error('Version not found');

  const newVersion = draft.version + 1;
  const title = deriveTitle(version.contentJson);

  await db
    .update(drafts)
    .set({
      contentJson: version.contentJson as any,
      title,
      version: newVersion,
      updatedAt: new Date(),
    })
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, user.id)));

  // Linear history: a restore is itself a versioned event.
  await snapshotVersion(user.id, draftId, version.contentJson, 'restore');

  revalidatePath('/studio/page');
  revalidatePath(`/studio/page/${draftId}`);

  return {
    savedAt: new Date().toISOString(),
    title,
    version: newVersion,
    content: version.contentJson,
  };
}
