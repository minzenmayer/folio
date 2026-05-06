// Thoughtbed · Maturation engine — Phase 18 (2026-05-05)
//
// Daily pass that LIFTS ideas based on signals the system already
// captures. Pairs with the Phase 14b cooling sweep — cooling cools,
// maturation warms, both clamp to the ladder.
//
// Signals (all stack):
//
//   1. Depth + breadth on entry. Auto-claimed ideas land at the
//      correct rung based on source quality. Re-evaluated each pass
//      so the formula naturally re-ranks the existing 806.
//        depth >= 0.8 AND breadth >= 0.6 → maturity floor 'ready'
//        depth >= 0.6                    → maturity floor 'shaping'
//        depth >= 0.7                    → temperature floor 'warm'
//
//   2. Cross-source resonance. Idea has cosine ≥ 0.80 against ideas
//      / extracted_ideas from N distinct source kinds.
//        2+ kinds → +1 temperature step
//        3+ kinds → +1 maturity step
//
//   3. Cluster density. Today's idea_clusters membership.
//        member of cluster of ≥3 → +1 temperature step
//        cluster representative AND ≥5 members → +1 maturity step
//
//   4. Draft-resonance. Max cosine against the user's drafts
//      updated in the last 30 days.
//        max cosine ≥ 0.75 → +1 temperature step
//        max cosine ≥ 0.85 → +1 maturity step
//
//   5. Connectedness. idea_edges where this idea is on either side.
//        ≥3 edges → +1 temperature step
//        ≥5 edges → +1 maturity step
//
// Lifts CAP at one step per signal per pass. Lifts STACK across
// signals — a single high-resonance idea can move +2 maturity in
// one pass (e.g., signals 2 + 4 each contribute a maturity step).
// Final values are clamped to the ladder.
//
// Pass scope: only lifts ideas where claim_kind in
// ('auto_claimed', 'authored', 'claimed'). The auto_claimed ones get
// the lifts that mostly matter (the legacy backlog). authored /
// claimed ideas can still receive lifts — the formula treats them
// the same — but the user has already endorsed them so the lifts
// just reinforce.
//
// Wraps in try/catch at each query to tolerate missing schema (e.g.,
// migration 0015 not applied yet).

