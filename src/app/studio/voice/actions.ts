// Thoughtbed · /studio/voice server actions — Phase 15 (UX rework)
//
// 5-sample-picker model. The user picks up to 5 training samples per
// platform via the page UI; rebuildProfile reads those samples and
// runs profileVault on them.
//
// Three sample kinds: corpus (pointer to a row in newsletter_issues /
// obsidian_notes / linkedin_posts), paste (inline text), upload
// (inline text from a file). voice_training_samples carries the
// state.

'use server';

import { eq, and, desc, sql, ilike, or, max, asc } from 'drizzle-orm';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  db,
  newsletterIssues,
  obsidianNotes,
  linkedinPosts,
  voiceProfiles,
  voiceTrainingSamples,
} from '@/db';
import { requireUser } from '@/lib/auth';
import { profileVault } from '@/lib/voice/profile-vault';
import type { Platform } from '@/lib/voice/profile';

const MAX_SAMPLES = 5;
const PASTE_BODY_MAX = 50_000;
const PASTE_TITLE_MAX = 200;

// ─── rebuildProfile ──────────────────────────────────────────────────

const rebuildProfileSchema = z.object({
  platform: z.enum(['longform', 'linkedin']),
});

export type RebuildProfileResult =
  | {
      ok: true;
      platform: Platform;
      sampleCount: number;
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
  revalidatePath('/studio/voice-insights');
  revalidatePath('/studio');

  if (!result.ok) {
    return { ok: false, reason: result.reason, message: result.message };
  }

  return {
    ok: true,
    platform: result.platform,
    sampleCount: result.sampleCount,
    builtAt: result.builtAt,
  };
}

// ─── listTrainingSamples ─────────────────────────────────────────────

const listSamplesSchema = z.object({
  platform: z.enum(['longform', 'linkedin']),
});

export type ListedSample = {
  id: string;
  platform: Platform;
  kind: 'corpus' | 'paste' | 'upload';
  // For corpus: the source kind ('newsletter_issue' | ...). Null for paste/upload.
  sourceKind: string | null;
  title: string;
  // Snippet for cards; full body fetched separately when expanded.
  snippet: string | null;
  position: number;
  createdAt: string;
};

export async function listTrainingSamples(
  input: unknown
): Promise<{ samples: ListedSample[] }> {
  const user = await requireUser();
  const { platform } = listSamplesSchema.parse(input);

  const rows = await db
    .select()
    .from(voiceTrainingSamples)
    .where(
      and(
        eq(voiceTrainingSamples.userId, user.id),
        eq(voiceTrainingSamples.platform, platform)
      )
    )
    .orderBy(asc(voiceTrainingSamples.position));

  // For corpus rows we need the title from the source table when the
  // user added the sample by reference. We stored title at add-time
  // for stability, so just use it as-is; same for body snippet.
  const samples: ListedSample[] = rows.map((r) => ({
    id: r.id,
    platform: r.platform as Platform,
    kind: r.kind as 'corpus' | 'paste' | 'upload',
    sourceKind: r.sourceKind ?? null,
    title: r.title,
    snippet: r.body ? r.body.slice(0, 280) : null,
    position: r.position,
    createdAt: r.createdAt.toISOString(),
  }));

  return { samples };
}

// ─── getTrainingSampleBody — full content for the expand view ────────

const getSampleBodySchema = z.object({
  id: z.string().uuid(),
});

export async function getTrainingSampleBody(
  input: unknown
): Promise<{ body: string }> {
  const user = await requireUser();
  const { id } = getSampleBodySchema.parse(input);

  const rows = await db
    .select()
    .from(voiceTrainingSamples)
    .where(
      and(
        eq(voiceTrainingSamples.id, id),
        eq(voiceTrainingSamples.userId, user.id)
      )
    )
    .limit(1);

  return { body: rows[0]?.body ?? '' };
}

// ─── addSample — corpus / paste / upload ─────────────────────────────

const addCorpusSchema = z.object({
  platform: z.enum(['longform', 'linkedin']),
  kind: z.literal('corpus'),
  sourceKind: z.enum(['newsletter_issue', 'obsidian_note', 'linkedin_post']),
  sourceId: z.string().uuid(),
});

const addPasteSchema = z.object({
  platform: z.enum(['longform', 'linkedin']),
  kind: z.literal('paste'),
  title: z.string().min(1).max(PASTE_TITLE_MAX),
  body: z.string().min(20).max(PASTE_BODY_MAX),
});

const addUploadSchema = z.object({
  platform: z.enum(['longform', 'linkedin']),
  kind: z.literal('upload'),
  title: z.string().min(1).max(PASTE_TITLE_MAX),
  body: z.string().min(20).max(PASTE_BODY_MAX),
  filename: z.string().min(1).max(200).optional(),
});

const addSampleSchema = z.discriminatedUnion('kind', [
  addCorpusSchema,
  addPasteSchema,
  addUploadSchema,
]);

export type AddSampleResult =
  | { ok: true; sampleId: string }
  | { ok: false; reason: 'cap_reached' | 'duplicate' | 'invalid' | 'error'; message: string };

