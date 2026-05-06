// Thoughtbed · EditorShell
//
// Phase 21 slice 2 (2026-05-06). The new top-level shell for the
// editor route. Wraps the editor pane and right-column chat in a
// 3-zone layout per the Phase 21 spec:
//
//   ┌─────────────────────────────────────────────────────────────┐
//   │  TOP TOOLBAR (slice 3 fills this in)                        │
//   ├──────────────────────────────────────┬──────────────────────┤
//   │  EDITOR PANE                         │  CHAT COMPANION       │
//   │  (slice 4 wraps in platform frame)   │  (slice 6 replaces    │
//   │                                      │   AssistantRailLive)  │
//   └──────────────────────────────────────┴──────────────────────┘
//
// Phase 21 slice 4 (2026-05-06): wraps the route in a
// PlatformProvider and wraps the editor slot in a PlatformFrame so
// the editor body re-shapes to match the active platform without
// the route page needing to know about platform state.

'use client';

import { type ReactNode } from 'react';
import { PlatformFrame } from './PlatformFrame';
import { PlatformProvider, type Platform } from './usePlatform';

export function EditorShell({
  draftId,
  initialPlatform,
  toolbar,
  editor,
  rightColumn,
}: {
  draftId: string;
  initialPlatform?: Platform;
  toolbar?: ReactNode;
  editor: ReactNode;
  rightColumn: ReactNode;
}) {
  return (
    <PlatformProvider draftId={draftId} initial={initialPlatform}>
      <div className="flex flex-col min-h-[calc(100vh-0px)]">
        <div className="border-b border-rule bg-bg">
          {toolbar ?? <div className="h-11" aria-hidden="true" />}
        </div>

        <div className="flex flex-col lg:flex-row flex-1 min-h-0">
          <section className="flex-1 min-w-0 px-[7%] py-12 md:py-14 overflow-y-auto">
            <PlatformFrame>{editor}</PlatformFrame>
          </section>

          {rightColumn}
        </div>
      </div>
    </PlatformProvider>
  );
}
