// Thoughtbed · Shared studio server actions
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
//     The retrieval primitive that the Related panel and the garden rail
//     both consume.
//
// Sprint 9 added the generative half:
//
//   • reflect({ draftId, mode? }) — loads the draft, runs findSimilar on
//     its text, hands draft + grounding hits to Claude (via
//     @ai-sdk/anthropic), and returns a 2-3 sentence reflection in the
//     user's own voice. Sprint 12 added the `mode` parameter so the
//     reflection's voice can match the draft's intent (newsletter vs.
//     LinkedIn vs. self-pilot). Failures return as a typed { ok: false }
//     variant rather than throwing, so the garden rail can render a
//     graceful error state.
//
// Sprint 10 (Thoughtbed pivot) added the writing-first dispatcher.
// Sprint 12 reshapes it for intent-driven composer modes:
//
//   • composeNew({ text, mode }) — the home composer's submit handler.
//     Modes:
//       · 'newsletter' (default) — first line as topic; create a draft
//         seeded with the topic as the H1 and an empty paragraph below.
//       · 'linkedin' — body-only draft (no H1), the typed text becomes
//         the first paragraph. LinkedIn posts are bodies, not titled essays.
//       · 'self-pilot' — empty draft. Honours "sometimes I just want to
//         write." The garden rail starts dormant on the editor route.
//     The redirect carries `?mode=` into the editor so the rail can
//     boot in mode-aware retrieval/voice.
//
//   • exploreIdeas({ intent, query? }) — Sprint 12 query interface for
//     Ideas mode. Three intents:
//       · 'untouched' — ideas with low/no overlap with existing drafts
//         (contrastive retrieval over the user's draft embeddings).
//       · 'mature' — ideas with maturity ≥ 'forming' ranked by signal
//         (heat + pull + weight) — what's ripe to write on.
//       · 'search' — semantic search over ideas via findSimilar.
//     Returns ranked items; navigation lives in the Composer client.
//
// All actions are strictly user-scoped. The vector queries use pgvector's
// <=> cosine-distance operator with HNSW indexes (idx_*_embedding);
// reflect() pays for one extra embedding round-trip (via findSimilar)
// which is cheap enough at Haiku-tier costs to ignore.

'use server';

import { eq, and, isNull, sql, desc, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  db,
  captures,
  ideas,
  drafts,
  newsletterIssues,
  // Sprint 15 Wave 3: vault notes + curated idea layer in the retrieval pool.
  obsidianNotes,
  extractedIdeas,
  // Phase 12 (2026-05-04): LinkedIn post archive (Apify-scraped) joins
  // the retrieval pool alongside vault notes and newsletter issues.
  linkedinPosts,
  // Phase 13 (2026-05-04): newsletters from Gmail (OAuth, Testing mode)
  // — only the user-promoted subset is eligible for retrieval.
  gmailMessages,
} from '@/db';
import { requireUser } from '@/lib/auth';
import { embedText } from '@/lib/embed';
import { tiptapJsonToText } from '@/lib/exports';
import { generateReflection, type ReflectionVoiceMode } from '@/lib/llm';
import {
  SIMILAR_KINDS,
  SIMILAR_KINDS_FOR_ZOD,
  type SimilarKind,
} from '@/lib/retrieval-kinds';
// Sprint 15 Wave 3 layer 1: clean source text before showing it to the
// LLM as snippet context. The same rules drive extractIdeas during sync.
import { cleanText } from '@/lib/clean-text';
// Sprint 15 Wave 2: extractIdeas backfill across already-ingested sources
// (newsletter issues now; obsidian notes after the user connects). Surfaced
// as a button on /studio/knowledge so it's a manual one-shot rather than
// silently consuming Anthropic credits at first deploy.
import {
  backfillNewsletterIdeas,
  backfillObsidianIdeas,
} from '@/lib/extract-ideas';

// ─── shared helpers ────────────────────────────────

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

// ─── backfillEmbeddings ───────────────────────────────────────────

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

// ─── backfillExtractedIdeas (Sprint 15 Wave 2) ──────────────────
//
// Sweeps newsletter_issues + obsidian_notes that don't yet have any
// extracted_ideas rows and runs extractIdeas() across them. This is the
// retroactive populate-the-garden step the spec calls for: once Wave 2
// ships, the founder's existing newsletter archive should resolve into
// Ideas alongside whatever the next sync writes natively.
//
// Manual one-shot (not on a cron) because it spends Anthropic credits.
// Subsequent issues/notes get extracted on their own write paths.

