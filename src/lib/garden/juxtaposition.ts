// Phase 14b — Garden redesign · creative juxtaposition compute
//
// The marquee partnership move: pair two ideas that create a generative
// tension and surface them with a system-generated provocation question.
//
// Three heuristics (spec section 6, in priority order):
//   · tension_within_theme — same theme cluster, opposite stance
//   · self_disagreement   — same author, contradictory claims (Haiku call)
//   · old_echo_of_new     — recently-claimed idea echoes a dormant ancestor
//
// Cron computes one new juxtaposition per user per day. "Show me another"
// pulls the next-best from the queue.

import { and, desc, eq, gte, isNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  db,
  ideas,
  extractedIdeas,
  gardenJuxtapositions,
  type NewGardenJuxtaposition,
} from '@/db';
import { generateObject } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

const HAIKU = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';

// Cosine distance helpers — pgvector returns 0..2; we use 1 - cosine_dist
// where 1 = identical, 0 = orthogonal, -1 = opposite. For our purposes
// "high distance + shared theme" means "same topic, opposite angle".

interface IdeaCandidate {
  kind: 'idea' | 'extracted_idea';
  id: string;
  title: string;
  preview: string;
  themes: string[];
  embedding: number[] | null;
  // for self_disagreement / authored detection
  isClaimed: boolean;
  // for old_echo_of_new
  temperature: string;
  createdAt: Date;
}

async function loadCandidates(userId: string): Promise<IdeaCandidate[]> {
  const ideaRows = await db
    .select({
      id: ideas.id,
      title: ideas.title,
      preview: ideas.essence,
      themes: ideas.themes,
      embedding: ideas.embedding,
      temperature: ideas.temperature,
      createdAt: ideas.createdAt,
    })
    .from(ideas)
    .where(eq(ideas.userId, userId));

  const extRows = await db
    .select({
      id: extractedIdeas.id,
      title: extractedIdeas.title,
      preview: extractedIdeas.claim,
      embedding: extractedIdeas.embedding,
      temperature: extractedIdeas.temperature,
      createdAt: extractedIdeas.createdAt,
      triageStatus: extractedIdeas.triageStatus,
    })
    .from(extractedIdeas)
    .where(
      and(
        eq(extractedIdeas.userId, userId),
        eq(extractedIdeas.triageStatus, 'pending')
      )
    );

  const out: IdeaCandidate[] = [];
  for (const r of ideaRows) {
    out.push({
      kind: 'idea',
      id: r.id,
      title: r.title,
      preview: r.preview ?? '',
      themes: r.themes ?? [],
      embedding: (r.embedding as unknown as number[] | null) ?? null,
      isClaimed: true,
      temperature: r.temperature,
      createdAt: r.createdAt ? new Date(r.createdAt) : new Date(0),
    });
  }
  for (const r of extRows) {
    out.push({
      kind: 'extracted_idea',
      id: r.id,
      title: r.title,
      preview: r.preview,
      themes: [],
      embedding: (r.embedding as unknown as number[] | null) ?? null,
      isClaimed: false,
      temperature: r.temperature,
      createdAt: r.createdAt ? new Date(r.createdAt) : new Date(0),
    });
  }
  return out;
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    an += a[i] * a[i];
    bn += b[i] * b[i];
  }
  if (an === 0 || bn === 0) return 0;
  return dot / (Math.sqrt(an) * Math.sqrt(bn));
}

interface ScoredPair {
  left: IdeaCandidate;
  right: IdeaCandidate;
  heuristic: 'tension_within_theme' | 'self_disagreement' | 'old_echo_of_new';
  score: number;
}

