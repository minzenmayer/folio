// Thoughtbed · usePlatform
//
// Phase 21 slice 4 (2026-05-06). Platform state for the editor route.
// Drives the platform-shape toggle in the toolbar and the visual
// frame around the editor body. Also feeds the chat companion's
// active-skill prompt (slice 9) so the assistant picks the right
// writing strategy.
//
// Persisted to localStorage per draft so reopening a draft brings
// you back to the same platform. The route page can pass an initial
// platform (from the URL ?mode= param) the first time a draft is
// opened.

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

export type Platform = 'linkedin' | 'newsletter' | 'blog' | 'note';

export const PLATFORMS: ReadonlyArray<Platform> = [
  'linkedin',
  'newsletter',
  'blog',
  'note',
];

export const PLATFORM_LABEL: Record<Platform, string> = {
  linkedin: 'LinkedIn',
  newsletter: 'Newsletter',
  blog: 'Blog',
  note: 'Note',
};

// Word count targets per platform. 'note' has no target — it's the
// freeform "no shape" mode.
export const PLATFORM_WORD_TARGET: Record<Platform, number | null> = {
  linkedin: 180,
  newsletter: 1000,
  blog: 700,
  note: null,
};

type PlatformCtxValue = {
  platform: Platform;
  setPlatform: (next: Platform) => void;
  cycle: (direction: 'left' | 'right') => void;
};

const PlatformCtx = createContext<PlatformCtxValue | null>(null);

const STORAGE_PREFIX = 'tb:platform:';

function readStored(draftId: string): Platform | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${draftId}`);
    if (
      raw === 'linkedin' ||
      raw === 'newsletter' ||
      raw === 'blog' ||
      raw === 'note'
    ) {
      return raw;
    }
  } catch {
    // Ignore.
  }
  return null;
}

function writeStored(draftId: string, value: Platform) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${draftId}`, value);
  } catch {
    // Ignore.
  }
}

export function PlatformProvider({
  draftId,
  initial,
  children,
}: {
  draftId: string;
  initial?: Platform;
  children: ReactNode;
}) {
  // Render with the initial value first; hydrate from localStorage
  // on mount so we don't break the SSR/CSR HTML contract.
  const [platform, setPlatformRaw] = useState<Platform>(initial ?? 'note');

  useEffect(() => {
    const stored = readStored(draftId);
    if (stored) setPlatformRaw(stored);
  }, [draftId]);

  const setPlatform = useCallback(
    (next: Platform) => {
      setPlatformRaw(next);
      writeStored(draftId, next);
    },
    [draftId]
  );

  const cycle = useCallback(
    (direction: 'left' | 'right') => {
      setPlatformRaw((prev) => {
        const idx = PLATFORMS.indexOf(prev);
        const nextIdx =
          direction === 'right'
            ? (idx + 1) % PLATFORMS.length
            : (idx - 1 + PLATFORMS.length) % PLATFORMS.length;
        const next = PLATFORMS[nextIdx];
        writeStored(draftId, next);
        return next;
      });
    },
    [draftId]
  );

  const value = useMemo<PlatformCtxValue>(
    () => ({ platform, setPlatform, cycle }),
    [platform, setPlatform, cycle]
  );

  return <PlatformCtx.Provider value={value}>{children}</PlatformCtx.Provider>;
}

export function usePlatform(): PlatformCtxValue {
  const ctx = useContext(PlatformCtx);
  if (!ctx) {
    throw new Error('usePlatform must be used inside <PlatformProvider>');
  }
  return ctx;
}
