// Thoughtbed · single source of truth for retrieval kinds.
//
// findSimilar (in src/app/studio/actions.ts) and generateReflection (in
// src/lib/llm.ts) both need to know the union of kinds the retrieval
// layer can return. Before Sprint 15 Wave 3, these lived as duplicate
// type unions — and one of them (reflect's call site) drifted out of
// sync with the other when newsletter_issue was added in Sprint 13. This
// module centralizes the truth so adding a kind requires touching one
// place, not three.
//
// The const array drives both the TypeScript union and the Zod schema.

export const SIMILAR_KINDS = [
  'capture',
  'idea',
  'draft',
  // Sprint 13: the user's own past newsletter issues (Beehiiv archive).
  'newsletter_issue',
  // Sprint 15 Wave 3: their Obsidian vault notes.
  'obsidian_note',
  // Phase 12 (2026-05-04): their LinkedIn post archive (Apify scrape).
  'linkedin_post',
  // Phase 13 (2026-05-04): newsletters they receive in Gmail (OAuth, Testing
  // mode). Promoted-only — a triaged subset of detected newsletter messages.
  'gmail_message',
  // Sprint 15 Wave 3: the curated Idea layer extracted from any source.
  // Distinct from 'idea' (which is the user's hand-authored ideas table)
  // — extracted_idea is title + claim + evidence pulled from a newsletter
  // issue or obsidian note by extractIdeas() during sync.
  'extracted_idea',
] as const;

export type SimilarKind = (typeof SIMILAR_KINDS)[number];

// Zod expects a non-readonly tuple; spreading into a fresh array is the
// canonical fix while keeping SIMILAR_KINDS itself frozen.
export const SIMILAR_KINDS_FOR_ZOD = [...SIMILAR_KINDS] as [
  SimilarKind,
  ...SimilarKind[],
];

// ── Phase 15b (2026-05-05) ──────────────────────────────────────────
// Retrieval buckets. The home composer's sparring-partner prompt
// distinguishes between *how the user writes* (voice) and *what they've
// read* (knowledge). The voice side splits further by surface, because
// Payton's longform voice (CSL newsletter / Obsidian) and his LinkedIn
// voice are genuinely different — flattening them averages out both.
//
//   voice_longform  — user-authored sources that read as essay-shape:
//                     newsletter_issue, obsidian_note, draft, idea, capture,
//                     plus extracted_ideas pulled from those.
//   voice_shortform — user-authored short-form: linkedin_post, plus
//                     extracted_ideas pulled from linkedin posts.
//   knowledge       — things the user *reads*, not writes: gmail_message,
//                     plus extracted_ideas pulled from gmail.
//
// `bucket(hit)` accepts either a bare SimilarKind or a partial SimilarHit
// shape with a `sourceKind` (the originating kind for extracted_idea
// rows). For extracted_idea without a known sourceKind, default to
// voice_longform — that's where extracted ideas overwhelmingly land in
// today's corpus and avoids polluting the knowledge bucket with
// user-authored material.
export type RetrievalBucket =
  | 'voice_longform'
  | 'voice_shortform'
  | 'knowledge';

export function bucket(
  input: SimilarKind | { kind: SimilarKind; sourceKind?: SimilarKind | null }
): RetrievalBucket {
  const kind = typeof input === 'string' ? input : input.kind;
  const sourceKind =
    typeof input === 'string' ? null : (input.sourceKind ?? null);

  switch (kind) {
    case 'newsletter_issue':
    case 'obsidian_note':
    case 'capture':
    case 'idea':
    case 'draft':
      return 'voice_longform';
    case 'linkedin_post':
      return 'voice_shortform';
    case 'gmail_message':
      return 'knowledge';
    case 'extracted_idea': {
      if (!sourceKind) return 'voice_longform';
      // Recurse with the source kind. Source can never itself be
      // extracted_idea (FK constraint), so this terminates after one hop.
      return bucket(sourceKind);
    }
  }
}
