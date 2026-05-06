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
// Sprint 7: every successful save also recomputes and stores an embedding
// of the flattened doc text. Best-effort try/catch — same pattern as
// snapshotVersion. Drafts now participate in findSimilar alongside ideas
// and captures.
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
// Sprint 15 Wave 4 / Phase 6: outbound Beehiiv publishing imports.
import { db, drafts, draftVersions, connectorAccounts } from '@/db';
import { decryptSecret } from '@/lib/crypto';
import { createPost as createBeehiivPost } from '@/lib/beehiiv';
import type {
  UpdateDraftResult,
  UpdateDraftTitleResult,
  DraftVersionRow,
  RestoreDraftResult,
} from './action-types';
import { tiptapJsonToHtml } from '@/lib/exports';
import type { PublishToBeehiivResult } from './publish-types';
import { requireUser } from '@/lib/auth';
import { embedText } from '@/lib/embed';
import { tiptapJsonToText } from '@/lib/exports';

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

/**
 * Phase 14a: strip the FIRST top-level H1 node from a Tiptap doc, if any.
 * Used when we auto-promote the H1 text into the dedicated title slot —
 * leaving the H1 in the body would visually duplicate the title.
 *
 * Returns a new doc; the input is not mutated.
 */
function stripFirstTopLevelH1(doc: any): any {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.content)) {
    return doc;
  }
  const next = { ...doc };
  let dropped = false;
  next.content = doc.content.filter((node: any) => {
    if (
      !dropped &&
      node?.type === 'heading' &&
      node.attrs?.level === 1
    ) {
      dropped = true;
      return false;
    }
    return true;
  });
  // If we ended up with zero content, give it back an empty paragraph so
  // Tiptap doesn't choke.
  if (next.content.length === 0) {
    next.content = [{ type: 'paragraph' }];
  }
  return next;
}

// Coalesce window for the snapshot policy. If the most recent autosave
// version for a draft is younger than this, the next autosave overwrites
// it in place rather than creating a new row.
const VERSION_COALESCE_MS = 30_000;

/**
 * Build the embedding source text for a draft. The Tiptap doc gets
 * flattened to plain text and prefixed with the derived title (when
 * present) so a draft about "X" matches search queries about "X" even
 * if the body text doesn't repeat the title verbatim.
 *
 * Returns null when the draft is effectively empty — embedText() rejects
 * empty input, so the caller skips the OpenAI call entirely in that case.
 */
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

/**
 * Best-effort embedding write for a draft. Computes embedText() on the
 * flattened doc and patches the row in place. Logs but never throws —
 * saves are sacred, embedding is auxiliary. Concurrent updates are fine:
 * the version-gated update has already landed; this only sets `embedding`.
 */
async function patchDraftEmbedding(
  draftId: string,
  userId: string,
  text: string | null
) {
  try {
    if (!text) return;
    const embedding = await embedText(text);
    await db
      .update(drafts)
      .set({ embedding })
      .where(and(eq(drafts.id, draftId), eq(drafts.userId, userId)));
  } catch (err) {
    console.warn('[patchDraftEmbedding] failed', err);
  }
}

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

  // An empty doc has no meaningful text → draftEmbedSource returns null →
  // patchDraftEmbedding is a no-op. The next save will fill it in.
  await patchDraftEmbedding(
    draft.id,
    user.id,
    draftEmbedSource(draft.contentJson, draft.title)
  );

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

