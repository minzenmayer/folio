// Thoughtbed · src/lib/voice/profile-vault.ts — Phase 15a (2026-05-05)
//
// profileVault({ userId, platform }) — build the voice profile for a
// platform from the user's corpus. Sampling rule:
//
//   1. Pull all canonical pieces for the platform.
//   2. If canonical < target per source kind, fill remaining slots
//      with recency-weighted random (60% last 6 months, 40% older).
//   3. Truncate per piece to a per-kind budget.
//   4. One Haiku call (generateVoiceProfile in src/lib/llm.ts).
//   5. Upsert into voice_profiles with the auto fields. Manual fields
//      stay untouched.
//
// Cost ~$0.20 per platform per build at Haiku rates. Manual rebuild
// cadence keeps this rounding-error.
//
// Spec: ~/Desktop/Thoughtbed/phase15a_voice_id_spec.md

import { eq, and, sql, inArray } from 'drizzle-orm';
import {
  db,
  newsletterIssues,
  obsidianNotes,
  linkedinPosts,
  voiceProfiles,
  voiceCanonicalPieces,
} from '@/db';
import {
  generateVoiceProfile,
  type VoiceProfileSample,
} from '@/lib/llm';
import type { Platform } from './profile';

// Target sample sizes per source kind. Defaults from the spec — tune
// here without touching the prompt or the read path.
const SAMPLE_TARGETS = {
  longform: {
    newsletter_issue: 10,
    obsidian_note: 20,
  },
  linkedin: {
    linkedin_post: 30,
  },
} as const;

// Per-piece text budget. Trade-off: bigger budget = better signal but
// quadratic cost in prompt size. The numbers here keep one platform
// build under ~50k input tokens at the spec's sample targets.
const TEXT_BUDGET_CHARS = {
  newsletter_issue: 4000,
  obsidian_note: 1500,
  linkedin_post: 2500,
} as const;

// Recency split: 60% of random fill from the last 6 months, 40% older.
// 6 months in ms ≈ 1000ms × 60s × 60min × 24h × 182d.
const RECENT_WINDOW_MS = 1000 * 60 * 60 * 24 * 182;
const RECENT_SHARE = 0.6;

type SourceKindForPlatform<P extends Platform> = P extends 'longform'
  ? 'newsletter_issue' | 'obsidian_note'
  : 'linkedin_post';

type CandidatePiece = {
  sourceKind: 'newsletter_issue' | 'obsidian_note' | 'linkedin_post';
  id: string;
  title: string | null;
  body: string;
  postedAt: Date | null;
  isCanonical: boolean;
};

// Reservoir-style random sampling that's recency-aware. Splits the
// pool into "recent" and "older" by RECENT_WINDOW_MS, draws
// targetCount × RECENT_SHARE from recent and the rest from older.
// Falls back gracefully if either bucket is empty.
function sampleRecencyWeighted<T extends { postedAt: Date | null }>(
  pool: T[],
  count: number,
  now: number
): T[] {
  if (count <= 0 || pool.length === 0) return [];
  if (pool.length <= count) return [...pool];

  const cutoff = now - RECENT_WINDOW_MS;
  const recent: T[] = [];
  const older: T[] = [];
  for (const p of pool) {
    const ts = p.postedAt?.getTime() ?? 0;
    if (ts >= cutoff) recent.push(p);
    else older.push(p);
  }

  const wantRecent = Math.min(
    Math.round(count * RECENT_SHARE),
    recent.length
  );
  const wantOlder = Math.min(count - wantRecent, older.length);
  // If recent fell short of its share, try to fill from older.
  const overflow = count - wantRecent - wantOlder;
  const wantOlderFinal = Math.min(wantOlder + overflow, older.length);
  // If older fell short too, try to take more from recent.
  const wantRecentFinal = Math.min(
    count - wantOlderFinal,
    recent.length
  );

  const drawn: T[] = [];
  drawn.push(...sampleRandom(recent, wantRecentFinal));
  drawn.push(...sampleRandom(older, wantOlderFinal));
  return drawn;
}

