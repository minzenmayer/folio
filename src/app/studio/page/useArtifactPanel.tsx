// Thoughtbed · useArtifactPanel
//
// Phase 22 slice 2 (2026-05-06). Tracks whether the artifact panel
// is open or closed, persisted per-draft to localStorage so the
// last state sticks across refreshes. Opens via 'Open in editor →'
// links in chat or via the Pull-into-editor flow; closes via the
// × in the panel header.
//
// Exposes openArtifact / closeArtifact / toggleArtifact for
// imperative control from anywhere in the route subtree, and the
// `state` value for components that render conditionally.

'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ArtifactPanelState = 'open' | 'closed';

type ArtifactPanelCtxValue = {
  state: ArtifactPanelState;
  openArtifact: () => void;
  closeArtifact: () => void;
  toggleArtifact: () => void;
};

const ArtifactPanelCtx = createContext<ArtifactPanelCtxValue | null>(null);

const STORAGE_PREFIX = 'tb:artifact:';

function readStored(draftId: string): ArtifactPanelState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${draftId}`);
    if (raw === 'open' || raw === 'closed') return raw;
  } catch {
    // Ignore.
  }
  return null;
}

function writeStored(draftId: string, value: ArtifactPanelState) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${draftId}`, value);
  } catch {
    // Ignore.
  }
}

export function ArtifactPanelProvider({
  draftId,
  initial,
  children,
}: {
  draftId: string;
  initial?: ArtifactPanelState;
  children: ReactNode;
}) {
  const [state, setStateRaw] = useState<ArtifactPanelState>(initial ?? 'closed');

  useEffect(() => {
    const stored = readStored(draftId);
    if (stored) setStateRaw(stored);
  }, [draftId]);

  const openArtifact = useCallback(() => {
    setStateRaw('open');
    writeStored(draftId, 'open');
  }, [draftId]);

  const closeArtifact = useCallback(() => {
    setStateRaw('closed');
    writeStored(draftId, 'closed');
  }, [draftId]);

  const toggleArtifact = useCallback(() => {
    setStateRaw((prev) => {
      const next: ArtifactPanelState = prev === 'open' ? 'closed' : 'open';
      writeStored(draftId, next);
      return next;
    });
  }, [draftId]);

  const value = useMemo<ArtifactPanelCtxValue>(
    () => ({ state, openArtifact, closeArtifact, toggleArtifact }),
    [state, openArtifact, closeArtifact, toggleArtifact]
  );

  return (
    <ArtifactPanelCtx.Provider value={value}>
      {children}
    </ArtifactPanelCtx.Provider>
  );
}

export function useArtifactPanel(): ArtifactPanelCtxValue {
  const ctx = useContext(ArtifactPanelCtx);
  if (!ctx) {
    throw new Error(
      'useArtifactPanel must be used inside <ArtifactPanelProvider>'
    );
  }
  return ctx;
}
