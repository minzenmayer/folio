// Thoughtbed · ArtifactPanel
//
// Phase 22 slice 2 (2026-05-06). Side panel that holds the editor
// + toolbar + platform-shaped frame. Slides in from the right
// when the user clicks 'Open in editor →' inside chat (or pulls
// an idea — the pull also opens the panel as a side effect).
// Closes via the × in the panel header.
//
// The editor is always mounted inside, even when the panel is
// closed — that way the editor instance + autosave keep running
// and the toolbar's word-count + history affordances stay live.
// Visibility is CSS-only.

'use client';

import { useEffect, type ReactNode } from 'react';
import { useArtifactPanel } from './useArtifactPanel';
import { useEditorContext } from './EditorContext';
import { PlatformFrame } from './PlatformFrame';
import { usePlatform } from './usePlatform';

export function ArtifactPanel({
  toolbar,
  editor,
}: {
  toolbar?: ReactNode;
  editor: ReactNode;
}) {
  const { state, closeArtifact } = useArtifactPanel();
  const isOpen = state === 'open';
  const { editor: tiptapEditor } = useEditorContext();
  const { previewWidth } = usePlatform();
  const readOnly = previewWidth !== 'desktop';

  // Phase 22 slice 3 (2026-05-06): preview + mobile modes are
  // read-only renders. Toggle Tiptap's editable flag so keystrokes
  // don't sneak through. Returns to editable when the user
  // switches back to the editor view.
  useEffect(() => {
    if (!tiptapEditor) return;
    tiptapEditor.setEditable(!readOnly);
    return () => {
      tiptapEditor.setEditable(true);
    };
  }, [tiptapEditor, readOnly]);

  return (
    <aside
      aria-label="Artifact"
      aria-hidden={!isOpen}
      className={`border-l border-rule bg-bg flex flex-col transition-[width,opacity] duration-150 ${
        isOpen
          ? 'w-full lg:w-[520px] opacity-100'
          : 'w-0 lg:w-0 opacity-0 pointer-events-none'
      }`}
    >
      <div className="border-b border-rule flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={closeArtifact}
          aria-label="Close panel"
          title="Close panel"
          className="text-tag hover:text-ink transition-colors p-1 rounded-soft -ml-1 shrink-0 focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="3.5" y1="3.5" x2="10.5" y2="10.5" />
            <line x1="10.5" y1="3.5" x2="3.5" y2="10.5" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">{toolbar}</div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-[5%] py-8">
        <PlatformFrame>{editor}</PlatformFrame>
      </div>
    </aside>
  );
}
