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
import {
  generateReflection,
  generateProposal,
  generateSectionDraft,
  generateBeatDraft,
  regenerateAngles as llmRegenerateAngles,
  regenerateOutline as llmRegenerateOutline,
  type ReflectionVoiceMode,
  type ProposalRetrievalItem,
  type ProposalResult,
} from '@/lib/llm';
// Phase 15a (2026-05-05): per-platform voice profile from /studio/voice.
// Returns { longform?, linkedin? }; undefined / partial is safe — the
// proposal prompt falls back to bucket samples on per-platform basis.
import { getVoiceProfile } from '@/lib/voice/profile';
import {
  SIMILAR_KINDS,
  SIMILAR_KINDS_FOR_ZOD,
  bucket,
  type SimilarKind,
  type RetrievalBucket,
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
      message: 'Nothing to reflect on yet. Start writing.',
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

// ─── proposeFromTopic — Phase 15b · home composer (sparring partner) ──
//
// 2026-05-05. The home composer at /studio submits a topic to this action.
// One round-trip; fits inside Vercel Hobby's 10s server-action cap on
// today's corpus sizes (one embed + per-kind vector queries via
// findSimilar + one Haiku call). If retrieval grows, kick+poll comes
// back later — stays single-shot for now.
//
// Return shape mirrors what the Spar UI needs:
//   - visibleThinking.lines: deterministic counts shaped into the
//     thinking-out-loud bullet list ("3 of your past CSL issues
//     circled this", "5 vault notes share vocabulary"). Computed from
//     bucket counts + a couple of kind-specific tallies.
//   - visibleThinking.summary: Claude's one-or-two-sentence
//     reflective lede.
//   - angles[].sources: source-citation indices resolved to
//     { label, title, kind, id } so the UI can render "from your CSL
//     issue X + vault note Y" without a second fetch.
//   - outline / followUpQuestion / platformGuess / retrievalCount:
//     straight pass-through for the UI.
//   - committableOutline: the bare beat strings the commit step
//     (Slice 6) will turn into H2 headers when the user opens the page.
//
// Voice profile is optional. Phase 15a will populate; 15b leaves it
// undefined and the proposal prompt falls back to the bucket samples.

const proposeFromTopicSchema = z.object({
  topic: z.string().min(3).max(2000),
  // Optional clarification when the user has already answered the
  // platform question in the spar conversation.
  platformHint: z.enum(['newsletter', 'linkedin', 'blog', 'note']).optional(),
  // Concatenated spar transcript so the partner can advance the
  // thinking instead of restarting on every iteration. Client decides
  // shape — usually `Q: ...\nA: ...` lines.
  conversationSoFar: z.string().max(8000).optional(),
});

export type ProposeAngle = {
  line: string;
  sources: Array<{
    index: number;
    kind: SimilarKind;
    bucket: RetrievalBucket;
    label: string;
    title: string | null;
    id: string;
  }>;
};

export type ProposeFromTopicResult =
  | {
      ok: true;
      topic: string;
      platformGuess: 'newsletter' | 'linkedin' | 'unknown';
      visibleThinking: {
        lines: string[];
        summary: string;
        // Phase 16 (2026-05-05): structured source-kind counts so the
        // Spar UI can render a small icon row signaling source breadth
        // without enumerating every count as a bullet line. Real-use
        // feedback after slice 2 push: the bullet list felt heavy;
        // the user wanted a tighter summary with icons-as-depth-cue.
        kindCounts: {
          ideas: number;
          cslIssues: number;
          linkedin: number;
          vault: number;
          gmail: number;
        };
      };
      angles: ProposeAngle[];
      // Phase 16: linkedin-only structural slot. null for newsletter
      // / unknown.
      hook: string | null;
      outline: { beat: string }[];
      followUpQuestion: string;
      retrievalCount: number;
    }
  | {
      ok: false;
      reason: 'too_short' | 'error';
      message: string;
    };

// Translate a SimilarHit into a human label used in both the LLM prompt
// blocks and the UI's source-citation chips. Kept verbose on purpose —
// the labels are the partner's "from your CSL issue …" voice.
function labelForHit(hit: SimilarHit): string {
  if (hit.kind === 'newsletter_issue') return 'your CSL issue';
  if (hit.kind === 'obsidian_note') return 'vault note';
  if (hit.kind === 'linkedin_post') return 'your LinkedIn post';
  if (hit.kind === 'gmail_message') return 'newsletter you read';
  if (hit.kind === 'extracted_idea') {
    // Show the originating source kind so "from your space" is precise.
    if (hit.sourceKind === 'newsletter_issue') return 'idea from your CSL';
    if (hit.sourceKind === 'obsidian_note') return 'idea from your vault';
    if (hit.sourceKind === 'linkedin_post')
      return 'idea from your LinkedIn';
    if (hit.sourceKind === 'gmail_message')
      return 'idea from a newsletter you read';
    return 'extracted idea';
  }
  if (hit.kind === 'idea') return 'idea in your garden';
  if (hit.kind === 'draft') return 'earlier draft';
  if (hit.kind === 'capture') return 'capture';
  // Exhaustive — but TS doesn't know SimilarKind has been narrowed.
  return 'item from your space';
}

// Body excerpt the LLM sees. Prefer the curated claim for
// extracted_ideas, fall back to snippet for everything else. Caller
// already truncated; we re-truncate to keep the prompt bounded across
// future kinds.
function bodyForHit(hit: SimilarHit): string | null {
  if (hit.kind === 'extracted_idea') {
    const claim = (hit.ideaClaim ?? '').trim();
    if (claim.length > 0) return claim;
  }
  const snip = (hit.snippet ?? '').trim();
  return snip.length > 0 ? snip : null;
}

// Shape the deterministic visible-thinking list. The exact wording
// matches the spec's example ("3 ripe ideas in your garden touched
// this", etc.). Each line is dropped if its tally is zero so the list
// doesn't read as "0 vault notes" stutters.
// Phase 16 (2026-05-05): structured per-kind counts. visibleThinkingLines
// builds human strings for legacy / accessibility; this returns the same
// data as numbers so the UI can render an icon row instead of bullets.
function visibleThinkingKindCounts(hits: SimilarHit[]): {
  ideas: number;
  cslIssues: number;
  linkedin: number;
  vault: number;
  gmail: number;
} {
  return {
    ideas: hits.filter((h) => h.kind === 'idea' || h.kind === 'extracted_idea')
      .length,
    cslIssues: hits.filter((h) => h.kind === 'newsletter_issue').length,
    linkedin: hits.filter((h) => h.kind === 'linkedin_post').length,
    vault: hits.filter((h) => h.kind === 'obsidian_note').length,
    gmail: hits.filter((h) => h.kind === 'gmail_message').length,
  };
}

function visibleThinkingLines(hits: SimilarHit[]): string[] {
  const lines: string[] = [];

  const ideaCount = hits.filter(
    (h) => h.kind === 'idea' || h.kind === 'extracted_idea'
  ).length;
  if (ideaCount > 0) {
    lines.push(
      `${ideaCount} ${ideaCount === 1 ? 'idea' : 'ideas'} in your garden touched this`
    );
  }

  const cslCount = hits.filter((h) => h.kind === 'newsletter_issue').length;
  if (cslCount > 0) {
    lines.push(
      `${cslCount} of your CSL ${cslCount === 1 ? 'issue' : 'issues'} circled around it`
    );
  }

  const linkedinCount = hits.filter((h) => h.kind === 'linkedin_post').length;
  if (linkedinCount > 0) {
    lines.push(
      `${linkedinCount} of your LinkedIn ${linkedinCount === 1 ? 'post' : 'posts'} touched it`
    );
  }

  const vaultCount = hits.filter((h) => h.kind === 'obsidian_note').length;
  if (vaultCount > 0) {
    lines.push(
      `${vaultCount} vault ${vaultCount === 1 ? 'note' : 'notes'} share vocabulary`
    );
  }

  const gmailCount = hits.filter((h) => h.kind === 'gmail_message').length;
  if (gmailCount > 0) {
    lines.push(
      `${gmailCount} ${gmailCount === 1 ? 'newsletter' : 'newsletters'} you read circle this`
    );
  }

  return lines;
}

/**
 * Home composer's submit handler. Retrieval + proposal in a single
 * round-trip. Stateless across sessions per Phase 15b spec — any
 * "memory" comes from conversationSoFar passed by the client.
 *
 * Failures return as a tagged union (ok: false) the same way reflect()
 * does, so the Spar UI can render a graceful state instead of an
 * unhandled exception.
 */
export async function proposeFromTopic(
  input: unknown
): Promise<ProposeFromTopicResult> {
  // Rather than throw on validation failure, surface as too_short — the
  // spar UI already swallows whitespace submits client-side, but server
  // input is never trusted.
  let parsed: z.infer<typeof proposeFromTopicSchema>;
  try {
    parsed = proposeFromTopicSchema.parse(input);
  } catch {
    return {
      ok: false,
      reason: 'too_short',
      message: 'Need a topic of at least 3 characters.',
    };
  }

  const user = await requireUser();

  let hits: SimilarHit[] = [];
  try {
    hits = await findSimilar({
      text: parsed.topic,
      // All kinds. The bucket helper sorts them downstream.
      kinds: [...SIMILAR_KINDS],
      // 12 is enough material for the partner without ballooning the
      // prompt. findSimilar already orders by similarity globally.
      limit: 12,
    });
  } catch (err) {
    console.warn('[proposeFromTopic] findSimilar failed', err);
    // Continue with empty hits — Claude's prompt knows how to handle
    // sparse-corpus mode and the user still gets angles + a question.
    hits = [];
  }

  // Build retrieval items for the LLM. Index is 1-based — angles cite
  // these.
  const retrievalItems: ProposalRetrievalItem[] = hits.map((h, i) => ({
    index: i + 1,
    bucket: bucket({ kind: h.kind, sourceKind: h.sourceKind ?? null }),
    label: labelForHit(h),
    title: h.title,
    body: bodyForHit(h),
  }));

  // Phase 15a (2026-05-05): voice profile is read here. Returns
  // { longform?, linkedin? } — undefined / partial is safe; the
  // generateProposal prompt falls back to the bucket samples per
  // platform when missing. findSimilar+profile read parallel for
  // latency.
  let voiceProfile: Awaited<ReturnType<typeof getVoiceProfile>> = {};
  try {
    voiceProfile = await getVoiceProfile(user.id);
  } catch (err) {
    console.warn('[proposeFromTopic] getVoiceProfile failed', err);
    voiceProfile = {};
  }

  let proposal: ProposalResult;
  try {
    proposal = await generateProposal({
      topic: parsed.topic,
      conversationSoFar: parsed.conversationSoFar,
      platformHint: parsed.platformHint,
      voiceProfile,
      retrieval: retrievalItems,
    });
  } catch (err) {
    console.error('[proposeFromTopic] generateProposal failed', err);
    return {
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : 'proposal failed',
    };
  }

  // Resolve angle source-citations into UI-friendly refs. Claude returns
  // 1-based indices; we look them up against the retrievalItems / hits
  // pair. Out-of-range indices (model hallucination) get dropped
  // silently — better than crashing the surface.
  const angles: ProposeAngle[] = proposal.angles.map((a) => {
    const sources = (a.sourceCitations ?? [])
      .map((idx) => {
        const item = retrievalItems[idx - 1];
        const hit = hits[idx - 1];
        if (!item || !hit) return null;
        return {
          index: item.index,
          kind: hit.kind,
          bucket: item.bucket,
          label: item.label,
          title: hit.title,
          id: hit.id,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
    return { line: a.line, sources };
  });

  return {
    ok: true,
    topic: parsed.topic,
    platformGuess: proposal.platformGuess,
    visibleThinking: {
      lines: visibleThinkingLines(hits),
      summary: proposal.retrievalSummary,
      kindCounts: visibleThinkingKindCounts(hits),
    },
    angles,
    hook: proposal.hook ?? null,
    outline: proposal.outline,
    followUpQuestion: proposal.followUpQuestion,
    retrievalCount: hits.length,
  };
}

// ─── draftSection — Phase 15a · per-beat draft in user's voice ────────
//
// Spar's "Draft a section" button calls this with the beat the user
// wants drafted. Returns prose to splice into client state; only
// persisted when the user hits "Open the page" (commitProposal
// accepts a sections map — see slice B3).
//
// Hard requirement: voice profile MUST exist for the resolved
// platform. Generic-voice section drafts are worse than no drafts
// (spec rationale; Voice ID was the reason this button waited).
// Returns ok:false { reason: 'no_voice_profile' } when the platform's
// profile is empty so the UI can prompt the user to /studio/voice
// rather than silently producing generic-sounding prose.

const draftSectionSchema = z.object({
  topic: z.string().min(1).max(2000),
  outline: z
    .array(z.object({ beat: z.string().min(1).max(800) }))
    .min(1)
    .max(8),
  beatIndex: z.number().int().min(0).max(7),
  platform: z.enum(['newsletter', 'linkedin']),
  conversationSoFar: z.string().max(8000).optional(),
});

export type DraftSectionResult =
  | { ok: true; beatIndex: number; prose: string }
  | {
      ok: false;
      reason: 'no_voice_profile' | 'invalid_input' | 'error';
      message: string;
    };

export async function draftSection(
  input: unknown
): Promise<DraftSectionResult> {
  let parsed: z.infer<typeof draftSectionSchema>;
  try {
    parsed = draftSectionSchema.parse(input);
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid_input',
      message: err instanceof Error ? err.message : 'invalid input',
    };
  }

  const user = await requireUser();

  // Resolve the voice profile for the platform. linkedin → linkedin
  // profile; newsletter → longform profile (essay-shape voice).
  const profileBundle = await getVoiceProfile(user.id);
  const platformProfile =
    parsed.platform === 'linkedin'
      ? profileBundle.linkedin
      : profileBundle.longform;

  if (!platformProfile) {
    return {
      ok: false,
      reason: 'no_voice_profile',
      message: `No ${parsed.platform === 'linkedin' ? 'LinkedIn' : 'longform'} voice profile yet. Build one at /studio/voice and try again.`,
    };
  }

  // Per-beat retrieval: re-run findSimilar against the beat text so
  // the draft pulls in references specific to this slot rather than
  // the whole topic. The beat is short, so retrieval is fast.
  const beat = parsed.outline[parsed.beatIndex]?.beat ?? parsed.topic;
  let hits: SimilarHit[] = [];
  try {
    hits = await findSimilar({
      text: beat,
      kinds: [...SIMILAR_KINDS],
      limit: 6,
    });
  } catch (err) {
    console.warn('[draftSection] findSimilar failed', err);
    hits = [];
  }

  const retrievalItems: ProposalRetrievalItem[] = hits.map((h, i) => ({
    index: i + 1,
    bucket: bucket({ kind: h.kind, sourceKind: h.sourceKind ?? null }),
    label: labelForHit(h),
    title: h.title,
    body: bodyForHit(h),
  }));

  try {
    const result = await generateSectionDraft({
      topic: parsed.topic,
      beatIndex: parsed.beatIndex,
      outline: parsed.outline,
      platform: parsed.platform,
      voiceProfile: platformProfile,
      retrieval: retrievalItems,
      conversationSoFar: parsed.conversationSoFar,
    });
    return {
      ok: true,
      beatIndex: parsed.beatIndex,
      prose: result.prose,
    };
  } catch (err) {
    console.error('[draftSection] generateSectionDraft failed', err);
    return {
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : 'draft failed',
    };
  }
}

// ─── regenerateAngles — Phase 16 · cheaper iteration: angles only ────
//
// 2026-05-05. Per-zone "Rethink angles" button calls this. Keeps
// outline / retrieval / proposal context where it is and only
// re-spins the three angles. Cheaper LLM call, target ~4-5s vs ~8-9s
// for the full proposeFromTopic. Returns the same ProposeAngle[]
// shape so the UI can splice without reshaping.

const regenerateAnglesSchema = z.object({
  topic: z.string().min(1).max(2000),
  outline: z.array(z.object({ beat: z.string().min(1).max(800) })).min(1).max(8),
  conversationSoFar: z.string().max(8000).optional(),
  platformHint: z.enum(['newsletter', 'linkedin', 'blog', 'note']).optional(),
});

export type RegenerateAnglesResult =
  | { ok: true; angles: ProposeAngle[] }
  | { ok: false; reason: 'invalid_input' | 'error'; message: string };

export async function regenerateAngles(
  input: unknown
): Promise<RegenerateAnglesResult> {
  let parsed: z.infer<typeof regenerateAnglesSchema>;
  try {
    parsed = regenerateAnglesSchema.parse(input);
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid_input',
      message: err instanceof Error ? err.message : 'invalid input',
    };
  }

  const user = await requireUser();

  let hits: SimilarHit[] = [];
  try {
    hits = await findSimilar({
      text: parsed.topic,
      kinds: [...SIMILAR_KINDS],
      limit: 12,
    });
  } catch (err) {
    console.warn('[regenerateAngles] findSimilar failed', err);
    hits = [];
  }

  const retrievalItems: ProposalRetrievalItem[] = hits.map((h, i) => ({
    index: i + 1,
    bucket: bucket({ kind: h.kind, sourceKind: h.sourceKind ?? null }),
    label: labelForHit(h),
    title: h.title,
    body: bodyForHit(h),
  }));

  let voiceProfile: Awaited<ReturnType<typeof getVoiceProfile>> = {};
  try {
    voiceProfile = await getVoiceProfile(user.id);
  } catch (err) {
    console.warn('[regenerateAngles] getVoiceProfile failed', err);
    voiceProfile = {};
  }

  try {
    const result = await llmRegenerateAngles({
      topic: parsed.topic,
      conversationSoFar: parsed.conversationSoFar,
      platformHint: parsed.platformHint,
      voiceProfile,
      retrieval: retrievalItems,
      existingOutline: parsed.outline,
    });
    const angles: ProposeAngle[] = result.angles.map((a) => {
      const sources = (a.sourceCitations ?? [])
        .map((idx) => {
          const item = retrievalItems[idx - 1];
          const hit = hits[idx - 1];
          if (!item || !hit) return null;
          return {
            index: item.index,
            kind: hit.kind,
            bucket: item.bucket,
            label: item.label,
            title: hit.title,
            id: hit.id,
          };
        })
        .filter((srt): srt is NonNullable<typeof srt> => srt !== null);
      return { line: a.line, sources };
    });
    return { ok: true, angles };
  } catch (err) {
    console.error('[regenerateAngles] llmRegenerateAngles failed', err);
    return {
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : 'rethink failed',
    };
  }
}

// ─── regenerateOutline — Phase 16 · cheaper iteration: outline only ──
//
// 2026-05-05. Per-zone "Rethink outline" button calls this. Keeps
// angles + retrieval intact; re-spins beats. Anchored beats are
// pinned in the LLM prompt as DO NOT CHANGE so iteration narrows
// toward the user's selections rather than wiping them.

const regenerateOutlineSchema = z.object({
  topic: z.string().min(1).max(2000),
  angles: z.array(z.object({ line: z.string().min(1).max(800) })).min(1).max(8),
  // Beats the user has anchored. Optional; empty array = nothing pinned.
  anchoredBeats: z.array(z.string().min(1).max(800)).max(8).optional(),
  conversationSoFar: z.string().max(8000).optional(),
  platformHint: z.enum(['newsletter', 'linkedin', 'blog', 'note']).optional(),
});

export type RegenerateOutlineResult =
  | { ok: true; outline: { beat: string }[] }
  | { ok: false; reason: 'invalid_input' | 'error'; message: string };

export async function regenerateOutline(
  input: unknown
): Promise<RegenerateOutlineResult> {
  let parsed: z.infer<typeof regenerateOutlineSchema>;
  try {
    parsed = regenerateOutlineSchema.parse(input);
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid_input',
      message: err instanceof Error ? err.message : 'invalid input',
    };
  }

  const user = await requireUser();

  let hits: SimilarHit[] = [];
  try {
    hits = await findSimilar({
      text: parsed.topic,
      kinds: [...SIMILAR_KINDS],
      limit: 12,
    });
  } catch (err) {
    console.warn('[regenerateOutline] findSimilar failed', err);
    hits = [];
  }

  const retrievalItems: ProposalRetrievalItem[] = hits.map((h, i) => ({
    index: i + 1,
    bucket: bucket({ kind: h.kind, sourceKind: h.sourceKind ?? null }),
    label: labelForHit(h),
    title: h.title,
    body: bodyForHit(h),
  }));

  let voiceProfile: Awaited<ReturnType<typeof getVoiceProfile>> = {};
  try {
    voiceProfile = await getVoiceProfile(user.id);
  } catch (err) {
    console.warn('[regenerateOutline] getVoiceProfile failed', err);
    voiceProfile = {};
  }

  try {
    const result = await llmRegenerateOutline({
      topic: parsed.topic,
      conversationSoFar: parsed.conversationSoFar,
      platformHint: parsed.platformHint,
      voiceProfile,
      retrieval: retrievalItems,
      existingAngles: parsed.angles,
      anchoredBeats: parsed.anchoredBeats,
    });
    return { ok: true, outline: result.outline };
  } catch (err) {
    console.error('[regenerateOutline] llmRegenerateOutline failed', err);
    return {
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : 'rethink failed',
    };
  }
}

// ─── draftBeat — Phase 16 · per-piece micro-drafting ─────────────────

// ─── draftBeat — Phase 16 · per-piece micro-drafting ─────────────────
//
// 2026-05-05. New primary path for the Spar's per-beat drafting.
// Difference from draftSection: the user has typed an INTENT for the
// beat ("what do you want to say here?") and we draft 2-4 sentences
// that pay off that intent, in their voice. draftSection (no-intent)
// stays available as a secondary "Draft anyway" affordance for users
// who want a take without supplying intent first.
//
// Voice profile fallback is SOFTER than draftSection. Missing voice
// profile is not a hard-block here — the user has already provided
// useful framing through their intent, so the function leans on
// retrieval voice cues + the intent and proceeds. The action returns
// ok:true with a flag so the UI can still surface "build a voice
// profile to make this sound more like you" as a soft note.

const draftBeatSchema = z.object({
  topic: z.string().min(1).max(2000),
  outline: z
    .array(z.object({ beat: z.string().min(1).max(800) }))
    .min(1)
    .max(8),
  beatIndex: z.number().int().min(0).max(7),
  platform: z.enum(['newsletter', 'linkedin']),
  userIntent: z.string().min(1).max(1500),
  conversationSoFar: z.string().max(8000).optional(),
});

export type DraftBeatResult =
  | {
      ok: true;
      beatIndex: number;
      prose: string;
      // Soft signal — true when no voice profile existed for the
      // platform and we used retrieval-only voice cues. UI shows a
      // small "Build voice profile to refine →" note.
      usedFallbackVoice: boolean;
    }
  | {
      ok: false;
      reason: 'invalid_input' | 'error';
      message: string;
    };

export async function draftBeat(input: unknown): Promise<DraftBeatResult> {
  let parsed: z.infer<typeof draftBeatSchema>;
  try {
    parsed = draftBeatSchema.parse(input);
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid_input',
      message: err instanceof Error ? err.message : 'invalid input',
    };
  }

  const user = await requireUser();

  // Voice profile is optional in v2's beat-drafting path. Missing
  // profile flips the soft-fallback flag; we still draft.
  const profileBundle = await getVoiceProfile(user.id);
  const platformProfile =
    parsed.platform === 'linkedin'
      ? profileBundle.linkedin
      : profileBundle.longform;
  const usedFallbackVoice = !platformProfile;

  // Per-beat retrieval — same pattern as draftSection. Beat text is
  // narrower than the topic, so the retrieval lands closer to what
  // the user said they want to say.
  const beat = parsed.outline[parsed.beatIndex]?.beat ?? parsed.topic;
  let hits: SimilarHit[] = [];
  try {
    hits = await findSimilar({
      text: `${beat}\n${parsed.userIntent}`,
      kinds: [...SIMILAR_KINDS],
      limit: 6,
    });
  } catch (err) {
    console.warn('[draftBeat] findSimilar failed', err);
    hits = [];
  }

  const retrievalItems: ProposalRetrievalItem[] = hits.map((h, i) => ({
    index: i + 1,
    bucket: bucket({ kind: h.kind, sourceKind: h.sourceKind ?? null }),
    label: labelForHit(h),
    title: h.title,
    body: bodyForHit(h),
  }));

  try {
    const result = await generateBeatDraft({
      topic: parsed.topic,
      beatIndex: parsed.beatIndex,
      outline: parsed.outline,
      platform: parsed.platform,
      voiceProfile: platformProfile,
      retrieval: retrievalItems,
      conversationSoFar: parsed.conversationSoFar,
      userIntent: parsed.userIntent,
    });
    return {
      ok: true,
      beatIndex: parsed.beatIndex,
      prose: result.prose,
      usedFallbackVoice,
    };
  } catch (err) {
    console.error('[draftBeat] generateBeatDraft failed', err);
    return {
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : 'draft failed',
    };
  }
}