export type BackfillIdeasResult = {
  newsletter: { scanned: number; extracted: number; failed: number; hasMore: boolean };
  obsidian: { scanned: number; extracted: number; failed: number; hasMore: boolean };
  hasMore: boolean;
};

// Phase 9: chunked. Each call processes up to `limit` not-yet-extracted
// sources from each of newsletter + obsidian (so up to 2*limit per call).
// Returns hasMore=true if either kind still has work; the client loops.
// Default 3 keeps a single call comfortably under Vercel Hobby's 10s
// timeout (Anthropic Haiku is ~3-5s per call).
export async function backfillExtractedIdeas(input?: {
  limit?: number;
}): Promise<BackfillIdeasResult> {
  const user = await requireUser();
  const limit = input?.limit ?? 3;
  const newsletter = await backfillNewsletterIdeas(user.id, { limit });
  const obsidian = await backfillObsidianIdeas(user.id, { limit });
  return {
    newsletter,
    obsidian,
    hasMore: newsletter.hasMore || obsidian.hasMore,
  };
}

// ─── findSimilar ──────────────────────────────────────

// Sprint 13 added 'newsletter_issue' as a retrieval kind. Sprint 15 Wave 3
// added 'obsidian_note' (vault notes) and 'extracted_idea' (the curated
// Idea layer extractIdeas() pulls out of any source). The kind discriminates
// so the rail can render the right glyph and Reflect can label the source
// in voice ("your own newsletter", "vault note", "extracted idea").
//
// SimilarKind / SIMILAR_KINDS now live in src/lib/retrieval-kinds.ts so this
// module and src/lib/llm.ts share one source of truth — adding a kind no
// longer requires touching three files.
export { type SimilarKind } from '@/lib/retrieval-kinds';

export type SimilarHit = {
  kind: SimilarKind;
  id: string;
  title: string | null;
  snippet: string | null;
  similarity: number; // 0..1, 1 = identical
  // Sprint 15 Wave 3: when the source has extracted_ideas attached, carry
  // the highest-signal Idea's title + claim so the synthesis layer prefers
  // the Idea's framing over a raw body excerpt. Only populated for kinds
  // backed by extracted_ideas rows (today: newsletter_issue, obsidian_note).
  ideaTitle?: string | null;
  ideaClaim?: string | null;
  // Phase 14a (2026-05-04): for kind === 'extracted_idea', carry the FULL
  // (untruncated) claim + evidence + the underlying source's title so the
  // rail card can render the whole claim and reveal evidence + source on
  // expand. claim is short by design, so the card always shows it.
  claimFull?: string | null;
  evidenceFull?: string | null;
  sourceTitle?: string | null;
  // Phase 15b (2026-05-05): for kind === 'extracted_idea', the originating
  // source kind (newsletter_issue / obsidian_note / linkedin_post /
  // gmail_message). Lets the bucket helper in retrieval-kinds.ts split
  // extracted ideas into voice vs knowledge for the home composer's
  // sparring-partner prompt. Null on non-extracted_idea hits.
  sourceKind?: SimilarKind | null;
  // Phase 14a: per-hit "this is here because…" reasoning, generated
  // alongside the synthesis paragraph in generateReflection. The rail
  // renders this as a small italic line under the title.
  reasoning?: string | null;
};

