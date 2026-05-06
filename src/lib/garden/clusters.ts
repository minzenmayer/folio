// Thoughtbed · Garden clusters — Phase 17 (2026-05-05)
//
// Per-day cluster snapshots. Every member with cosine ≥ 0.75 against
// the cluster representative AND sharing at least one theme tag joins
// the cluster. The representative is the highest-ripeness member
// (ties broken claimed > auto_claimed > unclaimed, then created_at
// desc).
//
// Greedy clustering pass: walk candidates ordered by ripeness desc;
// for each unassigned candidate, query its peers and form a cluster.
// Once assigned, members can't be reused. Solo items (no peers) get a
// 1-member cluster so the cluster view stays exhaustive.
//
// Persisted to idea_clusters (unique on user + run_date + rep). The
// cluster view default Garden surface (slice 5) reads via
// readClustersForToday.

import { and, eq, sql } from 'drizzle-orm';
import { db, ideas, extractedIdeas, ideaClusters } from '@/db';
import { computeRipeness } from './temperature';
import type { Temperature } from './types';

const CLUSTER_THRESHOLD = 0.75;

interface Candidate {
  kind: 'idea' | 'extracted_idea';
  id: string;
  title: string;
  preview: string; // ideas.essence | extracted_ideas.claim
  themes: string[];
  embedding: number[];
  // For ripeness scoring + tie-breaks.
  temperature: Temperature;
  maturity: string;
  msSinceVisit: number | null;
  digestSurfaceCount: number;
  claimKind: string | null; // 'authored' | 'claimed' | 'auto_claimed' | null (extracted)
  createdAt: Date;
  ripeness: number;
}

interface ClusterMember {
  kind: 'idea' | 'extracted_idea';
  id: string;
  ripeness: number;
}

interface Cluster {
  rep: Candidate;
  theme: string | null;
  members: ClusterMember[];
}

const CLAIM_KIND_RANK: Record<string, number> = {
  claimed: 3,
  auto_claimed: 2,
  authored: 1,
};

function tieBreak(a: Candidate, b: Candidate): number {
  // Highest ripeness wins. Then the higher-ranked claim_kind. Then
  // newer createdAt (more recent thinking is the better representative).
  if (a.ripeness !== b.ripeness) return b.ripeness - a.ripeness;
  const ar = CLAIM_KIND_RANK[a.claimKind ?? ''] ?? 0;
  const br = CLAIM_KIND_RANK[b.claimKind ?? ''] ?? 0;
  if (ar !== br) return br - ar;
  return b.createdAt.getTime() - a.createdAt.getTime();
}

async function loadCandidates(userId: string): Promise<Candidate[]> {
  const ideaRows = await db
    .select({
      id: ideas.id,
      title: ideas.title,
      essence: ideas.essence,
      themes: ideas.themes,
      embedding: ideas.embedding,
      temperature: ideas.temperature,
      maturity: ideas.maturity,
      lastVisitedAt: ideas.lastVisitedAt,
      digestSurfaceCount: ideas.digestSurfaceCount,
      claimKind: ideas.claimKind,
      createdAt: ideas.createdAt,
    })
    .from(ideas)
    .where(eq(ideas.userId, userId));

  const extRows = await db
    .select({
      id: extractedIdeas.id,
      title: extractedIdeas.title,
      claim: extractedIdeas.claim,
      embedding: extractedIdeas.embedding,
      temperature: extractedIdeas.temperature,
      digestSurfaceCount: extractedIdeas.digestSurfaceCount,
      createdAt: extractedIdeas.createdAt,
      triageStatus: extractedIdeas.triageStatus,
    })
    .from(extractedIdeas)
    .where(
      and(
        eq(extractedIdeas.userId, userId),
        // Promoted extracted_ideas have a partner ideas row already; skip
        // them so we don't double-cluster the same content.
        eq(extractedIdeas.triageStatus, 'pending')
      )
    );

  const out: Candidate[] = [];
  const now = Date.now();

  for (const r of ideaRows) {
    if (!r.embedding) continue;
    const msSinceVisit = r.lastVisitedAt
      ? now - new Date(r.lastVisitedAt).getTime()
      : null;
    const ripeness = computeRipeness({
      temperature: r.temperature as Temperature,
      maturity: r.maturity,
      msSinceVisit,
      retrievalCount14d: 0, // not tracked at cluster compute time; cheap default
      digestSurfaceCount: r.digestSurfaceCount,
    });
    out.push({
      kind: 'idea',
      id: r.id,
      title: r.title,
      preview: r.essence ?? '',
      themes: r.themes ?? [],
      embedding: r.embedding,
      temperature: r.temperature as Temperature,
      maturity: r.maturity,
      msSinceVisit,
      digestSurfaceCount: r.digestSurfaceCount,
      claimKind: r.claimKind,
      createdAt: r.createdAt ?? new Date(),
      ripeness,
    });
  }

  for (const r of extRows) {
    if (!r.embedding) continue;
    const ripeness = computeRipeness({
      temperature: r.temperature as Temperature,
      maturity: 'seed',
      msSinceVisit: null,
      retrievalCount14d: 0,
      digestSurfaceCount: r.digestSurfaceCount,
    });
    out.push({
      kind: 'extracted_idea',
      id: r.id,
      title: r.title,
      preview: r.claim,
      themes: [], // extracted_ideas don't carry themes; rely on cosine
      embedding: r.embedding,
      temperature: r.temperature as Temperature,
      maturity: 'seed',
      msSinceVisit: null,
      digestSurfaceCount: r.digestSurfaceCount,
      claimKind: null,
      createdAt: r.createdAt ?? new Date(),
      ripeness,
    });
  }

  return out;
}

