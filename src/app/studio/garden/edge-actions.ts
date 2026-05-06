// Thoughtbed · Edge-prompt server actions — Phase 17 (2026-05-05)
//
// Server-action wrappers around src/lib/garden/edge-prompts.ts so the
// client EdgePromptZone can call them. The library helper is non-server
// for testability; this file is just the action surface.

'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth';
import { pushToReady as libPushToReady } from '@/lib/garden/edge-prompts';
import { runMaturationPass } from '@/lib/garden/maturation';
import { runSeedChunk } from './seed-actions';

export async function pushToReadyAction(input: {
  ideaId: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const user = await requireUser();
  if (!input?.ideaId) return { ok: false, reason: 'invalid' };
  await libPushToReady(user.id, input.ideaId);
  revalidatePath('/studio/garden');
  return { ok: true };
}

// Phase 18 manual trigger. Surfaces in the Garden header so the user
// can fire the maturation pass without waiting for the daily cron.
export async function runMaturationNow(): Promise<
  | {
      ok: true;
      claimed: number;
      lifted: number;
      inspected: number;
      signal1: number;
      signal2: number;
      signal3: number;
      signal4: number;
      signal5: number;
      firstError: string | null;
    }
  | { ok: false; reason: string }
> {
  try {
    const user = await requireUser();

    // Phase 18 hotfix (2026-05-05): one-click does BOTH jobs.
    // Step 1: drive the seed chunk loop to completion so any
    //   unclaimed user-authored extracted_ideas get partner rows.
    //   Without this, maturation has nothing to inspect.
    // Step 2: run the maturation pass over the now-populated ideas
    //   table.
    //
    // The seed chunks each process up to 25 rows. Vercel server
    // actions are 10s capped — at ~50 rows/s the budget covers
    // ~500 rows comfortably. Cap the loop at 30 chunks (=750 rows)
    // so we don't time out on huge backlogs; the next click picks
    // up where this one stopped.

    let totalClaimed = 0;
    const MAX_CHUNKS = 30;
    try {
      for (let i = 0; i < MAX_CHUNKS; i++) {
        const chunk = await runSeedChunk();
        totalClaimed += chunk.claimed;
        if (!chunk.hasMore) break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      return { ok: false, reason: `seed phase failed: ${msg}` };
    }

    let res;
    try {
      res = await runMaturationPass(user.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      return { ok: false, reason: `maturation phase failed: ${msg}` };
    }

    // Bubble up the first error encountered during the pass so the
    // user sees WHICH loader / signal step failed, not just an
    // opaque count.
    const firstError = res.errors[0];
    revalidatePath('/studio/garden');
    return {
      ok: true,
      claimed: totalClaimed,
      lifted: res.lifted,
      inspected: res.inspected,
      signal1: res.signal1Hits,
      signal2: res.signal2Hits,
      signal3: res.signal3Hits,
      signal4: res.signal4Hits,
      signal5: res.signal5Hits,
      firstError: firstError ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'maturation failed',
    };
  }
}
