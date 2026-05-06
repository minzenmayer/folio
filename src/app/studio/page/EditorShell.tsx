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
// Slice 2 ships only the structural shell. The toolbar zone is a
// placeholder strip; the chat slot still renders the existing
// AssistantRailLive via EditorRightColumn. No behavior change yet,
// just the new wrapper to hang Phase 21 slices off.

'use client';

import { type ReactNode } from 'react';

export function EditorShell({
  toolbar,
  editor,
  rightColumn,
}: {
  toolbar?: ReactNode;
  editor: ReactNode;
  rightColumn: ReactNode;
}) {
  return (
    <div className="flex flex-col min-h-[calc(100vh-0px)]">
      {/* Top toolbar zone. Slice 3 wires document actions
          (favorite, download, copy, history) and slice 4 adds the
          platform-shape toggle + word-count target. */}
      <div className="border-b border-rule bg-bg">
        {toolbar ?? <div className="h-11" aria-hidden="true" />}
      </div>

      <div className="flex flex-col lg:flex-row flex-1 min-h-0">
        <section className="flex-1 min-w-0 px-[7%] py-12 md:py-14 overflow-y-auto">
          <div className="max-w-[68ch] mx-auto">{editor}</div>
        </section>

        {rightColumn}
      </div>
    </div>
  );
}
