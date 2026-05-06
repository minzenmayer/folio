// Phase 14b — Garden redesign · unified surface
//
// Two stacked views:
//   1. Today's digest (top) — 5 ideas + 1 reserved juxtaposition slot.
//      Reads from the cron-cached garden_digest_runs row; if none for today,
//      computes inline (single round trip).
//   2. Ranked feed (below) — full Garden with filter chips, sorted by ripeness.
//
// See spec: ~/Desktop/Thoughtbed/garden_redesign_spec.md section 2.

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { eq, and, sql } from 'drizzle-orm';
import { db, gardenJuxtapositions, ideas, extractedIdeas } from '@/db';
import { requireUser } from '@/lib/auth';
import { listGardenItems } from '@/lib/garden/read';
import {
  computeDigest,
  persistDigestRun,
  readTodaysDigest,
  markSurfaced,
} from '@/lib/garden/digest';
import { computeNextJuxtaposition } from '@/lib/garden/juxtaposition';
import { GardenDigest } from './GardenDigest';
import { GardenFeed } from './GardenFeed';
import { FilterChips } from './FilterChips';
import { SeedBanner } from './SeedBanner';
import { getSeedStatus } from './seed-actions';
import {
  readClustersForToday,
  computeClusters,
  persistClusters,
} from '@/lib/garden/clusters';
import type { ClusterSnapshot } from '@/lib/garden/clusters';
import { ClusterFeed } from './ClusterFeed';
import { ViewToggle } from './ViewToggle';
import type { ClusterRender } from './ClusterCard';

// Always render fresh — temperature changes are per-action and we
// invalidate paths from server actions, but pages also benefit from
// no-store for safety.
export const dynamic = 'force-dynamic';

interface SearchParams {
  filter?: string;
  source?: string;
  view?: string;
}