// ── Heuristic 1: tension within theme ──────────────────────────────────
// Same theme tag(s), low cosine similarity (opposite angle on shared topic).
function scoreTensionWithinTheme(cands: IdeaCandidate[]): ScoredPair[] {
  const out: ScoredPair[] = [];
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      const a = cands[i];
      const b = cands[j];
      if (!a.embedding || !b.embedding) continue;
      const sharedThemes = a.themes.filter((t) => b.themes.includes(t));
      if (sharedThemes.length === 0) continue;
      const cos = cosine(a.embedding, b.embedding);
      // tension = low cosine + theme overlap
      if (cos > 0.5) continue; // not opposite enough
      const score = sharedThemes.length * (1 - cos);
      out.push({
        left: a,
        right: b,
        heuristic: 'tension_within_theme',
        score,
      });
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, 5);
}

// ── Heuristic 2: self-disagreement ──────────────────────────────────────
// Both claimed by the user (or one claimed + one extracted from their own
// vault) AND the system thinks they contradict each other. Cosine high,
// then a Haiku classifier gates.
async function scoreSelfDisagreement(
  cands: IdeaCandidate[]
): Promise<ScoredPair[]> {
  const claimed = cands.filter((c) => c.isClaimed);
  const candidatePairs: { a: IdeaCandidate; b: IdeaCandidate; cos: number }[] = [];
  for (let i = 0; i < claimed.length; i++) {
    for (let j = i + 1; j < claimed.length; j++) {
      const a = claimed[i];
      const b = claimed[j];
      if (!a.embedding || !b.embedding) continue;
      const cos = cosine(a.embedding, b.embedding);
      if (cos < 0.7) continue;
      candidatePairs.push({ a, b, cos });
    }
  }

  candidatePairs.sort((x, y) => y.cos - x.cos);
  const top = candidatePairs.slice(0, 20); // cap Haiku spend

  const out: ScoredPair[] = [];
  for (const { a, b, cos } of top) {
    try {
      const { object } = await generateObject({
        model: anthropic(HAIKU),
        schema: z.object({
          relationship: z.enum(['contradicts', 'echoes', 'unrelated']),
          confidence: z.number().min(0).max(1),
        }),
        prompt:
          `Relationship between these two ideas — do they contradict each other?\n\n` +
          `IDEA A: ${a.title}\n${a.preview}\n\nIDEA B: ${b.title}\n${b.preview}\n\n` +
          `Return 'contradicts' only if they make incompatible claims about the same subject.`,
      });
      if (object.relationship === 'contradicts') {
        out.push({
          left: a,
          right: b,
          heuristic: 'self_disagreement',
          score: cos * object.confidence + 0.5, // boost over tension
        });
      }
    } catch {
      // Skip pair on classifier failure.
    }
  }
  return out;
}