const findSimilarSchema = z.object({
  text: z.string().min(1).max(8000),
  kinds: z
    .array(z.enum(SIMILAR_KINDS_FOR_ZOD))
    .min(1)
    .default([...SIMILAR_KINDS]),
  limit: z.number().int().min(1).max(50).default(10),
  // Caller passes when retrieval is "things related to X" and X itself
  // shouldn't show up in its own related list.
  excludeIdeaId: z.string().uuid().optional(),
  excludeDraftId: z.string().uuid().optional(),
  excludeCaptureId: z.string().uuid().optional(),
  excludeNewsletterIssueId: z.string().uuid().optional(),
  excludeObsidianNoteId: z.string().uuid().optional(),
  excludeExtractedIdeaId: z.string().uuid().optional(),
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

  if (wanted.has('newsletter_issue')) {
    // Sprint 15 Wave 3 layer 2: signal-boosted ranking + noise floor.
    // - Boost is a correlated subquery over extracted_ideas attached to
    //   this issue. We weight depth more than breadth (0.3 vs 0.2) per
    //   the brief, since depth captures "this source actually develops
    //   the idea" while breadth is whether the idea recurs across the
    //   bed (which findSimilar doesn't observe directly).
    // - Floor: skip results whose source has NO extracted_ideas AND
    //   raw cosine similarity is below 0.55. That kills the noise floor
    //   without losing the long tail of "no idea but very close" matches.
    const signalBoostSql = sql<number>`COALESCE(
      (SELECT MAX(0.3 * ${extractedIdeas.depthSignal} + 0.2 * ${extractedIdeas.breadthSignal})
       FROM ${extractedIdeas}
       WHERE ${extractedIdeas.newsletterIssueId} = ${newsletterIssues.id}),
      0
    )`;
    const signalFloorSql = sql`(
      (1 - (${newsletterIssues.embedding} <=> ${lit}::vector)) >= 0.55
      OR EXISTS (
        SELECT 1 FROM ${extractedIdeas}
        WHERE ${extractedIdeas.newsletterIssueId} = ${newsletterIssues.id}
      )
    )`;
    const issueWhere = data.excludeNewsletterIssueId
      ? sql`${newsletterIssues.userId} = ${user.id}
            AND ${newsletterIssues.embedding} IS NOT NULL
            AND ${newsletterIssues.id} != ${data.excludeNewsletterIssueId}
            AND ${signalFloorSql}`
      : sql`${newsletterIssues.userId} = ${user.id}
            AND ${newsletterIssues.embedding} IS NOT NULL
            AND ${signalFloorSql}`;

    promises.push(
      db
        .select({
          id: newsletterIssues.id,
          title: newsletterIssues.title,
          bodyText: newsletterIssues.bodyText,
          distance: sql<number>`${newsletterIssues.embedding} <=> ${lit}::vector`,
          boost: signalBoostSql,
        })
        .from(newsletterIssues)
        .where(issueWhere)
        // ORDER BY (distance - boost) ASC ranks high-signal close-cosine
        // matches first. Equivalent to (similarity + boost) DESC.
        .orderBy(
          sql`(${newsletterIssues.embedding} <=> ${lit}::vector) - ${signalBoostSql}`
        )
        .limit(perKindLimit)
        .then((rows) =>
          rows.map((r): SimilarHit => {
            const cleaned = cleanText('newsletter_issue', r.bodyText ?? '');
            const snippet =
              cleaned.length > 0
                ? cleaned.slice(0, 200) + (cleaned.length > 200 ? '…' : '')
                : null;
            return {
              kind: 'newsletter_issue',
              id: r.id,
              title: r.title,
              snippet,
              // similarity surfaces the boosted score so the rail's
              // sort order matches what the user sees. Raw cosine is
              // recoverable as similarity - boost if needed for debug.
              similarity: 1 - Number(r.distance) + Number(r.boost ?? 0),
            };
          })
        )
    );
  }

  if (wanted.has('obsidian_note')) {
    // Sprint 15 Wave 3 layer 2: same signal-boost + noise-floor pattern
    // as newsletter_issue above. See that branch for rationale.
    const signalBoostSql = sql<number>`COALESCE(
      (SELECT MAX(0.3 * ${extractedIdeas.depthSignal} + 0.2 * ${extractedIdeas.breadthSignal})
       FROM ${extractedIdeas}
       WHERE ${extractedIdeas.obsidianNoteId} = ${obsidianNotes.id}),
      0
    )`;
    const signalFloorSql = sql`(
      (1 - (${obsidianNotes.embedding} <=> ${lit}::vector)) >= 0.55
      OR EXISTS (
        SELECT 1 FROM ${extractedIdeas}
        WHERE ${extractedIdeas.obsidianNoteId} = ${obsidianNotes.id}
      )
    )`;
    const noteWhere = data.excludeObsidianNoteId
      ? sql`${obsidianNotes.userId} = ${user.id}
            AND ${obsidianNotes.embedding} IS NOT NULL
            AND ${obsidianNotes.id} != ${data.excludeObsidianNoteId}
            AND ${signalFloorSql}`
      : sql`${obsidianNotes.userId} = ${user.id}
            AND ${obsidianNotes.embedding} IS NOT NULL
            AND ${signalFloorSql}`;

    promises.push(
      db
        .select({
          id: obsidianNotes.id,
          title: obsidianNotes.title,
          path: obsidianNotes.path,
          bodyText: obsidianNotes.bodyText,
          distance: sql<number>`${obsidianNotes.embedding} <=> ${lit}::vector`,
          boost: signalBoostSql,
        })
        .from(obsidianNotes)
        .where(noteWhere)
        .orderBy(
          sql`(${obsidianNotes.embedding} <=> ${lit}::vector) - ${signalBoostSql}`
        )
        .limit(perKindLimit)
        .then((rows) =>
          rows.map((r): SimilarHit => {
            const cleaned = cleanText('obsidian_note', r.bodyText ?? '');
            const snippet =
              cleaned.length > 0
                ? cleaned.slice(0, 200) + (cleaned.length > 200 ? '…' : '')
                : null;
            return {
              kind: 'obsidian_note',
              id: r.id,
              // Title is always present in the column (resolveTitle's
              // frontmatter / H1 / filename fallback), so we surface it
              // straight rather than the path.
              title: r.title,
              snippet,
              similarity: 1 - Number(r.distance) + Number(r.boost ?? 0),
            };
          })
        )
    );
  }

  if (wanted.has('linkedin_post')) {
    // Phase 12: LinkedIn posts use the same signal-boost + noise-floor
    // pattern as obsidian_note above (post body has its own embedding;
    // extracted_ideas attached to the post lift the rank when present).
    const signalBoostSql = sql<number>`COALESCE(
      (SELECT MAX(0.3 * ${extractedIdeas.depthSignal} + 0.2 * ${extractedIdeas.breadthSignal})
       FROM ${extractedIdeas}
       WHERE ${extractedIdeas.linkedinPostId} = ${linkedinPosts.id}),
      0
    )`;
    const signalFloorSql = sql`(
      (1 - (${linkedinPosts.embedding} <=> ${lit}::vector)) >= 0.55
      OR EXISTS (
        SELECT 1 FROM ${extractedIdeas}
        WHERE ${extractedIdeas.linkedinPostId} = ${linkedinPosts.id}
      )
    )`;
    const postWhere = sql`${linkedinPosts.userId} = ${user.id}
            AND ${linkedinPosts.embedding} IS NOT NULL
            AND ${signalFloorSql}`;

    promises.push(
      db
        .select({
          id: linkedinPosts.id,
          authorName: linkedinPosts.authorName,
          bodyClean: linkedinPosts.bodyClean,
          linkedinUrl: linkedinPosts.linkedinUrl,
          distance: sql<number>`${linkedinPosts.embedding} <=> ${lit}::vector`,
          boost: signalBoostSql,
        })
        .from(linkedinPosts)
        .where(postWhere)
        .orderBy(
          sql`(${linkedinPosts.embedding} <=> ${lit}::vector) - ${signalBoostSql}`
        )
        .limit(perKindLimit)
        .then((rows) =>
          rows.map((r): SimilarHit => {
            // Title fallback: first line of body_clean (LinkedIn posts
            // don't have explicit titles). Snippet is body_clean.
            const body = r.bodyClean ?? '';
            const firstLine = body.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
            const title =
              firstLine.length > 80
                ? firstLine.slice(0, 77).trimEnd() + '…'
                : firstLine || '(LinkedIn post)';
            const snippet =
              body.length > 0
                ? body.slice(0, 200) + (body.length > 200 ? '…' : '')
                : null;
            return {
              kind: 'linkedin_post',
              id: r.id,
              title,
              snippet,
              similarity: 1 - Number(r.distance) + Number(r.boost ?? 0),
            };
          })
        )
    );
  }

  if (wanted.has('gmail_message')) {
    // Phase 13: Gmail newsletter messages. Same signal-boost + noise-floor
    // pattern as linkedin_post above. The status='promoted' filter is the
    // critical bit — pending / dismissed / snoozed messages are NOT in the
    // retrieval pool. Triage gates corpus membership.
    const gmailSignalBoostSql = sql<number>`COALESCE(
      (SELECT MAX(0.3 * ${extractedIdeas.depthSignal} + 0.2 * ${extractedIdeas.breadthSignal})
       FROM ${extractedIdeas}
       WHERE ${extractedIdeas.gmailMessageId} = ${gmailMessages.id}),
      0
    )`;
    const gmailSignalFloorSql = sql`(
      (1 - (${gmailMessages.embedding} <=> ${lit}::vector)) >= 0.55
      OR EXISTS (
        SELECT 1 FROM ${extractedIdeas}
        WHERE ${extractedIdeas.gmailMessageId} = ${gmailMessages.id}
      )
    )`;
    const gmailWhere = sql`${gmailMessages.userId} = ${user.id}
            AND ${gmailMessages.status} = 'promoted'
            AND ${gmailMessages.embedding} IS NOT NULL
            AND ${gmailSignalFloorSql}`;

    promises.push(
      db
        .select({
          id: gmailMessages.id,
          subject: gmailMessages.subject,
          fromName: gmailMessages.fromName,
          fromAddress: gmailMessages.fromAddress,
          bodyClean: gmailMessages.bodyClean,
          distance: sql<number>`${gmailMessages.embedding} <=> ${lit}::vector`,
          boost: gmailSignalBoostSql,
        })
        .from(gmailMessages)
        .where(gmailWhere)
        .orderBy(
          sql`(${gmailMessages.embedding} <=> ${lit}::vector) - ${gmailSignalBoostSql}`
        )
        .limit(perKindLimit)
        .then((rows) =>
          rows.map((r): SimilarHit => {
            // Title: prefer the Gmail Subject; fall back to the sender's
            // display name; final fallback is a generic label.
            const subj = (r.subject ?? '').trim();
            const sender = (r.fromName ?? r.fromAddress ?? '').trim();
            const title = subj || sender || '(newsletter)';
            const body = r.bodyClean ?? '';
            const snippet =
              body.length > 0
                ? body.slice(0, 200) + (body.length > 200 ? '…' : '')
                : null;
            return {
              kind: 'gmail_message',
              id: r.id,
              title,
              snippet,
              similarity: 1 - Number(r.distance) + Number(r.boost ?? 0),
            };
          })
        )
    );
  }

  if (wanted.has('extracted_idea')) {
    const ideaWhere = data.excludeExtractedIdeaId
      ? sql`${extractedIdeas.userId} = ${user.id}
            AND ${extractedIdeas.embedding} IS NOT NULL
            AND ${extractedIdeas.id} != ${data.excludeExtractedIdeaId}`
      : sql`${extractedIdeas.userId} = ${user.id}
            AND ${extractedIdeas.embedding} IS NOT NULL`;

    promises.push(
      db
        .select({
          id: extractedIdeas.id,
          title: extractedIdeas.title,
          claim: extractedIdeas.claim,
          evidence: extractedIdeas.evidence,
          // Phase 14a (2026-05-04): coalesce the four source-kind FK joins
          // into a single sourceTitle column so the rail card's expand can
          // render "from <source>" without four conditional fetches client
          // side. LEFT JOINs are cheap — only one of the FK columns is
          // ever set per row (the XOR check enforces it).
          sourceTitleNewsletter: newsletterIssues.title,
          sourceTitleObsidian: obsidianNotes.title,
          sourceTitleLinkedin: linkedinPosts.authorName,
          sourceTitleGmail: gmailMessages.subject,
          distance: sql<number>`${extractedIdeas.embedding} <=> ${lit}::vector`,
        })
        .from(extractedIdeas)
        .leftJoin(
          newsletterIssues,
          eq(extractedIdeas.newsletterIssueId, newsletterIssues.id)
        )
        .leftJoin(
          obsidianNotes,
          eq(extractedIdeas.obsidianNoteId, obsidianNotes.id)
        )
        .leftJoin(
          linkedinPosts,
          eq(extractedIdeas.linkedinPostId, linkedinPosts.id)
        )
        .leftJoin(
          gmailMessages,
          eq(extractedIdeas.gmailMessageId, gmailMessages.id)
        )
        .where(ideaWhere)
        .orderBy(sql`${extractedIdeas.embedding} <=> ${lit}::vector`)
        .limit(perKindLimit)
        .then((rows) =>
          rows.map((r): SimilarHit => {
            // Snippet is the curated 'claim' (with a fallback to evidence
            // if claim is unusually short). The synthesis layer prefers
            // ideaTitle + ideaClaim over snippet for these — we still
            // populate snippet for backward-compatible consumers.
            const claim = (r.claim ?? '').trim();
            const evidence = (r.evidence ?? '').trim();
            const snippet =
              claim.length > 0
                ? claim.slice(0, 280) + (claim.length > 280 ? '…' : '')
                : evidence.length > 0
                  ? evidence.slice(0, 280) + (evidence.length > 280 ? '…' : '')
                  : null;
            const sourceTitle =
              r.sourceTitleNewsletter ??
              r.sourceTitleObsidian ??
              r.sourceTitleLinkedin ??
              r.sourceTitleGmail ??
              null;
            // Phase 15b: surface which source kind the extracted_idea came
            // from. Used by retrieval-kinds.ts bucket() to route this hit
            // into voice_longform / voice_shortform / knowledge in the
            // home composer prompt. Exactly one FK is set per row (XOR
            // CHECK in 0009_gmail.sql), so first-non-null wins.
            const sourceKind: SimilarKind | null = r.sourceTitleNewsletter
              ? 'newsletter_issue'
              : r.sourceTitleObsidian
                ? 'obsidian_note'
                : r.sourceTitleLinkedin
                  ? 'linkedin_post'
                  : r.sourceTitleGmail
                    ? 'gmail_message'
                    : null;
            return {
              kind: 'extracted_idea',
              id: r.id,
              title: r.title,
              snippet,
              similarity: 1 - Number(r.distance),
              ideaTitle: r.title,
              ideaClaim: claim || null,
              claimFull: claim || null,
              evidenceFull: evidence || null,
              sourceTitle,
              sourceKind,
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

// ─── reflect — Sprint 9 generative reflection (Sprint 12 mode-aware) ─────

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
  // Sprint 12: composer mode tags the draft's voice. The reflection prompt
  // adapts: newsletter → "what would land in your next issue"; linkedin →
  // shorter, punchier; self-pilot / undefined → original neutral voice.
  mode: z.enum(['newsletter', 'linkedin', 'self-pilot']).optional(),
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
  const { draftId, mode } = reflectSchema.parse(input);

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
      // Sprint 15 Wave 3: pull from every retrieval kind. SIMILAR_KINDS is
      // exported from src/lib/retrieval-kinds.ts so this stays correct as
      // we add provider surfaces in future waves.
      kinds: [...SIMILAR_KINDS],
      limit: REFLECT_HIT_LIMIT,
      excludeDraftId: draftId,
    });
  } catch (err) {
    console.warn('[reflect] findSimilar failed; continuing ungrounded', err);
  }

  try {
    // Map the composer mode to a voice variant. self-pilot keeps the
    // original neutral voice — "the user wants to write, not be coached".
    const voice: ReflectionVoiceMode | undefined =
      mode === 'newsletter'
        ? 'newsletter'
        : mode === 'linkedin'
          ? 'linkedin'
          : undefined;

    const result = await generateReflection({
      draftText,
      hits: sources.map((s, i) => ({
        index: i + 1,
        kind: s.kind,
        title: s.title,
        snippet: s.snippet,
        // Sprint 15 Wave 3: surface the curated Idea fields when present so
        // the synthesis layer can refer to ideas by name.
        ideaTitle: s.ideaTitle ?? null,
        ideaClaim: s.ideaClaim ?? null,
      })),
      mode: voice,
    });
    // Phase 14a (2026-05-04): fan the per-hit reasoning back into sources
    // so the rail card render path can pick it up off the SimilarHit.
    const sourcesWithReasoning: SimilarHit[] = sources.map((s, i) => ({
      ...s,
      reasoning: result.reasoningByIndex[i + 1] ?? null,
    }));
    return {
      ok: true,
      reflection: result.reflection,
      sources: sourcesWithReasoning,
      basedOnChars: draftText.length,
    };
  } catch (err) {
    console.error('[reflect] generation failed', err);
    const message = err instanceof Error ? err.message : 'reflection failed';
    return { ok: false, reason: 'error', message };
  }
}

// ─── composeNew — Sprint 10/12 writing-first dispatcher ─────────────────

const composeSchema = z.object({
  // Self-pilot is the only mode that accepts an empty string — "open a
  // blank page". The schema uses min(0) to permit that; client checks the
  // non-self-pilot modes for non-empty before submit.
  text: z.string().max(20000).default(''),
  mode: z
    .enum(['newsletter', 'linkedin', 'self-pilot'])
    .default('newsletter'),
});

/**
 * Submit handler for the /studio home composer. Branches on mode into the
 * right draft create path:
 *
 *   newsletter → seed an H1 with the user's typed topic + an empty
 *                paragraph below; redirect into the editor with
 *                ?mode=newsletter so the rail boots in newsletter voice.
 *   linkedin   → body-only paragraph (no H1); redirect with ?mode=linkedin.
 *                LinkedIn posts are bodies, not titled essays.
 *   self-pilot → empty draft; redirect with ?mode=self-pilot. The rail
 *                starts dormant on the editor route.
 *
 * Each branch best-effort embeds the row inline (same pattern as the
 * individual create actions) so the new content participates in
 * findSimilar / reflect immediately. Failures log but never block.
 *
 * Note: Ideas mode never reaches this action — it's a query interface
 * served by exploreIdeas().
 */
export async function composeNew(input: unknown) {
  const user = await requireUser();
  const { text, mode } = composeSchema.parse(input);
  const trimmed = text.trim();

  // newsletter ── topic line as H1, empty paragraph below.
  if (mode === 'newsletter') {
    if (trimmed.length === 0) redirect('/studio');
    const topic = trimmed.split('\n')[0].slice(0, 280);
    const initialDoc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: topic }],
        },
        { type: 'paragraph' },
      ],
    };

    const [draft] = await db
      .insert(drafts)
      .values({
        userId: user.id,
        title: topic,
        contentJson: initialDoc,
      })
      .returning();

    try {
      const embedding = await embedText(topic);
      await db
        .update(drafts)
        .set({ embedding })
        .where(and(eq(drafts.id, draft.id), eq(drafts.userId, user.id)));
    } catch (err) {
      console.warn('[composeNew] newsletter embed failed', err);
    }

    revalidatePath('/studio');
    revalidatePath('/studio/page');
    redirect(`/studio/page/${draft.id}?mode=newsletter`);
  }

  // linkedin ── body-only, the typed text becomes the first paragraph.
  if (mode === 'linkedin') {
    if (trimmed.length === 0) redirect('/studio');
    const initialDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: trimmed }],
        },
      ],
    };

    const [draft] = await db
      .insert(drafts)
      .values({
        userId: user.id,
        title: null, // LinkedIn posts have no title
        contentJson: initialDoc,
      })
      .returning();

    try {
      const embedding = await embedText(trimmed);
      await db
        .update(drafts)
        .set({ embedding })
        .where(and(eq(drafts.id, draft.id), eq(drafts.userId, user.id)));
    } catch (err) {
      console.warn('[composeNew] linkedin embed failed', err);
    }

    revalidatePath('/studio');
    revalidatePath('/studio/page');
    redirect(`/studio/page/${draft.id}?mode=linkedin`);
  }

  // self-pilot ── empty draft; the rail starts dormant on the editor.
  // Optional one-liner from the textarea seeds a single paragraph, but
  // an empty input is the canonical case.
  const initialDoc =
    trimmed.length > 0
      ? {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: trimmed }],
            },
          ],
        }
      : { type: 'doc', content: [{ type: 'paragraph' }] };

  const [draft] = await db
    .insert(drafts)
    .values({
      userId: user.id,
      title: null,
      contentJson: initialDoc,
    })
    .returning();

  if (trimmed.length > 0) {
    try {
      const embedding = await embedText(trimmed);
      await db
        .update(drafts)
        .set({ embedding })
        .where(and(eq(drafts.id, draft.id), eq(drafts.userId, user.id)));
    } catch (err) {
      console.warn('[composeNew] self-pilot embed failed', err);
    }
  }

  revalidatePath('/studio');
  revalidatePath('/studio/page');
  redirect(`/studio/page/${draft.id}?mode=self-pilot`);
}

