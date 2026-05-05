// Phase 14b — Garden redesign · server actions
//
// All Garden mutations live here. The page reads via src/lib/garden/read.ts;
// the actions write via src/lib/garden/{temperature,digest,juxtaposition,merge}.

'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  ideas,
  extractedIdeas,
  ideaEdges,
  gardenJuxtapositions,
  type NewIdea,
} from '@/db';
import { requireUser } from '@/lib/auth';
import { embedText } from '@/lib/embed';
import type { Temperature } from '@/lib/garden/types';
import { stepDown, stepUp, smartStartingTemperature } from '@/lib/garden/temperature';
import { findMergeTarget, mergeExtractedIntoIdea, type MergeMode } from '@/lib/garden/merge';
import {
  computeNextJuxtaposition,
  pickAnotherJuxtaposition,
  readActiveJuxtaposition,
} from '@/lib/garden/juxtaposition';

const REVALIDATE_PATHS = ['/studio/garden', '/studio'];

function revalidate() {
  for (const p of REVALIDATE_PATHS) revalidatePath(p);
}

// ── Temperature actions ────────────────────────────────────────────────

export async function setTemperature(
  kind: 'idea' | 'extracted_idea',
  id: string,
  temperature: Temperature
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const user = await requireUser();
  const tbl = kind === 'idea' ? ideas : extractedIdeas;
  const updated = await db
    .update(tbl)
    .set({
      temperature,
      temperatureUpdatedAt: new Date(),
      digestSurfaceCount: 0,
    })
    .where(and(eq(tbl.id, id), eq(tbl.userId, user.id)))
    .returning({ id: tbl.id });
  if (updated.length === 0) return { ok: false, reason: 'not found' };
  revalidate();
  return { ok: true };
}

export async function markHot(
  kind: 'idea' | 'extracted_idea',
  id: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const user = await requireUser();
  const tbl = kind === 'idea' ? ideas : extractedIdeas;
  const pinUntil =
    kind === 'idea'
      ? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
      : null;

  if (kind === 'idea') {
    await db
      .update(ideas)
      .set({
        temperature: 'hot',
        temperatureUpdatedAt: new Date(),
        digestSurfaceCount: 0,
        pinnedUntil: pinUntil,
      })
      .where(and(eq(ideas.id, id), eq(ideas.userId, user.id)));
  } else {
    await db
      .update(extractedIdeas)
      .set({
        temperature: 'hot',
        temperatureUpdatedAt: new Date(),
        digestSurfaceCount: 0,
      })
      .where(and(eq(extractedIdeas.id, id), eq(extractedIdeas.userId, user.id)));
  }
  revalidate();
  return { ok: true };
}

export async function coolIt(
  kind: 'idea' | 'extracted_idea',
  id: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const user = await requireUser();
  const tbl = kind === 'idea' ? ideas : extractedIdeas;
  // Read current temperature, step down once.
  const [row] = await db
    .select({ t: tbl.temperature })
    .from(tbl)
    .where(and(eq(tbl.id, id), eq(tbl.userId, user.id)))
    .limit(1);
  if (!row) return { ok: false, reason: 'not found' };
  const next = stepDown(row.t as Temperature);
  await db
    .update(tbl)
    .set({ temperature: next, temperatureUpdatedAt: new Date() })
    .where(and(eq(tbl.id, id), eq(tbl.userId, user.id)));
  revalidate();
  return { ok: true };
}

export async function setAside(
  kind: 'idea' | 'extracted_idea',
  id: string
): Promise<{ ok: true }> {
  await setTemperature(kind, id, 'set_aside');
  return { ok: true };
}

export async function bringBack(
  kind: 'idea' | 'extracted_idea',
  id: string
): Promise<{ ok: true }> {
  const user = await requireUser();
  const tbl = kind === 'idea' ? ideas : extractedIdeas;
  if (kind === 'idea') {
    await db
      .update(ideas)
      .set({
        temperature: 'warm',
        temperatureUpdatedAt: new Date(),
        digestSurfaceCount: 0,
        pinnedUntil: null,
      })
      .where(and(eq(ideas.id, id), eq(ideas.userId, user.id)));
  } else {
    await db
      .update(extractedIdeas)
      .set({
        temperature: 'warm',
        temperatureUpdatedAt: new Date(),
        digestSurfaceCount: 0,
      })
      .where(and(eq(extractedIdeas.id, id), eq(extractedIdeas.userId, user.id)));
  }
  revalidate();
  return { ok: true };
}

