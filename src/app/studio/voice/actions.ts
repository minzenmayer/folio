// Thoughtbed · /studio/voice server actions — Phase 15a (2026-05-05)
//
// rebuildProfile(platform)  — kicks profileVault for the given
//                              platform; revalidates /studio/voice on
//                              completion.
// setCanonical / unsetCanonical({ sourceKind, sourceId })
//                            — toggles a piece in the
//                              voice_canonical_pieces join table.
// updateManualLists({ platform, attributes, thingsToAvoid })
//                            — overwrites the manual fields on the
//                              voice_profiles row.
// listCanonicalCandidates({ platform, search? })
//                            — returns the source pieces for the
//                              voice page's canonical list, with
//                              their current canonical state.
//
// All strictly user-scoped via requireUser.

'use server';

import { eq, and, desc, ilike, or } from 'drizzle-orm';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  db,
  newsletterIssues,
  obsidianNotes,
  linkedinPosts,
  voiceProfiles,
  voiceCanonicalPieces,
} from '@/db';
import { requireUser } from '@/lib/auth';
import { profileVault } from '@/lib/voice/profile-vault';
import type { Platform } from '@/lib/voice/profile';

// Source kind <-> platform mapping.
function sourceKindsForPlatform(platform: Platform): readonly (
  | 'newsletter_issue'
  | 'obsidian_note'
  | 'linkedin_post'
)[] {
  return platform === 'longform'
    ? (['newsletter_issue', 'obsidian_note'] as const)
    : (['linkedin_post'] as const);
}

// ─── rebuildProfile ──────────────────────────────────────────────────

const rebuildProfileSchema = z.object({
  platform: z.enum(['longform', 'linkedin']),
});

export type RebuildProfileResult =
  | {
      ok: true;
      platform: Platform;
      sampleCount: number;
      canonicalCount: number;
      builtAt: Date;
    }
  | {
      ok: false;
      reason: 'too_sparse' | 'error';
      message: string;
    };

export async function rebuildProfile(
  input: unknown
): Promise<RebuildProfileResult> {
  const user = await requireUser();
  const { platform } = rebuildProfileSchema.parse(input);

  const result = await profileVault({ userId: user.id, platform });
  revalidatePath('/studio/voice');
  revalidatePath('/studio');

  if (!result.ok) {
    return { ok: false, reason: result.reason, message: result.message };
  }

  return {
    ok: true,
    platform: result.platform,
    sampleCount: result.sampleCount,
    canonicalCount: result.canonicalCount,
    builtAt: result.builtAt,
  };
}

// ─── set/unsetCanonical ──────────────────────────────────────────────

const canonicalToggleSchema = z.object({
  sourceKind: z.enum(['newsletter_issue', 'obsidian_note', 'linkedin_post']),
  sourceId: z.string().uuid(),
});

export async function setCanonical(input: unknown) {
  const user = await requireUser();
  const { sourceKind, sourceId } = canonicalToggleSchema.parse(input);

  await db
    .insert(voiceCanonicalPieces)
    .values({ userId: user.id, sourceKind, sourceId })
    .onConflictDoNothing();

  revalidatePath('/studio/voice');
  return { ok: true as const };
}

export async function unsetCanonical(input: unknown) {
  const user = await requireUser();
  const { sourceKind, sourceId } = canonicalToggleSchema.parse(input);

  await db
    .delete(voiceCanonicalPieces)
    .where(
      and(
        eq(voiceCanonicalPieces.userId, user.id),
        eq(voiceCanonicalPieces.sourceKind, sourceKind),
        eq(voiceCanonicalPieces.sourceId, sourceId)
      )
    );

  revalidatePath('/studio/voice');
  return { ok: true as const };
}

// ─── updateManualLists ───────────────────────────────────────────────

const updateManualListsSchema = z.object({
  platform: z.enum(['longform', 'linkedin']),
  attributes: z.array(z.string().min(1).max(160)).max(20),
  thingsToAvoid: z.array(z.string().min(1).max(160)).max(20),
});

export async function updateManualLists(input: unknown) {
  const user = await requireUser();
  const { platform, attributes, thingsToAvoid } =
    updateManualListsSchema.parse(input);

  const trimmedAttrs = attributes
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  const trimmedAvoid = thingsToAvoid
    .map((a) => a.trim())
    .filter((a) => a.length > 0);

  // Upsert by (user_id, platform). If no profile row exists yet, this
  // creates a row with empty auto fields — manual content is allowed
  // before the first build, so the user can stage thoughts before
  // running profileVault for the first time.
  await db
    .insert(voiceProfiles)
    .values({
      userId: user.id,
      platform,
      attributesManual: trimmedAttrs,
      thingsToAvoidManual: trimmedAvoid,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [voiceProfiles.userId, voiceProfiles.platform],
      set: {
        attributesManual: trimmedAttrs,
        thingsToAvoidManual: trimmedAvoid,
        updatedAt: new Date(),
      },
    });

  revalidatePath('/studio/voice');
  return { ok: true as const };
}

// ─── listCanonicalCandidates ─────────────────────────────────────────

const listCandidatesSchema = z.object({
  platform: z.enum(['longform', 'linkedin']),
  search: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(500).default(200),
  // Source kind filter for the longform tab. linkedin only has one
  // source kind, so it's ignored there.
  sourceKind: z
    .enum(['newsletter_issue', 'obsidian_note', 'linkedin_post'])
    .optional(),
});

