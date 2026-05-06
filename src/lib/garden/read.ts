// Phase 14b — Garden redesign · unified read layer
//
// listGardenItems UNION ALLs the two backing tables (ideas + extracted_ideas)
// into one shape (GardenItem). Implemented as a Drizzle query helper rather
// than a SQL view because Drizzle plays poorly with UNION views in migrations.
//
// The Garden surfaces (digest, feed, board, juxtaposition selector) all read
// from this helper. Filters apply across the unified shape.

import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, ideas, extractedIdeas } from '@/db';
import type { Temperature, Maturity, GardenItem } from './types';
import { computeRipeness } from './temperature';

export interface GardenReadOpts {
  // Filter to a subset of temperatures. Default: all except set_aside.
  temperatures?: Temperature[];
  // Filter by maturity (only ideas have real maturity; extracted = seed).
  maturities?: Maturity[];
  // Filter to claimed-only or unclaimed-only. Default: both.
  claimedOnly?: boolean;
  unclaimedOnly?: boolean;
  // Filter by source kind for unclaimed extracted_ideas.
  sourceKind?: string | null;
  // Sort by ripeness desc (default) or recency.
  sort?: 'ripeness' | 'recent';
  // Optional pagination — cap on results returned.
  limit?: number;
}

export async function listGardenItems(
  userId: string,
  opts: GardenReadOpts = {}
): Promise<GardenItem[]> {
  const includeClaimed = !opts.unclaimedOnly;
  const includeUnclaimed = !opts.claimedOnly;

  const tempFilter = opts.temperatures ?? (['hot', 'warm', 'cool', 'cold'] as Temperature[]);
  const matFilter = opts.maturities;

  const items: GardenItem[] = [];

  if (includeClaimed) {
    const ideaConds = [eq(ideas.userId, userId), inArray(ideas.temperature, tempFilter as string[])];
    if (matFilter && matFilter.length > 0) {
      ideaConds.push(inArray(ideas.maturity, matFilter as string[]));
    }
    const ideaRows = await db
      .select({
        id: ideas.id,
        title: ideas.title,
        essence: ideas.essence,
        body: ideas.body,
        themes: ideas.themes,
        maturity: ideas.maturity,
        temperature: ideas.temperature,
        digestSurfaceCount: ideas.digestSurfaceCount,
        lastVisitedAt: ideas.lastVisitedAt,
        sourceExtractedIdeaId: ideas.sourceExtractedIdeaId,
        claimKind: ideas.claimKind,
      })
      .from(ideas)
      .where(and(...ideaConds));

    const now = Date.now();
    for (const row of ideaRows) {
      const msSinceVisit = row.lastVisitedAt
        ? now - new Date(row.lastVisitedAt).getTime()
        : null;
      items.push({
        kind: 'idea',
        id: row.id,
        title: row.title,
        preview: row.essence ?? '',
        temperature: row.temperature as Temperature,
        maturity: (row.maturity ?? 'seed') as Maturity,
        themes: row.themes ?? [],
        sourceKind: null,
        sourceRef: row.sourceExtractedIdeaId,
        lastVisitedAt: row.lastVisitedAt ? new Date(row.lastVisitedAt) : null,
        digestSurfaceCount: row.digestSurfaceCount ?? 0,
        isClaimed: true,
        claimKind: row.claimKind ?? null,
        body: typeof row.body === 'string' ? row.body : null,
        ripeness: computeRipeness({
          temperature: row.temperature as Temperature,
          maturity: row.maturity ?? 'seed',
          msSinceVisit,
          retrievalCount14d: 0, // TODO wire from rail-retrieval log when available
          digestSurfaceCount: row.digestSurfaceCount ?? 0,
        }),
      });
    }
  }

  if (includeUnclaimed) {
    const extConds = [
      eq(extractedIdeas.userId, userId),
      eq(extractedIdeas.triageStatus, 'pending'),
      inArray(extractedIdeas.temperature, tempFilter as string[]),
    ];
    if (opts.sourceKind) {
      extConds.push(eq(extractedIdeas.sourceKind, opts.sourceKind));
    }
    const extRows = await db
      .select({
        id: extractedIdeas.id,
        title: extractedIdeas.title,
        claim: extractedIdeas.claim,
        evidence: extractedIdeas.evidence,
        sourceKind: extractedIdeas.sourceKind,
        newsletterIssueId: extractedIdeas.newsletterIssueId,
        obsidianNoteId: extractedIdeas.obsidianNoteId,
        linkedinPostId: extractedIdeas.linkedinPostId,
        gmailMessageId: extractedIdeas.gmailMessageId,
        depthSignal: extractedIdeas.depthSignal,
        breadthSignal: extractedIdeas.breadthSignal,
        temperature: extractedIdeas.temperature,
        digestSurfaceCount: extractedIdeas.digestSurfaceCount,
        claimText: extractedIdeas.claimText,
      })
      .from(extractedIdeas)
      .where(and(...extConds));

    for (const row of extRows) {
      const sourceRef =
        row.newsletterIssueId ??
        row.obsidianNoteId ??
        row.linkedinPostId ??
        row.gmailMessageId;

      items.push({
        kind: 'extracted_idea',
        id: row.id,
        title: row.title,
        preview: row.claim,
        temperature: row.temperature as Temperature,
        maturity: 'seed',
        themes: [],
        sourceKind: row.sourceKind,
        sourceRef,
        lastVisitedAt: null,
        digestSurfaceCount: row.digestSurfaceCount ?? 0,
        isClaimed: false,
        evidence: row.evidence,
        ripeness: computeRipeness({
          temperature: row.temperature as Temperature,
          maturity: 'seed',
          msSinceVisit: null,
          retrievalCount14d: 0,
          digestSurfaceCount: row.digestSurfaceCount ?? 0,
        }),
      });
    }
  }

  // Sort
  if (opts.sort === 'recent') {
    items.sort((a, b) => {
      const aT = a.lastVisitedAt?.getTime() ?? 0;
      const bT = b.lastVisitedAt?.getTime() ?? 0;
      return bT - aT;
    });
  } else {
    items.sort((a, b) => b.ripeness - a.ripeness);
  }

  if (opts.limit && opts.limit > 0) {
    return items.slice(0, opts.limit);
  }
  return items;
}