// ── Open / visit ───────────────────────────────────────────────────────

export async function markVisited(ideaId: string): Promise<void> {
  const user = await requireUser();
  await db
    .update(ideas)
    .set({ lastVisitedAt: new Date() })
    .where(and(eq(ideas.id, ideaId), eq(ideas.userId, user.id)));
  revalidate();
}

// ── Claim flow — "Make it mine" textarea submit ────────────────────────
//
// The user wrote a sentence on an unclaimed extracted_idea. We:
//   1. Embed the claim text + source claim to find any existing match
//      above 0.85 cosine — if found, redirect to merge instead.
//   2. Otherwise create a new ideas row with body=claimText, link back via
//      source_extracted_idea_id, mark extracted_idea as 'promoted'.
//   3. Bump temperature based on smart starting rules.

export async function claimExtractedIdea(opts: {
  extractedId: string;
  claimText: string;
}): Promise<
  | { ok: true; ideaId: string; mergedInto?: string }
  | { ok: true; mergeSuggested: { targetIdeaId: string; cosine: number } }
  | { ok: false; reason: string }
> {
  const user = await requireUser();
  const trimmed = opts.claimText.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'claim text required' };
  }

  const [ext] = await db
    .select()
    .from(extractedIdeas)
    .where(
      and(
        eq(extractedIdeas.id, opts.extractedId),
        eq(extractedIdeas.userId, user.id)
      )
    )
    .limit(1);
  if (!ext) return { ok: false, reason: 'extracted idea not found' };

  // Build the text we'll embed (claim + user's framing) for merge probe.
  let embedding: number[] | null = null;
  try {
    embedding = await embedText(`${ext.title}\n\n${ext.claim}\n\n${trimmed}`);
  } catch {
    embedding = null;
  }

  // Probe for merge target.
  if (embedding) {
    const target = await findMergeTarget(user.id, embedding);
    if (target) {
      return { ok: true, mergeSuggested: { targetIdeaId: target.ideaId, cosine: target.cosine } };
    }
  }

  // No match — create the partner ideas row.
  const startingTemp = smartStartingTemperature({
    hasRecentThemeMatch: false, // TODO: theme matching with drafts
    depthSignal: ext.depthSignal ?? null,
  });

  const newIdea: NewIdea = {
    userId: user.id,
    title: ext.title,
    essence: ext.claim,
    body: trimmed,
    maturity: 'shaping',
    temperature: startingTemp,
    claimKind: 'claimed',
    sourceExtractedIdeaId: ext.id,
    embedding: embedding as unknown as number[] | null,
  };

  const [inserted] = await db
    .insert(ideas)
    .values(newIdea)
    .returning({ id: ideas.id });

  await db
    .update(extractedIdeas)
    .set({
      triageStatus: 'promoted',
      triagedAt: new Date(),
      claimText: trimmed,
    })
    .where(eq(extractedIdeas.id, ext.id));

  revalidate();
  return { ok: true, ideaId: inserted.id };
}

// ── Confirmed merge — user picked a path in the merge modal ────────────

