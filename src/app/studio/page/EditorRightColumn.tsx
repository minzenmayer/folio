// Thoughtbed · EditorRightColumn
//
// Phase 20 slice 6 (2026-05-06). Client wrapper around the editor route's
// right column (PlanRibbon + AssistantRailLive). Lives in its own file
// because the route page is a server component and the column needs to
// react to useRailCollapse, which is client-side state. The wrapper
// drives its own width — 360px expanded, 56px collapsed, 0 hidden — so
// the editor pane to the left can reflow into the freed space.

'use client';

import { PlanRibbon } from './PlanRibbon';
import { AssistantRailLive, type GardenRailMode } from './AssistantRailLive';
import { useRailCollapse } from './useRailCollapse';

export function EditorRightColumn({
  draftId,
  mode,
}: {
  draftId: string;
  mode?: GardenRailMode;
}) {
  const { state } = useRailCollapse();

  // Hidden = no column at all. Collapsed = 56px strip. Expanded = full.
  // The 'hidden' branch isn't surfaced in the UI yet (the chevron only
  // toggles expanded <-> collapsed). It's wired now so a future slice
  // that adds a 'Hide rail' control just sets the state and gets the
  // right reflow for free.
  const widthClass =
    state === 'hidden'
      ? 'hidden'
      : state === 'collapsed'
        ? 'w-[56px]'
        : 'w-full md:w-[360px]';

  return (
    <div className={`flex flex-col shrink-0 ${widthClass}`}>
      <PlanRibbon />
      <AssistantRailLive draftId={draftId} mode={mode} />
    </div>
  );
}
