// Thoughtbed · On the rise — Phase 19.3 (2026-05-06)
//
// Picks 6-9 ideas that are most worth a click right now. Visual
// grid below the daily 3 picks. Mix of hot, ready, recently-warmed
// to spark curiosity without flooding.
//
// Selection rule:
//   1. Anything hot (cap 3)
//   2. Top 'ready' by ripeness (cap 4)
//   3. Recently-warmed (warm temp, temperatureUpdatedAt within 14d) capped 3
//   4. Dedupe; cap final list at 9

import { and, eq, sql, desc, gte, ne } from 'drizzle-orm';
import { db, ideas } from '@/db';
import type { Maturity, Temperature } from './types';

export interface RisingItem {
  id: string;
  title: string;
  essence: string | null;
  temperature: Temperature;
  maturity: Maturity;
  themes: string[];
  reason: 'hot' | 'ready' | 'rising';
}

const MAX_TOTAL = 9;

export async function loadOnTheRise(userId: string): Promise<RisingItem[]> {
  const out: RisingItem[] = [];
  const seen = new Set<string>();

  // 1. Hot — up to 3.
  try {
    const hot = await db
      .select({
        id: ideas.id,
        title: ideas.title,
        essence: ideas.essence,
        temperature: ideas.temperature,
        maturity: ideas.maturity,
        themes: ideas.themes,
        lastVisitedAt: ideas.lastVisitedAt,
      })
      .from(ideas)
      .where(and(eq(ideas.userId, userId), eq(ideas.temperature, 'hot')))
      .orderBy(desc(ideas.lastVisitedAt))
      .limit(3);
    for (const r of hot) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({
        id: r.id,
        title: r.title,
        essence: r.essence,
        temperature: r.temperature as Temperature,
        maturity: r.maturity as Maturity,
        themes: r.themes ?? [],
        reason: 'hot',
      });
    }
  } catch (err) {
    console.warn('[on-the-rise] hot load failed', err);
  }

  // 2. Ready (not already in out) — up to 4.
  try {
    const ready = await db
      .select({
        id: ideas.id,
        title: ideas.title,
        essence: ideas.essence,
        temperature: ideas.temperature,
        maturity: ideas.maturity,
        themes: ideas.themes,
      })
      .from(ideas)
      .where(
        and(
          eq(ideas.userId, userId),
          eq(ideas.maturity, 'ready'),
          ne(ideas.temperature, 'set_aside')
        )
      )
      .orderBy(desc(ideas.lastVisitedAt))
      .limit(8);
    for (const r of ready) {
      if (seen.has(r.id)) continue;
      if (out.length >= MAX_TOTAL) break;
      seen.add(r.id);
      out.push({
        id: r.id,
        title: r.title,
        essence: r.essence,
        temperature: r.temperature as Temperature,
        maturity: r.maturity as Maturity,
        themes: r.themes ?? [],
        reason: 'ready',
      });
      if (out.filter((i) => i.reason === 'ready').length >= 4) break;
    }
  } catch (err) {
    console.warn('[on-the-rise] ready load failed', err);
  }

  // 3. Rising — warm temp recently updated.
  try {
    const rising = await db
      .select({
        id: ideas.id,
        title: ideas.title,
        essence: ideas.essence,
        temperature: ideas.temperature,
        maturity: ideas.maturity,
        themes: ideas.themes,
      })
      .from(ideas)
      .where(
        and(
          eq(ideas.userId, userId),
          eq(ideas.temperature, 'warm'),
          gte(
            ideas.temperatureUpdatedAt,
            sql`now() - interval '14 days'`
          )
        )
      )
      .orderBy(desc(ideas.temperatureUpdatedAt))
      .limit(8);
    for (const r of rising) {
      if (seen.has(r.id)) continue;
      if (out.length >= MAX_TOTAL) break;
      seen.add(r.id);
      out.push({
        id: r.id,
        title: r.title,
        essence: r.essence,
        temperature: r.temperature as Temperature,
        maturity: r.maturity as Maturity,
        themes: r.themes ?? [],
        reason: 'rising',
      });
      if (out.filter((i) => i.reason === 'rising').length >= 3) break;
    }
  } catch (err) {
    console.warn('[on-the-rise] rising load failed', err);
  }

  return out.slice(0, MAX_TOTAL);
}
