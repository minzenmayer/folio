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
