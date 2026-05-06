// Thoughtbed · EditorRightColumn
//
// Phase 20 slice 6 (2026-05-06). Client wrapper around the editor route's
// right column (PlanRibbon + AssistantRailLive). Lives in its own file
// because the route page is a server component and the column needs to
// react to useRailCollapse, which is client-side state. The wrapper
// drives its own width — 360px expanded, 56px collapsed, 0 hidden — so
// the editor pane to the left can reflow into the freed space.
//
// Phase 20 slice 7 (2026-05-06): mobile bottom-sheet variant. Below the
// lg breakpoint (<1024px) the column drops out of the route's grid and
// renders as a fixed bottom-right sheet, summoned by a chevron-up FAB.
// 'Collapse' becomes 'close sheet' — same useRailCollapse state, just a
// different visual surface. The FAB stays visible whenever the sheet is
// closed so the user can reopen it.

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
  const { state, setState } = useRailCollapse();

  // ── Desktop (>=lg) — in-route flex column ───────────────────────────
  // Hidden = no column at all. Collapsed = 56px strip. Expanded = full.
  // Below the lg breakpoint, this whole branch is hidden via Tailwind
  // utilities and the bottom-sheet variant takes over.
  const desktopWidthClass =
    state === 'hidden'
      ? 'lg:hidden'
      : state === 'collapsed'
        ? 'lg:w-[56px]'
        : 'lg:w-[360px]';

  // ── Mobile (<lg) — bottom-sheet ─────────────────────────────────────
  // 'expanded' = sheet open. Anything else = sheet closed (FAB visible).
  const sheetOpen = state === 'expanded';

  return (
    <>
      {/* Desktop column. Hidden under lg; the bottom-sheet renders below. */}
      <div
        className={`hidden lg:flex flex-col shrink-0 ${desktopWidthClass}`}
      >
        <PlanRibbon />
        <AssistantRailLive draftId={draftId} mode={mode} />
      </div>

      {/* Mobile bottom-sheet. Lives in a fixed-positioned overlay so it
          sits above the editor without pushing layout. The sheet itself
          mounts AssistantRailLive; PlanRibbon is desktop-only for now —
          the rail's collapse chevron in the sheet maps to 'close sheet'
          via the useRailCollapse hook the rail already reads. */}
      <div className="lg:hidden">
        {sheetOpen ? (
          <div className="fixed inset-x-0 bottom-0 z-30 max-h-[80vh] bg-bg border-t border-rule rounded-t-modal shadow-modal flex flex-col">
            <div className="flex items-center justify-between px-4 pt-3 pb-1">
              <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium">
                Resonance
              </span>
              <button
                type="button"
                onClick={() => setState('collapsed')}
                aria-label="Close sheet"
                title="Close sheet"
                className="font-mono text-[14px] leading-none text-tag hover:text-ink transition-colors px-2 py-1"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <AssistantRailLive draftId={draftId} mode={mode} />
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setState('expanded')}
            aria-label="Open resonance sheet"
            title="Open resonance"
            className="fixed bottom-4 right-4 z-30 h-12 px-4 rounded-full bg-ink text-bg font-mono text-[10px] tracking-[0.22em] uppercase shadow-modal hover:bg-accent transition-colors flex items-center gap-2"
          >
            <ChevronUpGlyph />
            Resonance
          </button>
        )}
      </div>
    </>
  );
}

function ChevronUpGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="3,8 6,5 9,8" />
    </svg>
  );
}