// ─── exploreIdeas — Sprint 12 query interface ───────────────────────

const exploreIdeasSchema = z.object({
  intent: z.enum(['untouched', 'mature', 'search']),
  query: z.string().min(1).max(2000).optional(),
});

export type ExploredIdea = {
  id: string;
  title: string;
  essence: string | null;
  // 'unknown' is used for the search variant where we don't fetch maturity
  // (findSimilar's hit shape doesn't carry it).
  maturity: string;
  signalScore?: number;
  similarity?: number;
};

export type ExploreIdeasResult =
  | {
      ok: true;
      intent: 'untouched' | 'mature' | 'search';
      ideas: ExploredIdea[];
    }
  | {
      ok: false;
      reason: 'needs_query' | 'error';
      message: string;
    };

const EXPLORE_LIMIT = 8;

// Maturity values (per /db/schema.ts):
//   'seed' | 'forming' | 'shaping' | 'ready' | 'circulated' | 'dormant'
// "Mature enough to write" === forming / shaping / ready / circulated.
const MATURE_ENOUGH = ['forming', 'shaping', 'ready', 'circulated'] as const;

/**
 * Composer's Ideas mode dispatcher. Three intents:
 *   · 'untouched' — ideas with low/no overlap to existing drafts. We
 *     compute, for each user-owned idea with an embedding, the MIN cosine
 *     distance to any of the user's draft embeddings (defaulting to 2.0
 *     when no drafts exist). Order DESC by that min distance to surface
 *     ideas farthest from anything written.
 *   · 'mature' — maturity ≥ 'forming', ranked by (heat + pull + weight).
 *   · 'search' — semantic search over ideas via findSimilar.
 *
 * No state changes; this is read-only retrieval. The Composer client
 * navigates to /studio/ideas/[id] when the user picks a result.
 */