export type CanonicalCandidate = {
  sourceKind: 'newsletter_issue' | 'obsidian_note' | 'linkedin_post';
  id: string;
  title: string | null;
  snippet: string | null;
  postedAt: Date | null;
  isCanonical: boolean;
};

export async function listCanonicalCandidates(
  input: unknown
): Promise<{
  candidates: CanonicalCandidate[];
  totalEligible: number;
  totalCanonical: number;
}> {
  const user = await requireUser();
  const parsed = listCandidatesSchema.parse(input);
  const platformKinds = sourceKindsForPlatform(parsed.platform);
  // platformKinds is a narrower readonly tuple per platform; k is the
  // full source-kind enum. Widen the array's element type for .includes
  // so TS doesn't reject the cross-union compare.
  const platformKindStrs = platformKinds as readonly string[];
  const wantedKinds = parsed.sourceKind
    ? ([parsed.sourceKind] as const).filter((k) => platformKindStrs.includes(k))
    : platformKinds;

  if (wantedKinds.length === 0) {
    return { candidates: [], totalEligible: 0, totalCanonical: 0 };
  }

  // Read canonical IDs once for the whole platform.
  const canonicalRows = await db
    .select({
      sourceKind: voiceCanonicalPieces.sourceKind,
      sourceId: voiceCanonicalPieces.sourceId,
    })
    .from(voiceCanonicalPieces)
    .where(eq(voiceCanonicalPieces.userId, user.id));
  const canonicalSet = new Set(
    canonicalRows.map((r) => `${r.sourceKind}:${r.sourceId}`)
  );

  const search = parsed.search?.trim();

  // Per-kind queries, then merge + sort. Per-kind keeps the SQL
  // tractable even though it's three branches.
  const out: CanonicalCandidate[] = [];

  if (wantedKinds.includes('newsletter_issue')) {
    const where = search
      ? and(
          eq(newsletterIssues.userId, user.id),
          ilike(newsletterIssues.title, `%${search}%`)
        )
      : eq(newsletterIssues.userId, user.id);
    const rows = await db
      .select({
        id: newsletterIssues.id,
        title: newsletterIssues.title,
        body: newsletterIssues.bodyText,
        postedAt: newsletterIssues.publishDate,
      })
      .from(newsletterIssues)
      .where(where)
      .orderBy(desc(newsletterIssues.publishDate))
      .limit(parsed.limit);
    for (const r of rows) {
      out.push({
        sourceKind: 'newsletter_issue',
        id: r.id,
        title: r.title,
        snippet: (r.body ?? '').slice(0, 240).trim() || null,
        postedAt: r.postedAt ?? null,
        isCanonical: canonicalSet.has(`newsletter_issue:${r.id}`),
      });
    }
  }

  if (wantedKinds.includes('obsidian_note')) {
    const where = search
      ? and(
          eq(obsidianNotes.userId, user.id),
          or(
            ilike(obsidianNotes.title, `%${search}%`),
            ilike(obsidianNotes.path, `%${search}%`)
          )
        )
      : eq(obsidianNotes.userId, user.id);
    const rows = await db
      .select({
        id: obsidianNotes.id,
        title: obsidianNotes.title,
        body: obsidianNotes.bodyText,
        postedAt: obsidianNotes.updatedAt,
      })
      .from(obsidianNotes)
      .where(where)
      .orderBy(desc(obsidianNotes.updatedAt))
      .limit(parsed.limit);
    for (const r of rows) {
      out.push({
        sourceKind: 'obsidian_note',
        id: r.id,
        title: r.title,
        snippet: (r.body ?? '').slice(0, 240).trim() || null,
        postedAt: r.postedAt ?? null,
        isCanonical: canonicalSet.has(`obsidian_note:${r.id}`),
      });
    }
  }

  if (wantedKinds.includes('linkedin_post')) {
    const where = search
      ? and(
          eq(linkedinPosts.userId, user.id),
          or(
            ilike(linkedinPosts.bodyClean, `%${search}%`),
            ilike(linkedinPosts.content, `%${search}%`)
          )
        )
      : eq(linkedinPosts.userId, user.id);
    const rows = await db
      .select({
        id: linkedinPosts.id,
        body: linkedinPosts.bodyClean,
        rawContent: linkedinPosts.content,
        postedAt: linkedinPosts.postedAt,
      })
      .from(linkedinPosts)
      .where(where)
      .orderBy(desc(linkedinPosts.postedAt))
      .limit(parsed.limit);
    for (const r of rows) {
      const text = (r.body ?? r.rawContent ?? '').trim();
      if (text.length === 0) continue;
      out.push({
        sourceKind: 'linkedin_post',
        id: r.id,
        title: text.split('\n')[0]?.slice(0, 80) || null,
        snippet: text.slice(0, 240) || null,
        postedAt: r.postedAt ?? null,
        isCanonical: canonicalSet.has(`linkedin_post:${r.id}`),
      });
    }
  }

  // Sort the merged list by postedAt desc; nulls last.
  out.sort((a, b) => {
    const aT = a.postedAt?.getTime() ?? 0;
    const bT = b.postedAt?.getTime() ?? 0;
    return bT - aT;
  });

  // Tallies for the page header.
  const platformCanonicalIds = canonicalRows.filter((r) =>
    platformKindStrs.includes(r.sourceKind)
  ).length;

  return {
    candidates: out.slice(0, parsed.limit),
    totalEligible: out.length,
    totalCanonical: platformCanonicalIds,
  };
}
