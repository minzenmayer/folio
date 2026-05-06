// Thoughtbed · EditorShell
//
// Phase 21 slice 2 (2026-05-06). The new top-level shell for the
// editor route. Wraps the editor pane and right-column chat in a
// 3-zone layout per the Phase 21 spec.
//
// Phase 21 slice 4 (2026-05-06): wraps the route in a
// PlatformProvider and wraps the editor slot in a PlatformFrame.
//
// Phase 22 slice 1 (2026-05-06): when a draft is empty (no body
// content yet), renders <EditorEmptyState> instead of the
// editor + chat shell. Centered greeting + chips + chat input.
// Once the user submits or clicks a chip, the shell transitions
// to the regular layout. Slice 2 will refactor the regular layout
// to chat-primary with the editor in an on-demand artifact panel.

'use client';

import { useState, type ReactNode } from 'react';
import { EditorEmptyState } from './EditorEmptyState';
import { PlatformFrame } from './PlatformFrame';
import { PlatformProvider, type Platform } from './usePlatform';

export function EditorShell({
  draftId,
  initialPlatform,
  initialIsEmpty,
  userName,
  toolbar,
  editor,
  rightColumn,
}: {
  draftId: string;
  initialPlatform?: Platform;
  initialIsEmpty?: boolean;
  userName?: string | null;
  toolbar?: ReactNode;
  editor: ReactNode;
  rightColumn: ReactNode;
}) {
  const [hasInteracted, setHasInteracted] = useState(false);
  const showEmpty = (initialIsEmpty ?? false) && !hasInteracted;

  return (
    <PlatformProvider draftId={draftId} initial={initialPlatform}>
      {showEmpty ? (
        <EditorEmptyState
          userName={userName ?? null}
          onContinue={() => {
            // Slice 5 wires the seed argument to ChatCompanion so
            // the user's first input or chip choice lands as the
            // opening turn. Slice 1 just transitions to the regular
            // layout.
            setHasInteracted(true);
          }}
        />
      ) : (
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
      )}
    </PlatformProvider>
  );
}