// ─── commitProposal — Phase 15b · "Open the page" hand-off ─────────────
//
// Creates a draft from the spar view's current outline + topic and
// redirects to /studio/page/[id]. Slice 6 of the Phase 15b stack.
//
// Inputs:
//   - topic: the user's submitted topic; used as the H1 / title.
//   - outline: array of beat strings; each becomes an H2 section header.
//   - platform: 'newsletter' | 'linkedin' — controls draft shape and
//     the editor's mode= URL parameter (so the rail boots in the
//     right voice). Linkedin still gets section H2s in 15b — body-only
//     fast-path is the escape-hatch composeNew path, not this one.
//
// Phase 15a slice B3 (2026-05-05): commitProposal now accepts an
// optional sections map keyed by beat index — drafted prose under
// each beat's H2 header in the new draft. The Spar surface
// passes this map when the user has hit "Draft section" on one or
// more beats. Empty/missing entries fall back to an empty paragraph
// (the existing 15b behavior).

const commitProposalSchema = z.object({
  topic: z.string().min(1).max(2000),
  outline: z
    .array(z.object({ beat: z.string().min(1).max(800) }))
    .min(0)
    .max(8),
  platform: z.enum(['newsletter', 'linkedin']).default('newsletter'),
  // Phase 15a slice B3: sections keyed by beat index → prose. Optional;
  // empty / missing entries fall through to the empty-paragraph
  // placeholder (the original 15b behavior). Stringly-typed keys
  // because z.record requires string keys; we coerce to int at the
  // splice site.
  sections: z.record(z.string(), z.string().max(8000)).optional(),
  // Phase 16 slice 5 (2026-05-05): which beats the user had anchored
  // in the spar. Phase 20.5 (2026-05-06) moved the stamp from H2
  // nodes onto the new thoughtBubble node's beatStatus attr. PlanRibbon
  // reads from there. 0-based outline indices.
  anchoredBeatIndices: z.array(z.number().int().min(0).max(7)).max(8).optional(),
});