export async function addTrainingSample(
  input: unknown
): Promise<AddSampleResult> {
  const user = await requireUser();
  let parsed: z.infer<typeof addSampleSchema>;
  try {
    parsed = addSampleSchema.parse(input);
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid',
      message: err instanceof Error ? err.message : 'invalid input',
    };
  }

  // Cap check.
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(voiceTrainingSamples)
    .where(
      and(
        eq(voiceTrainingSamples.userId, user.id),
        eq(voiceTrainingSamples.platform, parsed.platform)
      )
    );
  if (Number(count) >= MAX_SAMPLES) {
    return {
      ok: false,
      reason: 'cap_reached',
      message: `Already at the ${MAX_SAMPLES}-sample cap for this platform. Remove one first.`,
    };
  }

  // Duplicate check for corpus kind only.
  if (parsed.kind === 'corpus') {
    const dup = await db
      .select({ id: voiceTrainingSamples.id })
      .from(voiceTrainingSamples)
      .where(
        and(
          eq(voiceTrainingSamples.userId, user.id),
          eq(voiceTrainingSamples.platform, parsed.platform),
          eq(voiceTrainingSamples.kind, 'corpus'),
          eq(voiceTrainingSamples.sourceKind, parsed.sourceKind),
          eq(voiceTrainingSamples.sourceId, parsed.sourceId)
        )
      )
      .limit(1);
    if (dup.length > 0) {
      return {
        ok: false,
        reason: 'duplicate',
        message: 'That piece is already in your training samples.',
      };
    }
  }

  // Compute next position.
  const [maxRow] = await db
    .select({ m: max(voiceTrainingSamples.position) })
    .from(voiceTrainingSamples)
    .where(
      and(
        eq(voiceTrainingSamples.userId, user.id),
        eq(voiceTrainingSamples.platform, parsed.platform)
      )
    );
  const nextPosition = (Number(maxRow?.m ?? -1) + 1) | 0;

  // Resolve title + body for corpus samples (snapshot for stability).
  let title: string;
  let body: string;
  let filename: string | null = null;
  let sourceKind: string | null = null;
  let sourceId: string | null = null;

  if (parsed.kind === 'corpus') {
    sourceKind = parsed.sourceKind;
    sourceId = parsed.sourceId;
    const fetched = await fetchCorpusTitleBody(
      user.id,
      parsed.sourceKind,
      parsed.sourceId
    );
    if (!fetched) {
      return {
        ok: false,
        reason: 'invalid',
        message: 'Source piece not found in your space.',
      };
    }
    title = fetched.title;
    body = fetched.body;
  } else if (parsed.kind === 'paste') {
    title = parsed.title.trim();
    body = parsed.body.trim();
  } else {
    title = parsed.title.trim();
    body = parsed.body.trim();
    filename = parsed.filename ?? null;
  }

  const [inserted] = await db
    .insert(voiceTrainingSamples)
    .values({
      userId: user.id,
      platform: parsed.platform,
      kind: parsed.kind,
      sourceKind,
      sourceId,
      title,
      body,
      filename,
      position: nextPosition,
    })
    .returning({ id: voiceTrainingSamples.id });

  revalidatePath('/studio/voice');
  return { ok: true, sampleId: inserted.id };
}

async function fetchCorpusTitleBody(
  userId: string,
  sourceKind: 'newsletter_issue' | 'obsidian_note' | 'linkedin_post',
  sourceId: string
): Promise<{ title: string; body: string } | null> {
  if (sourceKind === 'newsletter_issue') {
    const [r] = await db
      .select({
        title: newsletterIssues.title,
        body: newsletterIssues.bodyText,
      })
      .from(newsletterIssues)
      .where(
        and(
          eq(newsletterIssues.id, sourceId),
          eq(newsletterIssues.userId, userId)
        )
      )
      .limit(1);
    if (!r || !r.body) return null;
    return { title: (r.title || 'Untitled issue').trim(), body: r.body };
  }
  if (sourceKind === 'obsidian_note') {
    const [r] = await db
      .select({ title: obsidianNotes.title, body: obsidianNotes.bodyText })
      .from(obsidianNotes)
      .where(
        and(
          eq(obsidianNotes.id, sourceId),
          eq(obsidianNotes.userId, userId)
        )
      )
      .limit(1);
    if (!r || !r.body) return null;
    return { title: (r.title || 'Untitled note').trim(), body: r.body };
  }
  if (sourceKind === 'linkedin_post') {
    const [r] = await db
      .select({
        body: linkedinPosts.bodyClean,
        rawContent: linkedinPosts.content,
      })
      .from(linkedinPosts)
      .where(
        and(
          eq(linkedinPosts.id, sourceId),
          eq(linkedinPosts.userId, userId)
        )
      )
      .limit(1);
    if (!r) return null;
    const body = (r.body ?? r.rawContent ?? '').trim();
    if (body.length === 0) return null;
    const title = body.split('\n')[0].slice(0, 80) || 'LinkedIn post';
    return { title, body };
  }
  return null;
}

// ─── removeSample ────────────────────────────────────────────────────

