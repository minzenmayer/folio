// Thoughtbed · src/lib/voice/profile-vault.ts — Phase 15 (UX rework)
//
// 2026-05-05. Voice ID training pipeline.
//
// New shape (Ghostbase-style): the user picks up to 5 training samples
// per platform via the /studio/voice UI. profileVault loads those
// samples (resolving corpus pointers to their full text) and runs one
// Haiku call per platform.
//
// Replaced the prior canonical-first + recency-fill model — that
// surface required browsing 79+ issues and 947+ vault notes which was
// unworkable. The new model: deliberate curation, max 5 samples,
// trained on exactly what the user picked.
//
// Spec: ~/Desktop/Thoughtbed/phase15a_voice_id_spec.md

import { eq, and, inArray } from 'drizzle-orm';
import {
  db,
  newsletterIssues,
  obsidianNotes,
  linkedinPosts,
  voiceProfiles,
  voiceTrainingSamples,
} from '@/db';
import {
  generateVoiceProfile,
  type VoiceProfileSample,
} from '@/lib/llm';
import type { Platform } from './profile';

// Per-piece text budget. Trade-off: bigger budget = better signal but
// quadratic cost in prompt size. With a 5-sample cap these can be
// generous — total prompt stays well under Haiku's 200k context.
const TEXT_BUDGET_CHARS = {
  newsletter_issue: 5000,
  obsidian_note: 3000,
  linkedin_post: 3000,
  // paste/upload kinds aren't bounded by source kind; cap inline.
  inline: 5000,
} as const;

const MIN_SAMPLES = 1;
const MAX_SAMPLES = 5;

// Fully-resolved sample with title + body in memory. The result of
// loadResolvedSamples below; what generateVoiceProfile consumes.
type ResolvedSample = {
  sourceKind: string; // 'newsletter_issue' | 'obsidian_note' | 'linkedin_post' | 'paste' | 'upload'
  title: string | null;
  body: string;
  postedAt: Date | null;
  // Provenance — for built_from_ids audit trail.
  provenance:
    | { kind: 'corpus'; sourceKind: string; sourceId: string }
    | { kind: 'paste' | 'upload'; sampleId: string };
};

export type ProfileVaultResult =
  | {
      ok: true;
      platform: Platform;
      sampleCount: number;
      summary: string;
      attributesAuto: string[];
      thingsToAvoidAuto: string[];
      builtAt: Date;
    }
  | {
      ok: false;
      reason: 'too_sparse' | 'error';
      message: string;
      availableCount?: number;
    };