export async function commitProposal(input: unknown) {
  const user = await requireUser();
  const { topic, outline, platform, sections, anchoredBeatIndices } =
    commitProposalSchema.parse(input);

  const trimmedTopic = topic.trim().slice(0, 280);
  const beats = outline.map((b) => b.beat.trim()).filter((b) => b.length > 0);

  // Resolve drafted prose per beat. The Spar surface's beat indices
  // are 0-based and align with `outline` (server received a copy). We
  // splice prose into proseByBeat[i] only when `outline[i].beat`
  // survived the trim+filter above and the user actually drafted it.
  const proseByOriginalIndex: Record<number, string> = {};
  if (sections) {
    for (const [k, v] of Object.entries(sections)) {
      const idx = Number.parseInt(k, 10);
      if (Number.isInteger(idx) && idx >= 0 && idx < outline.length) {
        const trimmed = (v ?? '').trim();
        if (trimmed.length > 0) proseByOriginalIndex[idx] = trimmed;
      }
    }
  }
  // Build a parallel array of prose aligned to the post-filter `beats`.
  // Skip-the-empty-beat filter above means we have to rebuild the
  // mapping in lockstep — for each original outline index, only
  // include the prose if the matching beat survived.
  // Phase 16 slice 5: each surviving beat also gets a stable
  // randomUUID + status (anchored | drafted | floating). The id +
  // status stamp into the H2 node attrs so the Plan ribbon can map
  // the spar's anchored set onto the editor's doc nodes.
  const anchoredSet = new Set<number>(anchoredBeatIndices ?? []);
  const beatsWithProse: Array<{
    beat: string;
    prose?: string;
    id: string;
    status: 'anchored' | 'drafted' | 'floating';
  }> = [];
  for (let i = 0; i < outline.length; i++) {
    const beatText = outline[i].beat.trim();
    if (beatText.length === 0) continue;
    const prose = proseByOriginalIndex[i];
    const status: 'anchored' | 'drafted' | 'floating' = anchoredSet.has(i)
      ? 'anchored'
      : prose
        ? 'drafted'
        : 'floating';
    beatsWithProse.push({
      beat: beatText,
      prose,
      id: crypto.randomUUID(),
      status,
    });
  }

  // Build a Tiptap doc:
  //   newsletter → H1 = topic, H2 per beat with an empty paragraph below
  //                each so the user has a slot to start writing.
  //   linkedin   → no H1; beats become a small bulleted scaffold so the
  //                shape is "outline + body" rather than "title + sections".
  // Phase 20.5 (2026-05-06): plan beats land in the editor as
  // thoughtBubble nodes (source='plan'), not H2 headings or bullet
  // lists. Same shape across platforms; the only platform difference
  // is whether the topic gets stamped as an H1 above the plan
  // (newsletter yes, linkedin no — linkedin reads as body-only).
  const planBubbleFor = (item: typeof beatsWithProse[number]) => ({
    type: 'thoughtBubble',
    attrs: {
      source: 'plan',
      ideaId: null,
      kind: null,
      beatId: item.id,
      beatStatus: item.status,
      title: item.beat,
      preview: '',
    },
  });
  const proseParagraphs = (prose: string) =>
    prose
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((para) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: para }],
      }));

  const content: Array<Record<string, unknown>> = [];
  if (platform === 'newsletter' && trimmedTopic.length > 0) {
    content.push({
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: trimmedTopic }],
    });
  }
  for (const item of beatsWithProse) {
    content.push(planBubbleFor(item));
    if (item.prose) {
      content.push(...proseParagraphs(item.prose));
    } else {
      content.push({ type: 'paragraph' });
    }
  }
  if (beatsWithProse.length === 0) content.push({ type: 'paragraph' });
  const initialDoc: {
    type: 'doc';
    content: Array<Record<string, unknown>>;
  } = { type: 'doc', content };

  const [draft] = await db
    .insert(drafts)
    .values({
      userId: user.id,
      title: platform === 'linkedin' ? null : trimmedTopic,
      contentJson: initialDoc,
    })
    .returning();

  // Best-effort embed (mirrors composeNew). Embedding the topic + the
  // outline beats together gives the rail a richer query shape than
  // topic alone.
  try {
    const embedSource = [trimmedTopic, ...beats].join('\n');
    if (embedSource.trim().length > 0) {
      const embedding = await embedText(embedSource);
      await db
        .update(drafts)
        .set({ embedding })
        .where(and(eq(drafts.id, draft.id), eq(drafts.userId, user.id)));
    }
  } catch (err) {
    console.warn('[commitProposal] embed failed', err);
  }

  revalidatePath('/studio');
  revalidatePath('/studio/page');
  redirect(`/studio/page/${draft.id}?mode=${platform}`);
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

