// Folio · Shared studio server actions
//
// Sprint 7: backfillEmbeddings — sweeps rows where embedding IS NULL,
// computes them in batches of 10, sleeps 200ms between batches. Needed
// because Sprint 3's createCapture already embedded but pre-Sprint-7
// ideas/drafts and pre-Sprint-3 captures don't.
//
// Strictly user-scoped — every query carries a userId match.
//
// findSimilar lands in this same file in the next commit. The shared
// embedding-source helpers live here so both actions can pull from the
// same definitions (write-time and search-time embeddings must stay
// aligned, otherwise neighbors drift).

'use server';

import { eq, and, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, captures, ideas, drafts } from '@/db';
import { requireUser } from '@/lib/auth';
import { embedText } from '@/lib/embed';
import { tiptapJsonToText } from '@/lib/exports';

// ─── shared helpers ────────────────────────────────────────

// Mirror of ideaEmbedSource from /studio/ideas/actions.ts — kept here so the
// backfill computes embeddings the same way the save path does. If the save
// path's source-text shape changes, change this too.
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

// Mirror of draftEmbedSource from /studio/page/actions.ts.
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