// ── getGardenItem — single-item fetch with body/evidence + linked ideas ──
//
// Used by the expand surface. Returns null if not found.

export interface GardenItemDetail extends GardenItem {
  // For claimed ideas, the long-form body that grows over time.
  body: string | null;
  // For unclaimed extracted_ideas, the source evidence excerpt.
  evidence: string | null;
}

export async function getGardenItem(
  userId: string,
  kind: 'idea' | 'extracted_idea',
  id: string
): Promise<GardenItemDetail | null> {
  if (kind === 'idea') {
    const [row] = await db
      .select()
      .from(ideas)
      .where(and(eq(ideas.id, id), eq(ideas.userId, userId)))
      .limit(1);
    if (!row) return null;
    const now = Date.now();
    const msSinceVisit = row.lastVisitedAt
      ? now - new Date(row.lastVisitedAt).getTime()
      : null;
    return {
      kind: 'idea',
      id: row.id,
      title: row.title,
      preview: row.essence ?? '',
      temperature: row.temperature as Temperature,
      maturity: (row.maturity ?? 'seed') as Maturity,
      themes: row.themes ?? [],
      sourceKind: null,
      sourceRef: row.sourceExtractedIdeaId,
      lastVisitedAt: row.lastVisitedAt ? new Date(row.lastVisitedAt) : null,
      digestSurfaceCount: row.digestSurfaceCount ?? 0,
      isClaimed: true,
      body: (row as unknown as { body?: string | null }).body ?? null,
      evidence: null,
      ripeness: computeRipeness({
        temperature: row.temperature as Temperature,
        maturity: row.maturity ?? 'seed',
        msSinceVisit,
        retrievalCount14d: 0,
        digestSurfaceCount: row.digestSurfaceCount ?? 0,
      }),
    };
  }

  const [row] = await db
    .select()
    .from(extractedIdeas)
    .where(and(eq(extractedIdeas.id, id), eq(extractedIdeas.userId, userId)))
    .limit(1);
  if (!row) return null;
  const sourceRef =
    row.newsletterIssueId ??
    row.obsidianNoteId ??
    row.linkedinPostId ??
    row.gmailMessageId;
  return {
    kind: 'extracted_idea',
    id: row.id,
    title: row.title,
    preview: row.claim,
    temperature: row.temperature as Temperature,
    maturity: 'seed',
    themes: [],
    sourceKind: row.sourceKind,
    sourceRef,
    lastVisitedAt: null,
    digestSurfaceCount: row.digestSurfaceCount ?? 0,
    isClaimed: false,
    body: null,
    evidence: row.evidence,
    ripeness: computeRipeness({
      temperature: row.temperature as Temperature,
      maturity: 'seed',
      msSinceVisit: null,
      retrievalCount14d: 0,
      digestSurfaceCount: row.digestSurfaceCount ?? 0,
    }),
  };
}
