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

  let eligibleRows: Array<{ count: number }> = [];
  let claimedRows: Array<{ count: number }> = [];
  try {
    eligibleRows = (await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int as count
        FROM extracted_ideas
       WHERE user_id = ${user.id}
         AND source_kind IN ('newsletter_issue', 'obsidian_note', 'linkedin_post')
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

  // Derived gate: seeded when the user has no eligible-but-unclaimed
  // rows left. Holds even when the column-write side of runSeedChunk
  // fails (migration not applied), because the actual claim work is
  // gated on the NOT EXISTS query against the ideas table.
  const seeded = totalEligible > 0 && alreadyClaimed >= totalEligible;

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

  // Phase 17 hotfix (2026-05-05): if migration 0015 is unapplied, the
  // users.phase17_seeded_at write at the bottom of this function will
  // throw. Catch around the whole body so the banner doesn't loop on
  // a 500 — return a 'no more work' result and the banner exits.
  try {

  // Find extracted rows that are auto-claim eligible AND don't yet
  // have a partner ideas row. LEFT JOIN to detect missing partner.
  const rows = (await db.execute<{
    id: string;
    title: string;
    claim: string;
    evidence: string | null;
    depth_signal: number;
    source_kind: string;
    embedding: number[] | null;
  }>(sql`
    SELECT e.id, e.title, e.claim, e.evidence, e.depth_signal, e.source_kind, e.embedding
      FROM extracted_ideas e
     WHERE e.user_id = ${user.id}
       AND e.source_kind IN ('newsletter_issue', 'obsidian_note', 'linkedin_post')
       AND NOT EXISTS (
         SELECT 1 FROM ideas i
          WHERE i.user_id = e.user_id
            AND i.source_extracted_idea_id = e.id
       )
     ORDER BY e.created_at ASC
     LIMIT ${CHUNK_SIZE}
  `)) as unknown as Array<{
    id: string;
    title: string;
    claim: string;
    evidence: string | null;
    depth_signal: number;
    source_kind: string;
    embedding: number[] | null;
  }>;

  const list = rows;

  let claimed = 0;
  for (const row of list) {
    try {
      const id = await autoClaimExtractedRow({
        userId: user.id,
        extractedId: row.id,
        sourceKind: row.source_kind,
        title: row.title,
        claim: row.claim,
        evidence: row.evidence,
        depthSignal: row.depth_signal,
        themes: [],
        embedding: row.embedding,
      });
      if (id) claimed += 1;
    } catch (err) {
      console.warn('[seedPhase17] auto-claim failed', row.id, err);
    }
  }

  // After the chunk: if no rows came back, this user has no more
  // pending work. Set the gate.
  const hasMore = list.length === CHUNK_SIZE;
  if (!hasMore) {
    await db
      .update(users)
      .set({ phase17SeededAt: sql`now()` })
      .where(eq(users.id, user.id));
  }

  // Count total auto-claims (mirrors getSeedStatus).
  const totalRows = (await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int as count
      FROM ideas
     WHERE user_id = ${user.id}
       AND claim_kind = 'auto_claimed'
  `)) as unknown as Array<{ count: number }>;
  const totalClaimed = Number(totalRows[0]?.count ?? 0);

  if (claimed > 0) revalidatePath('/studio/garden');

  return { claimed, totalClaimed, hasMore };
  } catch (err) {
    console.warn('[runSeedChunk] failed (migration?)', err);
    return { claimed: 0, totalClaimed: 0, hasMore: false };
  }
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