// ─── originalityCheck — Phase 21 slice 10 ──────────────────────────
//
// Runs findSimilar against the user's PUBLISHED archive
// (newsletter_issue + linkedin_post) with a high-similarity threshold
// and returns matches the chat companion renders as a tool result.
// Lets the user check whether the post they're drafting is going to
// duplicate something they've already published.
//
// Threshold: 0.65 cosine similarity. Tuned conservatively — anything
// higher and we miss real overlaps where the writer rephrased the
// same idea; anything lower and we surface noise. The chat surface
// shows a friendly null-result when nothing crosses the threshold.

const ORIGINALITY_THRESHOLD = 0.65;
const ORIGINALITY_LIMIT = 6;
const ORIGINALITY_MIN_CHARS = 40;

const originalityCheckSchema = z.object({
  text: z.string().min(1).max(8000),
});

export type OriginalityCheckResult =
  | {
      ok: true;
      matches: SimilarHit[];
      basedOnChars: number;
      threshold: number;
    }
  | {
      ok: false;
      reason: 'too_short' | 'error';
      message: string;
    };

export async function originalityCheck(
  input: unknown
): Promise<OriginalityCheckResult> {
  await requireUser();
  const data = originalityCheckSchema.parse(input);
  const text = data.text.trim();
  if (text.length < ORIGINALITY_MIN_CHARS) {
    return {
      ok: false,
      reason: 'too_short',
      message: `Need at least ${ORIGINALITY_MIN_CHARS} characters to run a meaningful check.`,
    };
  }

  try {
    const hits = await findSimilar({
      text,
      kinds: ['newsletter_issue', 'linkedin_post'],
      limit: ORIGINALITY_LIMIT,
    });
    const matches = hits
      .filter((h) => h.similarity >= ORIGINALITY_THRESHOLD)
      .slice(0, ORIGINALITY_LIMIT);
    return {
      ok: true,
      matches,
      basedOnChars: text.length,
      threshold: ORIGINALITY_THRESHOLD,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'originality check failed';
    return { ok: false, reason: 'error', message };
  }
}

// ─── proposeHooks / proposeClosers — Phase 22 slice 6 ──────────────
//
// Server action wrappers around generateHookCloserOptions in llm.ts.
// Loads the platform skill, calls the LLM, returns either the
// labeled options or a soft-error result for the chat to render.

const proposeHookCloserSchema = z.object({
  draftText: z.string().min(0).max(8000),
  platform: z.enum(['linkedin', 'newsletter', 'blog', 'note']),
});

export type ProposeHookCloserResult =
  | {
      ok: true;
      kind: 'hook' | 'closer';
      options: { label: string; body: string }[];
    }
  | {
      ok: false;
      reason: 'error';
      message: string;
    };

async function runHookCloser(
  kind: 'hook' | 'closer',
  input: unknown
): Promise<ProposeHookCloserResult> {
  await requireUser();
  const data = proposeHookCloserSchema.parse(input);
  try {
    const { generateHookCloserOptions } = await import('@/lib/llm');
    const { getPlatformSkill } = await import('@/lib/platform-skills');
    const platformSkill = getPlatformSkill(data.platform);
    const platformLabel =
      data.platform === 'linkedin'
        ? 'LinkedIn'
        : data.platform === 'newsletter'
          ? 'Newsletter'
          : data.platform === 'blog'
            ? 'Blog'
            : 'Note';
    const options = await generateHookCloserOptions({
      kind,
      draftText: data.draftText,
      platformSkill,
      platformLabel,
    });
    return { ok: true, kind, options };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'generation failed';
    return { ok: false, reason: 'error', message };
  }
}

export async function proposeHooks(
  input: unknown
): Promise<ProposeHookCloserResult> {
  return runHookCloser('hook', input);
}

export async function proposeClosers(
  input: unknown
): Promise<ProposeHookCloserResult> {
  return runHookCloser('closer', input);
}

// ─── getSourceDetail — Phase 23 v2 slice 5.2 ─────────────────────────
//
// Expand a 'From your space' pill into a modal. Each kind hits a
// different table for its title + excerpt. Read-only; lazy — only
// called when the user actually clicks a pill.

const getSourceDetailSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(SIMILAR_KINDS_FOR_ZOD),
});

