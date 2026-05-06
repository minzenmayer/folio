// Thoughtbed · Garden edge-prompts — Phase 17 (2026-05-05)
//
// Picks up to 3 ideas "on the edge" — cool but recently warmed, or
// shaping but stuck, or ready but never circulated. Surfaces above
// the digest with one-tap actions (warm / set aside / +sentence).
//
// The compute is cheap enough to run on every Garden load (capped
// LIMIT 3 per criterion, at most 3 total). No new cron.

import { and, eq, sql } from 'drizzle-orm';
import { db, ideas } from '@/db';
import type { Maturity, Temperature } from './types';

export type EdgeReason =
  | 'about_to_cool'
  | 'shaping_stuck'
  | 'ready_uncirculated';

export interface EdgePrompt {
  ideaId: string;
  title: string;
  preview: string | null;
  temperature: Temperature;
  maturity: Maturity;
  reason: EdgeReason;
  reasonLine: string;
  // The recommended action — drives the primary button label on the card.
  primaryAction: 'warm' | 'push_to_ready' | 'open_editor';
}

const REASON_COPY: Record<EdgeReason, string> = {
  about_to_cool: 'Surfaced a few times, no action. About to cool.',
  shaping_stuck: 'Shaping but quiet for a week. Push it forward?',
  ready_uncirculated: 'Ready, but never written from. Time to use it?',
};

const PRIMARY_ACTION: Record<EdgeReason, EdgePrompt['primaryAction']> = {
  about_to_cool: 'warm',
  shaping_stuck: 'push_to_ready',
  ready_uncirculated: 'open_editor',
};

export async function findEdgeMatches(userId: string): Promise<EdgePrompt[]> {
  // Phase 17 hotfix (2026-05-05): wrap the queries so any DB hiccup
  // (or future schema drift) returns an empty list instead of crashing
  // the Garden page. Each query is independent — failure of one
  // criterion shouldn't suppress the others.
  try {
  // Pull each criterion's top-3 in priority order. Dedupe by idea id
  // across criteria. Cap the final list at 3.
  const aboutToCool = await db.execute<{
    id: string;
    title: string;
    essence: string | null;
    temperature: string;
    maturity: string;
  }>(sql`
    SELECT id, title, essence, temperature, maturity
      FROM ideas
     WHERE user_id = ${userId}
       AND temperature = 'cool'
       AND temperature_updated_at > now() - interval '14 days'
       AND digest_surface_count >= 2
       AND (pinned_until IS NULL OR pinned_until < now())
     ORDER BY temperature_updated_at DESC
     LIMIT 3
  `);

  const shapingStuck = await db.execute<{
    id: string;
    title: string;
    essence: string | null;
    temperature: string;
    maturity: string;
  }>(sql`
    SELECT id, title, essence, temperature, maturity
      FROM ideas
     WHERE user_id = ${userId}
       AND maturity = 'shaping'
       AND COALESCE(last_visited_at, created_at) < now() - interval '7 days'
     ORDER BY COALESCE(last_visited_at, created_at) ASC
     LIMIT 3
  `);

  const readyUncirc = await db.execute<{
    id: string;
    title: string;
    essence: string | null;
    temperature: string;
    maturity: string;
  }>(sql`
    SELECT id, title, essence, temperature, maturity
      FROM ideas
     WHERE user_id = ${userId}
       AND maturity = 'ready'
       AND COALESCE(last_visited_at, created_at) < now() - interval '7 days'
     ORDER BY COALESCE(last_visited_at, created_at) ASC
     LIMIT 3
  `);

  type Row = {
    id: string;
    title: string;
    essence: string | null;
    temperature: string;
    maturity: string;
  };

  const candidates: Array<{ row: Row; reason: EdgeReason }> = [];
  for (const row of (aboutToCool as unknown as Row[])) {
    candidates.push({ row, reason: 'about_to_cool' });
  }
  for (const row of (shapingStuck as unknown as Row[])) {
    candidates.push({ row, reason: 'shaping_stuck' });
  }
  for (const row of (readyUncirc as unknown as Row[])) {
    candidates.push({ row, reason: 'ready_uncirculated' });
  }

  const seen = new Set<string>();
  const out: EdgePrompt[] = [];
  for (const c of candidates) {
    if (seen.has(c.row.id)) continue;
    seen.add(c.row.id);
    out.push({
      ideaId: c.row.id,
      title: c.row.title,
      preview: c.row.essence,
      temperature: c.row.temperature as Temperature,
      maturity: c.row.maturity as Maturity,
      reason: c.reason,
      reasonLine: REASON_COPY[c.reason],
      primaryAction: PRIMARY_ACTION[c.reason],
    });
    if (out.length >= 3) break;
  }
  return out;
  } catch (err) {
    console.warn('[findEdgeMatches] failed', err);
    return [];
  }
}

// Server action: bump maturity one step toward 'ready'. Used by
// EdgePromptZone's 'Push to ready' button. Idempotent — if already
// ready, no-op.
const MATURITY_LADDER: Maturity[] = [
  'seed',
  'forming',
  'shaping',
  'ready',
  'circulated',
  'dormant',
];

export function nextMaturity(m: Maturity): Maturity {
  const idx = MATURITY_LADDER.indexOf(m);
  if (idx < 0 || idx === MATURITY_LADDER.length - 1) return m;
  // Don't auto-step past 'ready' — circulated/dormant are user signals.
  if (m === 'ready') return 'ready';
  return MATURITY_LADDER[idx + 1];
}

export async function pushToReady(
  userId: string,
  ideaId: string
): Promise<void> {
  const [row] = await db
    .select({ maturity: ideas.maturity })
    .from(ideas)
    .where(and(eq(ideas.userId, userId), eq(ideas.id, ideaId)))
    .limit(1);
  if (!row) return;
  const next = nextMaturity(row.maturity as Maturity);
  if (next === row.maturity) return;
  await db
    .update(ideas)
    .set({ maturity: next })
    .where(and(eq(ideas.userId, userId), eq(ideas.id, ideaId)));
}
