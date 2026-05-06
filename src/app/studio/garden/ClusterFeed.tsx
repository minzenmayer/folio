// Thoughtbed · ClusterFeed — Phase 17 (2026-05-05)
//
// Renders the day's clusters as a list of ClusterCard. Empty state
// when the user has nothing yet. The toggle between cluster view and
// flat list lives in ViewToggle (sibling component); this surface
// only renders the cluster shape.

import type { ClusterRender } from './ClusterCard';
import { ClusterCard } from './ClusterCard';

export function ClusterFeed({ clusters }: { clusters: ClusterRender[] }) {
  if (clusters.length === 0) {
    return (
      <div className="text-center py-12 border border-dashed border-rule rounded-card bg-paper">
        <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-2">
          No clusters yet
        </div>
        <p className="font-sans text-[14px] text-tag">
          Clusters compute overnight. Check back tomorrow, or switch to list
          view above for the flat feed.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {clusters.map((c) => (
        <ClusterCard key={c.id} cluster={c} />
      ))}
    </div>
  );
}