// In-memory cosine. Both vectors are 1536-dim (text-embedding-3-small).
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function shareTheme(a: Candidate, b: Candidate): boolean {
  // Extracted ideas don't carry themes — for them we treat any cosine
  // peer as shared (rely on cosine alone). For ideas vs ideas, require
  // at least one overlapping theme tag.
  if (a.kind === 'extracted_idea' || b.kind === 'extracted_idea') return true;
  if (a.themes.length === 0 || b.themes.length === 0) return true;
  const setA = new Set(a.themes.map((t) => t.toLowerCase()));
  return b.themes.some((t) => setA.has(t.toLowerCase()));
}

export async function computeClusters(userId: string): Promise<Cluster[]> {
  const candidates = await loadCandidates(userId);
  if (candidates.length === 0) return [];

  // Sort by ripeness desc with tie-breaks. Highest-ripeness candidates
  // become representatives first.
  const sorted = [...candidates].sort(tieBreak);
  const assigned = new Set<string>();
  const clusters: Cluster[] = [];

  for (const cand of sorted) {
    const key = `${cand.kind}|${cand.id}`;
    if (assigned.has(key)) continue;

    const members: ClusterMember[] = [
      { kind: cand.kind, id: cand.id, ripeness: cand.ripeness },
    ];
    assigned.add(key);

    let sharedTheme: string | null = null;
    for (const peer of sorted) {
      if (peer === cand) continue;
      const peerKey = `${peer.kind}|${peer.id}`;
      if (assigned.has(peerKey)) continue;
      const c = cosine(cand.embedding, peer.embedding);
      if (c < CLUSTER_THRESHOLD) continue;
      if (!shareTheme(cand, peer)) continue;
      members.push({ kind: peer.kind, id: peer.id, ripeness: peer.ripeness });
      assigned.add(peerKey);

      if (!sharedTheme && cand.themes.length > 0 && peer.themes.length > 0) {
        const setA = new Set(cand.themes.map((t) => t.toLowerCase()));
        const overlap = peer.themes.find((t) => setA.has(t.toLowerCase()));
        if (overlap) sharedTheme = overlap;
      }
    }

    clusters.push({ rep: cand, theme: sharedTheme, members });
  }

  return clusters;
}

export async function persistClusters(
  userId: string,
  runDate: Date,
  clusters: Cluster[]
): Promise<number> {
  if (clusters.length === 0) return 0;
  const dateOnly = runDate.toISOString().slice(0, 10);

  // Phase 17 hotfix (2026-05-05): if migration 0015 isn't applied, the
  // idea_clusters table doesn't exist; both delete and insert throw.
  // Swallow + log so the cron / on-demand caller doesn't 500.
  try {
    await db
      .delete(ideaClusters)
      .where(
        and(
          eq(ideaClusters.userId, userId),
          eq(ideaClusters.runDate, dateOnly)
        )
      );

    const rows = clusters.map((c) => ({
      userId,
      runDate: dateOnly,
      repKind: c.rep.kind,
      repId: c.rep.id,
      theme: c.theme,
      memberCount: c.members.length,
      members: c.members,
    }));

    await db.insert(ideaClusters).values(rows);
    return rows.length;
  } catch (err) {
    console.warn('[persistClusters] failed (migration?)', err);
    return 0;
  }
}

export interface ClusterSnapshot {
  id: string;
  repKind: 'idea' | 'extracted_idea';
  repId: string;
  theme: string | null;
  memberCount: number;
  members: ClusterMember[];
}

export async function readClustersForToday(
  userId: string
): Promise<ClusterSnapshot[]> {
  const today = new Date().toISOString().slice(0, 10);
  // Phase 17 hotfix (2026-05-05): tolerate missing idea_clusters
  // table (migration 0015 not yet applied). Returns [] so the page
  // falls back to the 'no clusters yet' empty state.
  let rows: Array<{
    id: string;
    repKind: string;
    repId: string;
    theme: string | null;
    memberCount: number;
    members: unknown;
  }> = [];
  try {
    rows = await db
      .select({
        id: ideaClusters.id,
        repKind: ideaClusters.repKind,
        repId: ideaClusters.repId,
        theme: ideaClusters.theme,
        memberCount: ideaClusters.memberCount,
        members: ideaClusters.members,
      })
      .from(ideaClusters)
      .where(
        and(
          eq(ideaClusters.userId, userId),
          eq(ideaClusters.runDate, today)
        )
      )
      .orderBy(sql`${ideaClusters.memberCount} desc`);
  } catch (err) {
    console.warn('[readClustersForToday] read failed (migration?)', err);
    return [];
  }

  return rows.map((r) => ({
    id: r.id,
    repKind: r.repKind as 'idea' | 'extracted_idea',
    repId: r.repId,
    theme: r.theme,
    memberCount: r.memberCount,
    members: (r.members as ClusterMember[]) ?? [],
  }));
}