function sampleRandom<T>(pool: T[], k: number): T[] {
  if (k <= 0 || pool.length === 0) return [];
  if (pool.length <= k) return [...pool];
  // Fisher–Yates partial shuffle of indices.
  const idx = Array.from({ length: pool.length }, (_, i) => i);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, k).map((i) => pool[i]);
}

async function loadCandidates(
  userId: string,
  sourceKind: 'newsletter_issue' | 'obsidian_note' | 'linkedin_post',
  canonicalIds: Set<string>
): Promise<CandidatePiece[]> {
  if (sourceKind === 'newsletter_issue') {
    const rows = await db
      .select({
        id: newsletterIssues.id,
        title: newsletterIssues.title,
        body: newsletterIssues.bodyText,
        postedAt: newsletterIssues.publishDate,
      })
      .from(newsletterIssues)
      .where(
        and(
          eq(newsletterIssues.userId, userId),
          // Skip rows with no body — can't profile from nothing.
          sql`${newsletterIssues.bodyText} IS NOT NULL AND length(${newsletterIssues.bodyText}) > 200`
        )
      );
    return rows.map((r) => ({
      sourceKind,
      id: r.id,
      title: r.title ?? null,
      body: (r.body ?? '').slice(0, TEXT_BUDGET_CHARS[sourceKind]),
      postedAt: r.postedAt ?? null,
      isCanonical: canonicalIds.has(r.id),
    }));
  }

  if (sourceKind === 'obsidian_note') {
    const rows = await db
      .select({
        id: obsidianNotes.id,
        title: obsidianNotes.title,
        body: obsidianNotes.bodyText,
        postedAt: obsidianNotes.updatedAt,
      })
      .from(obsidianNotes)
      .where(
        and(
          eq(obsidianNotes.userId, userId),
          sql`${obsidianNotes.bodyText} IS NOT NULL AND length(${obsidianNotes.bodyText}) > 100`
        )
      );
    return rows.map((r) => ({
      sourceKind,
      id: r.id,
      title: r.title ?? null,
      body: (r.body ?? '').slice(0, TEXT_BUDGET_CHARS[sourceKind]),
      postedAt: r.postedAt ?? null,
      isCanonical: canonicalIds.has(r.id),
    }));
  }

  if (sourceKind === 'linkedin_post') {
    const rows = await db
      .select({
        id: linkedinPosts.id,
        title: sql<string | null>`null`,
        body: linkedinPosts.bodyClean,
        rawContent: linkedinPosts.content,
        postedAt: linkedinPosts.postedAt,
      })
      .from(linkedinPosts)
      .where(
        and(
          eq(linkedinPosts.userId, userId),
          sql`(${linkedinPosts.bodyClean} IS NOT NULL OR ${linkedinPosts.content} IS NOT NULL)`
        )
      );
    return rows
      .map((r) => {
        const text = (r.body ?? r.rawContent ?? '').trim();
        if (text.length < 50) return null;
        return {
          sourceKind,
          id: r.id,
          title: null,
          body: text.slice(0, TEXT_BUDGET_CHARS[sourceKind]),
          postedAt: r.postedAt ?? null,
          isCanonical: canonicalIds.has(r.id),
        } satisfies CandidatePiece;
      })
      .filter((x): x is CandidatePiece => x !== null);
  }

  return [];
}

export type ProfileVaultResult =
  | {
      ok: true;
      platform: Platform;
      sampleCount: number;
      canonicalCount: number;
      summary: string;
      attributesAuto: string[];
      thingsToAvoidAuto: string[];
      builtAt: Date;
    }
  | {
      ok: false;
      reason: 'too_sparse' | 'error';
      message: string;
      // Counts of what WAS available, for the placeholder UI.
      availableCount?: number;
    };

// Minimum sample size below which the build refuses. Returning a
// placeholder profile from too-thin a corpus produces generic-sounding
// output and worse: it signals "this is your voice" when it isn't.
const MIN_SAMPLE_SIZE = 5;

