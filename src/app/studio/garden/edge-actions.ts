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
  { ok: true; lifted: number; inspected: number } | { ok: false; reason: string }
> {
  try {
    const user = await requireUser();
    const res = await runMaturationPass(user.id);
    revalidatePath('/studio/garden');
    return { ok: true, lifted: res.lifted, inspected: res.inspected };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'maturation failed',
    };
  }
}
