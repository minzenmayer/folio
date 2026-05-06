// Thoughtbed · Phase 17 onboarding mass-claim — server actions
//
// 2026-05-05. The one-time pass that promotes every legacy
// extracted_idea (newsletter_issue / obsidian_note / linkedin_post)
// to a partner ideas row. Runs once per user, gated by
// users.phase17_seeded_at.
//
// Vercel Hobby caps server actions at 10s. The pass works in chunks of
// 25 (mirrors the Phase 13 kickFirstGmailSync pattern). The Garden
// page kicks the first chunk on load if seeding hasn't completed; the
// banner kicks subsequent chunks via polling until phase17_seeded_at
// is set.

'use server';

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, ideas, extractedIdeas, users } from '@/db';
import { requireUser } from '@/lib/auth';
import { autoClaimExtractedRow } from '@/lib/garden/auto-claim';
import { revalidatePath } from 'next/cache';

const CHUNK_SIZE = 25;

export type SeedStatus = {
  // Total user-authored extracted_ideas eligible for auto-claim.
  totalEligible: number;
  // How many have already been auto-claimed (partner ideas row exists).
  alreadyClaimed: number;
  // Whether the per-user gate is set (i.e. seeding is officially done).
  seeded: boolean;
};

export async function getSeedStatus(): Promise<SeedStatus> {
  const user = await requireUser();
  // Phase 18 hotfix (2026-05-05): drop the users.phase17_seeded_at
  // gate. The earlier fallback returned seeded=true when the column
  // was missing — that suppressed the banner forever for users who
  // hadn't applied migration 0015. The onboarding pass is idempotent
  // (runSeedChunk's NOT EXISTS clause skips already-claimed rows),
  // so we can safely use the derived gate: seeded = the user has
  // no eligible-but-unclaimed rows left.
  //
  // The column write at the end of runSeedChunk still happens when
  // the migration IS applied (informational), but it's no longer
  // load-bearing.
  void user;

  // Phase 18 diagnostic fix (2026-05-05): totalEligible must mirror
  // the chunk's NOT EXISTS pattern. The prior count over ALL
  // user-authored extracted_ideas was misleading — many were
  // already claimed manually (Phase 14b) and have partner ideas
  // rows. Banner saw work-to-do that didn't actually exist, fired
  // a chunk that returned 0 hasMore, and exited.
  let eligibleRows: Array<{ count: number }> = [];
  let claimedRows: Array<{ count: number }> = [];
  try {
    eligibleRows = (await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int as count
        FROM extracted_ideas e
       WHERE e.user_id = ${user.id}
         AND e.source_kind IN ('newsletter_issue', 'obsidian_note', 'linkedin_post')
         AND NOT EXISTS (
           SELECT 1 FROM ideas i
            WHERE i.user_id = e.user_id
              AND i.source_extracted_idea_id = e.id
         )
    `)) as unknown as Array<{ count: number }>;
    claimedRows = (await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int as count
        FROM ideas
       WHERE user_id = ${user.id}
         AND claim_kind = 'auto_claimed'
    `)) as unknown as Array<{ count: number }>;
  } catch (err) {
    console.warn('[getSeedStatus] count queries failed', err);
  }

  const totalEligible = Number(eligibleRows[0]?.count ?? 0);
  const alreadyClaimed = Number(claimedRows[0]?.count ?? 0);

  // Derived gate: seeded means 'no eligible-but-unclaimed rows
  // remaining.' Now that totalEligible mirrors the NOT EXISTS, this
  // is simply totalEligible === 0. (alreadyClaimed is informational
  // — auto_claimed counts can be 0 even when seeded if all the
  // user's ideas were claimed manually before Phase 17.)
  const seeded = totalEligible === 0;

  return {
    totalEligible,
    alreadyClaimed,
    seeded,
  };
}

export type SeedChunkResult = {
  // Number of new ideas rows created in THIS chunk.
  claimed: number;
  // Total claimed so far for the user.
  totalClaimed: number;
  // Whether more work remains (i.e. another chunk should fire).
  hasMore: boolean;
};