export async function updateDraft(input: unknown): Promise<UpdateDraftResult> {
  const user = await requireUser();
  const data = updateDraftSchema.parse(input);

  // Defensive JSON round-trip on the action input.
  //
  // Phase 11.1 fix (2026-05-04): under Next 15.5 the action-input
  // serializer was leaving nested objects in `safeContent` in a
  // state where direct property access threw
  //   "Cannot access level on the server. You cannot dot into a
  //    temporary client reference from a server component."
  // every time deriveTitle() walked the doc tree on its way to
  // `node.attrs?.level === 1`. Vercel digest 1661242608, hundreds of
  // 500s in the autosave loop. Commit 6bfa563's type-extraction fix
  // (replicated for the three remaining inline types in 478f77f) was
  // a partial mitigation — the actual workaround is to roundtrip the
  // payload through JSON.stringify/parse so the server walks plain
  // POJOs, not whatever the RSC serializer left behind.
  let safeContent: unknown = JSON.parse(JSON.stringify(data.contentJson));

  // Phase 14a: read existing title before the write so we can preserve a
  // user-set title across body autosaves AND only auto-promote H1 → title
  // when the title slot is currently empty.
  const [existing] = await db
    .select({
      title: drafts.title,
    })
    .from(drafts)
    .where(and(eq(drafts.id, data.draftId), eq(drafts.userId, user.id)))
    .limit(1);

  const existingTitle = existing?.title?.trim() ?? '';
  const derivedFromBody = deriveTitle(safeContent);

  let title: string | null;
  let titleSetFromH1 = false;
  if (existingTitle.length > 0) {
    // The user has set a title via the dedicated title input — never
    // overwrite it from the body. Same call site as before, just guarded.
    title = existingTitle;
  } else if (derivedFromBody) {
    // Auto-promote: lift the H1 text into the title slot AND strip the H1
    // node from the body so the title doesn't visually double up.
    title = derivedFromBody;
    safeContent = stripFirstTopLevelH1(safeContent);
    titleSetFromH1 = true;
  } else {
    title = null;
  }

  const newVersion = data.expectedVersion + 1;

  const updated = await db
    .update(drafts)
    .set({
      contentJson: safeContent as any,
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
  await snapshotVersion(user.id, data.draftId, safeContent, 'autosave');

  // Re-embed the draft so it stays current in findSimilar. Best-effort.
  await patchDraftEmbedding(
    data.draftId,
    user.id,
    draftEmbedSource(safeContent, title)
  );

  revalidatePath('/studio/page');
  revalidatePath(`/studio/page/${data.draftId}`);

  return {
    ok: true,
    savedAt: new Date().toISOString(),
    title,
    version: newVersion,
    titleSetFromH1: titleSetFromH1 || undefined,
    contentJson: titleSetFromH1 ? safeContent : undefined,
  };
}

// ─── updateDraftTitle ─────────────────────────────────
// Phase 14a (2026-05-04). Powers the dedicated title input on the editor.
// Updates only the title column + bumps version (so the body autosave's
// optimistic-concurrency loop stays in sync). Empty / whitespace strings
// clear the title back to null so future H1 auto-promotion can fire.

const updateDraftTitleSchema = z.object({
  draftId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
  title: z.string().max(280),
});

export async function updateDraftTitle(
  input: unknown
): Promise<UpdateDraftTitleResult> {
  const user = await requireUser();
  const data = updateDraftTitleSchema.parse(input);

  const trimmed = data.title.trim();
  const nextTitle: string | null = trimmed.length > 0 ? trimmed : null;
  const newVersion = data.expectedVersion + 1;

  const updated = await db
    .update(drafts)
    .set({
      title: nextTitle,
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
    const [current] = await db
      .select({
        version: drafts.version,
        title: drafts.title,
        updatedAt: drafts.updatedAt,
      })
      .from(drafts)
      .where(and(eq(drafts.id, data.draftId), eq(drafts.userId, user.id)))
      .limit(1);

    if (!current) {
      throw new Error('Draft not found');
    }

    return {
      ok: false,
      conflict: true,
      currentTitle: current.title,
      currentVersion: current.version,
      currentUpdatedAt: current.updatedAt.toISOString(),
    };
  }

  revalidatePath('/studio/page');
  revalidatePath(`/studio/page/${data.draftId}`);

  return {
    ok: true,
    savedAt: new Date().toISOString(),
    title: nextTitle,
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

  // Re-embed against the restored content so retrieval reflects what the
  // draft now says, not what it said before the time-travel.
  await patchDraftEmbedding(
    draftId,
    user.id,
    draftEmbedSource(version.contentJson, title)
  );

  revalidatePath('/studio/page');
  revalidatePath(`/studio/page/${draftId}`);

  return {
    savedAt: new Date().toISOString(),
    title,
    version: newVersion,
    content: version.contentJson,
  };
}


// ─── publishDraftToBeehiiv (Sprint 15 Wave 4 / Phase 6) ───────
// Outbound: take a draft, send it to Beehiiv as a new draft post. The
// user reviews + sends inside Beehiiv — we never auto-send.
//
// PublishToBeehiivResult lives in ./publish-types.ts (separate module)
// because Next.js's RSC compiler confuses type discriminators exported
// from 'use server' files with client references at runtime.

const publishToBeehiivSchema = z.object({
  draftId: z.string().uuid(),
});

// Re-export the type so existing imports from '../actions' keep working.
export type {
  UpdateDraftResult,
  DraftVersionRow,
  RestoreDraftResult,
} from './action-types';
export type { PublishToBeehiivResult };

export async function publishDraftToBeehiiv(
  input: unknown
): Promise<PublishToBeehiivResult> {
  const user = await requireUser();
  const { draftId } = publishToBeehiivSchema.parse(input);

  // Load the draft (own-or-throw).
  const [draft] = await db
    .select({
      id: drafts.id,
      contentJson: drafts.contentJson,
      title: drafts.title,
    })
    .from(drafts)
    .where(
      and(
        eq(drafts.id, draftId),
        eq(drafts.userId, user.id)
      )
    )
    .limit(1);
  if (!draft) throw new Error('Draft not found');

  // Find the user's connected Beehiiv account.
  const [account] = await db
    .select({
      id: connectorAccounts.id,
      status: connectorAccounts.status,
      encryptedSecret: connectorAccounts.encryptedSecret,
      metadata: connectorAccounts.metadata,
    })
    .from(connectorAccounts)
    .where(
      and(
        eq(connectorAccounts.userId, user.id),
        eq(connectorAccounts.provider, 'beehiiv')
      )
    )
    .limit(1);

  if (!account) {
    return {
      ok: false,
      reason: 'no_connector',
      message: 'Connect Beehiiv first (Settings → Connectors).',
    };
  }
  if (account.status !== 'connected') {
    return {
      ok: false,
      reason: 'connector_error',
      message:
        'Beehiiv connection is not active. Reconnect in Settings → Connectors.',
    };
  }

  const meta = (account.metadata ?? {}) as {
    publicationId?: string;
  };
  if (!meta.publicationId) {
    return {
      ok: false,
      reason: 'no_publication',
      message:
        'Beehiiv account has no publication on file. Reconnect in Settings → Connectors.',
    };
  }

  if (!account.encryptedSecret) {
    return {
      ok: false,
      reason: 'connector_error',
      message: 'Beehiiv API key is missing. Reconnect.',
    };
  }
  let apiKey: string;
  try {
    apiKey = decryptSecret(account.encryptedSecret);
  } catch (err) {
    console.error('[publishDraftToBeehiiv] decrypt failed', err);
    return {
      ok: false,
      reason: 'connector_error',
      message: 'Could not decrypt Beehiiv key. Reconnect.',
    };
  }

  // Convert Tiptap JSON → HTML, stripping the first H1 (Beehiiv takes
  // title separately). Use the draft's stored title for the post title;
  // fall back to a generic if absent.
  const bodyHtml = tiptapJsonToHtml(draft.contentJson, {
    stripFirstH1: true,
  });
  if (!bodyHtml.trim()) {
    return {
      ok: false,
      reason: 'empty_draft',
      message: 'Draft is empty. Nothing to publish.',
    };
  }

  const title = (draft.title ?? '').trim() || 'Untitled draft';

  try {
    const created = await createBeehiivPost(
      apiKey,
      meta.publicationId,
      {
        title,
        bodyHtml,
        audience: 'all',
        status: 'draft', // never auto-send
      }
    );
    return {
      ok: true,
      postId: created.id,
      postUrl: created.web_url ?? null,
      title,
    };
  } catch (err) {
    console.error('[publishDraftToBeehiiv] api error', err);
    const message =
      err instanceof Error ? err.message : 'Beehiiv publish failed';
    return { ok: false, reason: 'api_error', message };
  }
}
