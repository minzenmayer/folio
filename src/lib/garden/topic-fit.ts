// Thoughtbed · Topic-fit signal — Phase 19 (2026-05-05)
//
// The maturation engine had no concept of 'is this writing material
// or operational noise?' Every idea got equal treatment. With ~860
// ideas including system-setup notes, Claude scratch, and project
// housekeeping, the engine spent its lifts on stuff the user would
// never write about.
//
// Topic-fit fixes that. We compute a per-idea score in [0..1] that
// answers: 'Does this look like something this user actually writes
// about?'
//
// Score components:
//   · positive = max cosine against the user's PUBLISHED writing
//     corpus (newsletter_issue + linkedin_post embeddings). High
//     cosine = the idea resembles content the user has shipped.
//   · negative = max cosine against the user's SET_ASIDE pool.
//     High cosine = the idea resembles things the user has
//     explicitly told the system to ignore.
//   · final = clamp(positive - 0.5 * negative, 0, 1)
//
// The maturation pass applies topic-fit as a CEILING:
//   fit < 0.45 → temp ceiling 'cool', no maturity lifts at all
//   fit 0.45-0.65 → temp ceiling 'warm'
//   fit ≥ 0.65 → no ceiling (idea can reach hot/ready normally)
//
// Note: ceiling means 'can't go HIGHER than'. Existing user-pinned
// hot ideas stay pinned — see the temperature == 'hot' guard in
// maturation.ts.

import { and, eq } from 'drizzle-orm';
import {
  db,
  newsletterIssues,
  linkedinPosts,
  ideas,
} from '@/db';

const POSITIVE_CORPUS_KINDS = ['newsletter_issue', 'linkedin_post'] as const;

export interface TopicFitInputs {
  // The idea's embedding to score.
  embedding: number[] | null;
}

export interface TopicFitContext {
  // Pre-loaded positive corpus embeddings (newsletter + linkedin).
  positivePool: number[][];
  // Pre-loaded set-aside ideas' embeddings (negative).
  negativePool: number[][];
}

function cosine(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (a.length === 0 || b.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    if (typeof ai !== 'number' || typeof bi !== 'number') return 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function maxCosine(target: number[], pool: number[][]): number {
  let max = 0;
  for (const ref of pool) {
    const c = cosine(target, ref);
    if (c > max) max = c;
  }
  return max;
}

export async function loadTopicFitContext(
  userId: string
): Promise<TopicFitContext> {
  // Positive corpus: published writing.
  const positivePool: number[][] = [];
  try {
    const newsletter = await db
      .select({ embedding: newsletterIssues.embedding })
      .from(newsletterIssues)
      .where(eq(newsletterIssues.userId, userId));
    for (const r of newsletter) {
      if (Array.isArray(r.embedding) && r.embedding.length > 0) {
        positivePool.push(r.embedding);
      }
    }
  } catch (err) {
    console.warn('[topic-fit] newsletter load failed', err);
  }
  try {
    const linkedin = await db
      .select({ embedding: linkedinPosts.embedding })
      .from(linkedinPosts)
      .where(eq(linkedinPosts.userId, userId));
    for (const r of linkedin) {
      if (Array.isArray(r.embedding) && r.embedding.length > 0) {
        positivePool.push(r.embedding);
      }
    }
  } catch (err) {
    console.warn('[topic-fit] linkedin load failed', err);
  }

  // Phase 19 hotfix: also include claimed + authored ideas in the
  // positive corpus. The user has intentionally curated those —
  // they're 'what I write about' signal too, alongside published
  // writing.
  try {
    const claimed = await db
      .select({ embedding: ideas.embedding, claimKind: ideas.claimKind })
      .from(ideas)
      .where(eq(ideas.userId, userId));
    for (const r of claimed) {
      // Only claimed + authored (NOT auto_claimed — those are the
      // ideas we're TRYING to gate; including them would create
      // circularity).
      if (r.claimKind !== 'claimed' && r.claimKind !== 'authored') continue;
      if (Array.isArray(r.embedding) && r.embedding.length > 0) {
        positivePool.push(r.embedding);
      }
    }
  } catch (err) {
    console.warn('[topic-fit] claimed-ideas load failed', err);
  }

  // Negative pool: ideas the user has set aside.
  const negativePool: number[][] = [];
  try {
    const setAside = await db
      .select({ embedding: ideas.embedding })
      .from(ideas)
      .where(
        and(
          eq(ideas.userId, userId),
          eq(ideas.temperature, 'set_aside')
        )
      );
    for (const r of setAside) {
      if (Array.isArray(r.embedding) && r.embedding.length > 0) {
        negativePool.push(r.embedding);
      }
    }
  } catch (err) {
    console.warn('[topic-fit] set-aside load failed', err);
  }

  return { positivePool, negativePool };
}

export function computeTopicFit(
  inputs: TopicFitInputs,
  ctx: TopicFitContext
): number {
  if (!inputs.embedding || inputs.embedding.length === 0) {
    // Without an embedding we can't compute fit. Default to a
    // middling score so the idea isn't punished AND isn't blessed —
    // it'll mature based on the other 5 signals only.
    return 0.5;
  }
  const positive = maxCosine(inputs.embedding, ctx.positivePool);
  const negative = maxCosine(inputs.embedding, ctx.negativePool);
  const score = positive - 0.5 * negative;
  return Math.max(0, Math.min(1, score));
}

// Phase 19 hotfix (2026-05-05): lowered thresholds. Real-use showed
// 818 of 830 ideas hitting the cool ceiling at 0.45 — too aggressive.
// text-embedding-3-small actually scores 'topically aligned but not
// a duplicate' more like 0.35-0.55 for vault-vs-CSL pairs. New levels:
//
//   < 0.30 → cool ceiling (real noise — system setup, Claude scratch)
//   < 0.50 → warm ceiling (mid-topic — can warm but not hot/ready)
//   ≥ 0.50 → no ceiling (writing-worthy — full progression unlocked)

export type TopicFitCeiling = 'cool' | 'warm' | null;

export function topicFitCeiling(score: number): TopicFitCeiling {
  if (score < 0.3) return 'cool';
  if (score < 0.5) return 'warm';
  return null;
}
