// Phase 14b — Garden redesign · Temperature transitions + ripeness scoring
//
// Lifecycle rules (see spec section 3):
//   · Idea retrieved into Reflect rail → bumps temperature one step (capped at hot)
//   · Idea opened from Garden → sets last_visited_at; no temp change unless pinned
//   · Surfaced in digest 3× without action → cools one step (anti-calcification)
//   · No visit / retrieval in 30 days → cools one step
//   · "Mark hot" → temperature='hot', pinned_until = now() + 14 days
//   · "Set aside" → temperature='set_aside'; hidden from digest
//
// All transitions go through the helpers in this module. The cron sweep
// in src/app/api/cron/garden-digest/route.ts calls applyAutoCooling.

import type { Temperature } from './types';

// ── Step semantics ───────────────────────────────────────────────────────
// Cooling steps in order from hot → cold. set_aside is not on the chain;
// it's a manual gesture that lifts an idea off the ladder entirely.
const COOL_CHAIN: Temperature[] = ['hot', 'warm', 'cool', 'cold'];

export function stepDown(t: Temperature): Temperature {
  if (t === 'set_aside') return 'set_aside';
  const idx = COOL_CHAIN.indexOf(t);
  if (idx < 0) return 'cool'; // defensive
  return COOL_CHAIN[Math.min(idx + 1, COOL_CHAIN.length - 1)];
}

export function stepUp(t: Temperature): Temperature {
  if (t === 'set_aside') return 'warm';
  const idx = COOL_CHAIN.indexOf(t);
  if (idx < 0) return 'warm';
  return COOL_CHAIN[Math.max(idx - 1, 0)];
}

// ── Ripeness score ──────────────────────────────────────────────────────
// Hidden from cards; powers the default sort order of the digest + feed.
// The digest_freshness term penalizes ideas the system has surfaced
// repeatedly without action — that's the rule that breaks calcification.

const TEMP_WEIGHT: Record<Temperature, number> = {
  hot: 1.0,
  warm: 0.7,
  cool: 0.4,
  cold: 0.15,
  set_aside: 0.0,
};

const MATURITY_WEIGHT: Record<string, number> = {
  seed: 0.2,
  forming: 0.4,
  shaping: 0.6,
  ready: 1.0,
  circulated: 0.8,
  dormant: 0.1,
};

export interface RipenessInputs {
  temperature: Temperature;
  maturity: string;
  // ms since last visit; null = never visited
  msSinceVisit: number | null;
  // # times retrieved into Reflect rail in last 14 days
  retrievalCount14d: number;
  // # times surfaced in digest without action
  digestSurfaceCount: number;
}

export function computeRipeness(i: RipenessInputs): number {
  const tempW = TEMP_WEIGHT[i.temperature] ?? 0.4;
  const matW = MATURITY_WEIGHT[i.maturity] ?? 0.4;

  // 30-day exponential decay on visit recency (1.0 at visit, 0 after ~30d)
  const recencyW =
    i.msSinceVisit === null
      ? 0.3 // never-visited: middling
      : Math.max(0, Math.exp(-i.msSinceVisit / (1000 * 60 * 60 * 24 * 30)));

  // Retrieval frequency: capped saturation at 5 hits in 14d
  const retrievalW = Math.min(1.0, i.retrievalCount14d / 5);

  // Digest freshness: 1.0 at 0 surfaces, 0.2 floor at 5+
  const digestFreshnessW = Math.max(0.2, 1 - i.digestSurfaceCount / 5);

  return (
    0.4 * tempW +
    0.2 * matW +
    0.15 * recencyW +
    0.15 * retrievalW +
    0.1 * digestFreshnessW
  );
}

// ── Smart starting temperature for newly-claimed ideas ──────────────────
// Per spec section 3: warm if themes match recent drafts OR depth_signal
// > 0.7, else cool. The caller passes the inputs they have access to.

export function smartStartingTemperature(opts: {
  hasRecentThemeMatch: boolean;
  depthSignal: number | null;
}): Temperature {
  if (opts.hasRecentThemeMatch) return 'warm';
  if (opts.depthSignal !== null && opts.depthSignal > 0.7) return 'warm';
  return 'cool';
}