import { and, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { db, ideas, extractedIdeas, drafts, ideaEdges, ideaClusters } from '@/db';
import type { Maturity, Temperature } from './types';

// Phase 18 hotfix (2026-05-05): lowered thresholds. The 0.80 cosine
// was too conservative for corpora with mixed embedding qualities and
// older claimed ideas. New levels:
//   resonance: 0.72 (was 0.80) — catches near-duplicate themes
//   draft-resonance temp: 0.65 (was 0.75) — looser since drafts are
//     long and average-pool poorly against single-claim embeddings
//   draft-resonance maturity: 0.78 (was 0.85)
//   recent days: 60 (was 30) — wider window for sparse writers
const COSINE_RESONANCE_THRESHOLD = 0.72;
const COSINE_DRAFT_THRESHOLD_TEMP = 0.65;
const COSINE_DRAFT_THRESHOLD_MAT = 0.78;
const DRAFT_RECENT_DAYS = 60;

const MATURITY_LADDER: Maturity[] = [
  'seed',
  'forming',
  'shaping',
  'ready',
  'circulated',
  'dormant',
];

const TEMP_LADDER: Temperature[] = ['cold', 'cool', 'warm', 'hot'];

function maturityIndex(m: Maturity): number {
  return MATURITY_LADDER.indexOf(m);
}
function tempIndex(t: Temperature): number {
  return TEMP_LADDER.indexOf(t);
}

function bumpMaturity(m: Maturity, steps: number): Maturity {
  if (m === 'circulated' || m === 'dormant') return m; // user-state; don't auto-step past
  const i = maturityIndex(m);
  if (i < 0) return m;
  const target = Math.min(i + steps, maturityIndex('ready'));
  return MATURITY_LADDER[target];
}
function bumpTemperature(t: Temperature, steps: number): Temperature {
  if (t === 'set_aside') return t;
  const i = tempIndex(t);
  if (i < 0) return t;
  const target = Math.min(i + steps, tempIndex('hot'));
  return TEMP_LADDER[target];
}

function maxMaturity(a: Maturity, b: Maturity): Maturity {
  return maturityIndex(a) >= maturityIndex(b) ? a : b;
}
function maxTemperature(a: Temperature, b: Temperature): Temperature {
  if (a === 'set_aside' || b === 'set_aside') {
    return a === 'set_aside' ? b : a;
  }
  return tempIndex(a) >= tempIndex(b) ? a : b;
}

interface IdeaCand {
  id: string;
  title: string;
  themes: string[];
  embedding: number[];
  temperature: Temperature;
  maturity: Maturity;
  claimKind: string | null;
  sourceExtractedIdeaId: string | null;
  // depth/breadth come from the originating extracted_idea when claimed
  depthSignal: number | null;
  breadthSignal: number | null;
}

interface ExtractedCand {
  id: string;
  sourceKind: string;
  embedding: number[];
}

interface DraftCand {
  id: string;
  embedding: number[];
}

function cosine(a: unknown, b: unknown): number {
  // Defensive: pgvector embeddings sometimes round-trip as strings
  // depending on Drizzle adapter config. Reject anything that isn't
  // a real number array.
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

async function loadIdeas(userId: string): Promise<IdeaCand[]> {
  const ideaRows = await db
    .select({
      id: ideas.id,
      title: ideas.title,
      themes: ideas.themes,
      embedding: ideas.embedding,
      temperature: ideas.temperature,
      maturity: ideas.maturity,
      claimKind: ideas.claimKind,
      sourceExtractedIdeaId: ideas.sourceExtractedIdeaId,
    })
    .from(ideas)
    .where(eq(ideas.userId, userId));

  const sourceIds = ideaRows
    .map((r) => r.sourceExtractedIdeaId)
    .filter((s): s is string => !!s);

  // Pull the originating extracted_ideas' depth/breadth signals so the
  // entry-rule (signal #1) has data to read. One IN(...) query.
  const sigMap = new Map<string, { depth: number; breadth: number }>();
  if (sourceIds.length > 0) {
    const sigs = await db
      .select({
        id: extractedIdeas.id,
        depth: extractedIdeas.depthSignal,
        breadth: extractedIdeas.breadthSignal,
      })
      .from(extractedIdeas)
      .where(
        and(
          eq(extractedIdeas.userId, userId),
          inArray(extractedIdeas.id, sourceIds)
        )
      );
    for (const s of sigs) sigMap.set(s.id, { depth: s.depth, breadth: s.breadth });
  }

  const out: IdeaCand[] = [];
  for (const r of ideaRows) {
    // Phase 18 hotfix (2026-05-05): keep ideas without embeddings.
    // cosine() returns 0 for non-array embeddings, so signals 2/4
    // safely no-op. Signals 1/3/5 don't need embeddings to fire.
    // This means inspected reflects the actual ideas count, not
    // just the embedded subset.
    const sig = r.sourceExtractedIdeaId ? sigMap.get(r.sourceExtractedIdeaId) : null;
    out.push({
      id: r.id,
      title: r.title,
      themes: r.themes ?? [],
      embedding: (r.embedding ?? []) as number[],
      temperature: r.temperature as Temperature,
      maturity: r.maturity as Maturity,
      claimKind: r.claimKind,
      sourceExtractedIdeaId: r.sourceExtractedIdeaId,
      depthSignal: sig?.depth ?? null,
      breadthSignal: sig?.breadth ?? null,
    });
  }
  return out;
}

async function loadResonancePool(userId: string): Promise<ExtractedCand[]> {
  const rows = await db
    .select({
      id: extractedIdeas.id,
      sourceKind: extractedIdeas.sourceKind,
      embedding: extractedIdeas.embedding,
    })
    .from(extractedIdeas)
    .where(eq(extractedIdeas.userId, userId));
  const out: ExtractedCand[] = [];
  for (const r of rows) {
    if (!r.embedding) continue;
    out.push({ id: r.id, sourceKind: r.sourceKind, embedding: r.embedding });
  }
  return out;
}

async function loadRecentDrafts(userId: string): Promise<DraftCand[]> {
  const rows = await db
    .select({
      id: drafts.id,
      embedding: drafts.embedding,
    })
    .from(drafts)
    .where(
      and(
        eq(drafts.userId, userId),
        gte(drafts.updatedAt, sql`now() - (${DRAFT_RECENT_DAYS} || ' days')::interval`)
      )
    );
  const out: DraftCand[] = [];
  for (const r of rows) {
    if (!r.embedding) continue;
    out.push({ id: r.id, embedding: r.embedding });
  }
  return out;
}

async function loadEdgeCounts(userId: string): Promise<Map<string, number>> {
  // idea_edges has from_idea + to_idea; we count per-idea distinct
  // partners. Cheap aggregate query.
  const map = new Map<string, number>();
  try {
    const rows = await db
      .select({
        fromIdea: ideaEdges.fromIdea,
        toIdea: ideaEdges.toIdea,
      })
      .from(ideaEdges);
    for (const r of rows) {
      map.set(r.fromIdea, (map.get(r.fromIdea) ?? 0) + 1);
      map.set(r.toIdea, (map.get(r.toIdea) ?? 0) + 1);
    }
  } catch (err) {
    console.warn('[maturation] idea_edges load failed', err);
  }
  return map;
}

async function loadTodayClusters(userId: string): Promise<{
  membership: Map<string, { size: number; isRep: boolean }>;
}> {
  const today = new Date().toISOString().slice(0, 10);
  const membership = new Map<string, { size: number; isRep: boolean }>();
  try {
    const rows = await db
      .select({
        repKind: ideaClusters.repKind,
        repId: ideaClusters.repId,
        memberCount: ideaClusters.memberCount,
        members: ideaClusters.members,
      })
      .from(ideaClusters)
      .where(
        and(
          eq(ideaClusters.userId, userId),
          eq(ideaClusters.runDate, today)
        )
      );
    for (const r of rows) {
      // The cluster's representative + each member contribute the cluster's size.
      if (r.repKind === 'idea') {
        membership.set(r.repId, { size: r.memberCount, isRep: true });
      }
      const memArr = (r.members as Array<{ kind: string; id: string }>) ?? [];
      for (const m of memArr) {
        if (m.kind !== 'idea') continue;
        const existing = membership.get(m.id);
        if (!existing) {
          membership.set(m.id, { size: r.memberCount, isRep: false });
        }
      }
    }
  } catch (err) {
    console.warn('[maturation] idea_clusters load failed', err);
  }
  return { membership };
}

export interface MaturationReport {
  userId: string;
  inspected: number;
  lifted: number;
  // Phase 18 hotfix: per-signal hit counters for debug visibility.
  // signal{N}Hits = how many ideas had at least one lift contribution
  // from that signal during this pass.
  signal1Hits: number;
  signal2Hits: number;
  signal3Hits: number;
  signal4Hits: number;
  signal5Hits: number;
  errors: string[];
}

export async function runMaturationPass(
  userId: string
): Promise<MaturationReport> {
  const report: MaturationReport = {
    userId,
    inspected: 0,
    lifted: 0,
    signal1Hits: 0,
    signal2Hits: 0,
    signal3Hits: 0,
    signal4Hits: 0,
    signal5Hits: 0,
    errors: [],
  };

  let ideasList: IdeaCand[] = [];
  try {
    ideasList = await loadIdeas(userId);
  } catch (err) {
    throw new Error(`loadIdeas: ${(err as Error).message}`);
  }

  if (ideasList.length === 0) return report;
  report.inspected = ideasList.length;

  let resonancePool: ExtractedCand[] = [];
  try {
    resonancePool = await loadResonancePool(userId);
  } catch (err) {
    report.errors.push(`loadResonancePool: ${(err as Error).message}`);
  }

  let recentDrafts: DraftCand[] = [];
  try {
    recentDrafts = await loadRecentDrafts(userId);
  } catch (err) {
    report.errors.push(`loadRecentDrafts: ${(err as Error).message}`);
  }

  let edgeCounts = new Map<string, number>();
  try {
    edgeCounts = await loadEdgeCounts(userId);
  } catch (err) {
    report.errors.push(`loadEdgeCounts: ${(err as Error).message}`);
  }

  let clusterMembership = new Map<string, { size: number; isRep: boolean }>();
  try {
    const cl = await loadTodayClusters(userId);
    clusterMembership = cl.membership;
  } catch (err) {
    report.errors.push(`loadTodayClusters: ${(err as Error).message}`);
  }

  for (const idea of ideasList) {
    try {
    let nextTemp = idea.temperature;
    let nextMat = idea.maturity;

    // ── Signal 1: depth+breadth on entry ───────────────────
    if (idea.depthSignal !== null) {
      let s1Hit = false;
      if (idea.depthSignal >= 0.6) {
        const before = nextTemp;
        nextTemp = maxTemperature(nextTemp, 'warm');
        if (nextTemp !== before) s1Hit = true;
      }
      if (
        idea.depthSignal >= 0.8 &&
        (idea.breadthSignal ?? 0) >= 0.6
      ) {
        const before = nextMat;
        nextMat = maxMaturity(nextMat, 'ready');
        if (nextMat !== before) s1Hit = true;
      } else if (idea.depthSignal >= 0.6) {
        const before = nextMat;
        nextMat = maxMaturity(nextMat, 'shaping');
        if (nextMat !== before) s1Hit = true;
      } else if (idea.depthSignal < 0.6) {
        if (maturityIndex(nextMat) < maturityIndex('forming')) {
          nextMat = 'forming';
          s1Hit = true;
        }
      }
      if (s1Hit) report.signal1Hits += 1;
    }

    // ── Signal 2: cross-source resonance ───────────────────
    const distinctKinds = new Set<string>();
    for (const peer of resonancePool) {
      // Skip self via source_extracted_idea_id link.
      if (idea.sourceExtractedIdeaId && peer.id === idea.sourceExtractedIdeaId) continue;
      const c = cosine(idea.embedding, peer.embedding);
      if (c >= COSINE_RESONANCE_THRESHOLD) {
        distinctKinds.add(peer.sourceKind);
      }
    }
    if (distinctKinds.size >= 2) {
      nextTemp = bumpTemperature(nextTemp, 1);
      report.signal2Hits += 1;
    }
    if (distinctKinds.size >= 3) {
      nextMat = bumpMaturity(nextMat, 1);
    }

    // ── Signal 3: cluster density ──────────────────────────
    const cluster = clusterMembership.get(idea.id);
    if (cluster && cluster.size >= 3) {
      nextTemp = bumpTemperature(nextTemp, 1);
      report.signal3Hits += 1;
    }
    if (cluster && cluster.isRep && cluster.size >= 5) {
      nextMat = bumpMaturity(nextMat, 1);
    }

    // ── Signal 4: draft-resonance ──────────────────────────
    let maxDraftCos = 0;
    for (const d of recentDrafts) {
      const c = cosine(idea.embedding, d.embedding);
      if (c > maxDraftCos) maxDraftCos = c;
    }
    if (maxDraftCos >= COSINE_DRAFT_THRESHOLD_TEMP) {
      nextTemp = bumpTemperature(nextTemp, 1);
      report.signal4Hits += 1;
    }
    if (maxDraftCos >= COSINE_DRAFT_THRESHOLD_MAT) {
      nextMat = bumpMaturity(nextMat, 1);
    }

    // ── Signal 5: connectedness ────────────────────────────
    const ec = edgeCounts.get(idea.id) ?? 0;
    if (ec >= 3) {
      nextTemp = bumpTemperature(nextTemp, 1);
      report.signal5Hits += 1;
    }
    if (ec >= 5) nextMat = bumpMaturity(nextMat, 1);

    // Apply only if something changed. Don't touch pinned-hot ideas;
    // they're user-pinned and shouldn't move.
    if (idea.temperature === 'hot' && nextTemp !== 'hot') {
      nextTemp = 'hot'; // keep pin
    }
    if (idea.temperature === 'set_aside') {
      nextTemp = 'set_aside';
      nextMat = idea.maturity;
    }

    if (nextTemp !== idea.temperature || nextMat !== idea.maturity) {
      try {
        await db
          .update(ideas)
          .set({
            temperature: nextTemp,
            maturity: nextMat,
            ...(nextTemp !== idea.temperature
              ? { temperatureUpdatedAt: new Date() }
              : {}),
          })
          .where(and(eq(ideas.userId, userId), eq(ideas.id, idea.id)));
        report.lifted += 1;
      } catch (err) {
        report.errors.push(
          `lift ${idea.id}: ${(err as Error).message}`
        );
      }
    }
    } catch (err) {
      report.errors.push(`evaluate ${idea.id}: ${(err as Error).message}`);
    }
  }

  return report;
}
