// Thoughtbed · Garden auto-claim — Phase 17 (2026-05-05)
//
// Replaces the manual "write a sentence to claim" gate for ideas
// extracted from user-authored sources. The user already wrote the
// prose; the claim is implicit. This module exposes a pure helper
// (autoClaimFromExtracted) that the four extractIdeasFrom* helpers
// call right after they insert extracted_ideas rows, and the
// onboarding mass-claim pass (slice 3) calls per legacy row.
//
// Source kind decides eligibility:
//
//   newsletter_issue / obsidian_note / linkedin_post → AUTO-CLAIM
//   gmail_message                                    → stays unclaimed
//                                                      (clusters in v2)
//
// What auto-claim writes:
//   ideas.title    ← extracted_ideas.title
//   ideas.essence  ← extracted_ideas.claim
//   ideas.body     ← claim + evidence (literal append; voice-rewrite
//                    waits on Voice ID maturity)
//   ideas.maturity ← 'shaping' (real, but not user-finalized)
//   ideas.temperature ← warm if depth_signal > 0.6 OR theme matches
//                       a recent draft, else cool. Uses the existing
//                       smartStartingTemperature helper.
//   ideas.claim_kind  ← 'auto_claimed' (Phase 17 sentinel value)
//   ideas.source_extracted_idea_id ← the originating extracted row
//
// And it flips the source extracted_ideas.triage_status to 'promoted'
// so the unclaimed surface stops showing it (the partner ideas row
// is the visible record now).

import { and, eq, gte, sql } from 'drizzle-orm';
import {
  db,
  ideas,
  extractedIdeas,
  drafts,
  type NewIdea,
} from '@/db';
import { smartStartingTemperature } from './temperature';

// Only these source kinds auto-claim. gmail_message is the deliberate
// hold-out — newsletters the user reads, not wrote, so the partner
// ideas row should still require the user's intent.
const AUTO_CLAIM_KINDS = new Set([
  'newsletter_issue',
  'obsidian_note',
  'linkedin_post',
]);

export function isAutoClaimEligible(sourceKind: string | null | undefined): boolean {
  return sourceKind ? AUTO_CLAIM_KINDS.has(sourceKind) : false;
}

// Build the body text from the extracted row's claim + evidence.
// Literal append — voice-rewrite is a future phase. Trim, drop
// duplicate runs of the claim if the evidence already restates it.
function buildAutoBody(claim: string, evidence: string | null): string {
  const c = claim.trim();
  const e = (evidence ?? '').trim();
  if (e.length === 0) return c;
  if (e.includes(c)) return e;
  return `${c}\n\n${e}`;
}

// Cheap theme-match check used by smartStartingTemperature. We look
// at the user's most recent ~10 drafts to see if any of the
// extracted idea's themes show up in their text. The themes lookup
// is loose — a substring search is enough for a starting-temperature
// signal. Caller passes themes; pass [] to skip the check.
async function hasRecentThemeMatch(
  userId: string,
  themes: string[]
): Promise<boolean> {
  if (themes.length === 0) return false;
  const recent = await db
    .select({ contentJson: drafts.contentJson })
    .from(drafts)
    .where(
      and(
        eq(drafts.userId, userId),
        gte(
          drafts.updatedAt,
          sql`now() - interval '30 days'`
        )
      )
    )
    .orderBy(sql`${drafts.updatedAt} desc`)
    .limit(10);
  if (recent.length === 0) return false;
  const blob = recent
    .map((r) => JSON.stringify(r.contentJson ?? '').toLowerCase())
    .join(' ');
  return themes.some((t) => {
    const tt = t.trim().toLowerCase();
    return tt.length >= 3 && blob.includes(tt);
  });
}

// Pure shape-builder. Doesn't write to the DB. Caller decides whether
// to insert + how to handle the partner extracted row's triage update.
// We mirror the embedding from the extracted row (already computed),
// since the auto-body's vector is dominated by the same claim text.
export interface AutoClaimInput {
  userId: string;
  extractedId: string;
  sourceKind: string;
  title: string;
  claim: string;
  evidence: string | null;
  depthSignal: number | null;
  themes: string[];
  embedding: number[] | null;
}

export async function buildAutoClaim(
  input: AutoClaimInput
): Promise<NewIdea | null> {
  if (!isAutoClaimEligible(input.sourceKind)) return null;

  const themeMatch = await hasRecentThemeMatch(input.userId, input.themes);
  const temperature = smartStartingTemperature({
    hasRecentThemeMatch: themeMatch,
    depthSignal: input.depthSignal,
  });

  const body = buildAutoBody(input.claim, input.evidence);

  return {
    userId: input.userId,
    title: input.title.trim().slice(0, 280),
    essence: input.claim.trim().slice(0, 2000),
    body,
    sourceExtractedIdeaId: input.extractedId,
    maturity: 'shaping',
    temperature,
    claimKind: 'auto_claimed',
    embedding: input.embedding ?? undefined,
    themes: input.themes,
  };
}

// Per-row helper that the extractIdeasFrom* paths call right after
// they insert extracted_ideas. Returns the ideas row id when one is
// created, null when the source kind is not auto-claim eligible.
//
// Idempotent: skips when an ideas row with this source_extracted_idea_id
// already exists for the user.
export async function autoClaimExtractedRow(
  input: AutoClaimInput
): Promise<string | null> {
  if (!isAutoClaimEligible(input.sourceKind)) return null;

  // Already auto-claimed (idempotent — the onboarding pass and the
  // extraction path can both reach the same row).
  const [existing] = await db
    .select({ id: ideas.id })
    .from(ideas)
    .where(
      and(
        eq(ideas.userId, input.userId),
        eq(ideas.sourceExtractedIdeaId, input.extractedId)
      )
    )
    .limit(1);
  if (existing) return existing.id;

  const newRow = await buildAutoClaim(input);
  if (!newRow) return null;

  const [inserted] = await db
    .insert(ideas)
    .values(newRow)
    .returning({ id: ideas.id });
  if (!inserted) return null;

  await db
    .update(extractedIdeas)
    .set({
      triageStatus: 'promoted',
      triagedAt: sql`now()`,
    })
    .where(
      and(
        eq(extractedIdeas.userId, input.userId),
        eq(extractedIdeas.id, input.extractedId)
      )
    );

  return inserted.id;
}
