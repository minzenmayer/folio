// Thoughtbed · EditorShell
//
// Phase 22 slice 2 (2026-05-06). The route's top-level shell. New
// shape: chat is the primary surface in the main pane; the editor
// lives in an on-demand ArtifactPanel that slides in from the
// right when the user clicks 'Open in editor →' (or pulls an
// idea via the chat). When the panel is closed, the chat takes
// the full width.
//
// On a fresh blank draft, the EditorEmptyState (Phase 22 slice 1)
// takes over until the user clicks a chip or submits something.
//
// Slice 5 wires the chip seeds; slice 4 ships per-turn embedded
// artifact previews with their own 'Open in editor →' affordance.

'use client';

import { useState, type ReactNode } from 'react';
import { EditorEmptyState, type ChatSeed } from './EditorEmptyState';
import { PlatformProvider, type Platform } from './usePlatform';
import { ArtifactPanelProvider } from './useArtifactPanel';
import { ChatSeedProvider } from './useChatSeed';

export function EditorShell({
  draftId,
  initialPlatform,
  initialIsEmpty,
  userName,
  chat,
  artifactPanel,
}: {
  draftId: string;
  initialPlatform?: Platform;
  initialIsEmpty?: boolean;
  userName?: string | null;
  chat: ReactNode;
  artifactPanel: ReactNode;
}) {
  const [hasInteracted, setHasInteracted] = useState(false);
  const [seed, setSeed] = useState<ChatSeed | null>(null);
  const showEmpty = (initialIsEmpty ?? false) && !hasInteracted;

  // When the draft already had content on first load, default the
  // artifact panel to open so the user lands directly on what
  // they were last working on. Empty drafts default the panel
  // closed (the empty-state UI handles the entry path).
  const initialArtifact = (initialIsEmpty ?? false) ? 'closed' : 'open';

  return (
    <PlatformProvider draftId={draftId} initial={initialPlatform}>
      <ArtifactPanelProvider draftId={draftId} initial={initialArtifact}>
        {showEmpty ? (
          <EditorEmptyState
            userName={userName ?? null}
            onContinue={(s) => {
              setSeed(s);
              setHasInteracted(true);
            }}
          />
        ) : (
          <ChatSeedProvider initial={seed}>
            <div className="flex flex-col lg:flex-row min-h-[calc(100vh-0px)]">
              <main className="flex-1 min-w-0 flex flex-col">{chat}</main>
              {artifactPanel}
            </div>
          </ChatSeedProvider>
        )}
      </ArtifactPanelProvider>
    </PlatformProvider>
  );
}
