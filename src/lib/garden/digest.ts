// Phase 14b — Garden redesign · daily digest selection
//
// Picks the 5 ideas (4 + 1 reserved juxtaposition slot) that surface in
// today's digest. Sorted by ripeness; the score's digest_freshness term
// already penalizes recently-shown ideas so calcification is bounded.

import { eq, and, sql } from 'drizzle-orm';
import { db, ideas, extractedIdeas, gardenDigestRuns } from '@/db';
import type { GardenItem } from './types';
import { listGardenItems } from './read';

const DIGEST_SIZE = 5;

export interface DigestPick {
  kind: 'idea' | 'extracted_idea';
  id: string;
  reason: string;
}

// ── computeDigest — pure function over current data ────────────────────
export async function computeDigest(userId: string): Promise<DigestPick[]> {
  // Spec section 4: only claimed ideas in the daily digest.
  const items = await listGardenItems(userId, {
    claimedOnly: true,
    sort: 'ripeness',
    temperatures: ['hot', 'warm', 'cool'], // exclude cold + set_aside
  });

  return items.slice(0, DIGEST_SIZE).map((item) => ({
    kind: item.kind,
    id: item.id,
    reason: digestReason(item),
  }));
}

function digestReason(item: GardenItem): string {
  if (item.temperature === 'hot' && item.maturity === 'ready') {
    return 'Ripe to write.';
  }
  if (item.temperature === 'hot') {
    return 'Hot — worth your attention today.';
  }
  if (item.maturity === 'ready') {
    return 'Ready to write — temperature is just where you left it.';
  }
  if (item.digestSurfaceCount > 0) {
    return 'Returning. Worth a second look.';
  }
  return 'In rotation.';
}

// ── auto-cool sweep ─────────────────────────────────────────────────────
//
// Runs as part of the daily cron (right before the digest is computed).
// Three rules from spec section 3:
//   · 30+ days without visit → cool one step (when not pinned)
//   · digest_surface_count >= 3 → cool one step + reset count
//
// The pinned_until check skips ideas the user explicitly marked hot.

export async function applyAutoCooling(userId: string): Promise<{
  cooledByVisit: number;
  cooledByDigest: number;
}> {
  // Rule: digest_surface_count >= 3 → cool one step + reset count
  // (do this first; later we re-bump count for newly-surfaced ones).
  const digestCooled = await db
    .update(ideas)
    .set({
      temperature: sql`CASE
        WHEN ${ideas.temperature} = 'hot' THEN 'warm'
        WHEN ${ideas.temperature} = 'warm' THEN 'cool'
        WHEN ${ideas.temperature} = 'cool' THEN 'cold'
        ELSE ${ideas.temperature}
      END`,
      temperatureUpdatedAt: sql`now()`,
      digestSurfaceCount: 0,
      digestSurfaceFirstAt: null,
    })
    .where(
      and(
        eq(ideas.userId, userId),
        sql`${ideas.digestSurfaceCount} >= 3`,
        sql`${ideas.temperature} IN ('hot', 'warm', 'cool')`,
        sql`(${ideas.pinnedUntil} IS NULL OR ${ideas.pinnedUntil} < now())`
      )
    )
    .returning({ id: ideas.id });

  // Rule: 30+ days without visit → cool one step.
  const visitCooled = await db
    .update(ideas)
    .set({
      temperature: sql`CASE
        WHEN ${ideas.temperature} = 'hot' THEN 'warm'
        WHEN ${ideas.temperature} = 'warm' THEN 'cool'
        WHEN ${ideas.temperature} = 'cool' THEN 'cold'
        ELSE ${ideas.temperature}
      END`,
      temperatureUpdatedAt: sql`now()`,
    })
    .where(
      and(
        eq(ideas.userId, userId),
        sql`${ideas.temperature} IN ('hot', 'warm', 'cool')`,
        sql`(${ideas.lastVisitedAt} IS NULL OR ${ideas.lastVisitedAt} < now() - interval '30 days')`,
        sql`(${ideas.temperatureUpdatedAt} < now() - interval '7 days')`,
        sql`(${ideas.pinnedUntil} IS NULL OR ${ideas.pinnedUntil} < now())`
      )
    )
    .returning({ id: ideas.id });

  return {
    cooledByVisit: visitCooled.length,
    cooledByDigest: digestCooled.length,
  };
}

// ── markSurfaced — bump the digest counter on picked ideas ──────────────
export async function markSurfaced(
  userId: string,
  picks: DigestPick[]
): Promise<void> {
  const ideaIds = picks.filter((p) => p.kind === 'idea').map((p) => p.id);
  const extIds = picks.filter((p) => p.kind === 'extracted_idea').map((p) => p.id);

  if (ideaIds.length > 0) {
    await db
      .update(ideas)
      .set({
        digestSurfaceCount: sql`${ideas.digestSurfaceCount} + 1`,
        digestSurfaceFirstAt: sql`COALESCE(${ideas.digestSurfaceFirstAt}, now())`,
      })
      .where(and(eq(ideas.userId, userId), sql`${ideas.id} IN ${ideaIds}`));
  }
  if (extIds.length > 0) {
    await db
      .update(extractedIdeas)
      .set({
        digestSurfaceCount: sql`${extractedIdeas.digestSurfaceCount} + 1`,
      })
      .where(
        and(
          eq(extractedIdeas.userId, userId),
          sql`${extractedIdeas.id} IN ${extIds}`
        )
      );
  }
}

// ── persistDigestRun — cache the day's pick ─────────────────────────────
export async function persistDigestRun(
  userId: string,
  picks: DigestPick[],
  juxtapositionId: string | null
): Promise<void> {
  // unique on (user_id, run_date) — upsert via ON CONFLICT
  await db.execute(sql`
    INSERT INTO garden_digest_runs (user_id, run_date, selected, juxtaposition_id)
    VALUES (${userId}, CURRENT_DATE, ${JSON.stringify(picks)}::jsonb, ${juxtapositionId})
    ON CONFLICT (user_id, run_date) DO UPDATE
      SET selected = EXCLUDED.selected,
          juxtaposition_id = EXCLUDED.juxtaposition_id
  `);
}

// ── readTodaysDigest — read cached row for the page ─────────────────────
export async function readTodaysDigest(
  userId: string
): Promise<{ picks: DigestPick[]; juxtapositionId: string | null } | null> {
  const [row] = await db
    .select({
      selected: gardenDigestRuns.selected,
      juxtapositionId: gardenDigestRuns.juxtapositionId,
    })
    .from(gardenDigestRuns)
    .where(
      and(
        eq(gardenDigestRuns.userId, userId),
        sql`${gardenDigestRuns.runDate} = CURRENT_DATE`
      )
    )
    .limit(1);

  if (!row) return null;
  return {
    picks: row.selected as DigestPick[],
    juxtapositionId: row.juxtapositionId,
  };
}
