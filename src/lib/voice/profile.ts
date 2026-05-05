// Thoughtbed · src/lib/voice/profile.ts — Phase 15a (2026-05-05)
//
// Read-side helpers for the voice profile. The composer
// (proposeFromTopic / generateProposal) consumes the merged shape from
// here; the auto/manual split is internal to this module.
//
// Shape consumed by the composer (declared in src/lib/llm.ts):
//   ProposalVoiceProfile = {
//     summary?: string;
//     attributes?: string[];
//     thingsToAvoid?: string[];
//   };
//
// Storage shape (src/db/schema.ts):
//   voice_profiles row carries:
//     · summary (text, nullable)
//     · attributes_auto + attributes_manual (jsonb arrays)
//     · things_to_avoid_auto + things_to_avoid_manual (jsonb arrays)
//
// Merge rule: auto first, manual appended. No de-duplication —
// duplicates between auto and manual are rare and over-zealous
// dedup risks dropping intentional emphasis. Future revision can
// add a normalize+dedup step if real use surfaces it.

import { eq, and } from 'drizzle-orm';
import { db, voiceProfiles } from '@/db';
import type { ProposalVoiceProfile } from '@/lib/llm';

export type Platform = 'longform' | 'linkedin';

export const PLATFORMS: readonly Platform[] = ['longform', 'linkedin'] as const;

// What the composer expects when both platforms are loaded.
export type LoadedVoiceProfile = {
  longform?: ProposalVoiceProfile;
  linkedin?: ProposalVoiceProfile;
};

// Cast helper for jsonb columns. Drizzle types these as `unknown` for
// safety; we know they are string arrays at insert time (CHECK at app
// layer in profile-vault.ts + actions.ts).
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

// Merge a single voice_profiles row into the ProposalVoiceProfile
// shape. Auto first, manual appended. If both auto and manual are
// empty AND summary is null, returns undefined — the composer treats
// undefined as "no profile" and falls back to bucket samples.
export function mergeProfile(
  row: Pick<
    typeof voiceProfiles.$inferSelect,
    | 'summary'
    | 'attributesAuto'
    | 'attributesManual'
    | 'thingsToAvoidAuto'
    | 'thingsToAvoidManual'
  >
): ProposalVoiceProfile | undefined {
  const summary = (row.summary ?? '').trim() || undefined;
  const attributesAuto = asStringArray(row.attributesAuto);
  const attributesManual = asStringArray(row.attributesManual);
  const thingsToAvoidAuto = asStringArray(row.thingsToAvoidAuto);
  const thingsToAvoidManual = asStringArray(row.thingsToAvoidManual);

  const attributes = [...attributesAuto, ...attributesManual];
  const thingsToAvoid = [...thingsToAvoidAuto, ...thingsToAvoidManual];

  // No content at all → caller treats as "no profile". Letting an
  // empty profile through would inflate the prompt with empty fields
  // and isn't useful.
  if (
    !summary &&
    attributes.length === 0 &&
    thingsToAvoid.length === 0
  ) {
    return undefined;
  }

  return {
    summary,
    attributes,
    thingsToAvoid,
  };
}

// Read both platform rows for the given user. Returns an empty object
// (not undefined) when no rows exist — the composer's voiceProfile
// param is itself optional, so a partial object (only longform, say)
// passes through cleanly.
export async function getVoiceProfile(
  userId: string
): Promise<LoadedVoiceProfile> {
  const rows = await db
    .select({
      platform: voiceProfiles.platform,
      summary: voiceProfiles.summary,
      attributesAuto: voiceProfiles.attributesAuto,
      attributesManual: voiceProfiles.attributesManual,
      thingsToAvoidAuto: voiceProfiles.thingsToAvoidAuto,
      thingsToAvoidManual: voiceProfiles.thingsToAvoidManual,
    })
    .from(voiceProfiles)
    .where(eq(voiceProfiles.userId, userId));

  const out: LoadedVoiceProfile = {};
  for (const r of rows) {
    const merged = mergeProfile(r);
    if (!merged) continue;
    if (r.platform === 'longform') out.longform = merged;
    if (r.platform === 'linkedin') out.linkedin = merged;
  }
  return out;
}

// Read the raw row for a single platform — used by the /studio/voice
// page to render the auto/manual split to the user. The composer
// never calls this directly.
export async function getVoiceProfileRow(
  userId: string,
  platform: Platform
) {
  const rows = await db
    .select()
    .from(voiceProfiles)
    .where(
      and(
        eq(voiceProfiles.userId, userId),
        eq(voiceProfiles.platform, platform)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}
