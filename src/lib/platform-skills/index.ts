// Thoughtbed · platform-skills loader
//
// Phase 21 slice 9 (2026-05-06). Originally read the skill markdown
// files from disk via fs.readFileSync. That worked locally + in
// dev but Vercel's serverless bundler does NOT ship .md files
// alongside the function — the files weren't imported anywhere, so
// next-bundle-trace skipped them. Slice 8 of Phase 23 v2 (2026-05-07)
// rewired the loader to read from an inlined PLATFORM_SKILL_BODIES
// constant, so the strings ride in the JS bundle. To edit the craft
// text, edit the .md files in this directory then regenerate
// bodies.ts (the source of truth at runtime).

import 'server-only';

import type { Platform } from '@/app/studio/page/usePlatform';
import { PLATFORM_SKILL_BODIES } from './bodies';

export function getPlatformSkill(platform: Platform): string {
  return PLATFORM_SKILL_BODIES[platform];
}

export function listPlatformSkillNames(): Platform[] {
  return Object.keys(PLATFORM_SKILL_BODIES) as Platform[];
}

// ─── Phase 23 v2 slice 8 · safe loader for per-format depth ─────────
//
// generateProposal / generateRefinement get a possibly-undefined or
// possibly-'unknown' platformHint (the LLM sometimes returns
// platformGuess: 'unknown'). They want the skill body when it exists
// and `null` when it doesn't, without throwing.

const PLATFORM_KEYS: Set<string> = new Set(Object.keys(PLATFORM_SKILL_BODIES));

export function loadPlatformSkillSafe(
  platform: string | null | undefined,
): { platform: Platform; body: string } | null {
  if (!platform) return null;
  if (!PLATFORM_KEYS.has(platform)) return null;
  const p = platform as Platform;
  return { platform: p, body: getPlatformSkill(p) };
}
