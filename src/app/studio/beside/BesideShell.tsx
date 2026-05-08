// Thoughtbed · BesideShell
//
// Phase 24 slice 1 (2026-05-07). The structural shell of the
// Writing × Beside surface. Renders inside HomeComposer when the
// homepage user picks Writing × Beside and submits a topic.
//
// Three zones:
//   • Toolbar across the top (BesideToolbar)
//   • Editor placeholder in the center (slice 1 = textarea inside
//     PlatformFrame; real Tiptap lands in slice 2-3)
//   • Thought bed on the right (ThoughtBed) — collapsible
//
// The shell wraps everything in:
//   • PlatformProvider — so PlatformFrame works and the platform
//     cycle persists per session (slice 1 uses a stable shell-id
//     until drafts land)
//   • BesidePhaseProvider — drives the phase pill
//   • ThoughtBedCollapseProvider — drives the right-pane state
//
// Slice 1 is intentionally bones. No retrieval, no LLM, no claim
// writes, no draft creation.

'use client';

import { PlatformProvider, type Platform } from '../page/usePlatform';
import { BesidePhaseProvider } from './useBesidePhase';
import { ThoughtBedCollapseProvider } from './useThoughtBedCollapse';
import { BesideToolbar } from './BesideToolbar';
import { EditorPlaceholder } from './EditorPlaceholder';
import { ThoughtBed } from './ThoughtBed';

// Stable id used for localStorage scoping until slice 6 wires the
// Done flow (which creates a real draft row and gives us a real
// draft id to scope to).
const SHELL_ID = 'beside-shell';

export function BesideShell({
  topic,
  initialPlatform,
  onExit,
}: {
  topic: string;
  initialPlatform?: Platform;
  onExit: () => void;
}) {
  return (
    <PlatformProvider draftId={SHELL_ID} initial={initialPlatform ?? 'note'}>
      <BesidePhaseProvider>
        <ThoughtBedCollapseProvider>
          <div>
            <BesideToolbar onExit={onExit} />
            <div className="flex min-h-[calc(100vh-49px)]">
              <main className="flex-1 min-w-0">
                <EditorPlaceholder topic={topic} />
              </main>
              <ThoughtBed />
            </div>
          </div>
        </ThoughtBedCollapseProvider>
      </BesidePhaseProvider>
    </PlatformProvider>
  );
}
