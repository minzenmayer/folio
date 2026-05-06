// Thoughtbed · Garden audit — Phase 19 diagnostic
//
// 2026-05-05. After multiple rounds of threshold-tuning produced
// 'Lifted 0 of 830' the cleanest move is to STOP guessing and
// actually look at the data: distributions of depth, topic-fit,
// temperature, maturity. Top-N by signal. Sample off-topic items
// to verify the gate is catching real noise, not real writing.
//
// This action returns a JSON summary the audit page renders.

'use server';

import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  ideas,
  extractedIdeas,
  newsletterIssues,
  linkedinPosts,
} from '@/db';
import { requireUser } from '@/lib/auth';
import { loadTopicFitContext, computeTopicFit } from '@/lib/garden/topic-fit';

export type AuditResult = {
  totalIdeas: number;
  totalExtracted: number;
  byTemperature: Record<string, number>;
  byMaturity: Record<string, number>;
  byClaimKind: Record<string, number>;
  bySourceKind: Record<string, number>;
  depthDistribution: { bucket: string; count: number }[];
  topicFitDistribution: { bucket: string; count: number }[];
  // Composite = topic-fit × depth (highest → most likely to be writing-worthy)
  topByComposite: AuditIdea[];
  topByDepth: AuditIdea[];
  topByTopicFit: AuditIdea[];
  // Sample of low-topic-fit ideas so we can verify the gate is right
  offTopicSample: AuditIdea[];
  positiveCorpusSize: number;
  negativeCorpusSize: number;
};

type AuditIdea = {
  id: string;
  title: string;
  essence: string | null;
  temperature: string;
  maturity: string;
  claimKind: string;
  sourceKind: string | null;
  depthSignal: number | null;
  topicFit: number;
  composite: number;
};

function bucketize(value: number): string {
  if (value < 0.2) return '0.0-0.2';
  if (value < 0.4) return '0.2-0.4';
  if (value < 0.5) return '0.4-0.5';
  if (value < 0.6) return '0.5-0.6';
  if (value < 0.7) return '0.6-0.7';
  if (value < 0.8) return '0.7-0.8';
  return '0.8+';
}

export async function auditGarden(): Promise<AuditResult> {
  const user = await requireUser();

  // Pull all ideas with sourceExtractedIdeaId so we can join depth.
  const ideaRows = await db
    .select({
      id: ideas.id,
      title: ideas.title,
      essence: ideas.essence,
      temperature: ideas.temperature,
      maturity: ideas.maturity,
      claimKind: ideas.claimKind,
      embedding: ideas.embedding,
      sourceExtractedIdeaId: ideas.sourceExtractedIdeaId,
    })
    .from(ideas)
    .where(eq(ideas.userId, user.id));

  // Pull depth signals + source kinds via the originating extracted_ideas.
  const sourceIds = ideaRows
    .map((r) => r.sourceExtractedIdeaId)
    .filter((s): s is string => !!s);
  const sigMap = new Map<
    string,
    { depth: number; sourceKind: string }
  >();
  if (sourceIds.length > 0) {
    // Drizzle's inArray with empty array would fail.
    const sigs = await db
      .select({
        id: extractedIdeas.id,
        depth: extractedIdeas.depthSignal,
        sourceKind: extractedIdeas.sourceKind,
      })
      .from(extractedIdeas)
      .where(eq(extractedIdeas.userId, user.id));
    for (const s of sigs) {
      sigMap.set(s.id, { depth: s.depth, sourceKind: s.sourceKind });
    }
  }

  // Load topic-fit context once.
  const ctx = await loadTopicFitContext(user.id);

  // Hydrate each idea with depth + topic-fit + composite.
  const enriched: AuditIdea[] = ideaRows.map((r) => {
    const sig = r.sourceExtractedIdeaId
      ? sigMap.get(r.sourceExtractedIdeaId) ?? null
      : null;
    const topicFit = computeTopicFit(
      { embedding: Array.isArray(r.embedding) ? r.embedding : null },
      ctx
    );
    const depth = sig?.depth ?? null;
    const composite = (depth ?? 0) * topicFit;
    return {
      id: r.id,
      title: r.title,
      essence: r.essence,
      temperature: r.temperature,
      maturity: r.maturity,
      claimKind: r.claimKind,
      sourceKind: sig?.sourceKind ?? null,
      depthSignal: depth,
      topicFit,
      composite,
    };
  });

  // Distributions.
  const byTemperature: Record<string, number> = {};
  const byMaturity: Record<string, number> = {};
  const byClaimKind: Record<string, number> = {};
  const bySourceKind: Record<string, number> = {};
  const depthBuckets: Record<string, number> = {};
  const topicFitBuckets: Record<string, number> = {};

  for (const idea of enriched) {
    byTemperature[idea.temperature] =
      (byTemperature[idea.temperature] ?? 0) + 1;
    byMaturity[idea.maturity] = (byMaturity[idea.maturity] ?? 0) + 1;
    byClaimKind[idea.claimKind] = (byClaimKind[idea.claimKind] ?? 0) + 1;
    const sk = idea.sourceKind ?? '(none)';
    bySourceKind[sk] = (bySourceKind[sk] ?? 0) + 1;
    if (idea.depthSignal !== null) {
      const b = bucketize(idea.depthSignal);
      depthBuckets[b] = (depthBuckets[b] ?? 0) + 1;
    }
    const tfb = bucketize(idea.topicFit);
    topicFitBuckets[tfb] = (topicFitBuckets[tfb] ?? 0) + 1;
  }

  const depthDistribution = Object.entries(depthBuckets)
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
  const topicFitDistribution = Object.entries(topicFitBuckets)
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));

  // Top-N selectors.
  const topByComposite = [...enriched]
    .sort((a, b) => b.composite - a.composite)
    .slice(0, 15);
  const topByDepth = [...enriched]
    .filter((i) => i.depthSignal !== null)
    .sort((a, b) => (b.depthSignal ?? 0) - (a.depthSignal ?? 0))
    .slice(0, 15);
  const topByTopicFit = [...enriched]
    .sort((a, b) => b.topicFit - a.topicFit)
    .slice(0, 15);
  const offTopicSample = [...enriched]
    .filter((i) => i.topicFit < 0.3)
    .sort(() => Math.random() - 0.5)
    .slice(0, 15);

  // Extracted_ideas count for the user.
  const extCountRows = (await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int as count FROM extracted_ideas WHERE user_id = ${user.id}
  `)) as unknown as Array<{ count: number }>;
  const totalExtracted = Number(extCountRows[0]?.count ?? 0);

  return {
    totalIdeas: ideaRows.length,
    totalExtracted,
    byTemperature,
    byMaturity,
    byClaimKind,
    bySourceKind,
    depthDistribution,
    topicFitDistribution,
    topByComposite,
    topByDepth,
    topByTopicFit,
    offTopicSample,
    positiveCorpusSize: ctx.positivePool.length,
    negativeCorpusSize: ctx.negativePool.length,
  };
}
