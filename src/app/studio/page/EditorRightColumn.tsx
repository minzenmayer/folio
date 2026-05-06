// Thoughtbed · EditorRightColumn
//
// Phase 21 slice 6 (2026-05-06). Now wraps ChatCompanion (the new
// conversation-style writing partner) instead of AssistantRailLive.
// Same width / collapse / mobile-sheet semantics carry over from
// Phase 20 slices 6-7. AssistantRailLive stays in the codebase for
// now in case we need to roll back, but it's no longer mounted.

'use client';

import { ChatCompanion } from './ChatCompanion';
import { useRailCollapse } from './useRailCollapse';
import { type GardenRailMode } from './AssistantRailLive';

export function EditorRightColumn({
  draftId,
  mode,
}: {
  draftId: string;
  mode?: GardenRailMode;
}) {
  void mode;
  const { state, setState } = useRailCollapse();

  const desktopWidthClass =
    state === 'hidden'
      ? 'lg:hidden'
      : state === 'collapsed'
        ? 'lg:w-[56px]'
        : 'lg:w-[360px]';

  const sheetOpen = state === 'expanded';

  return (
    <>
      <div className={`hidden lg:flex flex-col shrink-0 ${desktopWidthClass}`}>
        <ChatCompanion draftId={draftId} />
      </div>

      <div className="lg:hidden">
        {sheetOpen ? (
          <div className="fixed inset-x-0 bottom-0 z-30 max-h-[80vh] bg-bg border-t border-rule rounded-t-modal shadow-modal flex flex-col">
            <div className="flex items-center justify-between px-4 pt-3 pb-1">
              <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium">
                Thoughtbed
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
              <ChatCompanion draftId={draftId} />
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setState('expanded')}
            aria-label="Open Thoughtbed companion"
            title="Open Thoughtbed"
            className="fixed bottom-4 right-4 z-30 h-12 px-4 rounded-full bg-ink text-bg font-mono text-[10px] tracking-[0.22em] uppercase shadow-modal hover:bg-accent transition-colors flex items-center gap-2"
          >
            <ChevronUpGlyph />
            Thoughtbed
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
