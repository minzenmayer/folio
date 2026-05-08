// Thoughtbed · useBesidePhase
//
// Phase 24 slice 1 (2026-05-07). Beside has two phases the writer
// toggles between:
//   thinking  — quiet retrieval, generous fragment surfacing,
//               no originality nag, no Done button.
//   shipping  — tighter retrieval, originality flagging on,
//               Done button appears in the toolbar.
//
// Slice 1 wires the context only. No surfacing behavior is tied
// to phase yet — that lands in slice 5. The toggle exists so
// Payton can see the chrome flip in the bones layout.

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

export type BesidePhase = 'thinking' | 'shipping';

type BesidePhaseCtxValue = {
  phase: BesidePhase;
  setPhase: (next: BesidePhase) => void;
  toggle: () => void;
};

const Ctx = createContext<BesidePhaseCtxValue | null>(null);

const STORAGE_KEY = 'tb:beside:phase';

function readStored(): BesidePhase | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'thinking' || raw === 'shipping') return raw;
  } catch {
    // Ignore.
  }
  return null;
}

function writeStored(value: BesidePhase) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Ignore.
  }
}

export function BesidePhaseProvider({ children }: { children: ReactNode }) {
  // Render with a stable initial value first; hydrate from localStorage
  // after mount so the SSR/CSR HTML contract holds.
  const [phase, setPhaseRaw] = useState<BesidePhase>('thinking');

  useEffect(() => {
    const stored = readStored();
    if (stored) setPhaseRaw(stored);
  }, []);

  const setPhase = useCallback((next: BesidePhase) => {
    setPhaseRaw(next);
    writeStored(next);
  }, []);

  const toggle = useCallback(() => {
    setPhaseRaw((prev) => {
      const next: BesidePhase = prev === 'thinking' ? 'shipping' : 'thinking';
      writeStored(next);
      return next;
    });
  }, []);

  const value = useMemo<BesidePhaseCtxValue>(
    () => ({ phase, setPhase, toggle }),
    [phase, setPhase, toggle]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBesidePhase(): BesidePhaseCtxValue {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error('useBesidePhase must be used inside <BesidePhaseProvider>');
  }
  return ctx;
}