export async function runSeedChunk(): Promise<SeedChunkResult> {
  const user = await requireUser();

  // Phase 18 hotfix (2026-05-05): isolate the optional column write
  // at the end of the chunk so it can't trash the chunk's actual
  // result. The core work (SELECT + autoClaim loop + COUNT) reports
  // accurately even when migration 0015 isn't applied.

  // Phase 18 hotfix (2026-05-05): use Drizzle's typed query builder
  // instead of raw SQL. Raw db.execute returns vector columns as
  // strings — passing those into db.insert(ideas).values() then
  // tries to serialize the string as a vector and throws 'b is not
  // iterable' from Drizzle's minified runtime. Typed queries parse
  // vectors to number[] automatically.
  let list: Array<{
    id: string;
    title: string;
    claim: string;
    evidence: string | null;
    depthSignal: number;
    sourceKind: string;
    embedding: number[] | null;
  }> = [];
  try {
    list = await db
      .select({
        id: extractedIdeas.id,
        title: extractedIdeas.title,
        claim: extractedIdeas.claim,
        evidence: extractedIdeas.evidence,
        depthSignal: extractedIdeas.depthSignal,
        sourceKind: extractedIdeas.sourceKind,
        embedding: extractedIdeas.embedding,
      })
      .from(extractedIdeas)
      .where(
        and(
          eq(extractedIdeas.userId, user.id),
          inArray(extractedIdeas.sourceKind, [
            'newsletter_issue',
            'obsidian_note',
            'linkedin_post',
          ]),
          sql`NOT EXISTS (
            SELECT 1 FROM ${ideas}
             WHERE ${ideas.userId} = ${extractedIdeas.userId}
               AND ${ideas.sourceExtractedIdeaId} = ${extractedIdeas.id}
          )`
        )
      )
      .orderBy(extractedIdeas.createdAt)
      .limit(CHUNK_SIZE);
  } catch (err) {
    console.warn('[runSeedChunk] eligibility query failed', err);
    return { claimed: 0, totalClaimed: 0, hasMore: false };
  }

  let claimed = 0;
  for (const row of list) {
    try {
      const id = await autoClaimExtractedRow({
        userId: user.id,
        extractedId: row.id,
        sourceKind: row.sourceKind,
        title: row.title,
        claim: row.claim,
        evidence: row.evidence,
        depthSignal: row.depthSignal,
        themes: [],
        // Phase 18 hotfix (2026-05-05): pass the embedding through.
        // The typed query above parses vectors as number[]
        // correctly, so Drizzle's insert serializer no longer
        // chokes. loadIdeas in the maturation pass needs the
        // embedding for cosine signals (2, 4) to fire.
        embedding: row.embedding,
      });
      if (id) claimed += 1;
    } catch (err) {
      console.warn('[seedPhase17] auto-claim failed', row.id, err);
    }
  }

  // hasMore reflects whether the SELECT was at the chunk size limit.
  // If yes, more rows likely remain. If less than chunk size, the
  // user has no more pending work — banner exits.
  const hasMore = list.length === CHUNK_SIZE;

  // Optional informational column write — fails silently when
  // migration 0015 isn't applied. Doesn't affect chunk semantics.
  if (!hasMore) {
    try {
      await db
        .update(users)
        .set({ phase17SeededAt: sql`now()` })
        .where(eq(users.id, user.id));
    } catch (err) {
      console.warn('[runSeedChunk] phase17_seeded_at write skipped', err);
    }
  }

  // Total auto-claims after this chunk. Wrapped because the schema
  // requires nothing new — but defensive belt-and-braces.
  let totalClaimed = 0;
  try {
    const totalRows = (await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int as count
        FROM ideas
       WHERE user_id = ${user.id}
         AND claim_kind = 'auto_claimed'
    `)) as unknown as Array<{ count: number }>;
    totalClaimed = Number(totalRows[0]?.count ?? 0);
  } catch (err) {
    console.warn('[runSeedChunk] total-count query failed', err);
  }

  if (claimed > 0) revalidatePath('/studio/garden');

  return { claimed, totalClaimed, hasMore };
}

// ─── Demote affordance — reverses an auto-claim ────────────
//
// Soft-archive: deletes the partner ideas row and resets the source
// extracted_idea back to 'pending'. Soft-archive (vs. true delete)
// would require an archived_at column; v1 hard-deletes the partner
// row — the source extracted_idea is the durable record, the partner
// is regenerable. If we later want undo, add archived_at and swap.

export async function demoteAutoClaim(input: {
  ideaId: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const user = await requireUser();

  // Look up the partner ideas row + its source.
  const [row] = await db
    .select({
      id: ideas.id,
      claimKind: ideas.claimKind,
      sourceExtractedIdeaId: ideas.sourceExtractedIdeaId,
    })
    .from(ideas)
    .where(and(eq(ideas.userId, user.id), eq(ideas.id, input.ideaId)))
    .limit(1);

  if (!row) return { ok: false, reason: 'not_found' };
  if (row.claimKind !== 'auto_claimed') {
    return { ok: false, reason: 'not_auto_claimed' };
  }

  // Reset the source extracted_idea so it lands back in the unclaimed
  // surface. Then delete the partner ideas row.
  if (row.sourceExtractedIdeaId) {
    await db
      .update(extractedIdeas)
      .set({ triageStatus: 'pending', triagedAt: null })
      .where(
        and(
          eq(extractedIdeas.userId, user.id),
          eq(extractedIdeas.id, row.sourceExtractedIdeaId)
        )
      );
  }

  await db
    .delete(ideas)
    .where(and(eq(ideas.userId, user.id), eq(ideas.id, input.ideaId)));

  revalidatePath('/studio/garden');
  return { ok: true };
}