// Load the 5 (or fewer) samples for (user, platform), resolving
// corpus pointers to their full text via JOINs. Returns up to
// MAX_SAMPLES rows, in `position` order.
async function loadResolvedSamples(
  userId: string,
  platform: Platform
): Promise<ResolvedSample[]> {
  const rows = await db
    .select()
    .from(voiceTrainingSamples)
    .where(
      and(
        eq(voiceTrainingSamples.userId, userId),
        eq(voiceTrainingSamples.platform, platform)
      )
    )
    .orderBy(voiceTrainingSamples.position)
    .limit(MAX_SAMPLES);

  // Pre-fetch the corpus bodies for any 'corpus' kind rows so we
  // don't N+1.
  const corpusByKind: Record<string, string[]> = {
    newsletter_issue: [],
    obsidian_note: [],
    linkedin_post: [],
  };
  for (const r of rows) {
    if (r.kind === 'corpus' && r.sourceKind && r.sourceId) {
      corpusByKind[r.sourceKind]?.push(r.sourceId);
    }
  }

  const newsletterMap = new Map<
    string,
    { title: string | null; body: string | null; postedAt: Date | null }
  >();
  if (corpusByKind.newsletter_issue.length > 0) {
    const ns = await db
      .select({
        id: newsletterIssues.id,
        title: newsletterIssues.title,
        body: newsletterIssues.bodyText,
        postedAt: newsletterIssues.publishDate,
      })
      .from(newsletterIssues)
      .where(inArray(newsletterIssues.id, corpusByKind.newsletter_issue));
    for (const n of ns)
      newsletterMap.set(n.id, {
        title: n.title,
        body: n.body,
        postedAt: n.postedAt,
      });
  }

  const obsidianMap = new Map<
    string,
    { title: string | null; body: string | null; postedAt: Date | null }
  >();
  if (corpusByKind.obsidian_note.length > 0) {
    const os = await db
      .select({
        id: obsidianNotes.id,
        title: obsidianNotes.title,
        body: obsidianNotes.bodyText,
        postedAt: obsidianNotes.updatedAt,
      })
      .from(obsidianNotes)
      .where(inArray(obsidianNotes.id, corpusByKind.obsidian_note));
    for (const o of os)
      obsidianMap.set(o.id, {
        title: o.title,
        body: o.body,
        postedAt: o.postedAt,
      });
  }

  const linkedinMap = new Map<
    string,
    { title: string | null; body: string | null; postedAt: Date | null }
  >();
  if (corpusByKind.linkedin_post.length > 0) {
    const ls = await db
      .select({
        id: linkedinPosts.id,
        body: linkedinPosts.bodyClean,
        rawContent: linkedinPosts.content,
        postedAt: linkedinPosts.postedAt,
      })
      .from(linkedinPosts)
      .where(inArray(linkedinPosts.id, corpusByKind.linkedin_post));
    for (const l of ls) {
      const text = (l.body ?? l.rawContent ?? '').trim();
      linkedinMap.set(l.id, {
        title: null,
        body: text || null,
        postedAt: l.postedAt,
      });
    }
  }

  const resolved: ResolvedSample[] = [];
  for (const r of rows) {
    if (r.kind === 'corpus' && r.sourceKind && r.sourceId) {
      let entry: { title: string | null; body: string | null; postedAt: Date | null } | undefined;
      if (r.sourceKind === 'newsletter_issue') entry = newsletterMap.get(r.sourceId);
      else if (r.sourceKind === 'obsidian_note') entry = obsidianMap.get(r.sourceId);
      else if (r.sourceKind === 'linkedin_post') entry = linkedinMap.get(r.sourceId);
      if (!entry || !entry.body) continue; // dangling pointer; skip
      const budget =
        r.sourceKind === 'newsletter_issue'
          ? TEXT_BUDGET_CHARS.newsletter_issue
          : r.sourceKind === 'obsidian_note'
            ? TEXT_BUDGET_CHARS.obsidian_note
            : TEXT_BUDGET_CHARS.linkedin_post;
      resolved.push({
        sourceKind: r.sourceKind,
        title: r.title || entry.title,
        body: entry.body.slice(0, budget),
        postedAt: entry.postedAt,
        provenance: {
          kind: 'corpus',
          sourceKind: r.sourceKind,
          sourceId: r.sourceId,
        },
      });
    } else if (r.kind === 'paste' || r.kind === 'upload') {
      resolved.push({
        sourceKind: r.kind,
        title: r.title,
        body: r.body.slice(0, TEXT_BUDGET_CHARS.inline),
        postedAt: null,
        provenance: { kind: r.kind, sampleId: r.id },
      });
    }
  }

  return resolved;
}

export async function profileVault({
  userId,
  platform,
}: {
  userId: string;
  platform: Platform;
}): Promise<ProfileVaultResult> {
  const samples = await loadResolvedSamples(userId, platform);

  if (samples.length < MIN_SAMPLES) {
    return {
      ok: false,
      reason: 'too_sparse',
      message: `Add at least ${MIN_SAMPLES} training sample before retraining the voice profile.`,
      availableCount: samples.length,
    };
  }

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

  const builtAt = new Date();
  const builtFromIds = samples.map((s) => s.provenance);

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

  return {
    ok: true,
    platform,
    sampleCount: samples.length,
    summary: result.summary,
    attributesAuto: result.attributes,
    thingsToAvoidAuto: result.thingsToAvoid,
    builtAt,
  };
}