const removeSampleSchema = z.object({
  id: z.string().uuid(),
});

export async function removeTrainingSample(input: unknown) {
  const user = await requireUser();
  const { id } = removeSampleSchema.parse(input);

  await db
    .delete(voiceTrainingSamples)
    .where(
      and(
        eq(voiceTrainingSamples.id, id),
        eq(voiceTrainingSamples.userId, user.id)
      )
    );

  revalidatePath('/studio/voice');
  return { ok: true as const };
}

// ─── searchCorpusForTraining ─────────────────────────────────────────
// Used by the Add-from-corpus picker. Returns matching pieces from the
// platform's source kinds, including those NOT yet selected so the
// user can find candidates.

const searchCorpusSchema = z.object({
  platform: z.enum(['longform', 'linkedin']),
  query: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export type CorpusSearchResult = {
  sourceKind: 'newsletter_issue' | 'obsidian_note' | 'linkedin_post';
  id: string;
  title: string;
  snippet: string | null;
  postedAt: string | null;
  alreadySelected: boolean;
  // Vault path for obsidian_note results (e.g., 'essays/trust.md').
  // Null for the other source kinds.
  path: string | null;
  // Approximate body length in chars. Used by the UI to show 'short
  // note' vs 'longform piece' indicators and filter client-side.
  charCount: number;
};

export async function searchCorpusForTraining(
  input: unknown
): Promise<{ results: CorpusSearchResult[] }> {
  const user = await requireUser();
  const parsed = searchCorpusSchema.parse(input);
  const search = parsed.query?.trim();
  // Phase 15 (UX rework, 2026-05-05): vault is excluded from the
  // picker. Vaults mix research notes with actual writing and there's
  // no clean signal at the row level to tell them apart, so the picker
  // surfaces only sources Thoughtbed knows the user authored: their
  // newsletter (longform) and their LinkedIn (shortform). Vault content
  // can still come in via Paste text or Upload file.
  const sourceKinds: ('newsletter_issue' | 'linkedin_post')[] =
    parsed.platform === 'longform' ? ['newsletter_issue'] : ['linkedin_post'];

  // Already-selected source IDs for this platform — used to gray
  // them out in the picker.
  const selectedRows = await db
    .select({
      sourceKind: voiceTrainingSamples.sourceKind,
      sourceId: voiceTrainingSamples.sourceId,
    })
    .from(voiceTrainingSamples)
    .where(
      and(
        eq(voiceTrainingSamples.userId, user.id),
        eq(voiceTrainingSamples.platform, parsed.platform),
        eq(voiceTrainingSamples.kind, 'corpus')
      )
    );
  const selectedSet = new Set(
    selectedRows
      .filter((r) => r.sourceKind && r.sourceId)
      .map((r) => `${r.sourceKind}:${r.sourceId}`)
  );

  const out: CorpusSearchResult[] = [];

  if (sourceKinds.includes('newsletter_issue')) {
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
      if (!r.body || r.body.length < 50) continue; // skip thin rows
      out.push({
        sourceKind: 'newsletter_issue',
        id: r.id,
        title: r.title || 'Untitled issue',
        snippet: r.body.slice(0, 280),
        postedAt: r.postedAt?.toISOString() ?? null,
        alreadySelected: selectedSet.has(`newsletter_issue:${r.id}`),
        path: null,
        charCount: r.body.length,
      });
    }
  }

  if (sourceKinds.includes('linkedin_post')) {
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
      const body = (r.body ?? r.rawContent ?? '').trim();
      if (body.length < 50) continue;
      const title = body.split('\n')[0].slice(0, 80) || 'LinkedIn post';
      out.push({
        sourceKind: 'linkedin_post',
        id: r.id,
        title,
        snippet: body.slice(0, 280),
        postedAt: r.postedAt?.toISOString() ?? null,
        alreadySelected: selectedSet.has(`linkedin_post:${r.id}`),
        path: null,
        charCount: body.length,
      });
    }
  }

  // Sort merged results by postedAt desc when present.
  out.sort((a, b) => {
    const at = a.postedAt ? new Date(a.postedAt).getTime() : 0;
    const bt = b.postedAt ? new Date(b.postedAt).getTime() : 0;
    return bt - at;
  });

  return { results: out.slice(0, parsed.limit) };
}

// ─── updateManualLists ───────────────────────────────────────────────
// Unchanged from the prior shape — manual additions still apply on top
// of Claude's auto-derived schema.

const updateManualListsSchema = z.object({
  platform: z.enum(['longform', 'linkedin']),
  attributes: z.array(z.string().min(1).max(160)).max(20),
  thingsToAvoid: z.array(z.string().min(1).max(160)).max(20),
});

export async function updateManualLists(input: unknown) {
  const user = await requireUser();
  const { platform, attributes, thingsToAvoid } =
    updateManualListsSchema.parse(input);

  const trimmedAttrs = attributes.map((a) => a.trim()).filter((a) => a.length > 0);
  const trimmedAvoid = thingsToAvoid.map((a) => a.trim()).filter((a) => a.length > 0);

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