export type GetSourceDetailResult =
  | {
      ok: true;
      kind: SimilarKind;
      title: string;
      // One-line essence — drawn from the source's summary field
      // when available (Garden ideas have an essence column;
      // newsletter issues have a subtitle). Optional.
      summary?: string | null;
      // Body paragraph(s) for the modal. May contain multiple
      // sentences/paragraphs separated by \n\n.
      excerpt: string;
      // Categorical metadata for ideas — surfaced as chips at the
      // foot of the modal so the user sees what bucket this lives
      // in. Empty array for kinds without these fields.
      themes?: string[];
      tags?: string[];
      url: string | null;
      isExternal: boolean;
    }
  | {
      ok: false;
      reason: 'invalid_input' | 'not_found' | 'error';
      message: string;
    };

const SOURCE_EXCERPT_MAX = 600; // roughly 120 words

function truncateForExcerpt(
  s: string | null | undefined,
  n: number = SOURCE_EXCERPT_MAX
): string {
  if (!s) return '';
  const trimmed = s.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= n) return trimmed;
  return trimmed.slice(0, n).trimEnd() + '…';
}

export async function getSourceDetail(
  input: unknown
): Promise<GetSourceDetailResult> {
  let parsed: z.infer<typeof getSourceDetailSchema>;
  try {
    parsed = getSourceDetailSchema.parse(input);
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid_input',
      message: err instanceof Error ? err.message : 'invalid input',
    };
  }

  const user = await requireUser();
  const { id, kind } = parsed;

  try {
    if (kind === 'extracted_idea') {
      const [row] = await db
        .select({
          title: extractedIdeas.title,
          claim: extractedIdeas.claim,
          evidence: extractedIdeas.evidence,
        })
        .from(extractedIdeas)
        .where(
          and(
            eq(extractedIdeas.id, id),
            eq(extractedIdeas.userId, user.id)
          )
        )
        .limit(1);
      if (!row) {
        return { ok: false, reason: 'not_found', message: 'Source not found.' };
      }
      const excerpt = truncateForExcerpt(
        [row.claim, row.evidence].filter(Boolean).join('\n\n')
      );
      return {
        ok: true,
        kind,
        title: row.title,
        excerpt,
        url: '/studio/insights',
        isExternal: false,
      };
    }
    if (kind === 'idea') {
      const [row] = await db
        .select({
          title: ideas.title,
          essence: ideas.essence,
          body: ideas.body,
          themes: ideas.themes,
          tags: ideas.tags,
        })
        .from(ideas)
        .where(and(eq(ideas.id, id), eq(ideas.userId, user.id)))
        .limit(1);
      if (!row) {
        return { ok: false, reason: 'not_found', message: 'Source not found.' };
      }
      const excerpt = truncateForExcerpt(row.body ?? row.essence ?? '');
      return {
        ok: true,
        kind,
        title: row.title,
        summary: row.essence,
        excerpt,
        themes: row.themes ?? [],
        tags: row.tags ?? [],
        url: `/studio/ideas/${id}`,
        isExternal: false,
      };
    }
    if (kind === 'newsletter_issue') {
      const [row] = await db
        .select({
          title: newsletterIssues.title,
          subtitle: newsletterIssues.subtitle,
          bodyText: newsletterIssues.bodyText,
          webUrl: newsletterIssues.webUrl,
        })
        .from(newsletterIssues)
        .where(
          and(
            eq(newsletterIssues.id, id),
            eq(newsletterIssues.userId, user.id)
          )
        )
        .limit(1);
      if (!row) {
        return { ok: false, reason: 'not_found', message: 'Source not found.' };
      }
      const excerpt = truncateForExcerpt(row.bodyText ?? row.subtitle ?? '');
      return {
        ok: true,
        kind,
        title: row.title,
        summary: row.subtitle,
        excerpt,
        url: row.webUrl ?? '/studio/insights?tab=beehiiv',
        isExternal: row.webUrl !== null,
      };
    }
    if (kind === 'linkedin_post') {
      const [row] = await db
        .select({
          content: linkedinPosts.content,
          bodyClean: linkedinPosts.bodyClean,
          linkedinUrl: linkedinPosts.linkedinUrl,
        })
        .from(linkedinPosts)
        .where(
          and(eq(linkedinPosts.id, id), eq(linkedinPosts.userId, user.id))
        )
        .limit(1);
      if (!row) {
        return { ok: false, reason: 'not_found', message: 'Source not found.' };
      }
      const fullBody = row.bodyClean ?? row.content ?? '';
      const excerpt = truncateForExcerpt(fullBody);
      const title =
        fullBody.split('\n').find((l) => l.trim().length > 0)?.slice(0, 80) ??
        'LinkedIn post';
      return {
        ok: true,
        kind,
        title,
        excerpt,
        url: row.linkedinUrl,
        isExternal: true,
      };
    }
    if (kind === 'obsidian_note') {
      const [row] = await db
        .select({
          title: obsidianNotes.title,
          bodyText: obsidianNotes.bodyText,
        })
        .from(obsidianNotes)
        .where(
          and(
            eq(obsidianNotes.id, id),
            eq(obsidianNotes.userId, user.id)
          )
        )
        .limit(1);
      if (!row) {
        return { ok: false, reason: 'not_found', message: 'Source not found.' };
      }
      const excerpt = truncateForExcerpt(row.bodyText ?? '');
      return {
        ok: true,
        kind,
        title: row.title,
        excerpt,
        url: '/studio/insights?tab=obsidian',
        isExternal: false,
      };
    }
    if (kind === 'gmail_message') {
      const [row] = await db
        .select({
          subject: gmailMessages.subject,
          snippet: gmailMessages.snippet,
          bodyClean: gmailMessages.bodyClean,
        })
        .from(gmailMessages)
        .where(
          and(
            eq(gmailMessages.id, id),
            eq(gmailMessages.userId, user.id)
          )
        )
        .limit(1);
      if (!row) {
        return { ok: false, reason: 'not_found', message: 'Source not found.' };
      }
      const excerpt = truncateForExcerpt(row.bodyClean ?? row.snippet ?? '');
      return {
        ok: true,
        kind,
        title: row.subject ?? 'Untitled message',
        excerpt,
        url: '/studio/insights?tab=gmail',
        isExternal: false,
      };
    }
    if (kind === 'draft') {
      const [row] = await db
        .select({ title: drafts.title })
        .from(drafts)
        .where(and(eq(drafts.id, id), eq(drafts.userId, user.id)))
        .limit(1);
      if (!row) {
        return { ok: false, reason: 'not_found', message: 'Source not found.' };
      }
      return {
        ok: true,
        kind,
        title: row.title ?? 'Untitled draft',
        excerpt: 'Open the draft to see the full text.',
        url: `/studio/page/${id}`,
        isExternal: false,
      };
    }
    if (kind === 'capture') {
      const [row] = await db
        .select({
          body: captures.body,
          summary: captures.summary,
        })
        .from(captures)
        .where(and(eq(captures.id, id), eq(captures.userId, user.id)))
        .limit(1);
      if (!row) {
        return { ok: false, reason: 'not_found', message: 'Source not found.' };
      }
      const excerpt = truncateForExcerpt(row.body ?? '');
      return {
        ok: true,
        kind,
        title: row.summary ?? 'Captured note',
        excerpt,
        url: '/studio/inbox',
        isExternal: false,
      };
    }
    return {
      ok: false,
      reason: 'not_found',
      message: `Unknown source kind: ${kind}`,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : 'unknown',
    };
  }
}

