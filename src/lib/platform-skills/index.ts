// Thoughtbed · platform-skills loader
//
// Phase 21 slice 9 (2026-05-06). Loads the writing-strategy skill
// for the active platform and exposes it to the chat companion's
// LLM prompt (slice 11 wires the round). Skills are markdown files
// under src/lib/platform-skills/, read at server-action time via
// fs.readFileSync — server-only, never bundled into the client.

import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Platform } from '@/app/studio/page/usePlatform';

const SKILL_FILES: Record<Platform, string> = {
  linkedin: 'linkedin-post.md',
  newsletter: 'newsletter-issue.md',
  blog: 'blog-post.md',
  note: 'note.md',
};

const cache = new Map<Platform, string>();

export function getPlatformSkill(platform: Platform): string {
  const cached = cache.get(platform);
  if (cached) return cached;

  const filename = SKILL_FILES[platform];
  const path = join(process.cwd(), 'src', 'lib', 'platform-skills', filename);
  const body = readFileSync(path, 'utf-8');
  cache.set(platform, body);
  return body;
}

export function listPlatformSkillNames(): Platform[] {
  return Object.keys(SKILL_FILES) as Platform[];
}

// ─── Phase 23 v2 slice 8 · safe loader for per-format depth ─────────
//
// generateProposal / generateRefinement get a possibly-undefined or
// possibly-'unknown' platformHint (the LLM sometimes returns
// platformGuess: 'unknown'). They want the skill body when it exists
// and `null` when it doesn't, without throwing. This wrapper keeps
// the strict typing of getPlatformSkill intact while letting prompt
// builders be lenient.

const PLATFORM_KEYS: Set<string> = new Set(Object.keys(SKILL_FILES));

export function loadPlatformSkillSafe(
  platform: string | null | undefined,
): { platform: Platform; body: string } | null {
  if (!platform) return null;
  if (!PLATFORM_KEYS.has(platform)) return null;
  const p = platform as Platform;
  return { platform: p, body: getPlatformSkill(p) };
}

