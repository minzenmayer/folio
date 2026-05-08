// Thoughtbed · useThoughtBedCollapse
//
// Phase 24 slice 1 (2026-05-07). Three-state collapse for the
// right-side thought bed in Beside:
//   expanded — full ~360px panel, search + clusters + edge prompts
//   strip    — 56px strip, just glyphs (Phase 20 collapse pattern)
//   hidden   — gone entirely
//
// Cycles right→down. localStorage-persisted (global key for
// slice 1; per-draft scoping moves in when slice 5+ wires the
// real draft.)

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

export type ThoughtBedState = 'expanded' | 'strip' | 'hidden';

type ThoughtBedCollapseCtxValue = {
  state: ThoughtBedState;
  setState: (next: ThoughtBedState) => void;
  cycle: () => void;
};

const Ctx = createContext<ThoughtBedCollapseCtxValue | null>(null);

const STORAGE_KEY = 'tb:beside:bed';

function readStored(): ThoughtBedState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'expanded' || raw === 'strip' || raw === 'hidden') return raw;
  } catch {
    // Ignore.
  }
  return null;
}

function writeStored(value: ThoughtBedState) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Ignore.
  }
}

const ORDER: ReadonlyArray<ThoughtBedState> = ['expanded', 'strip', 'hidden'];

export function ThoughtBedCollapseProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [state, setStateRaw] = useState<ThoughtBedState>('expanded');

  useEffect(() => {
    const stored = readStored();
    if (stored) setStateRaw(stored);
  }, []);

  const setState = useCallback((next: ThoughtBedState) => {
    setStateRaw(next);
    writeStored(next);
  }, []);

  const cycle = useCallback(() => {
    setStateRaw((prev) => {
      const idx = ORDER.indexOf(prev);
      const next = ORDER[(idx + 1) % ORDER.length];
      writeStored(next);
      return next;
    });
  }, []);

  const value = useMemo<ThoughtBedCollapseCtxValue>(
    () => ({ state, setState, cycle }),
    [state, setState, cycle]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useThoughtBedCollapse(): ThoughtBedCollapseCtxValue {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error(
      'useThoughtBedCollapse must be used inside <ThoughtBedCollapseProvider>'
    );
  }
  return ctx;
}