export async function exploreIdeas(
  input: unknown
): Promise<ExploreIdeasResult> {
  const user = await requireUser();
  const data = exploreIdeasSchema.parse(input);

  if (data.intent === 'mature') {
    const rows = await db
      .select({
        id: ideas.id,
        title: ideas.title,
        essence: ideas.essence,
        maturity: ideas.maturity,
        weight: ideas.weight,
        pull: ideas.pull,
        heat: ideas.heat,
      })
      .from(ideas)
      .where(
        and(
          eq(ideas.userId, user.id),
          inArray(ideas.maturity, [...MATURE_ENOUGH])
        )
      )
      .orderBy(
        desc(sql<number>`(
          COALESCE(${ideas.heat}, 0)
          + COALESCE(${ideas.pull}, 0)
          + COALESCE(${ideas.weight}, 0)
        )`),
        desc(ideas.lastVisitedAt)
      )
      .limit(EXPLORE_LIMIT);

    return {
      ok: true,
      intent: 'mature',
      ideas: rows.map((r) => ({
        id: r.id,
        title: r.title,
        essence: r.essence,
        maturity: r.maturity,
        signalScore:
          (r.heat ?? 0) + (r.pull ?? 0) + (r.weight ?? 0),
      })),
    };
  }

  if (data.intent === 'untouched') {
    // Contrastive retrieval: for each idea (with an embedding), find the
    // closest draft (by cosine distance) and surface the ideas whose
    // closest draft is farthest. Defaulting to 2.0 (max distance) when
    // the user has no drafts means every idea reads as "untouched".
    const result = await db.execute<{
      id: string;
      title: string;
      essence: string | null;
      maturity: string;
      min_distance: number;
    }>(sql`
      SELECT
        i.id::text AS id,
        i.title AS title,
        i.essence AS essence,
        i.maturity AS maturity,
        COALESCE(
          (SELECT MIN(i.embedding <=> d.embedding)
           FROM drafts d
           WHERE d.user_id = ${user.id}
             AND d.embedding IS NOT NULL),
          2.0
        ) AS min_distance
      FROM ideas i
      WHERE i.user_id = ${user.id}
        AND i.embedding IS NOT NULL
      ORDER BY min_distance DESC
      LIMIT ${EXPLORE_LIMIT}
    `);

    // db.execute on the Neon HTTP driver returns either a `.rows` array or
    // an array directly depending on driver version — be defensive.
    const rows = Array.isArray(result)
      ? (result as unknown as Array<{
          id: string;
          title: string;
          essence: string | null;
          maturity: string;
          min_distance: number | string;
        }>)
      : (result as { rows?: Array<{
          id: string;
          title: string;
          essence: string | null;
          maturity: string;
          min_distance: number | string;
        }> }).rows ?? [];

    return {
      ok: true,
      intent: 'untouched',
      ideas: rows.map((r) => ({
        id: r.id,
        title: r.title,
        essence: r.essence,
        maturity: r.maturity,
        signalScore: Number(r.min_distance),
      })),
    };
  }

  // intent === 'search'
  if (!data.query || data.query.trim().length === 0) {
    return {
      ok: false,
      reason: 'needs_query',
      message: 'Type a few words to search your ideas.',
    };
  }

  try {
    const hits = await findSimilar({
      text: data.query,
      kinds: ['idea'],
      limit: EXPLORE_LIMIT,
    });

    return {
      ok: true,
      intent: 'search',
      ideas: hits.map((h) => ({
        id: h.id,
        title: h.title ?? '(untitled)',
        essence: h.snippet,
        maturity: 'unknown',
        similarity: h.similarity,
      })),
    };
  } catch (err) {
    console.error('[exploreIdeas.search] failed', err);
    const message = err instanceof Error ? err.message : 'search failed';
    return { ok: false, reason: 'error', message };
  }
}