export async function profileVault({
  userId,
  platform,
}: {
  userId: string;
  platform: Platform;
}): Promise<ProfileVaultResult> {
  // 1. Load canonical IDs for this platform's source kinds.
  const sourceKinds: ('newsletter_issue' | 'obsidian_note' | 'linkedin_post')[] =
    platform === 'longform'
      ? ['newsletter_issue', 'obsidian_note']
      : ['linkedin_post'];

  const canonicalRows = await db
    .select({
      sourceKind: voiceCanonicalPieces.sourceKind,
      sourceId: voiceCanonicalPieces.sourceId,
    })
    .from(voiceCanonicalPieces)
    .where(
      and(
        eq(voiceCanonicalPieces.userId, userId),
        inArray(voiceCanonicalPieces.sourceKind, sourceKinds)
      )
    );

  // Per-kind sets so each kind's loader can stamp isCanonical.
  const canonicalByKind = new Map<string, Set<string>>();
  for (const k of sourceKinds) canonicalByKind.set(k, new Set());
  for (const r of canonicalRows) {
    canonicalByKind.get(r.sourceKind)?.add(r.sourceId);
  }

  // 2. Per source kind: load all candidates, pick canonical first,
  //    recency-fill the rest up to the per-kind target.
  const targets = SAMPLE_TARGETS[platform];
  const samples: CandidatePiece[] = [];
  const now = Date.now();

  for (const kind of sourceKinds) {
    const target =
      (targets as Record<string, number>)[kind] ?? 0;
    if (target <= 0) continue;
    const canonicalIds = canonicalByKind.get(kind) ?? new Set<string>();
    const candidates = await loadCandidates(userId, kind, canonicalIds);

    const canonicalSet = candidates.filter((c) => c.isCanonical);
    const nonCanonical = candidates.filter((c) => !c.isCanonical);

    // Canonical always included (up to target). If canonical exceeds
    // target, take all canonical (the user's curation overrides).
    const taken: CandidatePiece[] = [...canonicalSet];
    const needed = Math.max(0, target - taken.length);
    if (needed > 0 && nonCanonical.length > 0) {
      taken.push(...sampleRecencyWeighted(nonCanonical, needed, now));
    }
    samples.push(...taken);
  }

  // 3. Cold-start guard.
  if (samples.length < MIN_SAMPLE_SIZE) {
    return {
      ok: false,
      reason: 'too_sparse',
      message: `Voice profile needs at least ${MIN_SAMPLE_SIZE} pieces in your corpus before we can build it. Connect more sources or canonicalize more pieces, then rebuild.`,
      availableCount: samples.length,
    };
  }

  // 4. Build the LLM input shape and call.
  const llmSamples: VoiceProfileSample[] = samples.map((s) => ({
    sourceKind: s.sourceKind,
    title: s.title,
    postedAt: s.postedAt,
    body: s.body,
  }));

  let result;
  try {
    result = await generateVoiceProfile({ platform, samples: llmSamples });
  } catch (err) {
    console.error('[profileVault] generateVoiceProfile failed', err);
    return {
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : 'profile build failed',
    };
  }

  // 5. Persist. Upsert by (user_id, platform). Manual fields are
  //    untouched on update — they persist across rebuilds.
  const builtAt = new Date();
  const builtFromIds = samples.map((s) => ({
    kind: s.sourceKind,
    id: s.id,
    isCanonical: s.isCanonical,
  }));

  await db
    .insert(voiceProfiles)
    .values({
      userId,
      platform,
      summary: result.summary,
      attributesAuto: result.attributes,
      thingsToAvoidAuto: result.thingsToAvoid,
      builtAt,
      builtFromIds,
      updatedAt: builtAt,
    })
    .onConflictDoUpdate({
      target: [voiceProfiles.userId, voiceProfiles.platform],
      set: {
        summary: result.summary,
        attributesAuto: result.attributes,
        thingsToAvoidAuto: result.thingsToAvoid,
        builtAt,
        builtFromIds,
        updatedAt: builtAt,
      },
    });

  const canonicalCount = samples.filter((s) => s.isCanonical).length;

  return {
    ok: true,
    platform,
    sampleCount: samples.length,
    canonicalCount,
    summary: result.summary,
    attributesAuto: result.attributes,
    thingsToAvoidAuto: result.thingsToAvoid,
    builtAt,
  };
}