// ── Heuristic 3: old echo of new ───────────────────────────────────────
// Recently-claimed idea (last 7 days) has a dormant/cold ancestor.
function scoreOldEchoOfNew(cands: IdeaCandidate[]): ScoredPair[] {
  const sevenDaysAgo = Date.now() - 1000 * 60 * 60 * 24 * 7;
  const recent = cands.filter(
    (c) => c.isClaimed && c.createdAt.getTime() >= sevenDaysAgo
  );
  const dormant = cands.filter(
    (c) =>
      c.isClaimed &&
      (c.temperature === 'set_aside' || c.temperature === 'cold') &&
      c.createdAt.getTime() < sevenDaysAgo
  );

  const out: ScoredPair[] = [];
  for (const r of recent) {
    if (!r.embedding) continue;
    for (const d of dormant) {
      if (!d.embedding) continue;
      if (r.id === d.id) continue;
      const cos = cosine(r.embedding, d.embedding);
      if (cos < 0.8) continue;
      const ageDays = (Date.now() - d.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      out.push({
        left: r,
        right: d,
        heuristic: 'old_echo_of_new',
        score: cos * Math.min(ageDays / 90, 2),
      });
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, 5);
}

// ── generateProvocation — one Haiku call to produce question + reasoning ─
async function generateProvocation(pair: ScoredPair): Promise<{
  question: string;
  reasoning: string;
}> {
  const { object } = await generateObject({
    model: anthropic(HAIKU),
    schema: z.object({
      question: z
        .string()
        .describe('A one-sentence provocation question that captures the tension'),
      reasoning: z
        .string()
        .describe('A one-sentence "why these two" — the connection or contradiction'),
    }),
    prompt:
      `Two ideas the user is sitting with. Heuristic: ${pair.heuristic}.\n\n` +
      `IDEA A: ${pair.left.title}\n${pair.left.preview}\n\n` +
      `IDEA B: ${pair.right.title}\n${pair.right.preview}\n\n` +
      `Generate:\n` +
      `1. A one-sentence question that captures the tension between these ideas. ` +
      `Address the user as "you" if natural. Don't start with "How might..." or other clichéd openers.\n` +
      `2. A one-sentence reasoning line explaining why these belong together — same theme, opposite stance, or echoing pattern.`,
  });
  return object;
}

// ── computeNextJuxtaposition — main entry point ────────────────────────
//
// Pulls candidates, scores via all three heuristics, picks top, generates
// provocation, persists. Returns the persisted row id.

export async function computeNextJuxtaposition(
  userId: string
): Promise<string | null> {
  const cands = await loadCandidates(userId);
  if (cands.length < 2) return null;

  const tensions = scoreTensionWithinTheme(cands);
  const echoes = scoreOldEchoOfNew(cands);
  // Self-disagreement is expensive; only run if there are at least 4 claimed ideas
  const disagreements =
    cands.filter((c) => c.isClaimed).length >= 4
      ? await scoreSelfDisagreement(cands)
      : [];

  const all = [...tensions, ...echoes, ...disagreements].sort(
    (a, b) => b.score - a.score
  );

  if (all.length === 0) return null;

  // Skip pairs already surfaced and unacted recently (look-back 30 days)
  const recentSurfaced = await db
    .select({
      leftId: gardenJuxtapositions.leftId,
      rightId: gardenJuxtapositions.rightId,
    })
    .from(gardenJuxtapositions)
    .where(
      and(
        eq(gardenJuxtapositions.userId, userId),
        sql`${gardenJuxtapositions.surfacedAt} >= now() - interval '30 days'`
      )
    );
  const surfacedSet = new Set(
    recentSurfaced.flatMap((r) => [`${r.leftId}|${r.rightId}`, `${r.rightId}|${r.leftId}`])
  );

  const pick = all.find((p) => !surfacedSet.has(`${p.left.id}|${p.right.id}`));
  if (!pick) return null;

  let provocation: { question: string; reasoning: string };
  try {
    provocation = await generateProvocation(pick);
  } catch (err) {
    // Fall back to a simple template if Haiku call fails.
    provocation = {
      question: `What's the tension between "${pick.left.title}" and "${pick.right.title}"?`,
      reasoning: `Same theme cluster, opposite stance.`,
    };
  }

  const newRow: NewGardenJuxtaposition = {
    userId,
    heuristic: pick.heuristic,
    leftKind: pick.left.kind,
    leftId: pick.left.id,
    rightKind: pick.right.kind,
    rightId: pick.right.id,
    question: provocation.question,
    reasoning: provocation.reasoning,
    score: pick.score,
    surfacedAt: new Date(),
  };

  const [inserted] = await db
    .insert(gardenJuxtapositions)
    .values(newRow)
    .returning({ id: gardenJuxtapositions.id });

  return inserted?.id ?? null;
}

// ── readActiveJuxtaposition — fetch the row for today's digest ─────────
export async function readActiveJuxtaposition(
  userId: string,
  juxtapositionId: string
) {
  const [row] = await db
    .select()
    .from(gardenJuxtapositions)
    .where(
      and(
        eq(gardenJuxtapositions.id, juxtapositionId),
        eq(gardenJuxtapositions.userId, userId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function pickAnotherJuxtaposition(
  userId: string,
  currentId: string
): Promise<string | null> {
  // Mark current as skipped, compute next.
  await db
    .update(gardenJuxtapositions)
    .set({ actedOn: 'skipped', actedAt: new Date() })
    .where(
      and(
        eq(gardenJuxtapositions.id, currentId),
        eq(gardenJuxtapositions.userId, userId)
      )
    );
  return computeNextJuxtaposition(userId);
}
