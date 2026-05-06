// Thoughtbed · Edge-prompt server actions — Phase 17 (2026-05-05)
//
// Server-action wrappers around src/lib/garden/edge-prompts.ts so the
// client EdgePromptZone can call them. The library helper is non-server
// for testability; this file is just the action surface.

'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth';
import { pushToReady as libPushToReady } from '@/lib/garden/edge-prompts';

export async function pushToReadyAction(input: {
  ideaId: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const user = await requireUser();
  if (!input?.ideaId) return { ok: false, reason: 'invalid' };
  await libPushToReady(user.id, input.ideaId);
  revalidatePath('/studio/garden');
  return { ok: true };
}
