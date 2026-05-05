// Phase 14b — Garden redesign · shared types
// Single source of truth for the unified Garden's vocabulary.

export const TEMPERATURES = [
  'hot',
  'warm',
  'cool',
  'cold',
  'set_aside',
] as const;
export type Temperature = (typeof TEMPERATURES)[number];

export const MATURITIES = [
  'seed',
  'forming',
  'shaping',
  'ready',
  'circulated',
  'dormant',
] as const;
export type Maturity = (typeof MATURITIES)[number];

export type GardenItemKind = 'idea' | 'extracted_idea';

// The unified-read shape both the digest and the feed consume.
export interface GardenItem {
  kind: GardenItemKind;
  id: string;
  title: string;
  // ideas.essence | extracted_ideas.claim
  preview: string;
  temperature: Temperature;
  // 'seed' for extracted (always projected as seed in unified read)
  maturity: Maturity;
  themes: string[];
  // For extracted: which source kind. Null for hand-authored ideas.
  sourceKind: string | null;
  sourceRef: string | null;
  // ripeness in [0..1]; computed in-memory in src/lib/garden/temperature.ts
  ripeness: number;
  lastVisitedAt: Date | null;
  digestSurfaceCount: number;
  // True when this idea has user-authored framing (ideas.body / claim_text).
  isClaimed: boolean;
  // Phase 14b auxiliary
  evidence?: string | null;
  body?: string | null;
}
