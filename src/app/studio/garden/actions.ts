// Phase 14b — Garden redesign · server actions
//
// All Garden mutations live here. The page reads via src/lib/garden/read.ts;
// the actions write via src/lib/garden/{temperature,digest,juxtaposition,merge}.

'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import {
  db,
  ideas,
  extractedIdeas,
  ideaEdges,
  drafts,
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

// ── Phase 17 (2026-05-05) ─────────────────────────────────────────
// markIdeaPulledIntoDraft — implicit-claim signal. When an idea is
// pulled into a draft via the Reflect rail, the user is endorsing
// it through their writing. If the idea was auto_claimed (not yet
// user-finalized), flip claim_kind to 'claimed' so it stops showing
// the AUTO badge + becomes a true claimed idea. No-op when the idea
// is already 'claimed' or 'authored'.
//
// Also bumps last_visited_at so the existing ripeness math sees the
// activity. The Reflect rail's debounced retrieval already runs on
// the user's text; this action is fire-and-forget from the client.

export async function markIdeaPulledIntoDraft(
  ideaId: string
): Promise<{ ok: true; flipped: boolean } | { ok: false; reason: string }> {
  const user = await requireUser();
  const [row] = await db
    .select({ claimKind: ideas.claimKind })
    .from(ideas)
    .where(and(eq(ideas.id, ideaId), eq(ideas.userId, user.id)))
    .limit(1);
  if (!row) return { ok: false, reason: 'not_found' };

  // Always touch last_visited_at; the implicit-claim flip is the
  // bonus signal for auto_claimed.
  if (row.claimKind === 'auto_claimed') {
    await db
      .update(ideas)
      .set({
        claimKind: 'claimed',
        lastVisitedAt: new Date(),
      })
      .where(and(eq(ideas.id, ideaId), eq(ideas.userId, user.id)));
    revalidate();
    return { ok: true, flipped: true };
  }

  await db
    .update(ideas)
    .set({ lastVisitedAt: new Date() })
    .where(and(eq(ideas.id, ideaId), eq(ideas.userId, user.id)));
  return { ok: true, flipped: false };
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

  // Phase 17 (2026-05-05): editing essence or body on an auto_claimed
  // idea is the refine signal — flip claim_kind to 'claimed' so the
  // AUTO badge disappears + the idea reads as user-finalized.
  if (typeof opts.essence === 'string' || typeof opts.body === 'string') {
    const [existing] = await db
      .select({ claimKind: ideas.claimKind })
      .from(ideas)
      .where(and(eq(ideas.id, opts.ideaId), eq(ideas.userId, user.id)))
      .limit(1);
    if (existing?.claimKind === 'auto_claimed') {
      patch.claimKind = 'claimed';
    }
  }

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

// ── Phase 19.x (2026-05-06) ─────────────────────────────────────
// composeFromIdea — one-click "Write from idea" hand-off.
//
// User clicks the Write button on a Garden card; we create a fresh
// draft pre-seeded with the idea's title (H1) + essence (opening
// paragraph) + body (a "Where I've been on this" italicized note),
// embed the draft, and redirect into the editor in newsletter mode
// so the rail's Resonance zone wakes up next to the writing.
//
// Why this shape: Payton said "I need to go to click a button and
// just go straight into the writing mode, converting this idea
// into it." Goal is zero-friction conversion from Garden card to
// editing surface — no spar, no topic textarea round-trip.
//
// Side effects: marks the idea as visited (so ripeness math sees
// the activity); flips auto_claimed → claimed (pulling into a
// draft is the implicit-claim signal, same logic as
// markIdeaPulledIntoDraft).

export async function composeFromIdea(
  kind: 'idea' | 'extracted_idea',
  id: string
): Promise<never> {
  const user = await requireUser();

  // Load idea + build seed text for the draft. Each kind has a
  // slightly different shape — ideas have title/essence/body,
  // extracted_ideas have title/claim/evidence.
  let title: string;
  let essence: string | null = null;
  let body: string | null = null;

  if (kind === 'idea') {
    const [row] = await db
      .select({
        title: ideas.title,
        essence: ideas.essence,
        body: ideas.body,
        claimKind: ideas.claimKind,
      })
      .from(ideas)
      .where(and(eq(ideas.id, id), eq(ideas.userId, user.id)))
      .limit(1);
    if (!row) throw new Error('idea not found');
    title = row.title;
    essence = row.essence;
    body = row.body;

    // Implicit-claim flip + visit bump in one update.
    if (row.claimKind === 'auto_claimed') {
      await db
        .update(ideas)
        .set({ claimKind: 'claimed', lastVisitedAt: new Date() })
        .where(and(eq(ideas.id, id), eq(ideas.userId, user.id)));
    } else {
      await db
        .update(ideas)
        .set({ lastVisitedAt: new Date() })
        .where(and(eq(ideas.id, id), eq(ideas.userId, user.id)));
    }
  } else {
    const [row] = await db
      .select({
        title: extractedIdeas.title,
        claim: extractedIdeas.claim,
        evidence: extractedIdeas.evidence,
      })
      .from(extractedIdeas)
      .where(
        and(
          eq(extractedIdeas.id, id),
          eq(extractedIdeas.userId, user.id)
        )
      )
      .limit(1);
    if (!row) throw new Error('extracted idea not found');
    title = row.title;
    essence = row.claim;
    body = row.evidence;
  }

  // Build the Tiptap seed doc. Title becomes H1. Essence becomes
  // the opening paragraph. Body — when present — becomes a muted
  // "Where I've been on this" italicized note, blockquote-style,
  // so the user sees their prior thinking but the cursor lands
  // ready to write fresh prose.
  const docContent: Array<Record<string, unknown>> = [
    {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: title }],
    },
  ];

  if (essence && essence.trim().length > 0) {
    docContent.push({
      type: 'paragraph',
      content: [{ type: 'text', text: essence.trim() }],
    });
  }

  if (body && body.trim().length > 0 && body.trim() !== (essence ?? '').trim()) {
    docContent.push({
      type: 'blockquote',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [{ type: 'italic' }],
              text: body.trim(),
            },
          ],
        },
      ],
    });
  }

  // Cursor-ready empty paragraph at the bottom so the editor lands
  // ready to type instead of inside the seeded prose.
  docContent.push({ type: 'paragraph' });

  const initialDoc = { type: 'doc', content: docContent };

  const [draft] = await db
    .insert(drafts)
    .values({
      userId: user.id,
      title,
      contentJson: initialDoc,
    })
    .returning();

  // Embed the seed text so the rail can find adjacent ideas right
  // away. Failure here isn't a blocker.
  try {
    const seedText = [title, essence ?? '', body ?? '']
      .filter((s) => s && s.length > 0)
      .join('\n\n');
    const embedding = await embedText(seedText);
    await db
      .update(drafts)
      .set({ embedding })
      .where(and(eq(drafts.id, draft.id), eq(drafts.userId, user.id)));
  } catch (err) {
    console.warn('[composeFromIdea] embed failed', err);
  }

  revalidatePath('/studio');
  revalidatePath('/studio/garden');
  revalidatePath('/studio/page');

  redirect(`/studio/page/${draft.id}?mode=newsletter`);
}