// ─── runRefinement — Phase 23 v2 slice 6 ─────────────────────────────
//
// Refinement-specific server action. Same return shape as
// proposeFromTopic so the client UI does not change — the LLM just
// produces refinement-shaped angles instead of generic angles.
//
// For 'add_depth' specifically, also fires Exa neural search for
// external research (graceful fallback when EXA_API_KEY is not set).

import {
  generateRefinement as llmGenerateRefinement,
  type RefinementKind,
} from '@/lib/llm';
import { exaSearch, isExaConfigured } from '@/lib/exa';

const runRefinementSchema = z.object({
  refinement: z.enum([
    'sharpen_hook',
    'add_takeaway',
    'refine_stakes',
    'add_depth',
  ]),
  topic: z.string().min(1).max(2000),
  conversationSoFar: z.string().max(8000).optional(),
  platformHint: z.enum(['newsletter', 'linkedin', 'blog', 'note']).optional(),
});

export type RunRefinementResult = ProposeFromTopicResult;

export async function runRefinement(
  input: unknown
): Promise<RunRefinementResult> {
  let parsed: z.infer<typeof runRefinementSchema>;
  try {
    parsed = runRefinementSchema.parse(input);
  } catch {
    return {
      ok: false,
      reason: 'too_short',
      message: 'Need a topic for refinement.',
    };
  }

  const user = await requireUser();

  // Shared retrieval — same shape as proposeFromTopic so the LLM sees
  // the same voice + knowledge buckets it already knows how to read.
  let hits: SimilarHit[] = [];
  try {
    hits = await findSimilar({
      text: parsed.topic,
      kinds: [...SIMILAR_KINDS],
      limit: 12,
    });
  } catch (err) {
    console.warn('[runRefinement] findSimilar failed', err);
    hits = [];
  }

  const retrievalItems: ProposalRetrievalItem[] = hits.map((h, i) => ({
    index: i + 1,
    bucket: bucket({ kind: h.kind, sourceKind: h.sourceKind ?? null }),
    label: labelForHit(h),
    title: h.title,
    body: bodyForHit(h),
  }));

  // For 'add_depth' specifically: extend retrieval with Exa neural
  // search results (when configured). External hits get a synthetic
  // 'knowledge' bucket since they read like things-the-user-reads,
  // not voice samples.
  if (parsed.refinement === 'add_depth' && isExaConfigured()) {
    try {
      const externalHits = await exaSearch(parsed.topic, 5);
      let nextIndex = retrievalItems.length + 1;
      for (const r of externalHits) {
        retrievalItems.push({
          index: nextIndex,
          bucket: 'knowledge',
          label: 'external',
          title: r.title,
          body: r.content,
        });
        nextIndex += 1;
      }
    } catch (err) {
      console.warn('[runRefinement] exa failed', err);
    }
  }

  let voiceProfile: Awaited<ReturnType<typeof getVoiceProfile>> = {};
  try {
    voiceProfile = await getVoiceProfile(user.id);
  } catch (err) {
    console.warn('[runRefinement] getVoiceProfile failed', err);
    voiceProfile = {};
  }

  try {
    const result = await llmGenerateRefinement({
      refinement: parsed.refinement as RefinementKind,
      topic: parsed.topic,
      conversationSoFar: parsed.conversationSoFar,
      platformHint: parsed.platformHint,
      voiceProfile,
      retrieval: retrievalItems,
    });

    // Map the LLM's sourceCitations back to source rows so the client
    // pills can show titles + ids. Mirror proposeFromTopic's pattern.
    const angles: ProposeAngle[] = result.angles.map((a) => {
      const sources = (a.sourceCitations ?? [])
        .map((idx) => {
          const item = retrievalItems[idx - 1];
          const hit = hits[idx - 1];
          if (!item) return null;
          // External (Exa) hits don't have a SimilarHit backing.
          // Surface them as a synthetic source with a stable id derived
          // from the index so the client renders a chip.
          if (!hit && item.label === 'external') {
            return {
              index: idx,
              kind: 'gmail_message' as SimilarKind,
              bucket: item.bucket,
              label: 'external',
              title: item.title,
              id: `external:${idx}`,
            };
          }
          if (!hit) return null;
          return {
            index: idx,
            kind: hit.kind,
            bucket: item.bucket,
            label: item.label,
            title: hit.title,
            id: hit.id,
          };
        })
        .filter((s): s is NonNullable<typeof s> => s !== null);
      return { line: a.line, sources };
    });

    return {
      ok: true,
      topic: parsed.topic,
      platformGuess: result.platformGuess,
      visibleThinking: {
        lines: [],
        summary: result.retrievalSummary,
        kindCounts: {
          ideas: hits.filter((h) => h.kind === 'extracted_idea').length,
          cslIssues: hits.filter((h) => h.kind === 'newsletter_issue').length,
          linkedin: hits.filter((h) => h.kind === 'linkedin_post').length,
          vault: hits.filter((h) => h.kind === 'obsidian_note').length,
          gmail: hits.filter((h) => h.kind === 'gmail_message').length,
        },
      },
      angles,
      hook: result.hook,
      outline: result.outline,
      followUpQuestion: result.followUpQuestion,
      retrievalCount: retrievalItems.length,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : 'unknown',
    };
  }
}

