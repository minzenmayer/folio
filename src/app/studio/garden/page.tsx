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
import { runMaturationPass } from '@/lib/garden/maturation';
import type { ClusterSnapshot } from '@/lib/garden/clusters';
import { ClusterFeed } from './ClusterFeed';
import { ViewToggle } from './ViewToggle';
import type { ClusterRender } from './ClusterCard';
import { findEdgeMatches } from '@/lib/garden/edge-prompts';
import { EdgePromptZone } from './EdgePromptZone';
import { MatureNowButton } from './MatureNowButton';
import { loadOnTheRise } from '@/lib/garden/on-the-rise';
import { OnTheRise } from './OnTheRise';
import { SearchBar } from './SearchBar';

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
  // Phase 19.3 (2026-05-05): re-compute when cache is non-null but
  // empty. Happens when the cron ran before any ideas were claimed
  // — cached run has zero picks, treat as cache-miss.
  if (digest && digest.picks.length === 0) digest = null;
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
  // (let-binding so the inline maturation fallback below can re-fetch
  // after lifts so the same render shows updated maturity/temperature.)
  let allItems = await listGardenItems(user.id, {
    sort: 'ripeness',
    temperatures: ['hot', 'warm', 'cool', 'cold'],
  });

  let itemMap = new Map<string, (typeof allItems)[number]>();
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
  // On-demand cluster compute when today's snapshot is missing.
  // Wrapped in try/catch — when migration 0015 isn't applied,
  // persistClusters silently fails and clusterSnapshots stays [].
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

  // Phase 18 hotfix (2026-05-05) — maturation fires INDEPENDENTLY of
  // cluster persistence. Signals 1, 2, 4, 5 work without idea_clusters
  // (signal 3 just contributes nothing when membership is empty).
  // Idempotent: each idea only writes if a temperature/maturity
  // changed. The cron is canonical; this is the immediacy hatch.
  if (allItems.length > 0) {
    try {
      const matReport = await runMaturationPass(user.id);
      if (matReport.lifted > 0) {
        // Re-fetch items so the updated maturity/temperature render
        // in the same response. Rebuild itemMap so cluster hydration
        // below picks up the new values.
        allItems = await listGardenItems(user.id, {
          sort: 'ripeness',
          temperatures: ['hot', 'warm', 'cool', 'cold'],
        });
        itemMap = new Map<string, (typeof allItems)[number]>();
        for (const it of allItems) itemMap.set(`${it.kind}|${it.id}`, it);
      }
    } catch (err) {
      console.warn('[garden/page] inline maturation failed', err);
    }
  }

  // Apply filter chips. The filter affects BOTH cluster view (via
  // matchesFilter on the representative) and flat-list view (via
  // feedItems). activeView decides which shape renders.
  const activeFilter = sp.filter ?? 'all';
  const activeView: 'cluster' | 'list' = sp.view === 'list' ? 'list' : 'cluster';

  function matchesFilter(it: (typeof allItems)[number]): boolean {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'hot') return it.temperature === 'hot';
    if (activeFilter === 'ready') return it.maturity === 'ready';
    if (activeFilter === 'unclaimed') return !it.isClaimed;
    return true;
  }

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

  // Hydrate cluster snapshots into ClusterRender shape, then filter
  // by activeFilter (a cluster matches when its representative does).
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
  }).filter((c): c is ClusterRender => c !== null && matchesFilter(c.rep));

  // When set_aside is filtered, cluster view doesn't have a meaningful
  // shape (clusters are computed against pending + claimed; set_aside
  // is hidden from clustering). Fall back to the flat list of set
  // aside items in cluster view too — by stuffing them as solo
  // pseudo-clusters so the surface still renders something.
  if (activeFilter === 'set_aside') {
    clusters.length = 0;
    for (const it of feedItems) {
      clusters.push({
        id: `pseudo-${it.kind}-${it.id}`,
        rep: it,
        theme: null,
        members: [it],
      });
    }
  }



  // Phase 19.3 hotfix (2026-05-06): wrap each new server-side call
  // in a try/catch so the Garden page renders even when one of the
  // loaders throws at runtime (e.g. transient DB hiccup).
  let seedStatus: Awaited<ReturnType<typeof getSeedStatus>>;
  try {
    seedStatus = await getSeedStatus();
  } catch (err) {
    console.warn('[garden/page] getSeedStatus failed', err);
    seedStatus = { totalEligible: 0, alreadyClaimed: 0, seeded: true };
  }

  let edgeMatches: Awaited<ReturnType<typeof findEdgeMatches>> = [];
  try {
    edgeMatches = await findEdgeMatches(user.id);
  } catch (err) {
    console.warn('[garden/page] findEdgeMatches failed', err);
  }

  let onTheRise: Awaited<ReturnType<typeof loadOnTheRise>> = [];
  try {
    onTheRise = await loadOnTheRise(user.id);
  } catch (err) {
    console.warn('[garden/page] loadOnTheRise failed', err);
  }

  return (
    <section>
      <div className="max-w-[1000px] mx-auto px-6 md:px-8 py-12 md:py-16">
        <div className="mb-8">
          <div className="flex items-baseline justify-between gap-3 mb-2 flex-wrap">
            <h1 className="font-sans text-[clamp(28px,4vw,40px)] font-semibold tracking-tight text-ink">
              Garden
            </h1>
            <div className="flex items-center gap-3">
              <a
                href="/studio/garden/audit"
                className="font-mono text-[10px] tracking-[0.16em] uppercase text-tag hover:text-ink transition-colors"
                title="Inspect the actual signal data behind the maturation engine"
              >
                Audit →
              </a>
              <MatureNowButton />
            </div>
          </div>
          <p className="font-sans text-[15px] leading-[1.55] text-ink-soft max-w-[58ch]">
            {allItems.length === 0
              ? 'Your Garden is empty. Plant something in Capture, or wait for sources to bring claims you can claim.'
              : `Here's what's most ready to write today. ${allItems.length} ideas total — browse them all below.`}
          </p>
        </div>

        {/* Phase 17 onboarding mass-claim banner — visible until the
            user's phase17_seeded_at gate is set. Component handles its
            own polling. */}
        <SeedBanner initialStatus={seedStatus} />

        {/* Phase 17 edge-prompts zone. */}
        <EdgePromptZone prompts={edgeMatches} />

        {digestItems.length > 0 && (
          <GardenDigest items={digestItems} juxtaposition={juxtaposition} />
        )}

        {/* Phase 19.3 — on-the-rise grid. */}
        <OnTheRise items={onTheRise} />

        {/* Browse separator */}
        <div className="mt-12 mb-4 flex items-baseline justify-between gap-3 border-t border-rule pt-6">
          <h2 className="font-sans text-[20px] font-semibold tracking-tight text-ink">
            Browse
          </h2>
          <p className="font-mono text-[10px] tracking-[0.16em] uppercase text-tag">
            All {allItems.length}
          </p>
        </div>

        {/* Smart search */}
        <SearchBar />

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