export async function confirmMerge(opts: {
  extractedId: string;
  targetIdeaId: string;
  mode: MergeMode;
  claimText?: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const user = await requireUser();
  const result = await mergeExtractedIntoIdea({
    userId: user.id,
    extractedId: opts.extractedId,
    targetIdeaId: opts.targetIdeaId,
    mode: opts.mode,
    claimText: opts.claimText,
  });
  if (result.ok) revalidate();
  return result;
}

// ── Edit title / essence / body ────────────────────────────────────────

export async function updateIdea(opts: {
  ideaId: string;
  title?: string;
  essence?: string;
  body?: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const user = await requireUser();
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof opts.title === 'string') patch.title = opts.title;
  if (typeof opts.essence === 'string') patch.essence = opts.essence;
  if (typeof opts.body === 'string') patch.body = opts.body;
  if (Object.keys(patch).length === 1) return { ok: false, reason: 'nothing to update' };

  // Re-embed if essence or body changed.
  if (typeof opts.essence === 'string' || typeof opts.body === 'string') {
    const [row] = await db
      .select({ title: ideas.title, essence: ideas.essence, body: ideas.body })
      .from(ideas)
      .where(and(eq(ideas.id, opts.ideaId), eq(ideas.userId, user.id)))
      .limit(1);
    if (row) {
      const text = [
        opts.title ?? row.title,
        opts.essence ?? row.essence ?? '',
        opts.body ?? row.body ?? '',
      ]
        .filter((s) => s && s.length > 0)
        .join('\n\n');
      try {
        const e = await embedText(text);
        patch.embedding = e;
      } catch {
        // Skip embedding update on failure; not a blocker.
      }
    }
  }

  await db
    .update(ideas)
    .set(patch)
    .where(and(eq(ideas.id, opts.ideaId), eq(ideas.userId, user.id)));
  revalidate();
  return { ok: true };
}

// ── Juxtaposition actions ──────────────────────────────────────────────

export async function claimTension(
  juxtapositionId: string
): Promise<{ ok: true; newIdeaId: string } | { ok: false; reason: string }> {
  const user = await requireUser();
  const jx = await readActiveJuxtaposition(user.id, juxtapositionId);
  if (!jx) return { ok: false, reason: 'juxtaposition not found' };

  // Resolve the two ancestor ideas to seed the body.
  const leftLabel =
    jx.leftKind === 'idea'
      ? (await db.select({ t: ideas.title }).from(ideas).where(eq(ideas.id, jx.leftId)).limit(1))[0]?.t
      : (await db
          .select({ t: extractedIdeas.title })
          .from(extractedIdeas)
          .where(eq(extractedIdeas.id, jx.leftId))
          .limit(1))[0]?.t;
  const rightLabel =
    jx.rightKind === 'idea'
      ? (await db.select({ t: ideas.title }).from(ideas).where(eq(ideas.id, jx.rightId)).limit(1))[0]?.t
      : (await db
          .select({ t: extractedIdeas.title })
          .from(extractedIdeas)
          .where(eq(extractedIdeas.id, jx.rightId))
          .limit(1))[0]?.t;

  const stubBody = `Two ideas in tension:
  · ${leftLabel ?? '(unknown)'}
  · ${rightLabel ?? '(unknown)'}

${jx.reasoning}

What's the angle that holds both?`;

  const [newIdea] = await db
    .insert(ideas)
    .values({
      userId: user.id,
      title: jx.question,
      essence: jx.reasoning,
      body: stubBody,
      maturity: 'forming',
      temperature: 'warm',
      claimKind: 'claimed',
    })
    .returning({ id: ideas.id });

  // Link both ancestors via idea_edges (only if they're real ideas;
  // extracted_idea rows aren't on the FK). For extracted_idea ancestors
  // we skip the edge row — the lineage lives in garden_juxtapositions.
  if (jx.leftKind === 'idea') {
    await db.insert(ideaEdges).values({
      fromIdea: jx.leftId,
      toIdea: newIdea.id,
      kind: 'parent',
      strength: 1.0,
      userConfirmed: 1,
    });
  }
  if (jx.rightKind === 'idea') {
    await db.insert(ideaEdges).values({
      fromIdea: jx.rightId,
      toIdea: newIdea.id,
      kind: 'parent',
      strength: 1.0,
      userConfirmed: 1,
    });
  }

  await db
    .update(gardenJuxtapositions)
    .set({ actedOn: 'claimed', actedAt: new Date() })
    .where(eq(gardenJuxtapositions.id, juxtapositionId));

  revalidate();
  return { ok: true, newIdeaId: newIdea.id };
}

export async function showAnotherJuxtaposition(
  currentId: string
): Promise<{ ok: true; nextId: string | null }> {
  const user = await requireUser();
  const next = await pickAnotherJuxtaposition(user.id, currentId);
  revalidate();
  return { ok: true, nextId: next };
}

export async function dismissJuxtaposition(
  id: string
): Promise<{ ok: true }> {
  const user = await requireUser();
  await db
    .update(gardenJuxtapositions)
    .set({ actedOn: 'skipped', actedAt: new Date() })
    .where(
      and(
        eq(gardenJuxtapositions.id, id),
        eq(gardenJuxtapositions.userId, user.id)
      )
    );
  revalidate();
  return { ok: true };
}

// ── Manual juxtaposition compute (for the cron + dev) ──────────────────

export async function computeJuxtapositionForUser(): Promise<{
  ok: true;
  juxtapositionId: string | null;
}> {
  const user = await requireUser();
  const id = await computeNextJuxtaposition(user.id);
  return { ok: true, juxtapositionId: id };
}