// ─── chat_sessions — Phase 23 v2 slice 7 ─────────────────────────────
//
// Persist a Writing × With-assistant coaching thread so the user can
// step away (open a source in a new tab, get pulled into a meeting)
// and return without losing the conversation. The sidebar surfaces
// recent sessions; /studio?chat=<id> rehydrates a session.

import { chatSessions } from '@/db';

const createChatSessionSchema = z.object({
  topic: z.string().min(1).max(2000),
  title: z.string().min(1).max(120),
  platformGuess: z.enum(['newsletter', 'linkedin', 'unknown']).default('unknown'),
  // CoachTurn[] — opaque from the server's perspective. The shape is
  // owned by the client. We just persist the JSON and hand it back
  // on resume.
  turns: z.array(z.unknown()),
  stage: z.enum(['thread', 'coaching', 'finalized']).default('coaching'),
});

export type CreateChatSessionResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'invalid_input' | 'error'; message: string };

export async function createChatSession(
  input: unknown
): Promise<CreateChatSessionResult> {
  let parsed: z.infer<typeof createChatSessionSchema>;
  try {
    parsed = createChatSessionSchema.parse(input);
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid_input',
      message: err instanceof Error ? err.message : 'invalid input',
    };
  }

  const user = await requireUser();

  try {
    const [row] = await db
      .insert(chatSessions)
      .values({
        userId: user.id,
        title: parsed.title.slice(0, 120),
        topic: parsed.topic.slice(0, 2000),
        platformGuess: parsed.platformGuess,
        turns: parsed.turns,
        stage: parsed.stage,
      })
      .returning({ id: chatSessions.id });
    return { ok: true, id: row.id };
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : 'unknown',
    };
  }
}