export default async function GardenPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const user = await requireUser();
  const sp = (await searchParams) ?? {};

  // Read or compute today's digest.
  let digest = await readTodaysDigest(user.id);
  if (!digest) {
    const picks = await computeDigest(user.id);
    let juxtapositionId: string | null = null;
    try {
      juxtapositionId = await computeNextJuxtaposition(user.id);
    } catch (err) {
      console.error('[garden/page] juxtaposition compute failed', err);
    }
    if (picks.length > 0) {
      await persistDigestRun(user.id, picks, juxtapositionId);
      await markSurfaced(user.id, picks);
    }
    digest = { picks, juxtapositionId };
  }

  // Hydrate digest picks with full GardenItem data.
  const allItems = await listGardenItems(user.id, {
    sort: 'ripeness',
    temperatures: ['hot', 'warm', 'cool', 'cold'],
  });

  const itemMap = new Map<string, (typeof allItems)[number]>();
  for (const it of allItems) itemMap.set(`${it.kind}|${it.id}`, it);

  const digestItems = digest.picks
    .map((p) => ({
      reason: p.reason,
      item: itemMap.get(`${p.kind}|${p.id}`),
    }))
    .filter((d): d is { reason: string; item: NonNullable<typeof d.item> } => !!d.item);

  // Hydrate juxtaposition.
  let juxtaposition = null as null | {
    id: string;
    question: string;
    reasoning: string;
    leftTitle: string;
    rightTitle: string;
    heuristic: string;
  };
  if (digest.juxtapositionId) {
    const [jxRow] = await db
      .select()
      .from(gardenJuxtapositions)
      .where(eq(gardenJuxtapositions.id, digest.juxtapositionId))
      .limit(1);

    if (jxRow) {
      const leftTbl = jxRow.leftKind === 'idea' ? ideas : extractedIdeas;
      const rightTbl = jxRow.rightKind === 'idea' ? ideas : extractedIdeas;
      const [left] = await db
        .select({ title: leftTbl.title })
        .from(leftTbl)
        .where(eq(leftTbl.id, jxRow.leftId))
        .limit(1);
      const [right] = await db
        .select({ title: rightTbl.title })
        .from(rightTbl)
        .where(eq(rightTbl.id, jxRow.rightId))
        .limit(1);
      juxtaposition = {
        id: jxRow.id,
        question: jxRow.question,
        reasoning: jxRow.reasoning,
        leftTitle: left?.title ?? '(unknown)',
        rightTitle: right?.title ?? '(unknown)',
        heuristic: jxRow.heuristic,
      };
    }
  }

  // Phase 17 (2026-05-05) — cluster view default. Read today's run; if
  // empty, compute on-demand once (the cron will catch up daily but
  // the first user after migration shouldn't see a blank surface).
  let clusterSnapshots: ClusterSnapshot[] = await readClustersForToday(user.id);
  if (clusterSnapshots.length === 0 && allItems.length > 0) {
    try {
      const computed = await computeClusters(user.id);
      const persisted = await persistClusters(user.id, new Date(), computed);
      if (persisted > 0) {
        clusterSnapshots = await readClustersForToday(user.id);
      }
    } catch (err) {
      console.warn('[garden/page] on-demand cluster compute failed', err);
    }
  }

  // Hydrate cluster snapshots into ClusterRender shape.
  const clusters: ClusterRender[] = clusterSnapshots.map((cs) => {
    const repItem = itemMap.get(`${cs.repKind}|${cs.repId}`);
    if (!repItem) return null;
    const memberItems = cs.members
      .map((m) => itemMap.get(`${m.kind}|${m.id}`))
      .filter((m): m is NonNullable<typeof m> => !!m);
    return {
      id: cs.id,
      rep: repItem,
      theme: cs.theme,
      members: memberItems,
    };
  }).filter((c): c is ClusterRender => c !== null);

  // Apply filter chips for the feed below.
  const activeFilter = sp.filter ?? 'all';
  const activeView: 'cluster' | 'list' = sp.view === 'list' ? 'list' : 'cluster';
  let feedItems = allItems;
  if (activeFilter === 'hot') {
    feedItems = allItems.filter((i) => i.temperature === 'hot');
  } else if (activeFilter === 'ready') {
    feedItems = allItems.filter((i) => i.maturity === 'ready');
  } else if (activeFilter === 'unclaimed') {
    feedItems = allItems.filter((i) => !i.isClaimed);
  } else if (activeFilter === 'set_aside') {
    feedItems = await listGardenItems(user.id, {
      temperatures: ['set_aside'],
    });
  }

  return (
    <section>
      <div className="max-w-[1000px] mx-auto px-6 md:px-8 py-12 md:py-16">
        <div className="mb-8">
          <h1 className="font-sans text-[clamp(28px,4vw,40px)] font-semibold tracking-tight text-ink mb-2">
            Garden
          </h1>
          <p className="font-sans text-[15px] leading-[1.55] text-ink-soft max-w-[58ch]">
            {allItems.length === 0
              ? 'Your Garden is empty. Plant something in Capture, or wait for sources to bring claims you can claim.'
              : `${allItems.length} ${allItems.length === 1 ? 'idea' : 'ideas'} in your Garden. Claimed and unclaimed, all in one place.`}
          </p>
        </div>

        {/* Phase 17 onboarding mass-claim banner — visible until the
            user's phase17_seeded_at gate is set. Component handles its
            own polling. */}
        <SeedBanner initialStatus={await getSeedStatus()} />

        {digestItems.length > 0 && (
          <GardenDigest items={digestItems} juxtaposition={juxtaposition} />
        )}

        {/* Phase 17: cluster vs list toggle + filter chips share the
            row above the feed surfaces. Cluster view is the default;
            list view ships the existing ranked feed. */}
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <FilterChips active={activeFilter} />
          <ViewToggle active={activeView} />
        </div>

        {activeView === 'cluster' ? (
          <ClusterFeed clusters={clusters} />
        ) : (
          <GardenFeed items={feedItems} />
        )}
      </div>
    </section>
  );
}