// ── Phase 19.x (2026-05-06) ─────────────────────────────────────
// appendIdeaNote — "Your take" inline addition.
//
// User adds their own framing onto an idea card without leaving the
// Garden. Goal is logical embedding — not blind append. The note
// becomes a dated "Your take" section added to the bottom of the
// body, separated from prior content, and the entire body re-embeds
// so similarity math picks up the new framing.
//
// Side effects:
//   1. Appends "## Your take · YYYY-MM-DD\n{trimmed}" to body.
//   2. Re-embeds (title + essence + new body) — the note flows
//      into all retrieval queries downstream.
//   3. Bumps lastVisitedAt + last_evolved_at (engagement + evolution
//      signals the maturation engine reads).
//   4. Flips auto_claimed → claimed (a user adding their own take
//      is the same endorsement as pulling into a draft — kills the
//      AUTO badge).
//
// Why not just edit body directly? Because edits feel clinical;
// adding a "Your take" section preserves the original idea while
// surfacing the user's contribution as a distinct layer. Future
// notes will stack as additional sections, building a thinking
// log over time.

export async function appendIdeaNote(opts: {
  kind: 'idea' | 'extracted_idea';
  id: string;
  note: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const user = await requireUser();
  const trimmed = opts.note.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'note required' };
  if (trimmed.length > 4000) return { ok: false, reason: 'note too long' };

  if (opts.kind === 'extracted_idea') {
    // Extracted ideas don't have a body column — they have evidence.
    // For now: claim the extracted idea with the note text. This
    // routes through the normal claim flow so the user gets a real
    // partner ideas row with their take as the body. Calling
    // claimExtractedIdea inline keeps the embedding + provenance
    // logic in one place.
    return claimExtractedIdea({
      extractedId: opts.id,
      claimText: trimmed,
    }).then((r) => {
      if (r.ok) return { ok: true } as const;
      if ('reason' in r) return { ok: false, reason: r.reason } as const;
      return { ok: false, reason: 'claim suggested merge' } as const;
    });
  }

  // Real ideas — append "Your take" section.
  const [row] = await db
    .select({
      title: ideas.title,
      essence: ideas.essence,
      body: ideas.body,
      claimKind: ideas.claimKind,
    })
    .from(ideas)
    .where(and(eq(ideas.id, opts.id), eq(ideas.userId, user.id)))
    .limit(1);
  if (!row) return { ok: false, reason: 'idea not found' };

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const yourTake = `## Your take · ${today}\n${trimmed}`;
  const newBody = row.body && row.body.trim().length > 0
    ? `${row.body.trimEnd()}\n\n${yourTake}`
    : yourTake;

  // Re-embed using the full text. The "Your take" section becomes
  // part of the embedding so the rail's similarity queries surface
  // this idea when the user is writing about adjacent topics.
  let embedding: number[] | null = null;
  try {
    const text = [row.title, row.essence ?? '', newBody]
      .filter((s) => s && s.length > 0)
      .join('\n\n');
    embedding = await embedText(text);
  } catch (err) {
    console.warn('[appendIdeaNote] embed failed', err);
  }

  const patch: Record<string, unknown> = {
    body: newBody,
    updatedAt: new Date(),
    lastVisitedAt: new Date(),
    lastEvolvedAt: new Date(),
  };
  if (row.claimKind === 'auto_claimed') {
    patch.claimKind = 'claimed';
  }
  if (embedding) patch.embedding = embedding;

  await db
    .update(ideas)
    .set(patch)
    .where(and(eq(ideas.id, opts.id), eq(ideas.userId, user.id)));

  revalidate();
  return { ok: true };
}