const updateChatSessionSchema = z.object({
  id: z.string().uuid(),
  turns: z.array(z.unknown()),
  stage: z.enum(['thread', 'coaching', 'finalized']).optional(),
});

export async function updateChatSession(
  input: unknown
): Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
  let parsed: z.infer<typeof updateChatSessionSchema>;
  try {
    parsed = updateChatSessionSchema.parse(input);
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid_input',
      message: err instanceof Error ? err.message : 'invalid input',
    };
  }

  const user = await requireUser();

  try {
    await db
      .update(chatSessions)
      .set({
        turns: parsed.turns,
        ...(parsed.stage ? { stage: parsed.stage } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chatSessions.id, parsed.id),
          eq(chatSessions.userId, user.id)
        )
      );
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : 'unknown',
    };
  }
}

export type ChatSessionDetail = {
  id: string;
  title: string;
  topic: string;
  platformGuess: 'newsletter' | 'linkedin' | 'unknown';
  turns: unknown[];
  stage: 'thread' | 'coaching' | 'finalized';
};

export async function getChatSession(
  id: unknown
): Promise<ChatSessionDetail | null> {
  if (typeof id !== 'string') return null;
  const user = await requireUser();
  try {
    const [row] = await db
      .select({
        id: chatSessions.id,
        title: chatSessions.title,
        topic: chatSessions.topic,
        platformGuess: chatSessions.platformGuess,
        turns: chatSessions.turns,
        stage: chatSessions.stage,
      })
      .from(chatSessions)
      .where(
        and(eq(chatSessions.id, id), eq(chatSessions.userId, user.id))
      )
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      topic: row.topic,
      platformGuess: row.platformGuess as ChatSessionDetail['platformGuess'],
      turns: Array.isArray(row.turns) ? row.turns : [],
      stage: row.stage as ChatSessionDetail['stage'],
    };
  } catch (err) {
    console.warn('[getChatSession] failed', err);
    return null;
  }
}

export type ChatSessionListItem = {
  id: string;
  title: string;
  updatedAt: string;
};

export async function listRecentChatSessions(
  limit: number = 12
): Promise<ChatSessionListItem[]> {
  const user = await requireUser();
  try {
    const rows = await db
      .select({
        id: chatSessions.id,
        title: chatSessions.title,
        updatedAt: chatSessions.updatedAt,
      })
      .from(chatSessions)
      .where(eq(chatSessions.userId, user.id))
      .orderBy(desc(chatSessions.updatedAt))
      .limit(Math.max(1, Math.min(limit, 40)));
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      updatedAt: r.updatedAt.toISOString(),
    }));
  } catch (err) {
    console.warn('[listRecentChatSessions] failed', err);
    return [];
  }
}

